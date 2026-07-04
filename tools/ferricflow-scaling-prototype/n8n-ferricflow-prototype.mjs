#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sdkPath =
	process.env.FERRICFLOW_SDK_PATH ??
	resolve(here, '../../../ferricstore-typescript/dist/index.js');

const {
	FerricStoreClient,
	JsonCodec,
	WorkflowClient,
	complete,
	fail,
	retry,
	transition,
} = await import(pathToFileURL(sdkPath).href);

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
	const arg = process.argv[i];
	if (!arg.startsWith('--')) continue;

	const [rawKey, rawValue] = arg.slice(2).split('=', 2);
	const value = rawValue ?? process.argv[i + 1];
	args.set(rawKey, value);
	if (rawValue == null && value != null && !value.startsWith('--')) i += 1;
}

const mode = args.get('mode') ?? 'success';
const workflowId = args.get('workflow-id') ?? 'workflow-demo';
const executionId = args.get('execution-id') ?? `exec-${Date.now()}`;
const workerId = args.get('worker') ?? 'ferricflow-worker-1';
const ferricstoreUrl = process.env.FERRICSTORE_URL ?? 'ferric://127.0.0.1:6388';
const partitionKey = args.get('partition-key') ?? `execution:${executionId}`;

if (!['success', 'retry-once', 'fail'].includes(mode)) {
	console.error(`Unsupported --mode "${mode}". Use success, retry-once, or fail.`);
	process.exit(2);
}

const flow = await FerricStoreClient.fromUrl(ferricstoreUrl, {
	codec: new JsonCodec(),
});

const n8nExecution = new WorkflowClient(flow).workflow({
	type: 'n8n_execution_prototype',
	initialState: 'queued',
	worker: workerId,
});

function logState(state, execution, extra = {}) {
	console.log(
		JSON.stringify(
			{
				state,
				executionId: execution.executionId,
				workflowId: execution.workflowId,
				workerId,
				...extra,
			},
			null,
			2,
		),
	);
}

function jobDataFrom(ctx) {
	if (typeof ctx.payload !== 'object' || ctx.payload == null) {
		throw new Error(`Expected n8n JobData payload for ${ctx.id}`);
	}

	return ctx.payload;
}

function recordSummary(record) {
	if (record == null) return undefined;

	return {
		id: record.id,
		type: record.type,
		state: record.state,
		runState: record.runState,
		partitionKey: record.partitionKey,
		payload: record.payload,
		version: record.version,
		fencingToken: record.fencingToken,
	};
}

n8nExecution.state('queued', async (ctx) => {
	const jobData = jobDataFrom(ctx);
	logState('queued', jobData, { event: 'worker claimed queued execution' });

	return transition('loading_execution', {
		payload: jobData,
	});
});

n8nExecution.state('loading_execution', async (ctx) => {
	const jobData = jobDataFrom(ctx);
	logState('loading_execution', jobData, {
		event: 'simulate ExecutionPersistence.findSingleExecution(executionId)',
	});

	if (mode === 'fail') {
		return fail({
			error: {
				message: 'Simulated n8n execution lookup failure',
				executionId: jobData.executionId,
			},
			ttlMs: 300_000,
		});
	}

	return transition('executing', {
		payload: jobData,
	});
});

n8nExecution.state('executing', async (ctx) => {
	const jobData = jobDataFrom(ctx);
	logState('executing', jobData, {
		event: 'simulate JobProcessor.processJob(job)',
		retried: jobData.retried === true,
	});

	if (mode === 'retry-once' && jobData.retried !== true) {
		return retry({
			error: {
				message: 'Simulated transient worker error',
				executionId: jobData.executionId,
			},
			payload: {
				...jobData,
				retried: true,
			},
			runAtMs: Date.now() + 50,
		});
	}

	return complete({
		result: {
			success: true,
			status: 'success',
			lastNodeExecuted: 'Mock n8n node',
			stoppedAt: new Date().toISOString(),
		},
		ttlMs: 300_000,
	});
});

const jobData = {
	workflowId,
	executionId,
	loadStaticData: true,
	streamingEnabled: false,
	projectId: 'project-demo',
	projectName: 'FerricFlow prototype',
	queuePriority: mode === 'retry-once' ? 50 : 100,
};

console.log(
	JSON.stringify(
		{
			event: 'main enqueues execution as FerricFlow record',
			ferricstoreUrl,
			type: n8nExecution.type,
			executionId,
			partitionKey,
			mode,
		},
		null,
		2,
	),
);

await n8nExecution.start(executionId, {
	idempotent: true,
	partitionKey,
	payload: jobData,
});

let finalRecord;
for (let tick = 0; tick < 12; tick += 1) {
	const result = await n8nExecution
		.worker({
			batchSize: 1,
			states: ['queued', 'loading_execution', 'executing'],
			worker: workerId,
			partitionKey,
		})
		.runOnce();

	finalRecord = await n8nExecution.get(executionId, {
		partitionKey,
		full: true,
	});

	console.log(
		JSON.stringify(
			{
				event: 'worker tick',
				tick,
				claimed: result.claimed,
				applied: result.applied,
				state: finalRecord?.state,
				runState: finalRecord?.runState,
			},
			null,
			2,
		),
	);

	if (finalRecord?.state === 'completed' || finalRecord?.state === 'failed') break;
	await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
}

const history = await n8nExecution.history(executionId, { partitionKey });

console.log(
	JSON.stringify(
		{
			event: 'final FerricFlow record',
			record: recordSummary(finalRecord),
			historyEvents: history.length,
		},
		null,
		2,
	),
);

await flow.close();
