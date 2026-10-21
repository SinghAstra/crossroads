export function isJsonParseError(error: unknown): error is SyntaxError {
  return error instanceof SyntaxError && 'body' in error;
}

export function isPayloadTooLargeError(error: unknown): error is Error & { type: string } {
  return (
    error instanceof Error &&
    'type' in error &&
    (error as { type?: unknown }).type === 'entity.too.large'
  );
}

export function isDuplicateKeyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ER_DUP_ENTRY'
  );
}
