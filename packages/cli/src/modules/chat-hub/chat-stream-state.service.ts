import type { ChatMessageId, ChatSessionId } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { ChatHubConfig, ExecutionsConfig, GlobalConfig } from '@n8n/config';
import { Time } from '@n8n/constants';
import { OnShutdown } from '@n8n/decorators';
import { Service } from '@n8n/di';
import type { Cluster, Redis } from 'ioredis';
import { InstanceSettings } from 'n8n-core';
import { jsonParse, jsonStringify } from 'n8n-workflow';

import {
	createFerricStoreClient,
	responseText,
	type FerricStoreClient,
} from '@/scaling/ferricflow/ferricstore-sdk';
import { RedisClientService } from '@/services/redis-client.service';

/**
 * Stream state for an active chat session
 */
export interface StreamState {
	/** Chat session ID */
	sessionId: ChatSessionId;
	/** Message ID being streamed */
	messageId: ChatMessageId;
	/** User ID */
	userId: string;
	/** Current sequence number */
	sequenceNumber: number;
	/** Timestamp when stream started */
	startedAt: number;
}

/**
 * Buffered chunk for reconnection replay
 */
export interface BufferedChunk {
	sequenceNumber: number;
	content: string;
}

/**
 * Parameters for starting a new stream
 */
export interface StartStreamParams {
	sessionId: ChatSessionId;
	messageId: ChatMessageId;
	userId: string;
}

/**
 * Parameters for starting a new execution
 */
export interface StartExecutionParams {
	sessionId: ChatSessionId;
	userId: string;
}

/**
 * Service responsible for storing chat session state for reconnection support.
 * Uses in-memory storage for single-main mode and a shared backend for multi-main/queue mode.
 */
@Service()
export class ChatStreamStateService {
	private readonly memoryStore = new Map<ChatSessionId, StreamState>();
	private readonly chunkBuffer = new Map<ChatSessionId, BufferedChunk[]>();
	private readonly cleanupTimers = new Map<ChatSessionId, ReturnType<typeof setTimeout>>();

	private readonly useFerricStore: boolean;
	private readonly useRedis: boolean;
	private readonly redisPrefix: string;
	private readonly cleanupDelayMs: number;
	private ferricStoreClient: Promise<FerricStoreClient> | null = null;
	private redisClient: Redis | Cluster | null = null;

	constructor(
		private readonly logger: Logger,
		private readonly instanceSettings: InstanceSettings,
		private readonly executionsConfig: ExecutionsConfig,
		private readonly globalConfig: GlobalConfig,
		private readonly chatHubConfig: ChatHubConfig,
		private readonly redisClientService: RedisClientService,
	) {
		this.logger = this.logger.scoped('chat-hub');
		const useSharedStorage =
			this.instanceSettings.isMultiMain || this.executionsConfig.mode === 'queue';
		this.useFerricStore = useSharedStorage && this.globalConfig.queue?.backend === 'ferricflow';
		this.useRedis = useSharedStorage && !this.useFerricStore;
		this.redisPrefix = `${this.globalConfig.redis.prefix}:chat-hub:stream:`;
		this.cleanupDelayMs = this.chatHubConfig.streamStateTtl * Time.seconds.toMilliseconds;

		if (this.useFerricStore) {
			this.ferricStoreClient = createFerricStoreClient(
				this.globalConfig.queue.ferricflow.sdkPath,
				this.globalConfig.queue.ferricflow.url,
				'n8n-ferricflow-chat-hub-streams',
			);
		} else if (this.useRedis) {
			this.redisClient = this.redisClientService.createClient({ type: 'subscriber(n8n)' });
		}
	}

	/**
	 * Start tracking a new execution (can contain multiple messages)
	 */
	async startExecution(params: StartExecutionParams): Promise<void> {
		const { sessionId, userId } = params;

		const state: StreamState = {
			sessionId,
			messageId: '', // Will be set when first message starts
			userId,
			sequenceNumber: 0,
			startedAt: Date.now(),
		};

		if (this.useFerricStore) {
			await this.setFerricStoreState(sessionId, state);
			await this.setFerricStoreChunks(sessionId, []);
		} else if (this.useRedis) {
			await this.setRedisState(sessionId, state);
			await this.setRedisChunks(sessionId, []);
		} else {
			this.memoryStore.set(sessionId, state);
			this.chunkBuffer.set(sessionId, []);
			this.scheduleCleanup(sessionId);
		}

		this.logger.debug(`Started execution for session ${sessionId}`);
	}

