import { interpretor } from 'formula-interpreter';
import { expandHelpers, restoreHelpers } from './helper-expansion.ts';

export interface FormulaResponse {
  status: number;
  data?: unknown;
  error?: string;
  calculation?: string;
  highlight?: string;
}

export interface FormulaOptions {
  timeout?: number;
  memoryInMB?: number;
}

function toCodeFormula(formula: string): string {
  return formula.replace(/EXTERNAL_VAR\.(?!CODE\b)([A-Za-z_$][\w$]*)/g, 'EXTERNAL_VAR.CODE.$1');
}

export async function runFormula(
  formula: string,
  inputs: Record<string, unknown>,
  options: FormulaOptions = {},
): Promise<FormulaResponse> {
  const executable = expandHelpers(toCodeFormula(formula));
  const libraryOptions = { timeout: 5000, memoryInMB: 10, ...options };
  const response = (await interpretor(executable, [], { CODE: inputs }, libraryOptions)) as FormulaResponse;
  if (typeof response.calculation === 'string') {
    const withoutCode = response.calculation.replaceAll('EXTERNAL_VAR.CODE.', 'EXTERNAL_VAR.');
    response.calculation = restoreHelpers(withoutCode);
  }
  return response;
}
