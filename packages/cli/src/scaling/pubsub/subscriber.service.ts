import { Logger } from '@n8n/backend-common';
import { ExecutionsConfig, GlobalConfig } from '@n8n/config';
import { Service } from '@n8n/di';
import type { Redis as SingleNodeClient, Cluster as MultiNodeClient } from 'ioredis';
import debounce from 'lodash/debounce';
import { InstanceSettings } from 'n8n-core';
import { jsonParse } from 'n8n-workflow';
import type { LogMetadata } from 'n8n-workflow';

import { RedisClientService } from '@/services/redis-client.service';
import {
	createFerricStoreClient,
	readNewFerricFlowWorkflowRecords,
	seedSeenFerricFlowWorkflowRecords,
	type FerricStoreClient,
} from '@/scaling/ferricflow/ferricstore-sdk';
import { scalingWorkflowDefinition } from '@/scaling/ferricflow/scaling-workflows';

import { PubSubEventBus } from './pubsub.eventbus';
import type { PubSub } from './pubsub.types';
import {
	COMMAND_PUBSUB_CHANNEL,
	WORKER_RESPONSE_PUBSUB_CHANNEL,
	MCP_RELAY_PUBSUB_CHANNEL,
} from '../constants';

/**
 * Responsible for subscribing to the pubsub channels used by scaling mode.
 */
/**
 * MCP relay message format for multi-main queue mode.
 * Used to relay MCP responses (like list tools) between main instances.
 */
export interface McpRelayMessage {
	sessionId: string;
	messageId: string;
	response: unknown;
}

@Service()
export class Subscriber {
	private readonly client?: SingleNodeClient | MultiNodeClient;

	private ferricClient?: Promise<FerricStoreClient>;

	private readonly commandChannel: string;

	private readonly workerResponseChannel: string;

	private readonly mcpRelayChannel: string;

	/** Callback for MCP relay messages. Set by ScalingService. */
	private mcpRelayHandler?: (msg: McpRelayMessage) => void;

	private readonly debouncedHandlers = new Map<string, ReturnType<typeof debounce>>();

	private readonly ferricWorkflowSubscriptions = new Map<string, { seen: Set<string> }>();

	private stopped = false;

	constructor(
		private readonly logger: Logger,
		private readonly instanceSettings: InstanceSettings,
		private readonly pubsubEventBus: PubSubEventBus,
		private readonly redisClientService: RedisClientService,
		private readonly executionsConfig: ExecutionsConfig,
		private readonly globalConfig: GlobalConfig,
	) {
		// @TODO: Once this class is only ever initialized in scaling mode, throw in the next line instead.
		if (this.executionsConfig.mode !== 'queue') return;

		this.logger = this.logger.scoped(['scaling', 'pubsub']);

		// Build prefixed channel names for proper isolation between deployments
		const prefix = this.scalingPrefix;
		this.commandChannel = `${prefix}:${COMMAND_PUBSUB_CHANNEL}`;
		this.workerResponseChannel = `${prefix}:${WORKER_RESPONSE_PUBSUB_CHANNEL}`;
		this.mcpRelayChannel = `${prefix}:${MCP_RELAY_PUBSUB_CHANNEL}`;

		if (this.scalingBackend === 'ferricflow') {
			this.ferricClient = this.createFerricClient();
			return;
		}

		this.client = this.redisClientService.createClient({ type: 'subscriber(n8n)' });

		this.client.on('message', (channel: string, str: string) => {
			this.handleChannelMessage(channel, str);
		});
	}

	/**
	 * Set the handler for MCP relay messages.
	 * Called by ScalingService to route messages to handleMcpResponse.
	 */
	setMcpRelayHandler(handler: (msg: McpRelayMessage) => void): void {
		this.mcpRelayHandler = handler;
	}

	private handleMcpRelayMessage(str: string): void {
		const msg = jsonParse<McpRelayMessage | null>(str, { fallbackValue: null });
		if (!msg?.sessionId || !msg.messageId) {
			this.logger.error('Received malformed MCP relay message', { msg: str });
			return;
		}

		this.logger.debug('Received MCP relay message', {
			sessionId: msg.sessionId,
			messageId: msg.messageId,
		});

		if (this.mcpRelayHandler) {
			this.mcpRelayHandler(msg);
		}
	}

	getClient() {
		return this.client;
	}

	getCommandChannel() {
		return this.commandChannel;
	}

	getWorkerResponseChannel() {
		return this.workerResponseChannel;
	}

	getMcpRelayChannel() {
		return this.mcpRelayChannel;
	}

	// @TODO: Use `@OnShutdown()` decorator
	shutdown() {
		this.stopped = true;
		for (const handler of this.debouncedHandlers.values()) handler.cancel();
		this.client?.disconnect();
		void this.ferricClient?.then(async (client) => await client.close());
	}

