import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { createApp } from '../src/app.ts';
import { closePool } from '../src/data/close-pool.ts';
import pool from '../src/data/pool.ts';
import { closeFormulaWorkers } from '../src/lib/formula-worker-pool.ts';

const app = createApp();
const MAX_BULK_MS = 30_000;
const PERFORMANCE_RECORDS = 500;
const PERFORMANCE_FORMULAS = 10;

interface BulkFormulaExplanation {
  name: string;
  status: string;
  result: unknown;
  error: string | null;
  reason: string | null;
}

interface BulkResult {
  recordIndex: number;
  runUuid: string;
  record: Record<string, unknown>;
  formulas: BulkFormulaExplanation[];
  status: string;
}

interface BulkSummary {
  totalRecords: number;
  totalFormulas: number;
  totalMs: number;
  avgMsPerRecord: number;
  failedRecords: number;
  failedFormulas: number;
  skippedFormulas: number;
}

interface BulkBody {
  results: BulkResult[];
  summary: BulkSummary;
}

after(async () => {
  await closeFormulaWorkers();
  await closePool();
});

function uniqueName(prefix: string): string {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  return `${prefix}_${suffix}`;
}

function createFormula(
  name: string,
  formulaText: string,
  sampleData?: Record<string, unknown>,
): request.Test {
  const body: Record<string, unknown> = { name, formulaText };
  if (sampleData !== undefined) {
    body.sampleData = sampleData;
  }
  return request(app).post('/formulas').send(body);
}

function previewBulk(
  records: readonly Record<string, unknown>[],
  formulaUuids?: readonly string[],
): request.Test {
  const body: Record<string, unknown> = { records };
  if (formulaUuids !== undefined) {
    body.formulaUuids = formulaUuids;
  }
  return request(app).post('/formulas/preview/bulk').send(body);
}

