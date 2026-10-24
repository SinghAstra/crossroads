import { AppError } from '../lib/app-error.ts';
import { ErrorCodes } from '../lib/error-codes.ts';
import { extractInputs } from '../lib/formula-inputs.ts';
import type { FormulaSnapshot } from '../lib/formula-types.ts';
import {
  findCurrentFormula,
  findFormulaVersion,
  listActiveFormulas,
  normalizeFormulaRow,
  type FormulaRow,
} from '../data/formula-repository.ts';
import { saveRecord } from '../data/save-record.ts';
import type {
  ChangeFormulaBody,
  CreateFormulaBody,
  DeactivateFormulaBody,
  RollbackFormulaBody,
} from '../validation/formula-schemas.ts';
import {
  formulaNotFound,
  formulaVersionConflict,
  formulaVersionNotFound,
  normalizeFormulaVersionConflict,
} from './formula-errors.ts';
import {
  assertActiveNameAvailable,
  assertNoDependentBreakage,
  assertSaveGraphAcyclic,
  validateFormulaSample,
} from './formula-rules.ts';

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
    throw formulaNotFound(body.uuid);
  }
  if (current.version !== body.version) {
    throw formulaVersionConflict(current);
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
    throw normalizeFormulaVersionConflict(error);
  }
}

export async function deactivateFormula(
  uuid: string,
  body: DeactivateFormulaBody,
): Promise<FormulaRow> {
  const current = await findCurrentFormula(uuid);
  if (!current) {
    throw formulaNotFound(uuid);
  }
  if (current.version !== body.version) {
    throw formulaVersionConflict(current);
  }
  if (current.status === 'INACTIVE') {
    return current;
  }
  const active = await listActiveFormulas();
  assertNoDependentBreakage(active, current.name, body.force ?? false);
  try {
    const saved = await saveRecord(
      'formulas',
      { uuid: current.uuid, status: 'INACTIVE' },
      { expectedVersion: body.version },
    );
    return normalizeFormulaRow(saved);
  } catch (error) {
    throw normalizeFormulaVersionConflict(error);
  }
}

export async function rollbackFormula(
  uuid: string,
  body: RollbackFormulaBody,
): Promise<FormulaRow> {
  const current = await findCurrentFormula(uuid);
  if (!current) {
    throw formulaNotFound(uuid);
  }
  if (current.version !== body.version) {
    throw formulaVersionConflict(current);
  }
  if (body.targetVersion >= current.version) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      'targetVersion must be older than the current version',
      { targetVersion: body.targetVersion, currentVersion: current.version },
    );
  }
  const target = await findFormulaVersion(uuid, body.targetVersion);
  if (!target) {
    throw formulaVersionNotFound(uuid, body.targetVersion);
  }
  if (target.status === 'INACTIVE' && !body.force) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      'Rolling back to an inactive version requires force',
      { targetVersion: target.version, status: target.status },
    );
  }
  const active = await listActiveFormulas();
  const proposed: FormulaSnapshot = {
    uuid: current.uuid,
    version: current.version,
    name: target.name,
    formula_text: target.formula_text,
    status: target.status,
    inputs: target.inputs,
  };
  if (proposed.status === 'ACTIVE') {
    assertActiveNameAvailable(active, proposed.name, current.uuid);
  }
  await validateFormulaSample(active, proposed);
  assertSaveGraphAcyclic(active, proposed);
  if (
    current.status === 'ACTIVE'
    && (proposed.status === 'INACTIVE' || proposed.name !== current.name)
  ) {
    assertNoDependentBreakage(active, current.name, body.force ?? false);
  }
  try {
    const saved = await saveRecord(
      'formulas',
      {
        uuid: current.uuid,
        name: proposed.name,
        formula_text: proposed.formula_text,
        status: proposed.status,
        inputs: proposed.inputs,
      },
      { expectedVersion: body.version },
    );
    return normalizeFormulaRow(saved);
  } catch (error) {
    throw normalizeFormulaVersionConflict(error);
  }
}
