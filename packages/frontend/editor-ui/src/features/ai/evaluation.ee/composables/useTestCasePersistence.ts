import { ref } from 'vue';
import { useI18n } from '@n8n/i18n';
import { getParentNodes, mapConnectionsByDestination } from 'n8n-workflow';

import { useEvaluationsWizardSidepanelStore } from '../wizardSidepanel.store';
import { useToast } from '@/app/composables/useToast';
import { useTelemetry } from '@/app/composables/useTelemetry';
import { useRootStore } from '@n8n/stores/useRootStore';
import { injectWorkflowDocumentStore } from '@/app/stores/workflowDocument.store';
import { useNodeTypesStore } from '@/app/stores/nodeTypes.store';
import {
	addDataTableColumnApi,
	createDataTableApi,
	deleteDataTableApi,
	deleteDataTableRowsApi,
	fetchDataTablesApi,
	getDataTableRowsApi,
	insertDataTableRowApi,
	updateDataTableRowsApi,
} from '@/features/core/dataTable/dataTable.api';
import type {
	DataTableColumnCreatePayload,
	DataTableRow,
} from '@/features/core/dataTable/dataTable.types';
import {
	createEvaluationConfig,
	deleteEvaluationConfig,
	listEvaluationConfigs,
	updateEvaluationConfig,
} from '../evaluation.api';
import type { EvaluationConfigDto, UpsertEvaluationConfigDto } from '@n8n/api-types';
import { useEvaluationStore } from '../evaluation.store';
import { useSliceInputs } from './useSliceInputs';
import { getExpectedFieldsForMetrics } from '../evaluation.constants';
import { buildEvaluationConfigDto } from './buildEvaluationConfigDto';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function useTestCasePersistence() {
	const wizardStore = useEvaluationsWizardSidepanelStore();
	const workflowDocumentStore = injectWorkflowDocumentStore();
	const nodeTypesStore = useNodeTypesStore();
	const rootStore = useRootStore();
	const toast = useToast();
	const locale = useI18n();
	const telemetry = useTelemetry();
	const sliceInputs = useSliceInputs();
	const evaluationStore = useEvaluationStore();

	const isPersisting = ref(false);

	/**
	 * Persist the currently-edited test case to the data table (INSERT when
	 * `activeRowIndex` is null, UPDATE otherwise) and then dispatch a test run
	 * scoped to that single row via `rowIndices`.
	 */
	async function persistAndRunCase(trigger: 'initial' | 'run_again' = 'initial'): Promise<boolean> {
		if (isPersisting.value) return false;

		const wf = workflowDocumentStore.value;
		const projectId = wf?.homeProject?.id;
		const workflowId = wf?.workflowId;
		if (!projectId || !workflowId) {
			showPersistError(new Error('Missing project or workflow context'));
			return false;
		}

		const slice = resolveSlice();
		if (!slice.ok) {
			showPersistError(new Error(slice.reason));
			return false;
		}

		const inputNames = sliceInputs.value.fieldNames;
		const expectedFields = getExpectedFieldsForMetrics(wizardStore.selectedMetricKeys);
		// Dedupe: an input column and an expected column can share a name.
		const seenColumns = new Set<string>();
		const requiredColumns: DataTableColumnCreatePayload[] = [];
		for (const name of [...inputNames, ...expectedFields.map((f) => f.name)]) {
			if (seenColumns.has(name)) continue;
			seenColumns.add(name);
			requiredColumns.push({ name, type: 'string' as const });
		}

		// Dry-run before any API calls so shape errors don't leave half-state.
		const dryRun = buildEvaluationConfigDto({
			workflowName: wf.name ?? 'workflow',
			upstreamNodeName: slice.upstreamNodeName,
			startNodeName: slice.startNodeName,
			endNodeName: slice.endNodeName,
			inputFieldNames: inputNames,
			selectedMetrics: wizardStore.selectedMetricKeys,
			judgeSelectionByMetric: wizardStore.judgeSelectionByMetric,
			customChecks: wizardStore.customChecks,
			dataTableId: '__placeholder__',
		});
		if (!dryRun.ok) {
			showPersistError(new Error(dryRun.reason));
			return false;
		}

		const tableName = `Evaluation: ${wf.name ?? 'workflow'}`.slice(0, 120);
		const configName = tableName;
		let createdTableId: string | undefined;
		let rowMutation:
			| { kind: 'insert'; tableId: string; rowId?: number }
			| { kind: 'update'; tableId: string; rowId: number; priorData: DataTableRow }
			| undefined;
		let createdConfigId: string | undefined;
		let priorConfigSnapshot: { id: string; payload: UpsertEvaluationConfigDto } | undefined;

		isPersisting.value = true;
		let configId: string | undefined;
		let resolvedIndex: number;
		const isNewCase = wizardStore.activeRowIndex === null;

		try {
			const ensured = await ensureDataTable(tableName, projectId, requiredColumns);
			if (ensured.created) createdTableId = ensured.id;

			const row: DataTableRow = {};
			for (const name of inputNames) row[name] = wizardStore.inputs[name] ?? '';
			for (const f of expectedFields) row[f.name] = wizardStore.expectedValues[f.name] ?? '';

			if (isNewCase) {
				// ADD path: determine append index then insert.
				const countResult = await getDataTableRowsApi(
					rootStore.restApiContext,
					ensured.id,
					projectId,
					{ take: 1 },
				);
				const appendIndex = countResult.count;
				const insertedRows = await insertDataTableRowApi(
					rootStore.restApiContext,
					ensured.id,
					row,
					projectId,
				);
				const insertedId = numericRowId(insertedRows[0]?.id);
				rowMutation = { kind: 'insert', tableId: ensured.id, rowId: insertedId };
				wizardStore.setActiveRow(appendIndex, insertedId ?? null);
				resolvedIndex = appendIndex;
			} else {
				// EDIT path: update the row at activeRowIndex.
				const n = wizardStore.activeRowIndex as number;
				let rowId = wizardStore.activeRowId;
				if (rowId === null) {
					// Resolve the row id via the API.
					const fetched = await getDataTableRowsApi(
						rootStore.restApiContext,
						ensured.id,
						projectId,
						{ skip: n, take: 1 },
					);
					const fetchedId = numericRowId(fetched.data[0]?.id);
					if (fetchedId === undefined) {
						throw new Error(`Could not resolve row id for index ${n}`);
					}
					rowId = fetchedId;
				}
				const priorFetch = await getDataTableRowsApi(
					rootStore.restApiContext,
					ensured.id,
					projectId,
					{ skip: n, take: 1 },
				);
				const priorData: DataTableRow = stripBookkeeping(priorFetch.data[0] ?? {});
				rowMutation = { kind: 'update', tableId: ensured.id, rowId, priorData };
				await updateDataTableRowsApi(rootStore.restApiContext, ensured.id, rowId, row, projectId);
				resolvedIndex = n;
			}

			const built = buildEvaluationConfigDto({
				workflowName: wf.name ?? 'workflow',
				upstreamNodeName: slice.upstreamNodeName,
				startNodeName: slice.startNodeName,
				endNodeName: slice.endNodeName,
				inputFieldNames: inputNames,
				selectedMetrics: wizardStore.selectedMetricKeys,
				judgeSelectionByMetric: wizardStore.judgeSelectionByMetric,
				customChecks: wizardStore.customChecks,
				dataTableId: ensured.id,
			});
			if (!built.ok) throw new Error(built.reason);

			const desiredDto = { ...built.dto, name: configName };
			const ensuredConfig = await ensureConfig(workflowId, desiredDto);
			if (ensuredConfig.created) {
				createdConfigId = ensuredConfig.id;
			} else {
				priorConfigSnapshot = { id: ensuredConfig.id, payload: ensuredConfig.priorPayload };
			}
			configId = ensuredConfig.id;
		} catch (error) {
			await rollback(projectId, workflowId, {
				createdTableId,
				rowMutation,
				createdConfigId,
				priorConfigSnapshot,
			});
			showPersistError(error);
			isPersisting.value = false;
			return false;
		}

		// Don't roll back on dispatch failure — config is intact, retry is safe.
		try {
			wizardStore.setActiveRunId(null);
			const dispatched = await evaluationStore.startTestRun(workflowId, {
				evaluationConfigId: configId,
				compileFromConfig: true,
				rowIndices: [resolvedIndex],
			});
			wizardStore.setActiveRunId(dispatched?.testRunId ?? null);
			telemetry.track('User ran evaluation', {
				workflow_id: workflowId,
				run_id: dispatched?.testRunId ?? null,
				row_index: resolvedIndex,
				is_new_case: isNewCase,
				trigger,
				metric_count: wizardStore.selectedMetricKeys.length,
				custom_check_count: wizardStore.customChecks.length,
				slice_mode: wizardStore.isSliceMode,
			});
			await evaluationStore.fetchTestRuns(workflowId);
			return true;
		} catch (error) {
			toast.showError(error, locale.baseText('evaluations.wizardSidepanel.step2.dispatchError'));
			return false;
		} finally {
			isPersisting.value = false;
		}
	}

	/**
	 * Persist the suite-level config (node under test + metrics) to the
	 * EvaluationConfig without touching any row or dispatching a run. Used by the
	 * overview's suite-config editor. Returns the config id, or null on failure.
	 * When `silent`, failures (e.g. node not yet chosen) are swallowed — suitable
	 * for debounced auto-save.
	 */
	async function saveConfig(opts?: { silent?: boolean }): Promise<string | null> {
		const wf = workflowDocumentStore.value;
		const projectId = wf?.homeProject?.id;
		const workflowId = wf?.workflowId;
		if (!projectId || !workflowId) return null;

		const slice = resolveSlice();
		if (!slice.ok) {
			if (!opts?.silent) showPersistError(new Error(slice.reason));
			return null;
		}

		const inputNames = sliceInputs.value.fieldNames;
		const expectedFields = getExpectedFieldsForMetrics(wizardStore.selectedMetricKeys);
		const seenColumns = new Set<string>();
		const requiredColumns: DataTableColumnCreatePayload[] = [];
		for (const name of [...inputNames, ...expectedFields.map((f) => f.name)]) {
			if (seenColumns.has(name)) continue;
			seenColumns.add(name);
			requiredColumns.push({ name, type: 'string' as const });
		}

		const tableName = `Evaluation: ${wf.name ?? 'workflow'}`.slice(0, 120);
		try {
			const ensured = await ensureDataTable(tableName, projectId, requiredColumns);
			const built = buildEvaluationConfigDto({
				workflowName: wf.name ?? 'workflow',
				upstreamNodeName: slice.upstreamNodeName,
				startNodeName: slice.startNodeName,
				endNodeName: slice.endNodeName,
				inputFieldNames: inputNames,
				selectedMetrics: wizardStore.selectedMetricKeys,
				judgeSelectionByMetric: wizardStore.judgeSelectionByMetric,
				customChecks: wizardStore.customChecks,
				dataTableId: ensured.id,
			});
			if (!built.ok) {
				if (!opts?.silent) showPersistError(new Error(built.reason));
				return null;
			}
			const ensuredConfig = await ensureConfig(workflowId, { ...built.dto, name: tableName });
			return ensuredConfig.id;
		} catch (error) {
			if (!opts?.silent) showPersistError(error);
			return null;
		}
	}

	/**
	 * Run all rows of the current evaluation config without mutating any row.
	 * Picks the canonical config (by name) if present, else falls back to the
	 * last config — same selection rule as `useWizardHydration`.
	 */
	async function runAll(): Promise<boolean> {
		const wf = workflowDocumentStore.value;
		const workflowId = wf?.workflowId;
		if (!workflowId) {
			showPersistError(new Error('Missing workflow context'));
			return false;
		}

		// Best-effort: persist any pending suite-config edits first so "Run all"
		// uses the latest node + metrics. Non-blocking — falls back to the
		// existing config if this can't run (e.g. node not resolvable here).
		await saveConfig({ silent: true });

		let configId: string;
		try {
			const configs = await listEvaluationConfigs(rootStore.restApiContext, workflowId);
			const canonicalName = `Evaluation: ${wf.name ?? 'workflow'}`.slice(0, 120);
			const config = configs.find((c) => c.name === canonicalName) ?? configs[configs.length - 1];
			if (!config) {
				toast.showError(
					new Error('No evaluation config found. Run a single test case first.'),
					locale.baseText('evaluations.wizardSidepanel.step2.persistError'),
				);
				return false;
			}
			configId = config.id;
		} catch (error) {
			showPersistError(error);
			return false;
		}

		try {
			wizardStore.setActiveRunId(null);
			const dispatched = await evaluationStore.startTestRun(workflowId, {
				evaluationConfigId: configId,
				compileFromConfig: true,
			});
			wizardStore.setActiveRunId(dispatched?.testRunId ?? null);
			telemetry.track('User ran evaluation', {
				workflow_id: workflowId,
				run_id: dispatched?.testRunId ?? null,
				trigger: 'run_all',
			});
			await evaluationStore.fetchTestRuns(workflowId);
			return true;
		} catch (error) {
			toast.showError(error, locale.baseText('evaluations.wizardSidepanel.step2.dispatchError'));
			return false;
		}
	}

	// ---------------------------------------------------------------------------
	// Private helpers (copied from useWizardPersistence to avoid modifying it)
	// ---------------------------------------------------------------------------

	type EnsureConfigResult =
		| { created: true; id: string }
		| { created: false; id: string; priorPayload: UpsertEvaluationConfigDto };

	async function ensureConfig(
		workflowId: string,
		dto: UpsertEvaluationConfigDto,
	): Promise<EnsureConfigResult> {
		const configs = await listEvaluationConfigs(rootStore.restApiContext, workflowId);
		const existing = configs.find((c) => c.name === dto.name);
		if (!existing) {
			const created = await createEvaluationConfig(rootStore.restApiContext, workflowId, dto);
			return { created: true, id: created.id };
		}
		const priorPayload = toUpsertPayload(existing);
		const updated = await updateEvaluationConfig(
			rootStore.restApiContext,
			workflowId,
			existing.id,
			dto,
		);
		return { created: false, id: updated.id, priorPayload };
	}

	function toUpsertPayload(config: EvaluationConfigDto): UpsertEvaluationConfigDto {
		const base = {
			name: config.name,
			startNodeName: config.startNodeName,
			endNodeName: config.endNodeName,
			metrics: config.metrics,
		};
		if (config.datasetSource === 'data_table') {
			return { ...base, datasetSource: 'data_table', datasetRef: config.datasetRef };
		}
		return { ...base, datasetSource: 'google_sheets', datasetRef: config.datasetRef };
	}

	type EnsureDataTableResult = { id: string; created: boolean };

	async function ensureDataTable(
		baseName: string,
		projectId: string,
		required: DataTableColumnCreatePayload[],
	): Promise<EnsureDataTableResult> {
		const PAGE = 100;
		const matches: Array<{ id: string; columns: Array<{ name: string }>; name: string }> = [];
		let skip = 0;
		const MAX_ITERATIONS = 50;
		for (let i = 0; i < MAX_ITERATIONS; i++) {
			const list = await fetchDataTablesApi(
				rootStore.restApiContext,
				projectId,
				{ skip, take: PAGE },
				{ name: baseName, projectId },
			);
			for (const table of list.data) matches.push(table);
			if (list.data.length < PAGE || skip + PAGE >= list.count) break;
			skip += PAGE;
		}

		const existing = matches.find((t) => t.name === baseName);
		if (existing) {
			const have = new Set(existing.columns.map((c) => c.name));
			const missing = required.filter((c) => !have.has(c.name));
			for (const column of missing) {
				await addDataTableColumnApi(rootStore.restApiContext, existing.id, projectId, column);
			}
			return { id: existing.id, created: false };
		}

		const created = await createDataTableApi(
			rootStore.restApiContext,
			baseName,
			projectId,
			required,
		);
		return { id: created.id, created: true };
	}

	async function rollback(
		projectId: string,
		workflowId: string,
		state: {
			createdTableId?: string;
			rowMutation?:
				| { kind: 'insert'; tableId: string; rowId?: number }
				| { kind: 'update'; tableId: string; rowId: number; priorData: DataTableRow };
			createdConfigId?: string;
			priorConfigSnapshot?: { id: string; payload: UpsertEvaluationConfigDto };
		},
	): Promise<void> {
		const logRollbackFailure = (step: string, error: unknown) => {
			// eslint-disable-next-line no-console
			console.error(`[evaluations] rollback ${step} failed`, error);
		};

		if (state.createdConfigId) {
			try {
				await deleteEvaluationConfig(rootStore.restApiContext, workflowId, state.createdConfigId);
			} catch (error) {
				logRollbackFailure('delete config', error);
			}
		} else if (state.priorConfigSnapshot) {
			try {
				await updateEvaluationConfig(
					rootStore.restApiContext,
					workflowId,
					state.priorConfigSnapshot.id,
					state.priorConfigSnapshot.payload,
				);
			} catch (error) {
				logRollbackFailure('restore prior config', error);
			}
		}

		let tableDeleted = false;
		if (state.createdTableId) {
			try {
				await deleteDataTableApi(rootStore.restApiContext, state.createdTableId, projectId);
				tableDeleted = true;
			} catch (error) {
				logRollbackFailure('delete data table', error);
			}
		}
		if (!tableDeleted && state.rowMutation) {
			const mutation = state.rowMutation;
			if (mutation.kind === 'insert' && mutation.rowId !== undefined) {
				try {
					await deleteDataTableRowsApi(
						rootStore.restApiContext,
						mutation.tableId,
						[mutation.rowId],
						projectId,
					);
				} catch (error) {
					logRollbackFailure('delete data table row', error);
				}
			} else if (mutation.kind === 'update') {
				try {
					await updateDataTableRowsApi(
						rootStore.restApiContext,
						mutation.tableId,
						mutation.rowId,
						mutation.priorData,
						projectId,
					);
				} catch (error) {
					logRollbackFailure('restore prior data table row', error);
				}
			}
		}
	}

	type SliceResolution =
		| { ok: true; upstreamNodeName: string; startNodeName: string; endNodeName: string }
		| { ok: false; reason: string };

	function resolveSlice(): SliceResolution {
		const wf = workflowDocumentStore.value;
		const connections = wf?.connectionsBySourceNode ?? {};
		const allNodes = wf?.allNodes ?? [];
		const byDest = mapConnectionsByDestination(connections);

		if (!wizardStore.isSliceMode) {
			const aiNode = wizardStore.aiNodeName;
			if (!aiNode) return { ok: false, reason: 'Pick an AI node to evaluate' };

			const triggerNames = new Set(
				allNodes.filter((n) => nodeTypesStore.isTriggerNode(n.type)).map((n) => n.name),
			);
			if (triggerNames.size === 0) return { ok: false, reason: 'Workflow has no trigger' };

			const ancestors = getParentNodes(byDest, aiNode, 'main');
			const chain = [aiNode, ...ancestors];
			let startNodeName: string | undefined;
			let upstreamNodeName: string | undefined;
			for (const candidate of chain) {
				if (triggerNames.has(candidate)) continue;
				const parents = getParentNodes(byDest, candidate, 'main', 1);
				if (parents.length === 1 && triggerNames.has(parents[0])) {
					startNodeName = candidate;
					upstreamNodeName = parents[0];
					break;
				}
			}
			if (!startNodeName || !upstreamNodeName) {
				return {
					ok: false,
					reason: `Couldn't trace AI node "${aiNode}" back to a trigger`,
				};
			}
			return {
				ok: true,
				upstreamNodeName,
				startNodeName,
				endNodeName: aiNode,
			};
		}

		const start = wizardStore.startNodeName;
		const end = wizardStore.endNodeName;
		if (!start || !end) return { ok: false, reason: 'Pick a start and end node for the slice' };

		const parents = getParentNodes(byDest, start, 'main', 1);
		if (parents.length !== 1) {
			return {
				ok: false,
				reason: `Start node "${start}" must have exactly one upstream node (found ${parents.length})`,
			};
		}
		return { ok: true, upstreamNodeName: parents[0], startNodeName: start, endNodeName: end };
	}

	function showPersistError(error: unknown) {
		toast.showError(error, locale.baseText('evaluations.wizardSidepanel.step2.persistError'));
	}

	return { persistAndRunCase, runAll, saveConfig, isPersisting };
}

// ---------------------------------------------------------------------------
// Module-level pure helpers (no closure dependencies)
// ---------------------------------------------------------------------------

function numericRowId(id: unknown): number | undefined {
	if (typeof id === 'number') return id;
	if (typeof id === 'string' && /^\d+$/.test(id)) return Number(id);
	return undefined;
}

// Bookkeeping columns (id/createdAt/updatedAt) are rejected by the update API.
function stripBookkeeping(row: DataTableRow): DataTableRow {
	const out: DataTableRow = {};
	for (const [k, v] of Object.entries(row)) {
		if (k === 'id' || k === 'createdAt' || k === 'updatedAt') continue;
		out[k] = v;
	}
	return out;
}