	/**
	 * End an execution and clean up state
	 */
	async endExecution(sessionId: ChatSessionId): Promise<void> {
		if (this.useFerricStore) {
			await this.deleteFerricStoreState(sessionId);
			await this.deleteFerricStoreChunks(sessionId);
		} else if (this.useRedis) {
			await this.deleteRedisState(sessionId);
			await this.deleteRedisChunks(sessionId);
		} else {
			this.memoryStore.delete(sessionId);
			this.chunkBuffer.delete(sessionId);
			this.cancelCleanup(sessionId);
		}

		this.logger.debug(`Ended execution for session ${sessionId}`);
	}

	/**
	 * Set the current message ID being streamed
	 */
	async setCurrentMessage(sessionId: ChatSessionId, messageId: ChatMessageId): Promise<void> {
		if (this.useFerricStore) {
			const state = await this.getFerricStoreState(sessionId);
			if (state) {
				state.messageId = messageId;
				await this.setFerricStoreState(sessionId, state);
			}
		} else if (this.useRedis) {
			const state = await this.getRedisState(sessionId);
			if (state) {
				state.messageId = messageId;
				await this.setRedisState(sessionId, state);
			}
		} else {
			const state = this.memoryStore.get(sessionId);
			if (state) {
				state.messageId = messageId;
			}
		}

		this.logger.debug(`Set current message for session ${sessionId} to ${messageId}`);
	}

	/**
	 * Start tracking a new stream
	 */
	async startStream(params: StartStreamParams): Promise<void> {
		const { sessionId, messageId, userId } = params;

		const state: StreamState = {
			sessionId,
			messageId,
			userId,
			sequenceNumber: 0,
			startedAt: Date.now(),
		};

		if (this.useFerricStore) {
			await this.setFerricStoreState(sessionId, state);
			await this.setFerricStoreChunks(sessionId, []);
		} else if (this.useRedis) {
			await this.setRedisState(sessionId, state);
			await this.setRedisChunks(sessionId, []);
		} else {
			this.memoryStore.set(sessionId, state);
			this.chunkBuffer.set(sessionId, []);
			this.scheduleCleanup(sessionId);
		}

		this.logger.debug(`Started stream for session ${sessionId} message ${messageId}`);
	}

	/**
	 * Get the current stream state for a session
	 */
	async getStreamState(sessionId: ChatSessionId): Promise<StreamState | null> {
		if (this.useFerricStore) {
			return await this.getFerricStoreState(sessionId);
		}
		if (this.useRedis) {
			return await this.getRedisState(sessionId);
		}
		return this.memoryStore.get(sessionId) ?? null;
	}

	/**
	 * Increment and return the next sequence number
	 */
	async incrementSequence(sessionId: ChatSessionId): Promise<number> {
		if (this.useFerricStore) {
			const state = await this.getFerricStoreState(sessionId);
			if (!state) return 0;
			state.sequenceNumber += 1;
			await this.setFerricStoreState(sessionId, state);
			return state.sequenceNumber;
		}

		if (this.useRedis) {
			const state = await this.getRedisState(sessionId);
			if (!state) return 0;
			state.sequenceNumber += 1;
			await this.setRedisState(sessionId, state);
			return state.sequenceNumber;
		}

		const state = this.memoryStore.get(sessionId);
		if (!state) return 0;
		state.sequenceNumber += 1;
		return state.sequenceNumber;
	}

	/**
	 * Buffer a chunk for reconnection replay
	 */
	async bufferChunk(sessionId: ChatSessionId, chunk: BufferedChunk): Promise<void> {
		if (this.useFerricStore) {
			const chunks = await this.getFerricStoreChunks(sessionId);
			chunks.push(chunk);

			while (chunks.length > this.chatHubConfig.maxBufferedChunks) {
				chunks.shift();
			}

			await this.setFerricStoreChunks(sessionId, chunks);
		} else if (this.useRedis) {
			const chunks = await this.getRedisChunks(sessionId);
			chunks.push(chunk);

			while (chunks.length > this.chatHubConfig.maxBufferedChunks) {
				chunks.shift();
			}

			await this.setRedisChunks(sessionId, chunks);
		} else {
			let chunks = this.chunkBuffer.get(sessionId);
			if (!chunks) {
				chunks = [];
				this.chunkBuffer.set(sessionId, chunks);
			}

			chunks.push(chunk);

			while (chunks.length > this.chatHubConfig.maxBufferedChunks) {
				chunks.shift();
			}
		}
	}

