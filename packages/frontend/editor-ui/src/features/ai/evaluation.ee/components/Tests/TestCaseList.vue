<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { N8nOption, N8nSelect, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import type { ExecutionSummary } from 'n8n-workflow';

import { useEvaluationsWizardSidepanelStore } from '../../wizardSidepanel.store';
import { injectWorkflowDocumentStore } from '@/app/stores/workflowDocument.store';
import { useExecutionsStore } from '@/features/execution/executions/executions.store';
import { useToast } from '@/app/composables/useToast';
import { useAiRootNodes } from '../../composables/useAiRootNodes';
import { useCreateCaseFromExecution } from '../../composables/useCreateCaseFromExecution';
import ExecutionRow from './ExecutionRow.vue';

const MAX_EXECUTION_CANDIDATES = 20;

const locale = useI18n();
const wizardStore = useEvaluationsWizardSidepanelStore();
const workflowDocumentStore = injectWorkflowDocumentStore();
const executionsStore = useExecutionsStore();
const toast = useToast();
const aiRootNodes = useAiRootNodes();
const { createFromExecutionId } = useCreateCaseFromExecution();

const { aiNodeName } = storeToRefs(wizardStore);

// ─── Executions to base a test case on ───────────────────────────────────────

const executionCandidates = ref<ExecutionSummary[]>([]);

async function fetchExecutionCandidates() {
	const workflowId = workflowDocumentStore.value?.workflowId;
	if (!workflowId) return;
	try {
		const list = await executionsStore.fetchExecutions({ status: ['success'], workflowId });
		executionCandidates.value = list.results
			.filter((e) => e.mode !== 'evaluation' && typeof e.id === 'string')
			.slice(0, MAX_EXECUTION_CANDIDATES);
	} catch (error) {
		console.warn('[TestCaseList] failed to load execution candidates', error);
	}
}

onMounted(() => {
	void fetchExecutionCandidates();
});

async function handleCreateFromExecution(summary: ExecutionSummary) {
	try {
		await createFromExecutionId(summary.id);
	} catch (error) {
		toast.showError(error, locale.baseText('evaluations.tests.seedFromExecution.error'));
	}
}
</script>

<template>
	<div :class="$style.container" data-test-id="tests-list">
		<!-- Breadcrumb -->
		<div :class="$style.breadcrumb">
			<button
				type="button"
				:class="$style.breadcrumbRoot"
				data-test-id="tests-list-breadcrumb-root"
				@click="wizardStore.openList()"
			>
				<N8nText size="small" color="text-base">
					{{ locale.baseText('setupPanel.tabs.evaluations') }}
				</N8nText>
			</button>
			<N8nText size="small" color="text-light">/</N8nText>
			<N8nText size="small" color="text-dark" bold>
				{{ locale.baseText('evaluations.tests.newCase.title') }}
			</N8nText>
		</div>

		<!-- Choose an AI node + Choose an execution -->
		<div :class="$style.controls">
			<div :class="$style.field">
				<N8nText size="small" color="text-dark">
					{{ locale.baseText('evaluations.tests.chooseAiNode') }}
				</N8nText>
				<N8nSelect
					v-model="aiNodeName"
					size="small"
					filterable
					:placeholder="locale.baseText('evaluations.tests.chooseAiNode.placeholder')"
					data-test-id="tests-list-ai-node-select"
				>
					<N8nOption
						v-for="node in aiRootNodes"
						:key="node.name"
						:label="node.name"
						:value="node.name"
					/>
				</N8nSelect>
			</div>

			<N8nText size="small" color="text-dark">
				{{ locale.baseText('evaluations.tests.chooseExecution') }}
			</N8nText>
		</div>

		<!-- Executions -->
		<div v-if="executionCandidates.length > 0" data-test-id="tests-list-executions">
			<ExecutionRow
				v-for="(execution, i) in executionCandidates"
				:key="execution.id"
				:execution="execution"
				:alt="i % 2 === 0"
				@create="handleCreateFromExecution(execution)"
			/>
		</div>

		<div v-else :class="$style.empty">
			<N8nText size="small" color="text-light">
				{{ locale.baseText('evaluations.tests.executions.empty') }}
			</N8nText>
		</div>
	</div>
</template>

<style module lang="scss">
.container {
	display: flex;
	flex-direction: column;
	overflow-y: auto;
}

.breadcrumb {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	padding: var(--spacing--md);
}

.breadcrumbRoot {
	background: none;
	border: none;
	padding: 0;
	cursor: pointer;

	&:hover :global(.n8n-text) {
		text-decoration: underline;
	}
}

.controls {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--lg);
	padding: 0 var(--spacing--md) var(--spacing--md);
}

.field {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.empty {
	padding: var(--spacing--md);
	text-align: center;
}
</style>
