<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '@n8n/i18n';
import { N8nIcon, N8nText } from '@n8n/design-system';
import { statusDictionary } from '../../evaluation.constants';
import type { TestCaseExecutionStatus } from '../../evaluation.api';

const props = defineProps<{
	index: number;
	/** Preview of the test case's first input value. */
	title: string;
	/** Status of the associated test-case execution. */
	status?: TestCaseExecutionStatus;
	score?: string;
}>();

const emit = defineEmits<{
	click: [];
}>();

const locale = useI18n();

const heading = computed(() =>
	locale.baseText('evaluations.tests.list.caseLabel', {
		interpolate: { index: props.index + 1 },
	}),
);

const statusIcon = computed(() => {
	if (!props.status) return null;
	// 'evaluation_running' is a test-case-only status; render it like 'running'.
	const key = props.status === 'evaluation_running' ? 'running' : props.status;
	return statusDictionary[key] ?? null;
});
</script>

<template>
	<button
		:class="$style.card"
		:data-test-id="`tests-list-item-${index}`"
		type="button"
		@click="emit('click')"
	>
		<div :class="$style.main">
			<div :class="$style.headingRow">
				<N8nText size="small" color="text-dark" bold>{{ heading }}</N8nText>
				<span v-if="statusIcon || score" :class="$style.meta">
					<N8nText v-if="score" size="xsmall" color="text-base">{{ score }}</N8nText>
					<N8nIcon
						v-if="statusIcon"
						:icon="statusIcon.icon"
						:color="statusIcon.color"
						size="small"
					/>
				</span>
			</div>
			<N8nText size="xsmall" color="text-light" :class="$style.preview">
				{{ title }}
			</N8nText>
		</div>

		<span :class="$style.editHint">
			<N8nIcon icon="square-pen" size="xsmall" />
			<N8nText size="xsmall" color="text-light">
				{{ locale.baseText('evaluations.tests.list.editHint') }}
			</N8nText>
		</span>
	</button>
</template>

<style module lang="scss">
.card {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
	width: 100%;
	padding: var(--spacing--sm);
	background-color: var(--background--surface);
	border: var(--border);
	border-radius: var(--radius--xs);
	cursor: pointer;
	text-align: left;
	transition:
		border-color var(--duration--snappy) ease,
		box-shadow var(--duration--snappy) ease;
	outline: none;

	&:hover,
	&:focus-visible {
		border-color: var(--border-color--strong);
		box-shadow: 0 0 0 1px var(--border-color--strong);
	}
}

.main {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.headingRow {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--xs);
}

.meta {
	display: flex;
	align-items: center;
	gap: var(--spacing--3xs);
	flex-shrink: 0;
}

.preview {
	display: block;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.editHint {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--4xs);
	flex-shrink: 0;
	color: var(--color--text--tint-1);
	opacity: 0;
	transition: opacity var(--duration--snappy) ease;
}

.card:hover .editHint,
.card:focus-visible .editHint {
	opacity: 1;
}
</style>
