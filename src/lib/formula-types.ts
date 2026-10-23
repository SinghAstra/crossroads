export type FormulaStatus = 'ACTIVE' | 'INACTIVE';

export interface FormulaSnapshot {
  readonly uuid: string;
  readonly version: number;
  readonly name: string;
  readonly formula_text: string;
  readonly status: FormulaStatus;
  readonly inputs: readonly string[];
}
