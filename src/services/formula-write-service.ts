import { AppError } from '../lib/app-error.ts';
import { ErrorCodes } from '../lib/error-codes.ts';
import { extractInputs } from '../lib/formula-inputs.ts';
import type { FormulaSnapshot } from '../lib/formula-types.ts';
import {
  findCurrentFormula,
  listActiveFormulas,
  normalizeFormulaRow,
  type FormulaRow,
} from '../data/formula-repository.ts';
import { saveRecord } from '../data/save-record.ts';
import type { ChangeFormulaBody, CreateFormulaBody } from '../validation/formula-schemas.ts';
import {
  assertActiveNameAvailable,
  assertNoDependentBreakage,
  assertSaveGraphAcyclic,
  validateFormulaSample,
} from './formula-rules.ts';

function versionConflict(current: FormulaRow): AppError {
  return new AppError(
    409,
    ErrorCodes.VERSION_CONFLICT,
    'A newer version already exists',
    { current },
  );
}

function normalizeVersionConflict(error: unknown): unknown {
  if (error instanceof AppError && error.code === ErrorCodes.VERSION_CONFLICT) {
    const details = error.details as { current?: Record<string, unknown> } | null;
    if (details?.current) {
      return new AppError(
        409,
        ErrorCodes.VERSION_CONFLICT,
        error.message,
        { current: normalizeFormulaRow(details.current) },
      );
    }
  }
  return error;
}

function createSnapshot(body: CreateFormulaBody): FormulaSnapshot {
  return {
    uuid: '',
    version: 0,
    name: body.name,
    formula_text: body.formulaText,
    status: 'ACTIVE',
    inputs: extractInputs(body.formulaText),
  };
}

export async function createFormula(body: CreateFormulaBody): Promise<FormulaRow> {
  const active = await listActiveFormulas();
  const proposed = createSnapshot(body);
  assertActiveNameAvailable(active, proposed.name);
  await validateFormulaSample(active, proposed, body.sampleData);
  assertSaveGraphAcyclic(active, proposed);
  const data: Record<string, unknown> = {
    name: proposed.name,
    formula_text: proposed.formula_text,
    status: proposed.status,
    inputs: proposed.inputs,
  };
  if (body.createdBy !== undefined) {
    data.created_by = body.createdBy;
  }
  const saved = await saveRecord('formulas', data);
  return normalizeFormulaRow(saved);
}

export async function changeFormula(body: ChangeFormulaBody): Promise<FormulaRow> {
  const current = await findCurrentFormula(body.uuid);
  if (!current) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Formula not found', { uuid: body.uuid });
  }
  if (current.version !== body.version) {
    throw versionConflict(current);
  }
  const active = await listActiveFormulas();
  const formulaText = body.formulaText ?? current.formula_text;
  const proposed: FormulaSnapshot = {
    uuid: current.uuid,
    version: current.version,
    name: body.name ?? current.name,
    formula_text: formulaText,
    status: current.status,
    inputs: extractInputs(formulaText),
  };
  if (proposed.status === 'ACTIVE') {
    assertActiveNameAvailable(active, proposed.name, current.uuid);
  }
  await validateFormulaSample(active, proposed, body.sampleData);
  assertSaveGraphAcyclic(active, proposed);
  if (proposed.status === 'ACTIVE' && proposed.name !== current.name) {
    assertNoDependentBreakage(active, current.name, body.force ?? false);
  }
  try {
    const saved = await saveRecord(
      'formulas',
      {
        uuid: current.uuid,
        name: proposed.name,
        formula_text: proposed.formula_text,
        inputs: proposed.inputs,
      },
      { expectedVersion: body.version },
    );
    return normalizeFormulaRow(saved);
  } catch (error) {
    throw normalizeVersionConflict(error);
  }
}