	async subscribe(channel: string) {
		if (this.executionsConfig.mode !== 'queue') return;

		if (this.scalingBackend === 'ferricflow') {
			await this.subscribeFerricFlowWorkflow(channel);
			return;
		}

		await this.client?.subscribe(channel, (error) => {
			if (error) {
				this.logger.error(`Failed to subscribe to channel ${channel}`, { error });
				return;
			}

			this.logger.debug(`Subscribed to channel ${channel}`);
		});
	}

	private eventNameFrom(msg: PubSub.Command | PubSub.WorkerResponse) {
		return 'command' in msg ? msg.command : msg.response;
	}

	private handleChannelMessage(channel: string, str: string) {
		if (channel === this.mcpRelayChannel) {
			this.handleMcpRelayMessage(str);
			return;
		}

		const msg = this.parseMessage(str, channel);
		if (!msg) return;

		const handlerFn = (message: PubSub.Command | PubSub.WorkerResponse) => {
			this.pubsubEventBus.emit(this.eventNameFrom(message), message.payload);
		};

		if (!msg.debounce) return handlerFn(msg);

		const eventName = this.eventNameFrom(msg);
		let handler = this.debouncedHandlers.get(eventName);
		if (!handler) {
			handler = debounce(handlerFn, 300);
			this.debouncedHandlers.set(eventName, handler);
		}
		handler(msg);
	}

	private parseMessage(str: string, channel: string) {
		const msg = jsonParse<PubSub.Command | PubSub.WorkerResponse | null>(str, {
			fallbackValue: null,
		});

		if (!msg) {
			this.logger.error('Received malformed pubsub message', {
				msg: str,
				channel,
			});
			return null;
		}

		const { hostId } = this.instanceSettings;

		if (
			'command' in msg &&
			!msg.selfSend &&
			(msg.senderId === hostId || (msg.targets && !msg.targets.includes(hostId)))
		) {
			return null;
		}

		let msgName = this.eventNameFrom(msg);

		const metadata: LogMetadata = { msg: msgName, channel };

		if ('command' in msg && msg.command === 'relay-execution-lifecycle-event') {
			const { data, type } = msg.payload;
			msgName += ` (${type})`;
			metadata.type = type;
			if ('executionId' in data) metadata.executionId = data.executionId;
		}

		this.logger.debug(`Received pubsub msg: ${msgName}`, metadata);

		return msg;
	}

	private get scalingBackend() {
		return this.globalConfig.queue?.backend ?? 'ferricflow';
	}

	private get scalingPrefix() {
		return this.scalingBackend === 'ferricflow'
			? this.globalConfig.queue.ferricflow.prefix
			: this.globalConfig.redis.prefix;
	}

	private createFerricClient() {
		return createFerricStoreClient(
			this.globalConfig.queue.ferricflow.sdkPath,
			this.globalConfig.queue.ferricflow.url,
			'n8n-scaling-subscriber',
		);
	}

	private async getFerricClient() {
		this.ferricClient ??= this.createFerricClient();
		return await this.ferricClient;
	}

	private async subscribeFerricFlowWorkflow(channel: string) {
		if (this.ferricWorkflowSubscriptions.has(channel)) return;

		const client = await this.getFerricClient();
		const subscription = {
			seen: new Set<string>(),
		};
		await seedSeenFerricFlowWorkflowRecords(client, {
			...this.scalingWorkflow(channel),
			seen: subscription.seen,
		});

		this.ferricWorkflowSubscriptions.set(channel, subscription);
		this.logger.debug(`Subscribed to FerricFlow workflow partition ${channel}`);

		void this.ferricFlowWorkflowLoop(channel, subscription);
	}

	private async ferricFlowWorkflowLoop(channel: string, subscription: { seen: Set<string> }) {
		while (!this.stopped && this.ferricWorkflowSubscriptions.get(channel) === subscription) {
			try {
				const records = await readNewFerricFlowWorkflowRecords<{ message?: string }>(
					await this.getFerricClient(),
					{
						...this.scalingWorkflow(channel),
						seen: subscription.seen,
					},
				);

				for (const record of records) {
					const message = record.payload?.message;
					if (message) this.handleChannelMessage(channel, message);
				}
			} catch (error) {
				if (this.stopped) return;

				this.logger.error(`Failed reading FerricFlow workflow partition ${channel}`, { error });
				await sleep(1000);
			}

			await sleep(this.pollIntervalMs());
		}
	}

	private scalingWorkflow(channel: string) {
		return scalingWorkflowDefinition(this.scalingPrefix, channel, {
			commandChannel: this.commandChannel,
			mcpRelayChannel: this.mcpRelayChannel,
			workerResponseChannel: this.workerResponseChannel,
		});
	}

	private pollIntervalMs() {
		return this.globalConfig.queue?.ferricflow?.pollIntervalMs ?? 250;
	}
}

async function sleep(ms: number) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
