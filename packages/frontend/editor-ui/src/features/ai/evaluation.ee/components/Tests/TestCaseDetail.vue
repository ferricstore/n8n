<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n, type BaseTextKey } from '@n8n/i18n';
import { N8nActionDropdown, N8nButton, N8nIcon, N8nInput, N8nText } from '@n8n/design-system';
import { getParentNodes, mapConnectionsByDestination, NodeConnectionTypes } from 'n8n-workflow';

import { injectWorkflowDocumentStore } from '@/app/stores/workflowDocument.store';

import { useEvaluationsWizardSidepanelStore } from '../../wizardSidepanel.store';
import { useTestCasePersistence } from '../../composables/useTestCasePersistence';
import { useSliceInputs } from '../../composables/useSliceInputs';
import {
	CANNED_METRICS,
	CANNED_METRIC_EXPECTED_FIELDS,
	type CannedMetricKey,
} from '../../evaluation.constants';
import TestCaseResultCard from './TestCaseResultCard.vue';

// Each metric renders as a sentence under "Output".
const METRIC_SENTENCE_KEY: Record<CannedMetricKey, BaseTextKey> = {
	correctness: 'evaluations.tests.metric.correctness.sentence',
	helpfulness: 'evaluations.tests.metric.helpfulness.sentence',
	stringSimilarity: 'evaluations.tests.metric.stringSimilarity.sentence',
	categorization: 'evaluations.tests.metric.categorization.sentence',
	toolsUsed: 'evaluations.tests.metric.toolsUsed.sentence',
};

const wizardStore = useEvaluationsWizardSidepanelStore();
const workflowDocumentStore = injectWorkflowDocumentStore();
const locale = useI18n();
const {
	selectedMetricKeys,
	customChecks,
	activeRowIndex,
	activeRunId,
	expectedValues,
	inputs,
	aiNodeName,
} = storeToRefs(wizardStore);

const { persistAndRunCase, isPersisting } = useTestCasePersistence();
const sliceInputs = useSliceInputs();

// ─── Header ──────────────────────────────────────────────────────────────────

const caseTitle = computed(() => {
	const firstField = sliceInputs.value.fieldNames[0];
	const firstValue = firstField ? inputs.value[firstField] : '';
	return firstValue || locale.baseText('evaluations.tests.newCase.title');
});

const caseMenuItems = computed(() => [
	{ id: 'back', label: locale.baseText('evaluations.tests.detail.back') },
]);

function onCaseMenu(action: string) {
	if (action === 'back') wizardStore.openList();
}

function handleBack() {
	wizardStore.openList();
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

// Selected canned metrics, in canonical order, each rendered as a sentence.
const selectedCannedMetrics = computed(() =>
	CANNED_METRICS.filter((m) => selectedMetricKeys.value.includes(m.key)),
);

function metricSentence(key: CannedMetricKey): string {
	return locale.baseText(METRIC_SENTENCE_KEY[key]);
}

function expectedFieldFor(key: CannedMetricKey) {
	return CANNED_METRIC_EXPECTED_FIELDS[key];
}

// ─── Tool-usage metric ───────────────────────────────────────────────────────

// Tools wired into the node under test (its ai_tool sub-nodes).
const connectedTools = computed<string[]>(() => {
	const node = aiNodeName.value;
	if (!node) return [];
	const connections = workflowDocumentStore.value?.connectionsBySourceNode ?? {};
	const byDest = mapConnectionsByDestination(connections);
	return getParentNodes(byDest, node, NodeConnectionTypes.AiTool, 1);
});

const selectedTools = computed(
	() =>
		new Set(
			(expectedValues.value.expectedTools ?? '')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean),
		),
);

function toggleTool(name: string) {
	const next = new Set(selectedTools.value);
	if (next.has(name)) next.delete(name);
	else next.add(name);
	wizardStore.setExpectedValue('expectedTools', Array.from(next).join(', '));
}

// ─── Run / result ────────────────────────────────────────────────────────────

// Once a run has been triggered for this case, show its outcome with the same
// result card used on the overview list, keyed by the row's index (which equals
// the case's runIndex). `persistAndRunCase` sets both before the run dispatches.
const resultCardIndex = computed<number | null>(() =>
	activeRunId.value !== null ? activeRowIndex.value : null,
);

async function handleRun() {
	await persistAndRunCase(activeRunId.value ? 'run_again' : 'initial');
}
</script>

