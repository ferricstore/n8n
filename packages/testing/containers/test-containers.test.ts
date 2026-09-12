import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { TEST_CONTAINER_IMAGES } from './test-containers';

void describe('test container images', () => {
	void it('pins FerricStore 0.11.16 to its immutable Quay digest', () => {
		assert.equal(
			TEST_CONTAINER_IMAGES.ferricstore,
			'quay.io/ferricstore/ferricstore:0.11.16@sha256:6a7364fb1c8936a0bf6658fea5b4c3a563b477291209203af98f1a5d34540d8a',
		);
	});

	void it('keeps the FerricFlow simulator quickstart on the tested image', async () => {
		const readme = await readFile(
			new URL('../../../tools/ferricflow-user-flow-simulator/README.md', import.meta.url),
			'utf8',
		);

		assert.match(
			readme,
			/quay\.io\/ferricstore\/ferricstore:0\.11\.16@sha256:6a7364fb1c8936a0bf6658fea5b4c3a563b477291209203af98f1a5d34540d8a/,
		);
	});
});
