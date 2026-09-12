#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const defaultSdkPath = resolve(here, '../../../ferricstore-typescript/dist/index.js');
const sdkPath = process.env.FERRICFLOW_SDK_PATH ?? defaultSdkPath;
const requireSdk = createRequire(import.meta.url);
const requireCliSdk = createRequire(resolve(repoRoot, 'packages/cli/package.json'));
const ferricstoreUrl =
	process.env.FERRICSTORE_URL ??
	process.env.N8N_FERRICFLOW_URL ??
	'ferric://127.0.0.1:6388';

let FerricStoreClient;
let JsonCodec;
let WorkflowClient;
let complete;
let fail;
let retry;
let transition;

const args = parseArgs(process.argv.slice(2));
const mode = args.get('mode') ?? 'smoke';
const runId = args.get('run-id') ?? `n8n-user-flow-${isoForPath(new Date())}-${randomUUID()}`;
const durationSeconds = intArg(args, 'duration-seconds', mode === 'soak' ? 24 * 60 * 60 : 300);
const maxJourneys = intArg(args, 'max-journeys', mode === 'debug' ? 1 : Number.MAX_SAFE_INTEGER);
const journeysPerMinute = numberArg(args, 'journeys-per-minute', mode === 'soak' ? 3 : 12);
const sampleIntervalSeconds = intArg(args, 'sample-interval-seconds', 30);
const scenarioFilter = args.get('scenario') ?? 'all';
const workerId = args.get('worker') ?? `n8n-sim-worker-${process.pid}`;
const prefix = args.get('prefix') ?? 'n8n-sim';
const logRoot = resolve(args.get('log-dir') ?? 'logs/ferricflow-user-flow-simulator', runId);
const failFast = boolArg(args, 'fail-fast', false);
const debug = mode === 'debug' || boolArg(args, 'debug', false);
const printEvery = intArg(args, 'print-every', 10);

if (!['smoke', 'soak', 'debug'].includes(mode)) {
	console.error(`Unsupported --mode "${mode}". Use smoke, soak, or debug.`);
	process.exit(2);
}

mkdirSync(logRoot, { recursive: true });

const logs = {
	events: createJsonlWriter(resolve(logRoot, 'events.jsonl')),
	errors: createJsonlWriter(resolve(logRoot, 'errors.jsonl')),
	metrics: createJsonlWriter(resolve(logRoot, 'metrics.jsonl')),
};

const metrics = {
	runId,
	mode,
	ferricstoreUrl,
	startedAt: new Date().toISOString(),
	endedAt: null,
	durationSeconds,
	journeysStarted: 0,
	journeysCompleted: 0,
	journeysCompletedWithErrors: 0,
	journeysAbandoned: 0,
	stepsOk: 0,
	stepsFailed: 0,
	expectedBusinessFailures: 0,
	errorsByScenario: {},
	errorsByStep: {},
	errorsByMessage: {},
	scenarioCounts: {},
	latencyMs: {},
	firstErrors: [],
	lastErrors: [],
	samples: [],
};

let client;
let executionWorkflow;
let stopped = false;

process.on('SIGINT', () => {
	stopped = true;
	logEvent('run_signal', { signal: 'SIGINT' });
});

process.on('SIGTERM', () => {
	stopped = true;
	logEvent('run_signal', { signal: 'SIGTERM' });
});

