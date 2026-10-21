export interface RawFormulaResponse {
  status: number;
  data?: unknown;
  error?: string;
  calculation?: string;
  highlight?: string;
}

export interface FormulaRunOptions {
  timeoutMs?: number;
}

export interface FormulaRunResult {
  status: 'SUCCESS' | 'FAILED';
  result: unknown;
  error: string | null;
  calculation: string | null;
  durationMs: number;
}

export interface FormulaWorkerRequest {
  evalString: string;
  libraries: string[];
  EXTERNAL_VAR: { CODE: Record<string, unknown> };
}
