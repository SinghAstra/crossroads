import { saveRecord } from '../data/save-record.ts';
import type { PreviewFormulaOutcome } from './formula-execution-service.ts';

export const BULK_LOG_CHUNK_SIZE = 500;

export interface BulkRunLogRecord {
  readonly runUuid: string;
  readonly recordIndex: number;
  readonly outcomes: readonly PreviewFormulaOutcome[];
}

export type BulkRunLogWriter = (
  records: readonly BulkRunLogRecord[],
) => Promise<void>;

export type RunLogSaver = (
  rows: Record<string, unknown>[],
) => Promise<unknown>;

function logError(outcome: PreviewFormulaOutcome): string | null {
  return outcome.status === 'SKIPPED' ? outcome.reason : outcome.error;
}

function buildRows(
  runUuid: string,
  recordIndex: number,
  outcomes: readonly PreviewFormulaOutcome[],
): Record<string, unknown>[] {
  return outcomes.map((outcome) => ({
    run_uuid: runUuid,
    formula_uuid: outcome.formula.uuid,
    formula_name: outcome.formula.name,
    formula_version: outcome.formula.version,
    record_index: recordIndex,
    input_json: outcome.inputData,
    result: outcome.result,
    calculation_text: outcome.calculation,
    error: logError(outcome),
    status: outcome.status,
  }));
}

async function saveRunRows(rows: Record<string, unknown>[]): Promise<unknown> {
  return saveRecord('formula_runs', rows);
}

export async function writePreviewRunLog(
  runUuid: string,
  outcomes: readonly PreviewFormulaOutcome[],
): Promise<void> {
  const rows = buildRows(runUuid, 0, outcomes);
  if (rows.length === 0) {
    return;
  }
  await saveRunRows(rows);
}

export async function writeBulkRunLog(
  records: readonly BulkRunLogRecord[],
  save: RunLogSaver = saveRunRows,
): Promise<void> {
  const rows = records.flatMap(
    (record) => buildRows(record.runUuid, record.recordIndex, record.outcomes),
  );
  if (rows.length === 0) {
    return;
  }
  for (let index = 0; index < rows.length; index += BULK_LOG_CHUNK_SIZE) {
    await save(rows.slice(index, index + BULK_LOG_CHUNK_SIZE));
  }
}