try {
	({
		FerricStoreClient,
		JsonCodec,
		WorkflowClient,
		complete,
		fail,
		retry,
		transition,
	} = await loadSdk());

	client = await FerricStoreClient.fromUrl(ferricstoreUrl, {
		codec: new JsonCodec(),
		nativeOptions: { clientName: `n8n-user-flow-simulator:${runId}` },
	});

	executionWorkflow = createExecutionWorkflow(client);

	logEvent('run_started', {
		mode,
		runId,
		ferricstoreUrl,
		logRoot,
		durationSeconds,
		maxJourneys,
		journeysPerMinute,
		sampleIntervalSeconds,
		scenarioFilter,
	});

	await runLoop();
} catch (error) {
	recordError({
		scenario: 'run',
		journeyId: runId,
		step: 'run_fatal',
		error,
		inputs: {
			mode,
			ferricstoreUrl,
			sdkPath,
			logRoot,
		},
	});
} finally {
	if (client) {
		try {
			await client.close();
		} catch (error) {
			recordError({
				scenario: 'run',
				journeyId: runId,
				step: 'client_close',
				error,
				inputs: {},
			});
		}
	}

	metrics.endedAt = new Date().toISOString();
	const summary = buildSummary();
	writeFileSync(resolve(logRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
	logEvent('run_finished', summary);

	for (const writer of Object.values(logs)) writer.end();

	console.log(JSON.stringify({ event: 'summary', logRoot, summary }, null, 2));
}

async function runLoop() {
	const deadline = Date.now() + durationSeconds * 1000;
	let nextSampleAt = 0;
	const delayMs = Math.max(Math.floor(60_000 / Math.max(journeysPerMinute, 0.001)), 1);

	while (!stopped && Date.now() < deadline && metrics.journeysStarted < maxJourneys) {
		const journeyStarted = Date.now();
		const scenario = pickScenario();
		const journey = createJourney(scenario);

		metrics.journeysStarted += 1;
		increment(metrics.scenarioCounts, scenario);

		logEvent('journey_started', {
			scenario,
			journeyId: journey.id,
			vars: journey.vars,
		});

		const result = await runJourney(journey);

		if (result.status === 'completed') metrics.journeysCompleted += 1;
		if (result.status === 'completed_with_errors') metrics.journeysCompletedWithErrors += 1;
		if (result.status === 'abandoned') metrics.journeysAbandoned += 1;

		logEvent('journey_finished', {
			scenario,
			journeyId: journey.id,
			status: result.status,
			errorCount: result.errorCount,
			latencyMs: Date.now() - journeyStarted,
			vars: journey.vars,
		});

		if (Date.now() >= nextSampleAt) {
			await sampleMetrics('interval');
			nextSampleAt = Date.now() + sampleIntervalSeconds * 1000;
		}

		if (metrics.journeysStarted % printEvery === 0 || debug) {
			console.log(
				JSON.stringify({
					event: 'progress',
					runId,
					journeysStarted: metrics.journeysStarted,
					journeysCompleted: metrics.journeysCompleted,
					journeysCompletedWithErrors: metrics.journeysCompletedWithErrors,
					journeysAbandoned: metrics.journeysAbandoned,
					stepsOk: metrics.stepsOk,
					stepsFailed: metrics.stepsFailed,
					logRoot,
				}),
			);
		}

		const remainingDelay = delayMs - (Date.now() - journeyStarted);
		if (!debug && remainingDelay > 0) await sleep(remainingDelay);
	}

	await sampleMetrics('final');
}

async function runJourney(journey) {
	const beforeErrors = metrics.stepsFailed;

	await step(journey, 'seed_user_and_project', seedUserAndProject, {
		userId: journey.vars.userId,
		projectId: journey.vars.projectId,
	});

	await step(journey, 'cache_workflow_static_data', cacheWorkflowStaticData, {
		workflowId: journey.vars.workflowId,
	});

	await step(journey, 'register_worker_heartbeat', registerWorkerHeartbeat, {
		workerId,
	});

	await step(journey, 'store_chat_session_state', storeChatSessionState, {
		sessionId: journey.vars.chatSessionId,
	});

	await step(journey, 'enqueue_execution_flow', enqueueExecutionFlow, {
		executionId: journey.vars.executionId,
		outcome: journey.vars.outcome,
	});

	await step(journey, 'process_execution_flow', processExecutionFlow, {
		executionId: journey.vars.executionId,
		partitionKey: journey.vars.partitionKey,
	});

	await step(journey, 'verify_execution_flow', verifyExecutionFlow, {
		executionId: journey.vars.executionId,
		partitionKey: journey.vars.partitionKey,
		expectedOutcome: journey.vars.outcome,
	});

	await step(journey, 'publish_execution_signal', publishExecutionSignal, {
		executionId: journey.vars.executionId,
	});

	const errorCount = metrics.stepsFailed - beforeErrors;
	if (journey.abandoned) return { status: 'abandoned', errorCount };
	return { status: errorCount > 0 ? 'completed_with_errors' : 'completed', errorCount };
}

function createExecutionWorkflow(flowClient) {
	const workflow = new WorkflowClient(flowClient).workflow({
		type: `${prefix}_n8n_execution`,
		initialState: 'queued',
		worker: workerId,
	});

	workflow.state('queued', async (ctx) => {
		const job = requirePayloadObject(ctx, 'queued');
		logEvent('execution_worker_state', {
			journeyId: job.journeyId,
			scenario: job.scenario,
			step: 'queued',
			executionId: job.executionId,
			flowId: ctx.id,
			partitionKey: ctx.partitionKey,
		});

		return transition('loading_execution', { payload: job });
	});

	workflow.state('loading_execution', async (ctx) => {
		const job = requirePayloadObject(ctx, 'loading_execution');
		logEvent('execution_worker_state', {
			journeyId: job.journeyId,
			scenario: job.scenario,
			step: 'loading_execution',
			executionId: job.executionId,
			flowId: ctx.id,
			partitionKey: ctx.partitionKey,
		});

		const executionEnvelope = await safeCommand(job, 'worker_get_execution_envelope', 'GET', [
			key('execution', job.executionId),
		]);

		if (executionEnvelope == null) {
			return fail({
				error: {
					message: 'Execution envelope missing during worker load',
					executionId: job.executionId,
					job,
				},
				ttlMs: 24 * 60 * 60 * 1000,
			});
		}

		return transition('executing', { payload: job });
	});

	workflow.state('executing', async (ctx) => {
		const job = requirePayloadObject(ctx, 'executing');
		logEvent('execution_worker_state', {
			journeyId: job.journeyId,
			scenario: job.scenario,
			step: 'executing',
			executionId: job.executionId,
			flowId: ctx.id,
			partitionKey: ctx.partitionKey,
			outcome: job.outcome,
			retried: job.retried === true,
			retryAttempt: job.retryAttempt ?? 0,
		});

		if (job.outcome === 'retry_once' && job.retried !== true) {
			return retry({
				error: {
					message: 'Mock transient n8n node failure',
					executionId: job.executionId,
					node: 'HTTP Request',
					input: job,
				},
				payload: { ...job, retried: true },
				runAtMs: Date.now() + 100,
			});
		}

		if (job.outcome === 'retry_backoff') {
			const retryAttempt = Number(job.retryAttempt ?? 0);
			const retryPlan = [100, 250, 500];

			if (retryAttempt < retryPlan.length) {
				const nextAttempt = retryAttempt + 1;

				return retry({
					error: {
						message: 'Mock transient dependency outage with backoff',
						executionId: job.executionId,
						node: 'Payment Gateway',
						retryAttempt: nextAttempt,
						nextDelayMs: retryPlan[retryAttempt],
						input: job,
					},
					payload: {
						...job,
						retryAttempt: nextAttempt,
						retryHistory: [
							...(Array.isArray(job.retryHistory) ? job.retryHistory : []),
							{
								at: new Date().toISOString(),
								attempt: nextAttempt,
								delayMs: retryPlan[retryAttempt],
								reason: 'payment_gateway_timeout',
							},
						],
					},
					runAtMs: Date.now() + retryPlan[retryAttempt],
				});
			}
		}

		if (job.outcome === 'business_fail') {
			metrics.expectedBusinessFailures += 1;
			return fail({
				error: {
					message: 'Mock expected workflow business failure',
					reason: 'payment_declined',
					executionId: job.executionId,
					userId: job.userId,
					workflowId: job.workflowId,
				},
				ttlMs: 24 * 60 * 60 * 1000,
			});
		}

		return complete({
			result: {
				success: true,
				status: 'success',
				executionId: job.executionId,
				workflowId: job.workflowId,
				lastNodeExecuted: 'Mock FerricStore Checkout Node',
				retryAttempt: job.retryAttempt ?? 0,
				retryHistory: Array.isArray(job.retryHistory) ? job.retryHistory : [],
				data: {
					orderId: job.orderId,
					total: job.total,
					items: job.items,
				},
				stoppedAt: new Date().toISOString(),
			},
			ttlMs: 24 * 60 * 60 * 1000,
		});
	});

	return workflow;
}

async function seedUserAndProject(journey, inputs) {
	const user = {
		id: inputs.userId,
		email: `${inputs.userId}@example.test`,
		password: `mock-password-${journey.id}`,
		tenantId: journey.vars.tenantId,
		projectId: inputs.projectId,
		createdAt: new Date().toISOString(),
	};

	await client.command('SET', key('user', user.id), JSON.stringify(user), 'EX', 24 * 60 * 60);
	await client.command('HSET', key('project', inputs.projectId), 'ownerId', user.id, 'name', 'Soak Project');
	await client.command('SADD', key('project-users', inputs.projectId), user.id);

	return { user };
}

async function cacheWorkflowStaticData(journey, inputs) {
	const workflow = {
		id: inputs.workflowId,
		name: 'Mock Checkout Workflow',
		active: true,
		nodes: ['Webhook', 'Set', 'FerricStore Checkout Node', 'Respond to Webhook'],
		credentials: {
			ferricstore: {
				url: ferricstoreUrl,
				apiKey: `mock-api-key-${journey.id}`,
			},
		},
	};

	const cacheKey = key('workflow-static-data', inputs.workflowId);
	await client.command('SET', cacheKey, JSON.stringify(workflow), 'EX', 60 * 60);
	const cached = await client.command('GET', cacheKey);

	if (String(cached) === '') throw new Error('workflow static data cache returned empty value');

	return { workflow, cached };
}

async function registerWorkerHeartbeat(_journey, inputs) {
	const now = Date.now();
	const heartbeat = {
		workerId: inputs.workerId,
		pid: process.pid,
		host: 'local-simulator',
		queueBackend: 'ferricflow',
		cacheBackend: 'ferricstore',
		seenAt: now,
	};

	await client.command('SET', key('worker', inputs.workerId), JSON.stringify(heartbeat), 'EX', 120);
	await client.command('SADD', key('workers'), inputs.workerId);
	await client.command('EXPIRE', key('workers'), 120);

	return { heartbeat };
}

async function storeChatSessionState(journey, inputs) {
	const state = {
		sessionId: inputs.sessionId,
		userId: journey.vars.userId,
		executionId: journey.vars.executionId,
		status: 'streaming',
		chunks: [
			{ index: 0, text: 'User asked for checkout status' },
			{ index: 1, text: 'Assistant is checking FerricFlow execution state' },
		],
	};

	await client.command('SET', key('chat-state', inputs.sessionId), JSON.stringify(state), 'EX', 3600);
	await client.command('SET', key('chat-chunks', inputs.sessionId), JSON.stringify(state.chunks), 'EX', 3600);

	return { state };
}

async function enqueueExecutionFlow(journey, inputs) {
	const envelope = {
		journeyId: journey.id,
		scenario: journey.scenario,
		userId: journey.vars.userId,
		projectId: journey.vars.projectId,
		workflowId: journey.vars.workflowId,
		executionId: inputs.executionId,
		orderId: journey.vars.orderId,
		partitionKey: journey.vars.partitionKey,
		outcome: inputs.outcome,
		total: journey.vars.total,
		items: journey.vars.items,
		loadStaticData: true,
		streamingEnabled: journey.scenario === 'chat_checkout',
		queuedAt: new Date().toISOString(),
	};

	await client.command('SET', key('execution', inputs.executionId), JSON.stringify(envelope), 'EX', 86400);

	await executionWorkflow.start(inputs.executionId, {
		idempotent: true,
		partitionKey: journey.vars.partitionKey,
		payload: envelope,
	});

	return { envelope };
}

async function processExecutionFlow(journey, inputs) {
	let finalRecord;
	const ticks = [];

	for (let tick = 0; tick < 40; tick += 1) {
		const result = await executionWorkflow
			.worker({
				batchSize: 1,
				states: ['queued', 'loading_execution', 'executing'],
				worker: workerId,
				partitionKey: inputs.partitionKey,
			})
			.runOnce();

		finalRecord = await executionWorkflow.get(inputs.executionId, {
			partitionKey: inputs.partitionKey,
			full: true,
		});

		ticks.push({
			tick,
			claimed: result.claimed,
			applied: result.applied,
			state: finalRecord?.state,
			runState: finalRecord?.runState,
		});

		if (finalRecord?.state === 'completed' || finalRecord?.state === 'failed') break;
		await sleep(100);
	}

	if (!finalRecord) throw new Error('execution flow was not readable after worker ticks');

	return { finalRecord: recordSummary(finalRecord), ticks };
}

async function verifyExecutionFlow(journey, inputs) {
	const record = await executionWorkflow.get(inputs.executionId, {
		partitionKey: inputs.partitionKey,
		full: true,
	});

	const history = await executionWorkflow.history(inputs.executionId, {
		partitionKey: inputs.partitionKey,
	});

	const expectedTerminal = inputs.expectedOutcome === 'business_fail' ? 'failed' : 'completed';
	if (record?.state !== expectedTerminal) {
		throw new Error(
			`execution ended in ${record?.state ?? 'missing'} but expected ${expectedTerminal}`,
		);
	}

	if (!Array.isArray(history) || history.length === 0) {
		throw new Error('execution history is empty after terminal state');
	}

	if (inputs.expectedOutcome === 'retry_once') {
		const maxAttempts = maxHistoryAttempts(history);
		if (maxAttempts < 1) {
			throw new Error(`expected execution history to reach at least attempt 1, got ${maxAttempts}`);
		}
	}

	if (inputs.expectedOutcome === 'retry_backoff') {
		const maxAttempts = maxHistoryAttempts(history);
		const errorRefCount = countHistoryEntriesWithErrorRef(history);
		const terminalData = flowTerminalData(record);
		const retryAttempt = Number(terminalData?.retryAttempt ?? -1);
		const retryHistory = Array.isArray(terminalData?.retryHistory) ? terminalData.retryHistory : [];
		const retryDelays = retryHistory.map((entry) => Number(entry?.delayMs));

		if (maxAttempts < 3) {
			throw new Error(`expected execution history to reach at least attempt 3, got ${maxAttempts}`);
		}
		if (errorRefCount < 1) {
			throw new Error('expected execution history to include retry error references');
		}
		if (retryAttempt !== 3) throw new Error(`expected retryAttempt 3, got ${retryAttempt}`);
		if (retryHistory.length !== 3) {
			throw new Error(`expected retryHistory length 3, got ${retryHistory.length}`);
		}
		if (retryDelays.join(',') !== '100,250,500') {
			throw new Error(`expected retry delays 100,250,500, got ${retryDelays.join(',')}`);
		}
	}

	const executionEnvelope = await client.command('GET', key('execution', inputs.executionId));
	if (String(executionEnvelope) === '') throw new Error('execution envelope missing after completion');

	return {
		record: recordSummary(record),
		historyEvents: history.length,
		maxHistoryAttempts: maxHistoryAttempts(history),
		expectedTerminal,
	};
}

function countHistoryEvents(history, eventName) {
	return history.filter((entry) => {
		return historyField(entry, 'event') === eventName || historyField(entry, 'Event') === eventName;
	}).length;
}

function flowTerminalData(record) {
	if (record?.result != null && typeof record.result === 'object') return record.result;
	if (record?.payload != null && typeof record.payload === 'object') return record.payload;
	return {};
}

function maxHistoryAttempts(history) {
	return Math.max(
		0,
		...history.map((entry) => {
			const attempts = Number.parseInt(historyField(entry, 'attempts'), 10);
			return Number.isFinite(attempts) ? attempts : 0;
		}),
	);
}

function countHistoryEntriesWithErrorRef(history) {
	return history.filter((entry) => historyField(entry, 'error_ref') !== '').length;
}

function historyField(entry, fieldName) {
	const fields = Array.isArray(entry) ? entry[1] : entry?.fields;
	if (fields == null || typeof fields !== 'object') return '';
	return bufferishToString(fields[fieldName]);
}

function bufferishToString(value) {
	if (value == null) return '';
	if (Buffer.isBuffer(value)) return value.toString('utf8');
	if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
	if (typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
		return Buffer.from(value.data).toString('utf8');
	}
	return String(value);
}

async function publishExecutionSignal(journey, inputs) {
	const signalId = `${inputs.executionId}:signal:${randomUUID()}`;
	const signalPayload = {
		journeyId: journey.id,
		executionId: inputs.executionId,
		workflowId: journey.vars.workflowId,
		event: 'job-finished',
		emittedAt: new Date().toISOString(),
	};

	await client.create(signalId, {
		idempotent: true,
		partitionKey: journey.vars.partitionKey,
		payload: signalPayload,
		state: 'recorded',
		type: `${prefix}_n8n_execution_signal`,
		retentionTtlMs: 24 * 60 * 60 * 1000,
	});

	const signals = await client.list(`${prefix}_n8n_execution_signal`, {
		count: 10,
		partitionKey: journey.vars.partitionKey,
		state: 'recorded',
	});

	return { signalId, signalCount: signals.length, signalPayload };
}

async function safeCommand(job, stepName, commandName, commandArgs) {
	try {
		return await client.command(commandName, ...commandArgs);
	} catch (error) {
		recordError({
			scenario: job.scenario,
			journeyId: job.journeyId,
			step: stepName,
			error,
			inputs: {
				commandName,
				commandArgs,
				job,
			},
		});
		return null;
	}
}

async function step(journey, name, fn, inputs) {
	const started = Date.now();

	try {
		const result = await fn(journey, inputs);
		const latencyMs = Date.now() - started;
		metrics.stepsOk += 1;
		observeLatency(journey.scenario, name, latencyMs);

		logEvent('step_ok', {
			scenario: journey.scenario,
			journeyId: journey.id,
			step: name,
			latencyMs,
			inputs,
			result: debug ? result : compactResult(result),
			vars: journey.vars,
		});

		return result;
	} catch (error) {
		metrics.stepsFailed += 1;
		observeLatency(journey.scenario, name, Date.now() - started);

		recordError({
			scenario: journey.scenario,
			journeyId: journey.id,
			step: name,
			error,
			inputs,
			vars: journey.vars,
		});

		if (failFast) {
			journey.abandoned = true;
			throw error;
		}

		return null;
	}
}

async function sampleMetrics(reason) {
	let ping = null;
	let dbsize = null;

	try {
		ping = await client.command('PING');
	} catch (error) {
		recordError({
			scenario: 'metrics',
			journeyId: runId,
			step: 'ping',
			error,
			inputs: { reason },
		});
	}

	try {
		dbsize = await client.command('DBSIZE');
	} catch (error) {
		recordError({
			scenario: 'metrics',
			journeyId: runId,
			step: 'dbsize',
			error,
			inputs: { reason },
		});
	}

	const memory = process.memoryUsage();
	const sample = {
		ts: new Date().toISOString(),
		runId,
		reason,
		journeysStarted: metrics.journeysStarted,
		journeysCompleted: metrics.journeysCompleted,
		journeysCompletedWithErrors: metrics.journeysCompletedWithErrors,
		journeysAbandoned: metrics.journeysAbandoned,
		stepsOk: metrics.stepsOk,
		stepsFailed: metrics.stepsFailed,
		expectedBusinessFailures: metrics.expectedBusinessFailures,
		ping: valueToString(ping),
		dbsize: valueToString(dbsize),
		process: {
			pid: process.pid,
			uptimeSeconds: Math.round(process.uptime()),
			rssMb: bytesToMb(memory.rss),
			heapUsedMb: bytesToMb(memory.heapUsed),
			heapTotalMb: bytesToMb(memory.heapTotal),
			externalMb: bytesToMb(memory.external),
			arrayBuffersMb: bytesToMb(memory.arrayBuffers),
		},
	};

	metrics.samples.push(sample);
	if (metrics.samples.length > 200) metrics.samples.shift();
	logs.metrics.write(sample);
}

function createJourney(scenario) {
	const id = `journey-${Date.now()}-${randomUUID()}`;
	const tenantId = `tenant-${randomInt(1, 6)}`;
	const projectId = `${tenantId}:project-${randomInt(1, 4)}`;
	const workflowId = `${projectId}:workflow-checkout`;
	const executionId = `${prefix}:exec:${id}`;
	const orderId = `${prefix}:order:${randomUUID()}`;
	const partitionKey = `${prefix}:partition:${tenantId}:${workflowId}`;
	const outcomes = {
		checkout_success: 'success',
		checkout_retry_once: 'retry_once',
		checkout_retry_backoff: 'retry_backoff',
		checkout_business_fail: 'business_fail',
		chat_checkout: 'success',
	};

	return {
		id,
		scenario,
		abandoned: false,
		vars: {
			runId,
			tenantId,
			userId: `${tenantId}:user-${randomInt(1, 100)}`,
			projectId,
			workflowId,
			executionId,
			orderId,
			chatSessionId: `${prefix}:chat:${randomUUID()}`,
			partitionKey,
			outcome: outcomes[scenario] ?? 'success',
			total: Number((randomInt(1200, 25_000) / 100).toFixed(2)),
			items: [
				{ sku: `sku-${randomInt(1, 20)}`, qty: randomInt(1, 3) },
				{ sku: `sku-${randomInt(21, 40)}`, qty: 1 },
			],
		},
	};
}

function pickScenario() {
	const scenarios =
		scenarioFilter === 'all'
			? [
					'checkout_success',
					'checkout_retry_once',
					'checkout_retry_backoff',
					'checkout_business_fail',
					'chat_checkout',
				]
			: scenarioFilter.split(',').map((scenario) => scenario.trim()).filter(Boolean);

	return scenarios[randomInt(0, scenarios.length - 1)] ?? 'checkout_success';
}

function requirePayloadObject(ctx, state) {
	if (typeof ctx.payload !== 'object' || ctx.payload == null || Array.isArray(ctx.payload)) {
		throw new Error(`Expected object payload for ${ctx.id} in state ${state}`);
	}

	return ctx.payload;
}

function recordError({ scenario, journeyId, step, error, inputs = {}, vars = {}, lastKnownState = {} }) {
	const errorRecord = {
		ts: new Date().toISOString(),
		runId,
		scenario,
		journeyId,
		step,
		errorClass: error?.constructor?.name ?? typeof error,
		errorMessage: error?.message ?? String(error),
		errorStack: error?.stack,
		errorValue: serialize(error),
		inputs: serialize(inputs),
		vars: serialize(vars),
		lastKnownState: serialize(lastKnownState),
	};

	increment(metrics.errorsByScenario, scenario);
	increment(metrics.errorsByStep, `${scenario}:${step}`);
	increment(metrics.errorsByMessage, errorRecord.errorMessage);

	if (metrics.firstErrors.length < 20) metrics.firstErrors.push(errorRecord);
	metrics.lastErrors.push(errorRecord);
	if (metrics.lastErrors.length > 50) metrics.lastErrors.shift();

	logs.errors.write(errorRecord);
	logEvent('step_error', errorRecord);
}

function logEvent(event, fields = {}) {
	logs.events.write({
		ts: new Date().toISOString(),
		runId,
		event,
		...serialize(fields),
	});
}

function buildSummary() {
	const startedAt = new Date(metrics.startedAt).getTime();
	const endedAt = Date.now();

	return {
		...metrics,
		elapsedSeconds: Math.round((endedAt - startedAt) / 1000),
		logRoot,
		errorTotals: {
			byScenario: metrics.errorsByScenario,
			byStep: metrics.errorsByStep,
			byMessage: metrics.errorsByMessage,
		},
		latencySummary: summarizeLatencies(metrics.latencyMs),
	};
}

function summarizeLatencies(latencyMap) {
	const result = {};

	for (const [keyName, values] of Object.entries(latencyMap)) {
		const sorted = [...values].sort((a, b) => a - b);
		result[keyName] = {
			count: sorted.length,
			min: sorted[0] ?? 0,
			max: sorted[sorted.length - 1] ?? 0,
			p50: percentile(sorted, 0.5),
			p95: percentile(sorted, 0.95),
			p99: percentile(sorted, 0.99),
		};
	}

	return result;
}

function observeLatency(scenario, stepName, latencyMs) {
	const keyName = `${scenario}:${stepName}`;
	metrics.latencyMs[keyName] ??= [];
	metrics.latencyMs[keyName].push(latencyMs);
	if (metrics.latencyMs[keyName].length > 10_000) metrics.latencyMs[keyName].shift();
}

function percentile(sortedValues, p) {
	if (sortedValues.length === 0) return 0;
	const index = Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * p));
	return sortedValues[index];
}

