import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';

import { useCreateCaseFromExecution } from './useCreateCaseFromExecution';
import { useEvaluationsWizardSidepanelStore } from '../wizardSidepanel.store';

const mockFetchExecution = vi.fn();

vi.mock('@/features/execution/executions/executions.store', () => ({
	useExecutionsStore: () => ({ fetchExecution: mockFetchExecution }),
}));

vi.mock('@/app/composables/useWorkflowId', async () => {
	const { computed } = await import('vue');
	return {
		useWorkflowId: () => computed(() => 'wf-1'),
		useRouteWorkflowId: () => computed(() => 'wf-1'),
	};
});

const execution = {
	id: 'exec-1',
	data: {
		resultData: {
			runData: {
				Darwin: [{ data: { main: [[{ json: { response: 'the answer' } }]] } }],
			},
		},
	},
} as never;

describe('useCreateCaseFromExecution', () => {
	beforeEach(() => {
		setActivePinia(createTestingPinia({ stubActions: false }));
		mockFetchExecution.mockReset().mockResolvedValue(execution);
	});

	it('seeds a new case from an execution and opens the detail', () => {
		const store = useEvaluationsWizardSidepanelStore();
		store.aiNodeName = 'Darwin';
		const { createFromExecution } = useCreateCaseFromExecution();

		createFromExecution(execution);

		expect(store.seedExecution).toEqual(execution);
		expect(store.expectedValues.expectedAnswer).toBe('the answer');
		expect(store.viewMode).toBe('detail');
		expect(store.activeRowIndex).toBeNull();
	});

	it('fetches the execution by id then seeds', async () => {
		const store = useEvaluationsWizardSidepanelStore();
		store.aiNodeName = 'Darwin';
		const { createFromExecutionId } = useCreateCaseFromExecution();

		const ok = await createFromExecutionId('exec-1');

		expect(ok).toBe(true);
		expect(mockFetchExecution).toHaveBeenCalledWith('exec-1');
		expect(store.seedExecution).toEqual(execution);
		expect(store.viewMode).toBe('detail');
	});

	it('returns false when the execution cannot be loaded', async () => {
		mockFetchExecution.mockResolvedValue(null);
		const { createFromExecutionId } = useCreateCaseFromExecution();
		expect(await createFromExecutionId('missing')).toBe(false);
	});
});
