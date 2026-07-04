import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type FerricStoreClient = {
	close(): Promise<void>;
	command(...args: unknown[]): Promise<unknown>;
	create(id: string, options: Record<string, unknown>): Promise<unknown>;
	claimDue(type: string, options: Record<string, unknown>): Promise<FerricFlowRecord[]>;
	extendLease(id: string, options: Record<string, unknown>): Promise<FerricFlowRecord>;
	complete(id: string, options: Record<string, unknown>): Promise<unknown>;
	fail(id: string, options: Record<string, unknown>): Promise<unknown>;
	cancel(id: string, options: Record<string, unknown>): Promise<unknown>;
	get(id: string, options?: Record<string, unknown>): Promise<FerricFlowRecord | undefined>;
	list(type: string, options?: Record<string, unknown>): Promise<FerricFlowRecord[]>;
};

export type FerricFlowRecord = {
	id: string;
	type?: string;
	state: string;
	runState?: string;
	partitionKey?: string;
	payload?: unknown;
	result?: unknown;
	error?: unknown;
	leaseToken?: Buffer;
	fencingToken: number;
};

type FerricFlowSdk = {
	FerricStoreClient: {
		fromUrl(
			url: string,
			options: { codec: unknown; nativeOptions?: Record<string, unknown> },
		): Promise<FerricStoreClient>;
	};
	JsonCodec: new () => unknown;
};

const requireSdk = createRequire(__filename);

async function dynamicImport(specifier: string) {
	if (process.env.VITEST) return await import(/* @vite-ignore */ specifier);

	return (await eval(`import(${JSON.stringify(specifier)})`)) as unknown;
}

async function loadModule(specifier: string) {
	try {
		return requireSdk(specifier) as unknown;
	} catch (error) {
		const code =
			error && typeof error === 'object' && 'code' in error
				? (error as { code?: unknown }).code
				: undefined;
		if (code !== 'ERR_REQUIRE_ESM' && code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;

		return await dynamicImport(
			specifier.startsWith('/') ? pathToFileURL(specifier).href : specifier,
		);
	}
}

export type FerricFlowWorkflowRecord<TPayload = unknown> = {
	id: string;
	state: string;
	payload: TPayload;
};

type FerricFlowWorkflowRecordSpec = {
	type: string;
	state: string;
	partitionKey: string;
	payload: unknown;
	retentionTtlMs?: number;
};

type FerricFlowWorkflowQuery = {
	type: string;
	state: string;
	partitionKey: string;
	seen: Set<string>;
};

const FERRIC_FLOW_WORKFLOW_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

export async function createFerricStoreClient(
	configuredPath: string,
	url: string,
	clientName: string,
) {
	const sdk = await loadFerricFlowSdk(configuredPath);

	return await sdk.FerricStoreClient.fromUrl(url, {
		codec: new sdk.JsonCodec(),
		nativeOptions: { clientName },
	});
}

export async function loadFerricFlowSdk(configuredPath: string): Promise<FerricFlowSdk> {
	if (configuredPath) {
		const absolutePath = resolve(configuredPath);
		return (await loadModule(absolutePath)) as FerricFlowSdk;
	}

	try {
		const packageName = '@ferricstore/ferricstore';
		return (await loadModule(packageName)) as FerricFlowSdk;
	} catch {
		return (await loadModule(
			resolve(process.cwd(), '../ferricstore-typescript/dist/index.cjs'),
		)) as FerricFlowSdk;
	}
}

export async function createFerricFlowWorkflowRecord(
	client: FerricStoreClient,
	spec: FerricFlowWorkflowRecordSpec,
) {
	const id = `${spec.type}:${spec.state}:${Date.now()}:${randomUUID()}`;

	await client.create(id, {
		idempotent: true,
		partitionKey: spec.partitionKey,
		payload: spec.payload,
		retentionTtlMs: spec.retentionTtlMs ?? FERRIC_FLOW_WORKFLOW_RECORD_TTL_MS,
		state: spec.state,
		type: spec.type,
	});

	return id;
}

export async function seedSeenFerricFlowWorkflowRecords(
	client: FerricStoreClient,
	query: FerricFlowWorkflowQuery,
) {
	const records = await client.list(query.type, {
		count: 1000,
		partitionKey: query.partitionKey,
		state: query.state,
	});

	for (const record of records) query.seen.add(record.id);
}

export async function readNewFerricFlowWorkflowRecords<TPayload = unknown>(
	client: FerricStoreClient,
	query: FerricFlowWorkflowQuery,
) {
	const records = await client.list(query.type, {
		count: 1000,
		partitionKey: query.partitionKey,
		state: query.state,
	});
	const workflowRecords: Array<FerricFlowWorkflowRecord<TPayload>> = [];

	for (const record of records) {
		if (query.seen.has(record.id)) continue;

		query.seen.add(record.id);
		const fullRecord = await client.get(record.id, {
			full: true,
			partitionKey: query.partitionKey,
		});
		workflowRecords.push({
			id: record.id,
			payload: fullRecord?.payload as TPayload,
			state: record.state,
		});
	}

	trimSeenSet(query.seen);

	return workflowRecords;
}

function trimSeenSet(seen: Set<string>) {
	const maxSeen = 5000;
	if (seen.size <= maxSeen) return;

	const excess = seen.size - maxSeen;
	let removed = 0;
	for (const id of seen) {
		seen.delete(id);
		removed += 1;
		if (removed >= excess) return;
	}
}

export function responseText(value: unknown) {
	if (value == null) return '';
	if (Buffer.isBuffer(value)) return value.toString('utf8');
	if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
	return String(value);
}
