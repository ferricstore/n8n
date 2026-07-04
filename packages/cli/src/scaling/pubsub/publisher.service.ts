import { Logger } from '@n8n/backend-common';
import { ExecutionsConfig, GlobalConfig } from '@n8n/config';
import { Service } from '@n8n/di';
import type { Redis as SingleNodeClient, Cluster as MultiNodeClient } from 'ioredis';
import { InstanceSettings } from 'n8n-core';
import type { LogMetadata } from 'n8n-workflow';

import { RedisClientService } from '@/services/redis-client.service';
import {
	createFerricFlowWorkflowRecord,
	createFerricStoreClient,
	responseText,
	type FerricStoreClient,
} from '@/scaling/ferricflow/ferricstore-sdk';
import { scalingWorkflowDefinition } from '@/scaling/ferricflow/scaling-workflows';

import type { PubSub } from './pubsub.types';
import {
	COMMAND_PUBSUB_CHANNEL,
	IMMEDIATE_COMMANDS,
	SELF_SEND_COMMANDS,
	WORKER_RESPONSE_PUBSUB_CHANNEL,
	MCP_RELAY_PUBSUB_CHANNEL,
} from '../constants';
import type { McpRelayMessage } from './subscriber.service';

/**
 * Responsible for publishing messages into the pubsub channels used by scaling mode.
 */
@Service()
export class Publisher {
	private readonly client?: SingleNodeClient | MultiNodeClient;

	private ferricClient?: Promise<FerricStoreClient>;

	private readonly commandChannel: string;

	private readonly workerResponseChannel: string;

	private readonly mcpRelayChannel: string;

	// #region Lifecycle

	constructor(
		private readonly logger: Logger,
		private readonly redisClientService: RedisClientService,
		private readonly instanceSettings: InstanceSettings,
		private readonly executionsConfig: ExecutionsConfig,
		private readonly globalConfig: GlobalConfig,
	) {
		// @TODO: Once this class is only ever initialized in scaling mode, assert in the next line.
		if (this.executionsConfig.mode !== 'queue') return;

		this.logger = this.logger.scoped(['scaling', 'pubsub']);

		// Build prefixed channel names for proper isolation between deployments
		const prefix = this.scalingPrefix;
		this.commandChannel = `${prefix}:${COMMAND_PUBSUB_CHANNEL}`;
		this.workerResponseChannel = `${prefix}:${WORKER_RESPONSE_PUBSUB_CHANNEL}`;
		this.mcpRelayChannel = `${prefix}:${MCP_RELAY_PUBSUB_CHANNEL}`;

		if (this.scalingBackend === 'ferricflow') {
			this.ferricClient = this.createFerricClient();
		} else {
			this.client = this.redisClientService.createClient({ type: 'publisher(n8n)' });
		}
	}

	getClient() {
		return this.client;
	}

	// @TODO: Use `@OnShutdown()` decorator
	shutdown() {
		this.client?.disconnect();
		void this.ferricClient?.then(async (client) => await client.close());
	}

	// #endregion

	// #region Publishing

	/** Publish a command into the commands channel. */
	async publishCommand(msg: PubSub.Command) {
		// @TODO: Once this class is only ever used in scaling mode, remove next line.
		if (this.executionsConfig.mode !== 'queue') return;

		await this.publish(
			this.commandChannel,
			JSON.stringify({
				...msg,
				senderId: this.instanceSettings.hostId,
				selfSend: SELF_SEND_COMMANDS.has(msg.command),
				debounce: !IMMEDIATE_COMMANDS.has(msg.command),
			}),
		);

		let msgName = msg.command;

		const metadata: LogMetadata = { msg: msg.command, channel: this.commandChannel };

		if (msg.command === 'relay-execution-lifecycle-event') {
			const { data, type } = msg.payload;
			msgName += ` (${type})`;
			metadata.type = type;
			if ('executionId' in data) metadata.executionId = data.executionId;
		}

		this.logger.debug(`Published pubsub msg: ${msgName}`, metadata);
	}

	/** Publish a response to a command into the worker response channel. */
	async publishWorkerResponse(msg: PubSub.WorkerResponse) {
		if (this.executionsConfig.mode !== 'queue') return;

		await this.publish(this.workerResponseChannel, JSON.stringify(msg));

		this.logger.debug(`Published ${msg.response} to worker response channel`);
	}

	/** Publish an MCP relay message to route responses between main instances. */
	async publishMcpRelay(msg: McpRelayMessage) {
		// @TODO: Once this class is only ever used in scaling mode, remove next line.
		if (this.executionsConfig.mode !== 'queue') return;

		await this.publish(this.mcpRelayChannel, JSON.stringify(msg));

		this.logger.debug('Published MCP relay message', {
			sessionId: msg.sessionId,
			messageId: msg.messageId,
			channel: this.mcpRelayChannel,
		});
	}

	// #endregion

	// #region Key-value utils (used by MCP session store and legacy leader election)

	async setIfNotExists(key: string, value: string, ttl: number) {
		if (this.scalingBackend === 'ferricflow') {
			const result = await (await this.getFerricClient()).command(
				'SET',
				key,
				value,
				'EX',
				ttl,
				'NX',
			);
			return responseText(result).toUpperCase() === 'OK';
		}

		const result = await this.client?.set(key, value, 'EX', ttl, 'NX');
		return result === 'OK';
	}

	async set(key: string, value: string, ttl: number) {
		if (this.scalingBackend === 'ferricflow') {
			await (await this.getFerricClient()).command('SET', key, value, 'EX', ttl);
			return;
		}

		await this.client?.set(key, value, 'EX', ttl);
	}

	async setExpiration(key: string, ttl: number) {
		if (this.scalingBackend === 'ferricflow') {
			await (await this.getFerricClient()).command('EXPIRE', key, ttl);
			return;
		}

		await this.client?.expire(key, ttl);
	}

	async get(key: string) {
		if (this.scalingBackend === 'ferricflow') {
			const value = await (await this.getFerricClient()).command('GET', key);
			return value == null ? null : responseText(value);
		}

		return (await this.client?.get(key)) ?? null;
	}

	async clear(key: string) {
		if (this.scalingBackend === 'ferricflow') {
			await (await this.getFerricClient()).command('DEL', key);
			return;
		}

		await this.client?.del(key);
	}

	// #endregion

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
			'n8n-scaling-publisher',
		);
	}

	private async getFerricClient() {
		this.ferricClient ??= this.createFerricClient();
		return await this.ferricClient;
	}

	private async publish(channel: string, message: string) {
		if (this.scalingBackend === 'ferricflow') {
			await createFerricFlowWorkflowRecord(await this.getFerricClient(), {
				...this.scalingWorkflow(channel),
				payload: { channel, message },
			});
			return;
		}

		await this.client?.publish(channel, message);
	}

	private scalingWorkflow(channel: string) {
		return scalingWorkflowDefinition(this.scalingPrefix, channel, {
			commandChannel: this.commandChannel,
			mcpRelayChannel: this.mcpRelayChannel,
			workerResponseChannel: this.workerResponseChannel,
		});
	}
}
