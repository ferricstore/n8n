import { describe, expect, it } from 'vitest';

import { loadFerricFlowSdk } from '../ferricstore-sdk';

describe('FerricStore SDK loader', () => {
	it('loads the FerricStore SDK under Vitest', async () => {
		const sdk = await loadFerricFlowSdk('');

		expect(sdk.FerricStoreClient).toBeDefined();
		expect(sdk.JsonCodec).toBeDefined();
	});
});
