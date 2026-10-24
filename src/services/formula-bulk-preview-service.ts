import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import config from '../config/index.ts';
import type { FormulaRow } from '../data/formula-repository.ts';
import {
  createConcurrencyLimiter,
  mapWithConcurrency,
} from '../lib/concurrency.ts';
import type { BulkPreviewBody } from '../validation/bulk-preview-schemas.ts';
import {
  assertPreviewRecordInputs,
  createPreviewPlan,
  executePreviewPlan,
  type PreviewEvaluator,
  type PreviewExecutionPlan,
  type PreviewFormulaOutcome,
} from './formula-execution-service.ts';
import {
  buildPreviewResponse,
  type PreviewFormulaExplanation,
} from './formula-preview-response-service.ts';
import {
  resolvePreviewSelection,
  type PreviewSelection,
} from './formula-selection-service.ts';
import { loadPreviewSnapshot } from './formula-snapshot-service.ts';

export type BulkSnapshotLoader = (asOf?: Date) => Promise<FormulaRow[]>;

export type BulkPlanFactory = (
  selection: readonly PreviewSelection[],
) => PreviewExecutionPlan;

export interface BulkPreviewOptions {
  readonly loadSnapshot?: BulkSnapshotLoader;
  readonly createPlan?: BulkPlanFactory;
  readonly evaluator?: PreviewEvaluator;
  readonly timeoutMs?: number;
  readonly recordConcurrency?: number;
  readonly formulaConcurrency?: number;
  readonly previewConcurrency?: number;
}

export interface BulkPreviewRecordResult {
  readonly recordIndex: number;
  readonly runUuid: string;
  readonly inputRecord: Record<string, unknown>;
  readonly record: Record<string, unknown>;
  readonly formulas: PreviewFormulaExplanation[];
  readonly outcomes: readonly PreviewFormulaOutcome[];
  readonly durationMs: number;
}

export interface BulkPreviewExecution {
  readonly records: BulkPreviewRecordResult[];
  readonly totalMs: number;
}

export async function previewFormulasBulk(
  body: BulkPreviewBody,
  options: BulkPreviewOptions = {},
): Promise<BulkPreviewExecution> {
  const started = performance.now();
  const snapshot = await (options.loadSnapshot ?? loadPreviewSnapshot)(body.asOf);
  const selection = resolvePreviewSelection(snapshot, body.formulaUuids);
  const plan = (options.createPlan ?? createPreviewPlan)(selection);
  for (let index = 0; index < body.records.length; index += 1) {
    const record = body.records[index];
    if (record) {
      assertPreviewRecordInputs(plan, record, index);
    }
  }
  const limiter = createConcurrencyLimiter(
    options.formulaConcurrency ?? config.formula.formulaConcurrency,
  );
  const records = await mapWithConcurrency(
    body.records,
    options.recordConcurrency ?? config.formula.bulkRecordConcurrency,
    async (record, index) => {
      const recordStarted = performance.now();
      const outcomes = await executePreviewPlan(plan, record, {
        ...(options.evaluator ? { evaluator: options.evaluator } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        concurrency: options.previewConcurrency ?? config.formula.previewConcurrency,
        limiter,
      });
      const runUuid = randomUUID();
      const response = buildPreviewResponse(runUuid, record, outcomes);
      return {
        recordIndex: index,
        ...response,
        outcomes,
        durationMs: Number((performance.now() - recordStarted).toFixed(2)),
      };
    },
  );
  return {
    records,
    totalMs: Number((performance.now() - started).toFixed(2)),
  };
}
