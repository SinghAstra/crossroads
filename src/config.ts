import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

type Environment = 'development' | 'test' | 'production';

interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly connectionLimit: number;
}

interface FormulaConfig {
  readonly timeoutMs: number;
  readonly previewConcurrency: number;
  readonly bulkRecordConcurrency: number;
  readonly formulaConcurrency: number;
}

interface AppConfig {
  readonly env: Environment;
  readonly isTest: boolean;
  readonly port: number;
  readonly db: DatabaseConfig;
  readonly formula: FormulaConfig;
}

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(currentFile), '..');
const initialEnvironment = process.env.NODE_ENV ?? 'development';
const environmentFile = initialEnvironment === 'test' ? '.env.test' : '.env';

dotenv.config({ path: path.join(projectRoot, environmentFile), quiet: true });

function readString(name: string, fallback?: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    if (fallback !== undefined) {
      return fallback;
    }

    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readPositiveInteger(name: string, fallback: number): number {
  const rawValue = readString(name, String(fallback));
  const value = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }

  return value;
}

function readEnvironment(): Environment {
  const value = readString('NODE_ENV', 'development');

  if (value !== 'development' && value !== 'test' && value !== 'production') {
    throw new Error(`Unsupported NODE_ENV value: ${value}`);
  }

  return value;
}

const environment = readEnvironment();
const databaseName = readString(
  'DB_NAME',
  environment === 'test' ? 'crossroads_test' : 'crossroads',
);

if (environment === 'test' && !databaseName.endsWith('_test')) {
  throw new Error('The test environment must use a database whose name ends with _test');
}

const config: AppConfig = Object.freeze({
  env: environment,
  isTest: environment === 'test',
  port: readPositiveInteger('PORT', 3000),
  db: Object.freeze({
    host: readString('DB_HOST', '127.0.0.1'),
    port: readPositiveInteger('DB_PORT', 3306),
    user: readString('DB_USER', 'root'),
    password: process.env.DB_PASSWORD ?? '',
    database: databaseName,
    connectionLimit: readPositiveInteger('DB_CONNECTION_LIMIT', 10),
  }),
  formula: Object.freeze({
    timeoutMs: readPositiveInteger('FORMULA_TIMEOUT_MS', 500),
    previewConcurrency: readPositiveInteger('PREVIEW_CONCURRENCY', 4),
    bulkRecordConcurrency: readPositiveInteger('BULK_RECORD_CONCURRENCY', 4),
    formulaConcurrency: readPositiveInteger('FORMULA_CONCURRENCY', 8),
  }),
});

export default config;
