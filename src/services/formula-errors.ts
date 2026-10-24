import { AppError } from '../lib/app-error.ts';
import { ErrorCodes } from '../lib/error-codes.ts';
import { normalizeFormulaRow, type FormulaRow } from '../data/formula-repository.ts';

export function formulaNotFound(uuid: string): AppError {
  return new AppError(404, ErrorCodes.NOT_FOUND, 'Formula not found', { uuid });
}

export function formulaVersionConflict(current: FormulaRow): AppError {
  return new AppError(
    409,
    ErrorCodes.VERSION_CONFLICT,
    'A newer version already exists',
    { current },
  );
}

export function formulaVersionNotFound(uuid: string, targetVersion: number): AppError {
  return new AppError(404, ErrorCodes.NOT_FOUND, 'Formula version not found', {
    uuid,
    targetVersion,
  });
}

export function normalizeFormulaVersionConflict(error: unknown): unknown {
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
