import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { TEST_CONTAINER_IMAGES } from './test-containers';

void describe('test container images', () => {
	void it('pins FerricStore 0.11.15 to its immutable Quay digest', () => {
		assert.equal(
			TEST_CONTAINER_IMAGES.ferricstore,
			'quay.io/ferricstore/ferricstore:0.11.15@sha256:8d86005f22eac945ee13bd4c909f3149435be1dca747839e091830d238d4b752',
		);
	});

	void it('keeps the FerricFlow simulator quickstart on the tested image', async () => {
		const readme = await readFile(
			new URL('../../../tools/ferricflow-user-flow-simulator/README.md', import.meta.url),
			'utf8',
		);

		assert.match(
			readme,
			/quay\.io\/ferricstore\/ferricstore:0\.11\.15@sha256:8d86005f22eac945ee13bd4c909f3149435be1dca747839e091830d238d4b752/,
		);
	});
});
