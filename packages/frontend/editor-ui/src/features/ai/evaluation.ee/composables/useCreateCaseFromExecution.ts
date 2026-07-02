import type { IExecutionResponse } from '@/features/execution/executions/executions.types';
import { useExecutionsStore } from '@/features/execution/executions/executions.store';
import { useEvaluationsWizardSidepanelStore } from '../wizardSidepanel.store';
import { readFirstOutputItem } from './useSliceInputs';
import { extractAnswerText } from '../evaluation.utils';

/**
 * Seed a NEW test case from a successful execution and open its detail:
 * inputs prefill via `seedExecution` (resolved by `useSliceInputs`), and the
 * expected answer prefills from the end node's output. Shared by the create-case
 * execution picker and the "create case from execution" action on the
 * executions page.
 */
export function useCreateCaseFromExecution() {
	const wizardStore = useEvaluationsWizardSidepanelStore();
	const executionsStore = useExecutionsStore();

	function createFromExecution(execution: IExecutionResponse): void {
		// Reset the form, then let useSliceInputs resolve inputs from this
		// execution (top priority once seedExecution is set).
		wizardStore.inputs = {};
		wizardStore.setSeedExecution(execution);

		// Prefill the expected answer from the end node's output.
		const endNode = wizardStore.isSliceMode ? wizardStore.endNodeName : wizardStore.aiNodeName;
		const runData = execution.data?.resultData?.runData;
		const answer =
			endNode && runData ? extractAnswerText(readFirstOutputItem(runData, endNode)) : '';
		wizardStore.expectedValues = answer ? { expectedAnswer: answer } : {};

		wizardStore.openDetail(null);
	}

	async function createFromExecutionId(executionId: string): Promise<boolean> {
		const full = await executionsStore.fetchExecution(executionId);
		if (!full) return false;
		createFromExecution(full);
		return true;
	}

	return { createFromExecution, createFromExecutionId };
}
