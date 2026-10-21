import { interpretor } from 'formula-interpreter';
import { expandHelpers, restoreHelpers } from './helper-expansion.ts';

export interface FormulaResponse {
  status: number;
  data?: unknown;
  error?: string;
  calculation?: string;
  highlight?: string;
}

function toCodeFormula(formula: string): string {
  return formula.replace(/EXTERNAL_VAR\.(?!CODE\b)([A-Za-z_$][\w$]*)/g, 'EXTERNAL_VAR.CODE.$1');
}

export async function runFormula(
  formula: string,
  inputs: Record<string, unknown>,
): Promise<FormulaResponse> {
  const executable = expandHelpers(toCodeFormula(formula));
  const response = (await interpretor(executable, [], { CODE: inputs })) as FormulaResponse;
  if (typeof response.calculation === 'string') {
    const withoutCode = response.calculation.replaceAll('EXTERNAL_VAR.CODE.', 'EXTERNAL_VAR.');
    response.calculation = restoreHelpers(withoutCode);
  }
  return response;
}