<template>
	<div :class="$style.detail">
		<!-- Header: breadcrumb + menu + run -->
		<header :class="$style.header">
			<div :class="$style.breadcrumb">
				<button
					type="button"
					:class="$style.breadcrumbRoot"
					data-test-id="tests-detail-breadcrumb-root"
					@click="handleBack"
				>
					<N8nText size="small" color="text-base">
						{{ locale.baseText('setupPanel.tabs.evaluations') }}
					</N8nText>
				</button>
				<N8nText size="small" color="text-light">/</N8nText>
				<N8nText size="small" color="text-dark" bold :class="$style.caseTitle">
					{{ caseTitle }}
				</N8nText>
			</div>
			<N8nActionDropdown
				:items="caseMenuItems"
				activator-icon="ellipsis-vertical"
				activator-size="small"
				data-test-id="tests-detail-menu"
				@select="onCaseMenu"
			/>
			<N8nButton
				type="primary"
				size="small"
				:loading="isPersisting"
				data-test-id="tests-detail-run"
				@click="handleRun"
			>
				{{ locale.baseText('evaluations.tests.detail.run') }}
			</N8nButton>
		</header>

		<div :class="$style.body">
			<!-- When <node> receives input -->
			<div :class="$style.block">
				<!-- Node under test is configured at the suite level; read-only here. -->
				<div :class="$style.sentence">
					<N8nText size="small" color="text-dark">
						{{ locale.baseText('evaluations.tests.detail.when') }}
					</N8nText>
					<N8nText size="small" color="text-dark" bold data-test-id="tests-detail-ai-node">
						{{ aiNodeName }}
					</N8nText>
					<N8nText size="small" color="text-dark">
						{{ locale.baseText('evaluations.tests.detail.receivesInput') }}
					</N8nText>
				</div>

				<div :class="$style.indented">
					<div
						v-for="name in sliceInputs.fieldNames"
						:key="`input-${name}`"
						:class="$style.field"
						:data-test-id="`tests-detail-input-${name}`"
					>
						<N8nText size="small" color="text-dark">{{ name }}</N8nText>
						<N8nInput
							:model-value="inputs[name] ?? ''"
							type="textarea"
							:rows="2"
							size="small"
							@update:model-value="wizardStore.setInputValue(name, $event)"
						/>
					</div>
				</div>
			</div>

			<!-- Output: one sentence per metric -->
			<div :class="$style.block">
				<N8nText size="small" color="text-dark" bold>
					{{ locale.baseText('evaluations.tests.detail.output') }}
				</N8nText>

				<div :class="$style.indented">
					<div
						v-for="metric in selectedCannedMetrics"
						:key="metric.key"
						:class="$style.metric"
						:data-test-id="`tests-detail-metric-${metric.key}`"
					>
						<N8nText size="small" color="text-dark">{{ metricSentence(metric.key) }}</N8nText>

						<!-- Tool-usage: pick from the node's connected tools (per-case expected) -->
						<div v-if="metric.key === 'toolsUsed'" :class="$style.tools">
							<button
								v-for="tool in connectedTools"
								:key="tool"
								type="button"
								:class="$style.toolItem"
								:data-test-id="`tests-detail-tool-${tool}`"
								@click="toggleTool(tool)"
							>
								<span :class="[$style.box, selectedTools.has(tool) ? $style.boxChecked : null]">
									<N8nIcon v-if="selectedTools.has(tool)" icon="check" size="xsmall" />
								</span>
								<N8nText size="small" color="text-dark">{{ tool }}</N8nText>
							</button>
							<N8nText v-if="connectedTools.length === 0" size="small" color="text-light">
								{{ locale.baseText('evaluations.tests.detail.tools.empty') }}
							</N8nText>
						</div>

						<!-- Metrics with an expected value (similarity / categorization) -->
						<N8nInput
							v-else-if="expectedFieldFor(metric.key)"
							:model-value="expectedValues[expectedFieldFor(metric.key)!.name] ?? ''"
							type="textarea"
							:rows="3"
							size="small"
							:data-test-id="`tests-detail-expected-${expectedFieldFor(metric.key)!.name}`"
							@update:model-value="
								wizardStore.setExpectedValue(expectedFieldFor(metric.key)!.name, $event)
							"
						/>
					</div>

					<!-- Custom checks (expression based) — defined at the suite level, read-only here -->
					<div
						v-for="check in customChecks"
						:key="check.id"
						:class="$style.metric"
						:data-test-id="`tests-detail-custom-${check.id}`"
					>
						<N8nText size="small" color="text-dark">
							{{ locale.baseText('evaluations.tests.metric.custom.sentence') }}
						</N8nText>
						<N8nText
							size="small"
							color="text-dark"
							:class="$style.expression"
							:data-test-id="`tests-detail-custom-expression-${check.id}`"
						>
							{{ check.expression }}
						</N8nText>
					</div>
				</div>
			</div>

			<!-- Result: same card as the overview list, for a consistent look. -->
			<div
				v-if="resultCardIndex !== null"
				:class="$style.block"
				data-test-id="tests-detail-results"
			>
				<TestCaseResultCard :index="resultCardIndex" />
			</div>
		</div>
	</div>
</template>

<style module lang="scss">
.detail {
	display: flex;
	flex-direction: column;
	width: 100%;
	height: 100%;
	background-color: var(--background--surface);
	overflow: hidden;
}

.header {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
	padding: var(--spacing--sm) var(--spacing--md);
	border-bottom: var(--border);
}

.breadcrumb {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	flex: 1 1 auto;
	min-width: 0;
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

.caseTitle {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.body {
	flex: 1 1 auto;
	overflow-y: auto;
	padding: var(--spacing--sm) var(--spacing--md) var(--spacing--md);
	display: flex;
	flex-direction: column;
	gap: var(--spacing--lg);
}

.block {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.sentence {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--spacing--2xs);
}

.indented {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--md);
	padding-left: var(--spacing--md);
}

.field {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.metric {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.expression {
	font-family: var(--font-family--monospace, monospace);
	white-space: pre-wrap;
	word-break: break-word;
}

.tools {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.toolItem {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
	padding: 0;
	background: none;
	border: none;
	cursor: pointer;
	text-align: left;
}

.box {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 16px;
	height: 16px;
	flex-shrink: 0;
	border: var(--border);
	border-radius: var(--radius--sm);
	color: var(--color--text--xlight, white);
}

.boxChecked {
	background-color: var(--color--primary);
	border-color: var(--color--primary);
}
</style>
