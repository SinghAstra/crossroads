import {
  listActiveFormulas,
  listActiveFormulasAsOf,
  type FormulaRow,
} from '../data/formula-repository.ts';

export async function loadPreviewSnapshot(asOf?: Date): Promise<FormulaRow[]> {
  if (asOf === undefined) {
    return listActiveFormulas();
  }
  return listActiveFormulasAsOf(asOf);
}
