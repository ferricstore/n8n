import { describe, expect, it, vi } from 'vitest';

import {
	loadFerricFlowSdk,
	readNewFerricFlowWorkflowRecords,
	seedSeenFerricFlowWorkflowRecords,
} from '../ferricstore-sdk';

describe('FerricStore SDK loader', () => {
	it('loads the FerricStore SDK under Vitest', async () => {
		const sdk = await loadFerricFlowSdk('');

		expect(sdk.FERRICSTORE_SDK_VERSION).toBe('0.13.2');
		expect(sdk.FerricStoreClient).toBeDefined();
		expect(sdk.JsonCodec).toBeDefined();
	});
});

describe('FerricFlow workflow record queries', () => {
	it('seeds seen records through bounded cursor pages in oldest-to-newest insertion order', async () => {
		const query = vi
			.fn()
			.mockResolvedValueOnce({
				kind: 'records',
				page: { cursor: 'fqc1_next', hasMore: true },
				records: [
					{ run_id: 'newest', state: 'published' },
					{ run_id: 'middle', state: 'published' },
				],
			})
			.mockResolvedValueOnce({
				kind: 'records',
				page: { hasMore: false },
				records: [{ run_id: 'oldest', state: 'published' }],
			});
		const seen = new Set<string>();

		await seedSeenFerricFlowWorkflowRecords({ query } as never, {
			partitionKey: 'n8n:workflow-events',
			seen,
			state: 'published',
			type: 'n8n:workflow-event',
		});

		expect([...seen]).toEqual(['oldest', 'middle', 'newest']);
		expect(query).toHaveBeenCalledTimes(2);
		expect(query.mock.calls[0]?.[0]).toContain('LIMIT 100 RETURN RECORDS (run_id, state)');
		expect(query.mock.calls[0]?.[1]).toEqual({
			partition_key: 'n8n:workflow-events',
			state: 'published',
			type: 'n8n:workflow-event',
		});
		expect(query.mock.calls[1]?.[0]).toContain(
			'LIMIT 100 CURSOR @cursor RETURN RECORDS (run_id, state)',
		);
		expect(query.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ cursor: 'fqc1_next' }));
	});

	it('reads every unseen page and stops when it reaches a known record', async () => {
		const query = vi
			.fn()
			.mockResolvedValueOnce({
				kind: 'records',
				page: { cursor: 'fqc1_next', hasMore: true },
				records: [
					{ run_id: 'new-2', state: 'published' },
					{ run_id: 'new-1', state: 'published' },
				],
			})
			.mockResolvedValueOnce({
				kind: 'records',
				page: { cursor: 'fqc1_older', hasMore: true },
				records: [
					{ run_id: 'known', state: 'published' },
					{ run_id: 'older', state: 'published' },
				],
			});
		const get = vi.fn(async (id: string) => ({
			fencingToken: 0,
			id,
			payload: { id },
			state: 'published',
		}));
		const seen = new Set(['known']);

		const records = await readNewFerricFlowWorkflowRecords({ get, query } as never, {
			partitionKey: 'n8n:workflow-events',
			seen,
			state: 'published',
			type: 'n8n:workflow-event',
		});

		expect(records.map(({ id }) => id)).toEqual(['new-2', 'new-1']);
		expect(get.mock.calls.map(([id]) => id)).toEqual(['new-2', 'new-1']);
		expect(query).toHaveBeenCalledTimes(2);
		expect(seen).toEqual(new Set(['known', 'new-2', 'new-1']));
	});
});
