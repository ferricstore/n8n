import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const pullRequestWorkflow = readFileSync(
	new URL('../../workflows/ci-pull-requests.yml', import.meta.url),
	'utf8',
);

describe('maintained fork pull-request workflow', () => {
	it('does not request unavailable code-scanning permissions', () => {
		assert.doesNotMatch(pullRequestWorkflow, /uses: .*sec-ci-reusable\.yml/);
		assert.doesNotMatch(pullRequestWorkflow, /^\s+security-checks,$/m);
	});

	it('does not call upstream-only workflows that require pull-request writes', () => {
		assert.doesNotMatch(pullRequestWorkflow, /uses: .*test-evals-discovery\.yml/);
		assert.doesNotMatch(pullRequestWorkflow, /uses: .*util-qa-metrics-comment-reusable\.yml/);
	});
});
