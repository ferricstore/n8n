<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from '@n8n/i18n';
import { N8nIcon, N8nText } from '@n8n/design-system';

import { useEvaluationsWizardSidepanelStore } from '../../wizardSidepanel.store';
import { CANNED_METRICS } from '../../evaluation.constants';

const wizardStore = useEvaluationsWizardSidepanelStore();
const locale = useI18n();
const { selectedMetricKeys } = storeToRefs(wizardStore);

const isOpen = ref(false);

function toggleOpen() {
	isOpen.value = !isOpen.value;
}

const summaryLabel = computed(() => {
	if (selectedMetricKeys.value.length === 0) {
		return locale.baseText('evaluations.tests.metrics.none');
	}
	return CANNED_METRICS.filter((m) => selectedMetricKeys.value.includes(m.key))
		.map((m) => locale.baseText(m.labelKey))
		.join(', ');
});
</script>

<template>
	<div :class="$style.container" data-test-id="tests-metrics-dropdown">
		<button
			type="button"
			:class="$style.trigger"
			data-test-id="tests-metrics-dropdown-trigger"
			@click="toggleOpen"
		>
			<N8nText size="small" color="text-dark" :class="$style.summary">
				{{ summaryLabel }}
			</N8nText>
			<N8nIcon :icon="isOpen ? 'chevron-up' : 'chevron-down'" size="small" color="text-base" />
		</button>

		<ul v-if="isOpen" :class="$style.list">
			<li v-for="metric in CANNED_METRICS" :key="metric.key">
				<button
					type="button"
					:class="$style.option"
					:data-test-id="`tests-metrics-dropdown-metric-${metric.key}`"
					@click="wizardStore.toggleMetric(metric.key)"
				>
					<N8nText
						size="small"
						:color="selectedMetricKeys.includes(metric.key) ? 'text-dark' : 'text-base'"
					>
						{{ locale.baseText(metric.labelKey) }}
					</N8nText>
					<N8nIcon
						v-if="selectedMetricKeys.includes(metric.key)"
						icon="check"
						size="small"
						color="primary"
					/>
				</button>
			</li>
		</ul>
	</div>
</template>

<style module lang="scss">
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.trigger {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--xs);
	width: 100%;
	padding: var(--spacing--2xs) var(--spacing--sm);
	background-color: var(--background--surface);
	border: var(--border);
	border-radius: var(--radius--xs);
	cursor: pointer;
	text-align: left;
	outline: none;

	&:hover,
	&:focus-visible {
		border-color: var(--border-color--strong);
	}
}

.summary {
	flex: 1 1 auto;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.list {
	list-style: none;
	margin: 0;
	padding: var(--spacing--3xs);
	display: flex;
	flex-direction: column;
	border: var(--border);
	border-radius: var(--radius--xs);
	background-color: var(--background--surface);
}

.option {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--xs);
	width: 100%;
	padding: var(--spacing--2xs) var(--spacing--xs);
	background: none;
	border: none;
	border-radius: var(--radius--xs);
	cursor: pointer;
	text-align: left;

	&:hover,
	&:focus-visible {
		background-color: var(--background--subtle);
	}
}
</style>
