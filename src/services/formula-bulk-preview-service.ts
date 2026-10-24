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
  writeBulkRunLog,
  type BulkRunLogRecord,
  type BulkRunLogWriter,
} from './formula-run-log-service.ts';
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
  readonly writeLog?: BulkRunLogWriter;
}

export interface BulkPreviewResult {
  readonly recordIndex: number;
  readonly runUuid: string;
  readonly record: Record<string, unknown>;
  readonly formulas: PreviewFormulaExplanation[];
  readonly status: 'SUCCESS' | 'FAILED';
}

export interface BulkPreviewSummary {
  readonly totalRecords: number;
  readonly totalFormulas: number;
  readonly totalMs: number;
  readonly avgMsPerRecord: number;
  readonly failedRecords: number;
  readonly failedFormulas: number;
  readonly skippedFormulas: number;
}

export interface BulkPreviewResponse {
  readonly results: BulkPreviewResult[];
  readonly summary: BulkPreviewSummary;
}

interface BulkPreviewRecordExecution extends BulkRunLogRecord {
  readonly record: Record<string, unknown>;
  readonly formulas: PreviewFormulaExplanation[];
}

function recordStatus(
  outcomes: readonly PreviewFormulaOutcome[],
): 'SUCCESS' | 'FAILED' {
  return outcomes.some((outcome) => outcome.status !== 'SUCCESS')
    ? 'FAILED'
    : 'SUCCESS';
}

function countOutcomes(
  records: readonly BulkPreviewRecordExecution[],
  status: PreviewFormulaOutcome['status'],
): number {
  return records.reduce(
    (total, record) => total + record.outcomes.filter(
      (outcome) => outcome.status === status,
    ).length,
    0,
  );
}

export async function previewFormulasBulk(
  body: BulkPreviewBody,
  options: BulkPreviewOptions = {},
): Promise<BulkPreviewResponse> {
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
        runUuid,
        record: response.record,
        formulas: response.formulas,
        outcomes,
      };
    },
  );
  await (options.writeLog ?? writeBulkRunLog)(records);
  const results: BulkPreviewResult[] = records.map((record) => ({
    recordIndex: record.recordIndex,
    runUuid: record.runUuid,
    record: record.record,
    formulas: record.formulas,
    status: recordStatus(record.outcomes),
  }));
  const totalFormulas = records.reduce(
    (total, record) => total + record.outcomes.length,
    0,
  );
  const totalMs = Number((performance.now() - started).toFixed(2));
  return {
    results,
    summary: {
      totalRecords: results.length,
      totalFormulas,
      totalMs,
      avgMsPerRecord: results.length === 0
        ? 0
        : Number((totalMs / results.length).toFixed(2)),
      failedRecords: results.filter((result) => result.status === 'FAILED').length,
      failedFormulas: countOutcomes(records, 'FAILED'),
      skippedFormulas: countOutcomes(records, 'SKIPPED'),
    },
  };
}
