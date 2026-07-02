import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import userEvent from '@testing-library/user-event';

import { createComponentRenderer } from '@/__tests__/render';
import MetricsDropdown from './MetricsDropdown.vue';
import { useEvaluationsWizardSidepanelStore } from '../../wizardSidepanel.store';

vi.mock('@n8n/i18n', async (importOriginal) => ({
	...(await importOriginal()),
	useI18n: () => ({
		baseText: (key: string, opts?: { interpolate?: Record<string, string> }) => {
			if (opts?.interpolate) {
				return Object.entries(opts.interpolate).reduce(
					(str, [k, v]) => str.replace(`{${k}}`, v),
					key,
				);
			}
			return key;
		},
	}),
}));

vi.mock('@/app/composables/useWorkflowId', async () => {
	const { computed } = await import('vue');
	const { useWorkflowsStore } = await import('@/app/stores/workflows.store');
	return {
		useWorkflowId: () => computed(() => useWorkflowsStore().workflowId),
		useRouteWorkflowId: () => computed(() => useWorkflowsStore().workflowId),
	};
});

const renderComponent = createComponentRenderer(MetricsDropdown);

describe('MetricsDropdown', () => {
	beforeEach(() => {
		createTestingPinia({ stubActions: false });
	});

	it('renders with data-test-id', () => {
		const { getByTestId } = renderComponent();
		expect(getByTestId('tests-metrics-dropdown')).toBeInTheDocument();
	});

	it('shows the trigger button', () => {
		const { getByTestId } = renderComponent();
		expect(getByTestId('tests-metrics-dropdown-trigger')).toBeInTheDocument();
	});

	it('does not show the metric list before opening', () => {
		const { queryByTestId } = renderComponent();
		expect(queryByTestId('tests-metrics-dropdown-metric-correctness')).toBeNull();
	});

	it('opens the metric list when trigger is clicked', async () => {
		const { getByTestId } = renderComponent();
		await userEvent.click(getByTestId('tests-metrics-dropdown-trigger'));
		expect(getByTestId('tests-metrics-dropdown-metric-correctness')).toBeInTheDocument();
	});

	it('shows all canned metrics when open', async () => {
		const { getByTestId } = renderComponent();
		await userEvent.click(getByTestId('tests-metrics-dropdown-trigger'));
		expect(getByTestId('tests-metrics-dropdown-metric-correctness')).toBeInTheDocument();
		expect(getByTestId('tests-metrics-dropdown-metric-helpfulness')).toBeInTheDocument();
		expect(getByTestId('tests-metrics-dropdown-metric-stringSimilarity')).toBeInTheDocument();
		expect(getByTestId('tests-metrics-dropdown-metric-categorization')).toBeInTheDocument();
		expect(getByTestId('tests-metrics-dropdown-metric-toolsUsed')).toBeInTheDocument();
	});

	it('toggles a metric via the store when a CheckCard is clicked', async () => {
		const store = useEvaluationsWizardSidepanelStore();
		// Correctness is pre-selected by default.
		expect(store.selectedMetricKeys).toContain('correctness');

		const { getByTestId } = renderComponent();
		await userEvent.click(getByTestId('tests-metrics-dropdown-trigger'));
		await userEvent.click(getByTestId('tests-metrics-dropdown-metric-correctness'));

		expect(store.selectedMetricKeys).not.toContain('correctness');
	});

	it('adds a metric when an unselected CheckCard is clicked', async () => {
		const store = useEvaluationsWizardSidepanelStore();
		// toolsUsed is not pre-selected
		expect(store.selectedMetricKeys).not.toContain('toolsUsed');

		const { getByTestId } = renderComponent();
		await userEvent.click(getByTestId('tests-metrics-dropdown-trigger'));
		await userEvent.click(getByTestId('tests-metrics-dropdown-metric-toolsUsed'));

		expect(store.selectedMetricKeys).toContain('toolsUsed');
	});

	it('closes the panel when trigger is clicked again', async () => {
		const { getByTestId, queryByTestId } = renderComponent();
		await userEvent.click(getByTestId('tests-metrics-dropdown-trigger'));
		expect(getByTestId('tests-metrics-dropdown-metric-correctness')).toBeInTheDocument();

		await userEvent.click(getByTestId('tests-metrics-dropdown-trigger'));
		expect(queryByTestId('tests-metrics-dropdown-metric-correctness')).toBeNull();
	});
});
