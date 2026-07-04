import type { Logger } from '@n8n/backend-common';
import type { GlobalConfig } from '@n8n/config';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import { EventEmitter } from 'node:events';

import type {
	Job,
	JobData,
	JobId,
	JobMessage,
	JobOptions,
	JobQueue,
	JobStatus,
} from '../scaling.types';
import {
	createFerricFlowWorkflowRecord,
	createFerricStoreClient,
	readNewFerricFlowWorkflowRecords,
	seedSeenFerricFlowWorkflowRecords,
	type FerricFlowRecord,
	type FerricStoreClient,
} from './ferricstore-sdk';
import { FERRICFLOW_WORKFLOW_STATES } from './scaling-workflows';

type Processor = (job: Job) => Promise<void>;

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'canceled']);

type QueueSignal =
	| {
			kind: 'progress';
			jobId: JobId;
			message: JobMessage;
	  }
	| {
			kind: 'completed';
			jobId: JobId;
			result: unknown;
	  }
	| {
			kind: 'failed';
			jobId: JobId;
			failedReason: string;
	  };

export class FerricFlowQueue extends EventEmitter implements JobQueue {
	readonly client = {
		ping: async () => await this.flow.command('PING'),
	};

	private paused = false;

	private closed = false;

	private readonly seenQueueSignalIds = new Set<string>();

	private readonly activeJobs = new Map<JobId, FerricFlowJob>();

	private constructor(
		private readonly flow: FerricStoreClient,
		private readonly events: FerricStoreClient,
		private readonly globalConfig: GlobalConfig,
		private readonly logger: Logger,
	) {
		super();
	}

	static async create(globalConfig: GlobalConfig, logger: Logger) {
		const flow = await createFerricStoreClient(
			globalConfig.queue.ferricflow.sdkPath,
			globalConfig.queue.ferricflow.url,
			'n8n-ferricflow-queue',
		);
		const events = await createFerricStoreClient(
			globalConfig.queue.ferricflow.sdkPath,
			globalConfig.queue.ferricflow.url,
			'n8n-ferricflow-execution-signals',
		);

		const queue = new FerricFlowQueue(flow, events, globalConfig, logger);
		await queue.startExecutionSignalPolling();

		return queue;
	}

	process(_name: string, concurrency: number, handler: Processor) {
		for (let workerIndex = 0; workerIndex < concurrency; workerIndex += 1) {
			void this.workerLoop(workerIndex, handler);
		}
	}

	async add(_name: string, data: JobData, options: JobOptions) {
		const partitionKey = this.partitionKeyForExecution(data.executionId);

		await this.flow.create(data.executionId, {
			idempotent: true,
			partitionKey,
			payload: data,
			priority: this.toFerricPriority(options.priority),
			state: this.globalConfig.queue.ferricflow.queuedState,
			type: this.globalConfig.queue.ferricflow.type,
		});

		return new FerricFlowJob(
			this,
			data.executionId,
			data,
			partitionKey,
			this.globalConfig.queue.ferricflow.queuedState,
		);
	}

	async getJob(jobId: JobId) {
		const id = String(jobId);
		const partitionKey = this.partitionKeyForExecution(id);
		const record = await this.flow.get(id, { full: true, partitionKey });
		if (!record) return null;

		return this.jobFromRecord(record);
	}

	async getJobs(statuses: JobStatus[]) {
		const records = await this.flow.list(this.globalConfig.queue.ferricflow.type, {
			count: this.globalConfig.executions.queueRecovery.batchSize,
		});

		return records
			.filter((record) => this.matchesStatuses(record, statuses))
			.map((record) => this.jobFromRecord(record));
	}

	async getJobCounts() {
		const records = await this.flow.list(this.globalConfig.queue.ferricflow.type, { count: 1000 });
		let waiting = 0;
		let active = 0;

		for (const record of records) {
			if (
				record.state === this.globalConfig.queue.ferricflow.queuedState &&
				record.runState == null
			) {
				waiting += 1;
			} else if (!TERMINAL_STATES.has(record.state)) {
				active += 1;
			}
		}

		return { active, waiting };
	}

	async pause() {
		this.paused = true;
	}

	async close() {
		this.paused = true;
		this.closed = true;
		await this.flow.close();
		await this.events.close();
	}

	override on(event: string, listener: (...args: unknown[]) => void): this {
		super.on(event, listener);
		return this;
	}

	async emitProgress(jobId: JobId, message: JobMessage) {
		this.emit('global:progress', jobId, message);
		await this.publishExecutionSignal({ kind: 'progress', jobId, message });
	}