async function logsForRuns(runUuids: readonly string[]): Promise<RowDataPacket[]> {
  const placeholders = runUuids.map(() => '?').join(', ');
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM formula_runs WHERE run_uuid IN (${placeholders}) ORDER BY id ASC`,
    [...runUuids],
  );
  return rows;
}

async function countFormulaLogs(formulaUuid: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS count FROM formula_runs WHERE formula_uuid = ?',
    [formulaUuid],
  );
  return Number(rows[0]?.count);
}

function formulaByName(
  formulas: readonly BulkFormulaExplanation[],
  name: string,
): BulkFormulaExplanation {
  const formula = formulas.find((item) => item.name === name);
  assert.ok(formula);
  return formula;
}

test('POST /formulas/preview/bulk returns per-record results and grouped run logs', async () => {
  const prefix = uniqueName('bulk_endpoint');
  const commissionName = `${prefix}_commission`;
  const taxName = `${prefix}_tax`;
  const totalName = `${prefix}_total`;
  const commissionText = 'return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100';
  const taxText = `return EXTERNAL_VAR.${commissionName} * 0.18`;
  const totalText = `return EXTERNAL_VAR.${commissionName} + EXTERNAL_VAR.${taxName}`;
  const total = await createFormula(totalName, totalText);
  assert.equal(total.status, 200);
  const tax = await createFormula(taxName, taxText);
  assert.equal(tax.status, 200);
  const commission = await createFormula(commissionName, commissionText);
  assert.equal(commission.status, 200);
  const records = [
    { amount: 2000, rate: 10 },
    { amount: 1000, rate: 5 },
  ];
  const response = await previewBulk(records, [total.body.uuid]);
  assert.equal(response.status, 200);
  const body = response.body as BulkBody;
  assert.equal(body.results.length, 2);
  assert.equal(body.summary.totalRecords, 2);
  assert.equal(body.summary.totalFormulas, 6);
  assert.equal(body.summary.failedRecords, 0);
  assert.equal(body.summary.failedFormulas, 0);
  assert.equal(body.summary.skippedFormulas, 0);
  assert.ok(body.summary.totalMs >= 0);
  assert.equal(
    body.summary.avgMsPerRecord,
    Number((body.summary.totalMs / 2).toFixed(2)),
  );
  assert.deepEqual(body.results.map((result) => result.recordIndex), [0, 1]);
  assert.equal(new Set(body.results.map((result) => result.runUuid)).size, 2);
  for (const result of body.results) {
    assert.match(result.runUuid, /^[0-9a-f-]{36}$/);
    assert.equal(result.status, 'SUCCESS');
    assert.deepEqual(
      result.formulas.map((formula) => formula.name),
      [commissionName, taxName, totalName],
    );
    assert.ok(result.formulas.every((formula) => formula.status === 'SUCCESS'));
  }
  assert.equal(body.results[0]?.record[commissionName], 200);
  assert.equal(body.results[0]?.record[taxName], 36);
  assert.equal(body.results[0]?.record[totalName], 236);
  assert.equal(body.results[1]?.record[commissionName], 50);
  assert.equal(body.results[1]?.record[taxName], 9);
  assert.equal(body.results[1]?.record[totalName], 59);
  const logs = await logsForRuns(body.results.map((result) => result.runUuid));
  assert.equal(logs.length, 6);
  assert.deepEqual(logs.map((row) => Number(row.record_index)), [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(
    logs.map((row) => row.formula_name),
    [
      commissionName,
      taxName,
      totalName,
      commissionName,
      taxName,
      totalName,
    ],
  );
  assert.ok(logs.slice(0, 3).every((row) => row.run_uuid === body.results[0]?.runUuid));
  assert.ok(logs.slice(3).every((row) => row.run_uuid === body.results[1]?.runUuid));
  assert.equal(Number(logs[5]?.id), Number(logs[0]?.id) + 5);
});

test('POST /formulas/preview/bulk reports failed and skipped formula metrics', async () => {
  const prefix = uniqueName('bulk_failure');
  const slowName = `${prefix}_slow`;
  const dependentName = `${prefix}_dependent`;
  const independentName = `${prefix}_independent`;
  const slow = await createFormula(
    slowName,
    'while (EXTERNAL_VAR.loop) {} return 1',
    { loop: false },
  );
  assert.equal(slow.status, 200);
  const dependent = await createFormula(
    dependentName,
    `return EXTERNAL_VAR.${slowName} + 1`,
  );
  assert.equal(dependent.status, 200);
  const independent = await createFormula(independentName, 'return 7');
  assert.equal(independent.status, 200);
  const response = await previewBulk(
    [{ loop: true }, { loop: false }],
    [slow.body.uuid, dependent.body.uuid, independent.body.uuid],
  );
  assert.equal(response.status, 200);
  const body = response.body as BulkBody;
  assert.equal(body.summary.totalRecords, 2);
  assert.equal(body.summary.totalFormulas, 6);
  assert.equal(body.summary.failedRecords, 1);
  assert.equal(body.summary.failedFormulas, 1);
  assert.equal(body.summary.skippedFormulas, 1);
  const failedRecord = body.results[0];
  const successfulRecord = body.results[1];
  assert.ok(failedRecord);
  assert.ok(successfulRecord);
  assert.equal(failedRecord.status, 'FAILED');
  assert.equal(successfulRecord.status, 'SUCCESS');
  const slowFormula = formulaByName(failedRecord.formulas, slowName);
  assert.equal(slowFormula.status, 'FAILED');
  assert.match(String(slowFormula.error), /timed out/i);
  const dependentFormula = formulaByName(failedRecord.formulas, dependentName);
  assert.equal(dependentFormula.status, 'SKIPPED');
  assert.equal(dependentFormula.reason, `dependency ${slowName} failed`);
  const independentFormula = formulaByName(failedRecord.formulas, independentName);
  assert.equal(independentFormula.status, 'SUCCESS');
  assert.equal(independentFormula.result, 7);
  assert.ok(
    successfulRecord.formulas.every((formula) => formula.status === 'SUCCESS'),
  );
  const logs = await logsForRuns(body.results.map((result) => result.runUuid));
  assert.equal(logs.length, 6);
  assert.equal(
    logs.filter((row) => Number(row.record_index) === 0).length,
    3,
  );
  assert.equal(
    logs.filter((row) => Number(row.record_index) === 1).length,
    3,
  );
});

test('POST /formulas/preview/bulk rejects request errors without writing logs', async () => {
  const prefix = uniqueName('bulk_missing');
  const fieldName = `${prefix}_field`;
  const formulaName = `${prefix}_formula`;
  const created = await createFormula(
    formulaName,
    `return EXTERNAL_VAR.${fieldName}`,
    { [fieldName]: 1 },
  );
  assert.equal(created.status, 200);
  const missing = await previewBulk(
    [{ [fieldName]: 1 }, {}],
    [created.body.uuid],
  );
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'MISSING_INPUT');
  assert.deepEqual(missing.body.error.details, {
    missing: [fieldName],
    recordIndex: 1,
  });
  assert.equal(await countFormulaLogs(created.body.uuid), 0);
  const malformed = await previewBulk([], [created.body.uuid]);
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');
  const unknown = await previewBulk([{}], [randomUUID()]);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'NOT_FOUND');
});

test('POST /formulas/preview/bulk returns zero formulas and no logs for an empty selection', async () => {
  const response = await previewBulk([{ amount: 10 }], []);
  assert.equal(response.status, 200);
  const body = response.body as BulkBody;
  assert.equal(body.results.length, 1);
  assert.equal(body.summary.totalFormulas, 0);
  assert.equal(body.summary.failedRecords, 0);
  const result = body.results[0];
  assert.ok(result);
  assert.deepEqual(result.formulas, []);
  assert.deepEqual(result.record, { amount: 10 });
  const logs = await logsForRuns([result.runUuid]);
  assert.equal(logs.length, 0);
});

test('POST /formulas/preview/bulk keeps 500 records and 10 formulas under 30 seconds', {
  timeout: 60_000,
}, async (t) => {
  const prefix = uniqueName('bulk_perf');
  const names = Array.from(
    { length: PERFORMANCE_FORMULAS },
    (_, index) => `${prefix}_f${index}`,
  );
  const formulaUuids: string[] = [];
  for (const [index, name] of names.entries()) {
    const coefficient = ((index + 1) / 100).toFixed(2);
    const created = await createFormula(
      name,
      `return EXTERNAL_VAR.amount * ${coefficient} + EXTERNAL_VAR.rate`,
    );
    assert.equal(created.status, 200);
    formulaUuids.push(String(created.body.uuid));
  }
  const records = Array.from(
    { length: PERFORMANCE_RECORDS },
    (_, index) => ({ amount: 1000 + index, rate: 5 + (index % 5) }),
  );
  const started = performance.now();
  const response = await previewBulk(records, formulaUuids);
  const elapsed = Number((performance.now() - started).toFixed(2));
  assert.equal(response.status, 200);
  const body = response.body as BulkBody;
  assert.equal(body.results.length, PERFORMANCE_RECORDS);
  assert.equal(body.summary.totalRecords, PERFORMANCE_RECORDS);
  assert.equal(body.summary.totalFormulas, PERFORMANCE_RECORDS * PERFORMANCE_FORMULAS);
  assert.equal(body.summary.failedRecords, 0);
  assert.equal(body.summary.failedFormulas, 0);
  assert.equal(body.summary.skippedFormulas, 0);
  assert.ok(body.summary.totalMs < MAX_BULK_MS);
  assert.ok(elapsed < MAX_BULK_MS);
  assert.ok(body.summary.avgMsPerRecord >= 0);
  for (const [index, result] of body.results.entries()) {
    assert.equal(result.recordIndex, index);
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.formulas.length, PERFORMANCE_FORMULAS);
    assert.ok(result.formulas.every((formula) => formula.status === 'SUCCESS'));
    assert.ok(names.every((name) => Object.hasOwn(result.record, name)));
  }
  const logs = await logsForRuns(body.results.map((result) => result.runUuid));
  assert.equal(logs.length, PERFORMANCE_RECORDS * PERFORMANCE_FORMULAS);
  t.diagnostic(
    `500 x 10 bulk preview: ${body.summary.totalMs} ms total, ${elapsed} ms wall`,
  );
});