function createJsonlWriter(path) {
	const stream = createWriteStream(path, { flags: 'a' });

	return {
		write(value) {
			stream.write(`${JSON.stringify(serialize(value))}\n`);
		},
		end() {
			stream.end();
		},
	};
}

function parseArgs(argv) {
	const parsed = new Map();

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg.startsWith('--')) continue;

		const [rawKey, rawValue] = arg.slice(2).split('=', 2);
		const value = rawValue ?? argv[i + 1];
		parsed.set(rawKey, value ?? 'true');
		if (rawValue == null && value != null && !value.startsWith('--')) i += 1;
	}

	return parsed;
}

async function loadSdk() {
	if (process.env.FERRICFLOW_SDK_PATH) return await loadModule(resolve(process.env.FERRICFLOW_SDK_PATH));

	try {
		return await loadModule('@ferricstore/ferricstore');
	} catch {
		try {
			return await loadModule('@ferricstore/ferricstore', requireCliSdk);
		} catch {
			return await loadModule(sdkPath);
		}
	}
}

async function loadModule(specifier, requireFrom = requireSdk) {
	try {
		return requireFrom(specifier);
	} catch (error) {
		const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
		if (code !== 'ERR_REQUIRE_ESM' && code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;

		return await import(specifier.startsWith('/') ? pathToFileURL(specifier).href : specifier);
	}
}

function intArg(parsed, keyName, fallback) {
	if (!parsed.has(keyName)) return fallback;
	const value = Number.parseInt(parsed.get(keyName), 10);
	return Number.isFinite(value) ? value : fallback;
}

function numberArg(parsed, keyName, fallback) {
	if (!parsed.has(keyName)) return fallback;
	const value = Number.parseFloat(parsed.get(keyName));
	return Number.isFinite(value) ? value : fallback;
}

function boolArg(parsed, keyName, fallback) {
	if (!parsed.has(keyName)) return fallback;
	return ['1', 'true', 'yes', 'on'].includes(String(parsed.get(keyName)).toLowerCase());
}

function increment(map, keyName) {
	map[keyName] = (map[keyName] ?? 0) + 1;
}

function recordSummary(record) {
	if (record == null) return null;

	return {
		id: record.id,
		type: record.type,
		state: record.state,
		runState: record.runState,
		partitionKey: record.partitionKey,
		payload: record.payload,
		result: record.result,
		error: record.error,
		version: record.version,
		fencingToken: record.fencingToken,
	};
}

function compactResult(result) {
	if (result == null) return result;
	if (Array.isArray(result)) return { kind: 'array', length: result.length };
	if (typeof result !== 'object') return result;

	return Object.fromEntries(
		Object.entries(result).map(([keyName, value]) => {
			if (typeof value === 'string' && value.length > 300) return [keyName, `${value.slice(0, 300)}...`];
			if (Array.isArray(value)) return [keyName, { kind: 'array', length: value.length }];
			return [keyName, value];
		}),
	);
}

function serialize(value) {
	return JSON.parse(
		JSON.stringify(value, (_key, innerValue) => {
			if (typeof innerValue === 'bigint') return innerValue.toString();
			if (innerValue instanceof Error) {
				return {
					name: innerValue.name,
					message: innerValue.message,
					stack: innerValue.stack,
				};
			}
			if (Buffer.isBuffer(innerValue)) return innerValue.toString('utf8');
			if (innerValue instanceof Uint8Array) return Buffer.from(innerValue).toString('utf8');
			return innerValue;
		}),
	);
}

function key(...parts) {
	return [prefix, ...parts].join(':');
}

function isoForPath(date) {
	return date.toISOString().replace(/[:.]/g, '-');
}

function randomInt(min, max) {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

function bytesToMb(bytes) {
	return Number((bytes / 1024 / 1024).toFixed(2));
}

function valueToString(value) {
	if (value == null) return null;
	if (Buffer.isBuffer(value)) return value.toString('utf8');
	if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
	return String(value);
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
