export type Environment = 'development' | 'test' | 'production';

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly connectionLimit: number;
}

export interface FormulaConfig {
  readonly timeoutMs: number;
  readonly previewConcurrency: number;
  readonly bulkRecordConcurrency: number;
  readonly formulaConcurrency: number;
}

export interface AppConfig {
  readonly env: Environment;
  readonly isTest: boolean;
  readonly port: number;
  readonly db: DatabaseConfig;
  readonly formula: FormulaConfig;
}
