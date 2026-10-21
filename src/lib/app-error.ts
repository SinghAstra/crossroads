import type { ErrorCode } from './error-codes.ts';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details: unknown;
  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details: unknown = null,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
