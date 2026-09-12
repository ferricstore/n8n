import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { TEST_CONTAINER_IMAGES } from './test-containers';

void describe('test container images', () => {
	void it('pins FerricStore 0.11.17 to its immutable Quay digest', () => {
		assert.equal(
			TEST_CONTAINER_IMAGES.ferricstore,
			'quay.io/ferricstore/ferricstore:0.11.17@sha256:b1f260a5f01c8976c31daa828e375c8bb2e173f66e8ffc384b548a8b3d223230',
		);
	});

	void it('keeps the FerricFlow simulator quickstart on the tested image', async () => {
		const readme = await readFile(
			new URL('../../../tools/ferricflow-user-flow-simulator/README.md', import.meta.url),
			'utf8',
		);

		assert.match(
			readme,
			/quay\.io\/ferricstore\/ferricstore:0\.11\.17@sha256:b1f260a5f01c8976c31daa828e375c8bb2e173f66e8ffc384b548a8b3d223230/,
		);
	});
});