	/**
	 * Get chunks after a specific sequence number for reconnection replay
	 */
	async getChunksAfter(
		sessionId: ChatSessionId,
		lastReceivedSequence: number,
	): Promise<BufferedChunk[]> {
		let chunks: BufferedChunk[];

		if (this.useFerricStore) {
			chunks = await this.getFerricStoreChunks(sessionId);
		} else if (this.useRedis) {
			chunks = await this.getRedisChunks(sessionId);
		} else {
			chunks = this.chunkBuffer.get(sessionId) ?? [];
		}

		return chunks.filter((chunk) => chunk.sequenceNumber > lastReceivedSequence);
	}

	/**
	 * End a stream and clean up state
	 */
	async endStream(sessionId: ChatSessionId): Promise<void> {
		if (this.useFerricStore) {
			await this.deleteFerricStoreState(sessionId);
			await this.deleteFerricStoreChunks(sessionId);
		} else if (this.useRedis) {
			await this.deleteRedisState(sessionId);
			await this.deleteRedisChunks(sessionId);
		} else {
			this.memoryStore.delete(sessionId);
			this.chunkBuffer.delete(sessionId);
			this.cancelCleanup(sessionId);
		}

		this.logger.debug(`Ended stream for session ${sessionId}`);
	}

	/**
	 * Clean up on shutdown
	 */
	@OnShutdown()
	shutdown(): void {
		// Clear all cleanup timers
		for (const timer of this.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		this.cleanupTimers.clear();
		this.memoryStore.clear();
		this.chunkBuffer.clear();

		// Disconnect Redis client
		if (this.redisClient) {
			this.redisClient.disconnect();
		}
		if (this.ferricStoreClient) {
			void this.ferricStoreClient
				.then(async (client) => await client.close())
				.catch((error) => {
					this.logger.warn('Failed to close FerricStore chat stream state client', { error });
				});
		}
	}

	private getStateKey(sessionId: ChatSessionId): string {
		return `${this.redisPrefix}state:${sessionId}`;
	}

	private getChunksKey(sessionId: ChatSessionId): string {
		return `${this.redisPrefix}chunks:${sessionId}`;
	}

	private async getFerricStoreState(sessionId: ChatSessionId): Promise<StreamState | null> {
		if (!this.ferricStoreClient) return null;

		try {
			const data = await (await this.ferricStoreClient).command('GET', this.getStateKey(sessionId));
			if (data == null) return null;
			return jsonParse<StreamState>(responseText(data));
		} catch (error) {
			this.logger.warn(`Failed to get FerricStore state for session ${sessionId}`, { error });
			return null;
		}
	}

	private async setFerricStoreState(sessionId: ChatSessionId, state: StreamState): Promise<void> {
		if (!this.ferricStoreClient) return;

		try {
			await (await this.ferricStoreClient).command(
				'SET',
				this.getStateKey(sessionId),
				jsonStringify(state),
				'EX',
				this.chatHubConfig.streamStateTtl,
			);
		} catch (error) {
			this.logger.error(`Failed to set FerricStore state for session ${sessionId}`, { error });
		}
	}

	private async deleteFerricStoreState(sessionId: ChatSessionId): Promise<void> {
		if (!this.ferricStoreClient) return;

		try {
			await (await this.ferricStoreClient).command('DEL', this.getStateKey(sessionId));
		} catch (error) {
			this.logger.error(`Failed to delete FerricStore state for session ${sessionId}`, { error });
		}
	}

	private async getFerricStoreChunks(sessionId: ChatSessionId): Promise<BufferedChunk[]> {
		if (!this.ferricStoreClient) return [];

		try {
			const data = await (await this.ferricStoreClient).command(
				'GET',
				this.getChunksKey(sessionId),
			);
			if (data == null) return [];
			return jsonParse<BufferedChunk[]>(responseText(data));
		} catch (error) {
			this.logger.error(`Failed to get FerricStore chunks for session ${sessionId}`, { error });
			return [];
		}
	}

	private async setFerricStoreChunks(
		sessionId: ChatSessionId,
		chunks: BufferedChunk[],
	): Promise<void> {
		if (!this.ferricStoreClient) return;

		try {
			await (await this.ferricStoreClient).command(
				'SET',
				this.getChunksKey(sessionId),
				jsonStringify(chunks),
				'EX',
				this.chatHubConfig.streamStateTtl,
			);
		} catch (error) {
			this.logger.error(`Failed to set FerricStore chunks for session ${sessionId}`, { error });
		}
	}

	private async deleteFerricStoreChunks(sessionId: ChatSessionId): Promise<void> {
		if (!this.ferricStoreClient) return;

		try {
			await (await this.ferricStoreClient).command('DEL', this.getChunksKey(sessionId));
		} catch (error) {
			this.logger.error(`Failed to delete FerricStore chunks for session ${sessionId}`, { error });
		}
	}

	private async getRedisState(sessionId: ChatSessionId): Promise<StreamState | null> {
		if (!this.redisClient) return null;

		try {
			const data = await this.redisClient.get(this.getStateKey(sessionId));
			if (!data) return null;
			return jsonParse<StreamState>(data);
		} catch (error) {
			this.logger.warn(`Failed to get Redis state for session ${sessionId}`, { error });
			return null;
		}
	}

	private async setRedisState(sessionId: ChatSessionId, state: StreamState): Promise<void> {
		if (!this.redisClient) return;

		try {
			await this.redisClient.set(
				this.getStateKey(sessionId),
				jsonStringify(state),
				'EX',
				this.chatHubConfig.streamStateTtl,
			);
		} catch (error) {
			this.logger.error(`Failed to set Redis state for session ${sessionId}`, { error });
		}
	}

	private async deleteRedisState(sessionId: ChatSessionId): Promise<void> {
		if (!this.redisClient) return;

		try {
			await this.redisClient.del(this.getStateKey(sessionId));
		} catch (error) {
			this.logger.error(`Failed to delete Redis state for session ${sessionId}`, { error });
		}
	}

	private async getRedisChunks(sessionId: ChatSessionId): Promise<BufferedChunk[]> {
		if (!this.redisClient) return [];

		try {
			const data = await this.redisClient.get(this.getChunksKey(sessionId));
			if (!data) return [];
			return jsonParse<BufferedChunk[]>(data);
		} catch (error) {
			this.logger.error(`Failed to get Redis chunks for session ${sessionId}`, { error });
			return [];
		}
	}

	private async setRedisChunks(sessionId: ChatSessionId, chunks: BufferedChunk[]): Promise<void> {
		if (!this.redisClient) return;

		try {
			await this.redisClient.set(
				this.getChunksKey(sessionId),
				jsonStringify(chunks),
				'EX',
				this.chatHubConfig.streamStateTtl,
			);
		} catch (error) {
			this.logger.error(`Failed to set Redis chunks for session ${sessionId}`, { error });
		}
	}

	private async deleteRedisChunks(sessionId: ChatSessionId): Promise<void> {
		if (!this.redisClient) return;

		try {
			await this.redisClient.del(this.getChunksKey(sessionId));
		} catch (error) {
			this.logger.error(`Failed to delete Redis chunks for session ${sessionId}`, { error });
		}
	}

	private scheduleCleanup(sessionId: ChatSessionId): void {
		this.cancelCleanup(sessionId);

		const timer = setTimeout(() => {
			this.memoryStore.delete(sessionId);
			this.chunkBuffer.delete(sessionId);
			this.cleanupTimers.delete(sessionId);
			this.logger.debug(`Cleaned up expired stream for session ${sessionId}`);
		}, this.cleanupDelayMs);

		this.cleanupTimers.set(sessionId, timer);
	}

	private cancelCleanup(sessionId: ChatSessionId): void {
		const timer = this.cleanupTimers.get(sessionId);
		if (timer) {
			clearTimeout(timer);
			this.cleanupTimers.delete(sessionId);
		}
	}
}
