import { test, expect } from '../../../fixtures/base';

test.use({
	capability: {
		workers: 1,
		services: ['ferricstore'],
		env: {
			N8N_SCALING_BACKEND: 'ferricflow',
			N8N_CACHE_BACKEND: 'ferricstore',
		},
	},
});

test.describe('FerricFlow scaling backend @mode:queue @capability:ferricflow', () => {
	test('executes a webhook workflow on a worker without Redis', async ({ api, n8nContainer }) => {
		expect(n8nContainer.findContainers(/ferricstore/i).length).toBeGreaterThan(0);
		expect(n8nContainer.findContainers(/redis/i)).toHaveLength(0);

		const { webhookPath, workflowId } = await api.workflows.importWorkflowFromFile(
			'simple-webhook-test.json',
		);

		const webhookResponse = await api.webhooks.trigger(`/webhook/${webhookPath}`, {
			method: 'POST',
			data: { message: 'Hello from FerricFlow Playwright' },
			maxNotFoundRetries: 10,
			notFoundRetryDelayMs: 500,
		});

		expect(webhookResponse.ok()).toBe(true);

		const execution = await api.workflows.waitForExecution(workflowId, 30_000);
		expect(execution.status).toBe('success');

		const executionDetails = await api.workflows.getExecution(execution.id);
		expect(executionDetails.data).toContain('Hello from FerricFlow Playwright');
	});
});
