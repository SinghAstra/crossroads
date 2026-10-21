import { performance } from 'node:perf_hooks';
import config from '../config/index.ts';
import { formulaWorkerPool } from './formula-worker-pool.ts';
import { normalizeFormulaError, prepareFormula, restoreCalculation } from './formula-transform.ts';
import type { FormulaRunOptions, FormulaRunResult, RawFormulaResponse } from './formula-runner-types.ts';

function hasMissingInput(calculation: string | null): boolean {
  if (!calculation) {
    return false;
  }
  return calculation
    .split('\n')
    .some((line) => /^[A-Za-z_$][\w$.]* = undefined$/.test(line));
}

function hasNonFiniteCalculation(calculation: string | null): boolean {
  if (!calculation) {
    return false;
  }
  const lastLine = calculation.trim().split('\n').at(-1) ?? '';
  return /^= (?:-?Infinity|NaN)$/.test(lastLine);
}

function hasNonFiniteResult(result: unknown, calculation: string | null): boolean {
  if (typeof result === 'number' && !Number.isFinite(result)) {
    return true;
  }
  return result === null && hasNonFiniteCalculation(calculation);
}

function durationSince(start: number): number {
  return Number((performance.now() - start).toFixed(2));
}

function failure(error: string, calculation: string | null, durationMs: number): FormulaRunResult {
  return { status: 'FAILED', result: null, error, calculation, durationMs };
}

export async function runFormula(
  text: string,
  data: Record<string, unknown>,
  options: FormulaRunOptions = {},
): Promise<FormulaRunResult> {
  const start = performance.now();
  const timeoutMs = options.timeoutMs ?? config.formula.timeoutMs;
  let raw: RawFormulaResponse;
  try {
    raw = await formulaWorkerPool.run(prepareFormula(text), data, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Formula runner is unavailable';
    return failure(message, null, durationSince(start));
  }
  const calculation = raw.calculation ? restoreCalculation(raw.calculation) : null;
  const durationMs = durationSince(start);
  if (raw.status !== 1) {
    const message = raw.error === 'Timed out'
      ? `Formula timed out after ${timeoutMs} ms`
      : normalizeFormulaError(raw.error ?? 'Formula evaluation failed');
    return failure(message, calculation, durationMs);
  }
  if (raw.data === undefined) {
    return failure('Formula produced no result', calculation, durationMs);
  }
  const missingInput = hasMissingInput(calculation);
  const missingResult = raw.data === null || (typeof raw.data === 'number' && Number.isNaN(raw.data));
  if (missingInput && missingResult) {
    return failure('Formula is missing an input value', calculation, durationMs);
  }
  if (hasNonFiniteResult(raw.data, calculation)) {
    return failure('Formula produced a non-finite result', calculation, durationMs);
  }
  if (raw.data === null && !calculation) {
    return failure('Formula produced an invalid result', calculation, durationMs);
  }
  return { status: 'SUCCESS', result: raw.data, error: null, calculation, durationMs };
}
