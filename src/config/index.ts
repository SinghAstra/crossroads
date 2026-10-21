import { loadEnvironment } from './load-env.ts';
import { readEnvironment, readPositiveInteger, readString } from './readers.ts';
import type { AppConfig } from './types.ts';

loadEnvironment();

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
  port: readPositiveInteger('PORT', 4000),
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
