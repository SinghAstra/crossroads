import { saveRecord } from '../data/save-record.ts';
import type { PreviewFormulaOutcome } from './formula-execution-service.ts';

function logError(outcome: PreviewFormulaOutcome): string | null {
  return outcome.status === 'SKIPPED' ? outcome.reason : outcome.error;
}

export async function writePreviewRunLog(
  runUuid: string,
  outcomes: readonly PreviewFormulaOutcome[],
): Promise<void> {
  if (outcomes.length === 0) {
    return;
  }
  const rows: Record<string, unknown>[] = outcomes.map((outcome) => ({
    run_uuid: runUuid,
    formula_uuid: outcome.formula.uuid,
    formula_name: outcome.formula.name,
    formula_version: outcome.formula.version,
    record_index: 0,
    input_json: outcome.inputData,
    result: outcome.result,
    calculation_text: outcome.calculation,
    error: logError(outcome),
    status: outcome.status,
  }));
  await saveRecord('formula_runs', rows);
}
