import type { Response } from 'express';
import type { ErrorCode } from './error-codes.ts';

interface ErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
    details: unknown;
  };
}

export function sendError(
  res: Response,
  statusCode: number,
  code: ErrorCode,
  message: string,
  details: unknown = null,
): void {
  const payload: ErrorPayload = {
    error: {
      code,
      message,
      details,
    },
  };
  res.status(statusCode).json(payload);
}
