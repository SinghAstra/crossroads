import type { NextFunction, Request, Response } from 'express';
import {
  changeFormulaBodySchema,
  createFormulaBodySchema,
} from '../validation/formula-schemas.ts';
import { changeFormula, createFormula } from '../services/formula-write-service.ts';

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
