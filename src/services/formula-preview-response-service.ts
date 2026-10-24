import type {
  PreviewFormulaOutcome,
  PreviewRunStatus,
} from './formula-execution-service.ts';

export interface PreviewExplanationSteps {
  readonly inputs: Record<string, unknown>;
  readonly formula: string;
  readonly substituted: string | null;
  readonly result: unknown;
  readonly calculation?: string;
}

export interface PreviewFormulaExplanation {
  readonly uuid: string;
  readonly name: string;
  readonly version: number;
  readonly autoAdded: boolean;
  readonly status: PreviewRunStatus;
  readonly result: unknown;
  readonly steps: PreviewExplanationSteps;
  readonly error: string | null;
  readonly reason: string | null;
}

export interface PreviewResponse {
  readonly runUuid: string;
  readonly inputRecord: Record<string, unknown>;
  readonly record: Record<string, unknown>;
  readonly formulas: PreviewFormulaExplanation[];
}

function extractSubstituted(calculation: string | null): string | null {
  if (!calculation) {
    return null;
  }
  const lines = calculation.split('\n');
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (!/^return\b/.test(line)) {
      continue;
    }
    const substituted = lines[index + 1]?.trim() ?? '';
    if (substituted.startsWith('=')) {
      return substituted;
    }
  }
  return null;
}

function buildInputs(outcome: PreviewFormulaOutcome): Record<string, unknown> {
  const entries: Array<[string, unknown]> = [];
  for (const name of outcome.formula.inputs) {
    const value = Object.hasOwn(outcome.inputData, name) ? outcome.inputData[name] : null;
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

function buildSteps(outcome: PreviewFormulaOutcome): PreviewExplanationSteps {
  const substituted = extractSubstituted(outcome.calculation);
  const steps: PreviewExplanationSteps = {
    inputs: buildInputs(outcome),
    formula: outcome.formula.formula_text,
    substituted,
    result: outcome.result,
  };
  if (substituted === null && outcome.calculation !== null) {
    return { ...steps, calculation: outcome.calculation };
  }
  return steps;
}

export function buildFormulaExplanation(
  outcome: PreviewFormulaOutcome,
): PreviewFormulaExplanation {
  return {
    uuid: outcome.formula.uuid,
    name: outcome.formula.name,
    version: outcome.formula.version,
    autoAdded: outcome.autoAdded,
    status: outcome.status,
    result: outcome.result,
    steps: buildSteps(outcome),
    error: outcome.error,
    reason: outcome.reason,
  };
}

export function buildFinalRecord(
  record: Record<string, unknown>,
  outcomes: readonly PreviewFormulaOutcome[],
): Record<string, unknown> {
  const values = new Map<string, unknown>(Object.entries(record));
  for (const outcome of outcomes) {
    if (outcome.status === 'SUCCESS') {
      values.set(outcome.formula.name, outcome.result);
    }
  }
  return Object.fromEntries(values);
}

export function buildPreviewResponse(
  runUuid: string,
  record: Record<string, unknown>,
  outcomes: readonly PreviewFormulaOutcome[],
): PreviewResponse {
  return {
    runUuid,
    inputRecord: { ...record },
    record: buildFinalRecord(record, outcomes),
    formulas: outcomes.map(buildFormulaExplanation),
  };
}
