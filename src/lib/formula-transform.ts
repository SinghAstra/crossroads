import { expandHelpers, restoreHelpers } from './formula-helpers.ts';

export function toCodeFormula(formula: string): string {
  return formula.replace(/EXTERNAL_VAR\.(?!CODE\b)([A-Za-z_$][\w$]*)/g, 'EXTERNAL_VAR.CODE.$1');
}

export function prepareFormula(formula: string): string {
  return expandHelpers(toCodeFormula(formula));
}

export function normalizeFormulaError(message: string): string {
  return message.replaceAll('EXTERNAL_VAR.CODE.', 'EXTERNAL_VAR.');
}

export function restoreCalculation(calculation: string): string {
  return restoreHelpers(calculation.replaceAll('EXTERNAL_VAR.CODE.', 'EXTERNAL_VAR.'));
}
