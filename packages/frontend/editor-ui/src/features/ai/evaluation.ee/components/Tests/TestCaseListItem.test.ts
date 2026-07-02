import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';

import { createComponentRenderer } from '@/__tests__/render';
import TestCaseListItem from './TestCaseListItem.vue';

const renderComponent = createComponentRenderer(TestCaseListItem);

describe('TestCaseListItem', () => {
	it('renders the title', () => {
		const { getByText } = renderComponent({
			props: { index: 0, title: 'Hello world' },
		});

		expect(getByText('Hello world')).toBeInTheDocument();
	});

	it('uses data-test-id with the index', () => {
		const { getByTestId } = renderComponent({
			props: { index: 2, title: 'Test' },
		});

		expect(getByTestId('tests-list-item-2')).toBeInTheDocument();
	});

	it('emits click when the button is clicked', async () => {
		const { emitted, getByTestId } = renderComponent({
			props: { index: 0, title: 'Test case' },
		});

		await userEvent.click(getByTestId('tests-list-item-0'));
		expect(emitted('click')).toHaveLength(1);
	});

	it('shows a status icon when status is provided', () => {
		const { container } = renderComponent({
			props: { index: 0, title: 'Test', status: 'success' },
		});

		// N8nIcon renders an SVG with a data-icon attribute matching the icon name
		expect(container.querySelector('[class*="meta"]')).not.toBeNull();
	});

	it('shows a score when score is provided', () => {
		const { getByText } = renderComponent({
			props: { index: 0, title: 'Test', score: '0.8' },
		});

		expect(getByText('0.8')).toBeInTheDocument();
	});

	it('shows no score or status icon when neither is provided', () => {
		const { queryByText } = renderComponent({
			props: { index: 0, title: 'Only title' },
		});

		// Score/status area should have no content besides the title
		expect(queryByText('0.8')).toBeNull();
	});
});
