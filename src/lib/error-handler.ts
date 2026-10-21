import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from './app-error.ts';
import { ErrorCodes } from './error-codes.ts';
import {
  isDuplicateKeyError,
  isJsonParseError,
  isPayloadTooLargeError,
} from './error-guards.ts';
import { sendError } from './send-error.ts';

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error instanceof AppError) {
    if (error.statusCode >= 500) {
      console.error(error);
    }
    sendError(res, error.statusCode, error.code, error.message, error.details);
    return;
  }
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
      code: issue.code,
    }));
    sendError(res, 400, ErrorCodes.VALIDATION_ERROR, 'Request validation failed', details);
    return;
  }
  if (isPayloadTooLargeError(error)) {
    sendError(res, 413, ErrorCodes.PAYLOAD_TOO_LARGE, 'Request body is too large');
    return;
  }
  if (isJsonParseError(error)) {
    sendError(res, 400, ErrorCodes.INVALID_JSON, 'Request body is not valid JSON');
    return;
  }
  if (isDuplicateKeyError(error)) {
    sendError(res, 409, ErrorCodes.CONFLICT, 'The record already exists');
    return;
  }
  console.error(error);
  sendError(res, 500, ErrorCodes.INTERNAL_ERROR, 'An unexpected error occurred');
}
