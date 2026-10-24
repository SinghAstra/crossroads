import type { NextFunction, Request, Response } from 'express';
import {
  changeFormulaBodySchema,
  createFormulaBodySchema,
  deactivateFormulaBodySchema,
  formulaUuidParamsSchema,
  rollbackFormulaBodySchema,
} from '../validation/formula-schemas.ts';
import {
  getFormulaHistory,
  getFormulaImpact,
  listFormulas as listFormulaRows,
} from '../services/formula-read-service.ts';
import {
  changeFormula,
  createFormula,
  deactivateFormula as deactivateFormulaRecord,
  rollbackFormula as rollbackFormulaRecord,
} from '../services/formula-write-service.ts';

function hasUuid(body: unknown): boolean {
  return (
    typeof body === 'object'
    && body !== null
    && !Array.isArray(body)
    && Object.hasOwn(body, 'uuid')
  );
}

export async function saveFormula(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (hasUuid(req.body)) {
      const body = changeFormulaBodySchema.parse(req.body);
      const saved = await changeFormula(body);
      res.status(200).json(saved);
      return;
    }
    const body = createFormulaBodySchema.parse(req.body);
    const saved = await createFormula(body);
    res.status(200).json(saved);
  } catch (error) {
    next(error);
  }
}

export async function deactivateFormula(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const params = formulaUuidParamsSchema.parse(req.params);
    const body = deactivateFormulaBodySchema.parse(req.body);
    const saved = await deactivateFormulaRecord(params.uuid, body);
    res.status(200).json(saved);
  } catch (error) {
    next(error);
  }
}

export async function rollbackFormula(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const params = formulaUuidParamsSchema.parse(req.params);
    const body = rollbackFormulaBodySchema.parse(req.body);
    const saved = await rollbackFormulaRecord(params.uuid, body);
    res.status(200).json(saved);
  } catch (error) {
    next(error);
  }
}

export async function listFormulas(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const formulas = await listFormulaRows();
    res.status(200).json(formulas);
  } catch (error) {
    next(error);
  }
}

export async function formulaHistory(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const params = formulaUuidParamsSchema.parse(req.params);
    const history = await getFormulaHistory(params.uuid);
    res.status(200).json(history);
  } catch (error) {
    next(error);
  }
}

export async function formulaImpact(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const params = formulaUuidParamsSchema.parse(req.params);
    const impact = await getFormulaImpact(params.uuid);
    res.status(200).json(impact);
  } catch (error) {
    next(error);
  }
}