	async completeJob(job: FerricFlowJob, result: unknown) {
		if (!job.leaseToken || job.fencingToken == null) return;

		await this.flow.complete(String(job.id), {
			fencingToken: job.fencingToken,
			leaseToken: job.leaseToken,
			partitionKey: job.partitionKey,
			result,
			ttlMs: this.terminalTtlMs(),
		});

		await this.publishExecutionSignal({ kind: 'completed', jobId: job.id, result });
		this.emit('global:completed', job.id, result);
	}

	async failJob(job: FerricFlowJob, error: Error) {
		if (!job.leaseToken || job.fencingToken == null) return;

		await this.flow.fail(String(job.id), {
			error: { message: error.message, name: error.name, stack: error.stack },
			fencingToken: job.fencingToken,
			leaseToken: job.leaseToken,
			partitionKey: job.partitionKey,
			ttlMs: this.terminalTtlMs(),
		});

		await this.publishExecutionSignal({
			kind: 'failed',
			jobId: job.id,
			failedReason: error.message,
		});
		this.emit('global:failed', job.id, error.message);
	}

	async removeJob(job: FerricFlowJob) {
		const record = await this.flow.get(String(job.id), {
			full: true,
			partitionKey: job.partitionKey,
		});
		if (!record) return;

		await this.flow.cancel(String(job.id), {
			fencingToken: record.fencingToken,
			partitionKey: job.partitionKey,
			reason: 'Stopped by n8n',
			ttlMs: this.terminalTtlMs(),
		});
	}

	private async workerLoop(workerIndex: number, handler: Processor) {
		let idleSleepMs = this.globalConfig.queue.ferricflow.pollIntervalMs;
		const maxIdleSleepMs = this.globalConfig.queue.ferricflow.maxPollIntervalMs;

		while (!this.paused) {
			const jobs = await this.claimOne(workerIndex);

			if (jobs.length === 0) {
				await sleep(idleSleepMs);
				idleSleepMs = Math.min(maxIdleSleepMs, idleSleepMs * 2);
				continue;
			}

			idleSleepMs = this.globalConfig.queue.ferricflow.pollIntervalMs;

			for (const job of jobs) {
				this.activeJobs.set(job.id, job);
				const stopRenewingLease = this.startLeaseRenewal(job);
				try {
					const result = await handler(job);
					await this.completeJob(job, result);
				} catch (error) {
					const normalized = ensureError(error);
					try {
						await this.failJob(job, normalized);
					} catch (failError) {
						this.logger.error('Failed to mark FerricFlow job as failed', {
							error: ensureError(failError),
							executionId: job.data.executionId,
							jobId: job.id,
						});
					}
				} finally {
					stopRenewingLease();
					this.activeJobs.delete(job.id);
				}
			}
		}
	}

	private async claimOne(workerIndex: number) {
		const records = await this.flow.claimDue(this.globalConfig.queue.ferricflow.type, {
			leaseMs: this.globalConfig.queue.ferricflow.leaseMs,
			limit: 1,
			partitionKey: this.queuePartitionKey(),
			payload: true,
			reclaimExpired: true,
			state: this.globalConfig.queue.ferricflow.queuedState,
			worker: `n8n-ferricflow-${process.pid}-${workerIndex}`,
		});

		return records.map((record) => this.jobFromRecord(record));
	}

	private jobFromRecord(record: FerricFlowRecord) {
		const data = isJobData(record.payload)
			? record.payload
			: ({
					executionId: record.id,
					loadStaticData: false,
					workflowId: '',
				} satisfies JobData);

		return new FerricFlowJob(
			this,
			record.id,
			data,
			record.partitionKey ?? this.partitionKeyForExecution(record.id),
			this.globalConfig.queue.ferricflow.queuedState,
			record.leaseToken,
			record.fencingToken,
			record.state,
			record.result,
			record.error,
			record.runState,
		);
	}

	private matchesStatuses(record: FerricFlowRecord, statuses: JobStatus[]) {
		const isWaiting =
			record.state === this.globalConfig.queue.ferricflow.queuedState && record.runState == null;

		if (statuses.includes('waiting') && isWaiting) return true;

		if (statuses.includes('active') && !isWaiting && !TERMINAL_STATES.has(record.state)) {
			return true;
		}

		if (statuses.includes('failed') && record.state === 'failed') return true;
		if (statuses.includes('completed') && record.state === 'completed') return true;

		return false;
	}

	private partitionKeyForExecution(_executionId: string) {
		return this.queuePartitionKey();
	}

	private queuePartitionKey() {
		return `${this.globalConfig.queue.ferricflow.prefix}:n8n:executions`;
	}

	private terminalTtlMs() {
		return 7 * 24 * 60 * 60 * 1000;
	}

	private toFerricPriority(priority = 100) {
		if (priority <= 50) return 2;
		if (priority <= 100) return 1;
		return 0;
	}

