import type { NextFunction, Request, Response } from 'express';
import { AppError } from './app-error.ts';
import { ErrorCodes } from './error-codes.ts';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(
    new AppError(
      404,
      ErrorCodes.NOT_FOUND,
      `Route ${req.method} ${req.originalUrl} not found`,
    ),
  );
}