	private executionSignalType() {
		return `${this.globalConfig.queue.ferricflow.type}_signal`;
	}

	private executionSignalPartition() {
		return `${this.globalConfig.queue.ferricflow.prefix}:n8n:ferricflow:execution-signals`;
	}

	private async startExecutionSignalPolling() {
		await seedSeenFerricFlowWorkflowRecords(this.events, this.executionSignalQuery());
		void this.executionSignalLoop();
	}

	private async executionSignalLoop() {
		while (!this.closed) {
			try {
				const signals = await readNewFerricFlowWorkflowRecords<QueueSignal>(
					this.events,
					this.executionSignalQuery(),
				);

				for (const signal of signals) {
					this.emitQueueSignal(signal.payload);
				}
			} catch (error) {
				if (this.closed) return;

				this.logger.error('Failed reading FerricFlow execution signal records', {
					error: ensureError(error),
				});
				await sleep(1000);
			}

			await sleep(this.globalConfig.queue.ferricflow.pollIntervalMs);
		}
	}

	private emitQueueSignal(signal: QueueSignal) {
		switch (signal.kind) {
			case 'progress':
				this.emit('global:progress', signal.jobId, signal.message);
				break;
			case 'completed':
				this.emit('global:completed', signal.jobId, signal.result);
				break;
			case 'failed':
				this.emit('global:failed', signal.jobId, signal.failedReason);
				break;
		}
	}

	private async publishExecutionSignal(signal: QueueSignal) {
		await createFerricFlowWorkflowRecord(this.flow, {
			partitionKey: this.executionSignalPartition(),
			payload: signal,
			state: FERRICFLOW_WORKFLOW_STATES.recorded,
			type: this.executionSignalType(),
		});
	}

	private executionSignalQuery() {
		return {
			partitionKey: this.executionSignalPartition(),
			seen: this.seenQueueSignalIds,
			state: FERRICFLOW_WORKFLOW_STATES.recorded,
			type: this.executionSignalType(),
		};
	}

	private startLeaseRenewal(job: FerricFlowJob) {
		if (!job.leaseToken || job.fencingToken == null) return () => {};

		const renewEveryMs = Math.max(1000, Math.floor(this.globalConfig.queue.ferricflow.leaseMs / 2));
		const timer = setInterval(async () => {
			try {
				await this.flow.extendLease(String(job.id), {
					fencingToken: job.fencingToken,
					leaseMs: this.globalConfig.queue.ferricflow.leaseMs,
					leaseToken: job.leaseToken,
					partitionKey: job.partitionKey,
				});
			} catch (error) {
				this.logger.error('Failed to extend FerricFlow job lease', {
					error: ensureError(error),
					executionId: job.data.executionId,
					jobId: job.id,
				});
			}
		}, renewEveryMs);

		timer.unref?.();

		return () => clearInterval(timer);
	}
}

class FerricFlowJob implements Job {
	constructor(
		private readonly queue: FerricFlowQueue,
		readonly id: JobId,
		readonly data: JobData,
		readonly partitionKey: string,
		private readonly queuedState: string,
		readonly leaseToken?: Buffer,
		readonly fencingToken?: number,
		private readonly state?: string,
		private readonly result?: unknown,
		private readonly error?: unknown,
		private readonly runState?: string,
	) {}

	async progress(message: JobMessage) {
		await this.queue.emitProgress(this.id, message);
	}

	async finished() {
		for (;;) {
			const latest = await this.queue.getJob(this.id);
			const state = latest instanceof FerricFlowJob ? latest.state : undefined;

			if (state === 'completed') return latest instanceof FerricFlowJob ? latest.result : undefined;
			if (state === 'failed' || state === 'cancelled' || state === 'canceled') {
				const error = latest instanceof FerricFlowJob ? latest.error : undefined;
				throw new Error(
					error instanceof Error
						? error.message
						: `FerricFlow job ${String(this.id)} finished in state ${state}`,
				);
			}

			await sleep(250);
		}
	}

	async isActive() {
		const latest = await this.queue.getJob(this.id);
		if (!(latest instanceof FerricFlowJob)) return false;

		return latest.state !== undefined && !latest.isWaiting() && !TERMINAL_STATES.has(latest.state);
	}

	async remove() {
		await this.queue.removeJob(this);
	}

	private isWaiting() {
		return this.state === this.queuedState && this.runState == null;
	}
}

function isJobData(value: unknown): value is JobData {
	return (
		typeof value === 'object' &&
		value !== null &&
		'executionId' in value &&
		'workflowId' in value &&
		'loadStaticData' in value
	);
}

async function sleep(ms: number) {
	await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
