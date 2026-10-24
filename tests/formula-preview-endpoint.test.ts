import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { createApp } from '../src/app.ts';
import { closePool } from '../src/data/close-pool.ts';
import pool from '../src/data/pool.ts';
import { closeFormulaWorkers } from '../src/lib/formula-worker-pool.ts';

const app = createApp();

interface ExplanationSteps {
  inputs: Record<string, unknown>;
  formula: string;
  substituted: string | null;
  result: unknown;
  calculation?: string;
}

interface FormulaExplanation {
  uuid: string;
  name: string;
  version: number;
  autoAdded: boolean;
  status: string;
  result: unknown;
  steps: ExplanationSteps;
  error: string | null;
  reason: string | null;
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

function preview(body: Record<string, unknown>): request.Test {
  return request(app).post('/formulas/preview').send(body);
}

function changeFormula(
  formulaUuid: string,
  version: number,
  formulaText: string,
): request.Test {
  return request(app).post('/formulas').send({ uuid: formulaUuid, version, formulaText });
}

async function latestInsertedAt(
  firstUuid: string,
  secondUuid: string,
  thirdUuid: string,
): Promise<Date> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT MAX(inserted_at) AS inserted_at FROM formulas WHERE uuid IN (?, ?, ?)',
    [firstUuid, secondUuid, thirdUuid],
  );
  const value = rows[0]?.inserted_at;
  if (value instanceof Date) {
    return value;
  }
  return new Date(String(value));
}

async function runLogs(runUuid: string): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM formula_runs WHERE run_uuid = ? ORDER BY id ASC',
    [runUuid],
  );
  return rows;
}

function formulaByName(
  formulas: FormulaExplanation[],
  name: string,
): FormulaExplanation {
  const formula = formulas.find((item) => item.name === name);
  assert.ok(formula);
  return formula;
}

test('POST /formulas/preview runs the worked example created in reverse dependency order', async () => {
  const prefix = uniqueName('preview_example');
  const commissionName = `${prefix}_commission`;
  const taxName = `${prefix}_tax`;
  const totalName = `${prefix}_total`;
  const totalText = `return EXTERNAL_VAR.${commissionName} + EXTERNAL_VAR.${taxName}`;
  const taxText = `return EXTERNAL_VAR.${commissionName} * 0.18`;
  const commissionText = 'return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100';
  const total = await createFormula(totalName, totalText);
  assert.equal(total.status, 200);
  const tax = await createFormula(taxName, taxText);
  assert.equal(tax.status, 200);
  const commission = await createFormula(commissionName, commissionText);
  assert.equal(commission.status, 200);
  const record = { amount: 2000, rate: 10, [totalName]: 999 };
  const response = await preview({
    record,
    formulaUuids: [total.body.uuid],
  });
  assert.equal(response.status, 200);
  const body = response.body as {
    runUuid: string;
    inputRecord: Record<string, unknown>;
    record: Record<string, unknown>;
    formulas: FormulaExplanation[];
  };
  assert.match(body.runUuid, /^[0-9a-f-]{36}$/);
  assert.deepEqual(body.inputRecord, record);
  assert.equal(body.record.amount, 2000);
  assert.equal(body.record.rate, 10);
  assert.equal(body.record[commissionName], 200);
  assert.equal(body.record[taxName], 36);
  assert.equal(body.record[totalName], 236);
  assert.deepEqual(
    body.formulas.map((formula) => formula.name),
    [commissionName, taxName, totalName],
  );
  const commissionFormula = formulaByName(body.formulas, commissionName);
  assert.equal(commissionFormula.uuid, commission.body.uuid);
  assert.equal(commissionFormula.version, 1);
  assert.equal(commissionFormula.autoAdded, true);
  assert.equal(commissionFormula.status, 'SUCCESS');
  assert.equal(commissionFormula.result, 200);
  assert.equal(commissionFormula.error, null);
  assert.equal(commissionFormula.reason, null);
  assert.deepEqual(commissionFormula.steps, {
    inputs: { amount: 2000, rate: 10 },
    formula: commissionText,
    substituted: '= 2000 * 10 / 100',
    result: 200,
  });
  const taxFormula = formulaByName(body.formulas, taxName);
  assert.equal(taxFormula.autoAdded, true);
  assert.equal(taxFormula.status, 'SUCCESS');
  assert.equal(taxFormula.result, 36);
  assert.deepEqual(taxFormula.steps, {
    inputs: { [commissionName]: 200 },
    formula: taxText,
    substituted: '= 200 * 0.18',
    result: 36,
  });
  const totalFormula = formulaByName(body.formulas, totalName);
  assert.equal(totalFormula.autoAdded, false);
  assert.equal(totalFormula.status, 'SUCCESS');
  assert.equal(totalFormula.result, 236);
  assert.deepEqual(totalFormula.steps, {
    inputs: { [commissionName]: 200, [taxName]: 36 },
    formula: totalText,
    substituted: '= 200 + 36',
    result: 236,
  });
  const logs = await runLogs(body.runUuid);
  assert.equal(logs.length, 3);
  assert.deepEqual(
    logs.map((row) => row.formula_name),
    [commissionName, taxName, totalName],
  );
  assert.deepEqual(logs.map((row) => row.status), ['SUCCESS', 'SUCCESS', 'SUCCESS']);
  assert.ok(logs.every((row) => row.run_uuid === body.runUuid));
  assert.ok(logs.every((row) => Number(row.record_index) === 0));
  assert.equal(Number(logs[2]?.id), Number(logs[0]?.id) + 2);
  assert.deepEqual(logs[0]?.input_json, record);
  assert.deepEqual(logs[1]?.input_json, {
    ...record,
    [commissionName]: 200,
  });
  assert.deepEqual(logs[2]?.input_json, {
    ...record,
    [commissionName]: 200,
    [taxName]: 36,
  });
  assert.deepEqual(logs.map((row) => row.result), [200, 36, 236]);
  assert.ok(logs.every((row) => row.error === null));
  assert.match(String(logs[0]?.calculation_text), /return EXTERNAL_VAR\.amount/);
  assert.match(String(logs[1]?.calculation_text), /return EXTERNAL_VAR\..*_commission \* 0\.18/);
  assert.match(String(logs[2]?.calculation_text), /return EXTERNAL_VAR\..*_commission \+ EXTERNAL_VAR\..*_tax/);
});

test('POST /formulas/preview uses the historical snapshot when asOf is provided', async () => {
  const prefix = uniqueName('preview_asof');
  const commissionName = `${prefix}_commission`;
  const taxName = `${prefix}_tax`;
  const totalName = `${prefix}_total`;
  const commissionText = 'return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100';
  const taxText = `return EXTERNAL_VAR.${commissionName} * 0.18`;
  const changedTaxText = `return EXTERNAL_VAR.${commissionName} * 0.20`;
  const totalText = `return EXTERNAL_VAR.${commissionName} + EXTERNAL_VAR.${taxName}`;
  const total = await createFormula(totalName, totalText);
  assert.equal(total.status, 200);
  const tax = await createFormula(taxName, taxText);
  assert.equal(tax.status, 200);
  const commission = await createFormula(commissionName, commissionText);
  assert.equal(commission.status, 200);
  const historicalTimestamp = await latestInsertedAt(
    total.body.uuid,
    tax.body.uuid,
    commission.body.uuid,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const changed = await changeFormula(tax.body.uuid, 1, changedTaxText);
  assert.equal(changed.status, 200);
  assert.equal(changed.body.version, 2);
  assert.ok(
    new Date(String(changed.body.inserted_at)).getTime() > historicalTimestamp.getTime(),
  );
  const record = { amount: 2000, rate: 10 };
  const historical = await preview({
    record,
    formulaUuids: [total.body.uuid],
    asOf: historicalTimestamp.toISOString(),
  });
  assert.equal(historical.status, 200);
  const historicalBody = historical.body as {
    runUuid: string;
    record: Record<string, unknown>;
    formulas: FormulaExplanation[];
  };
  assert.equal(historicalBody.record[commissionName], 200);
  assert.equal(historicalBody.record[taxName], 36);
  assert.equal(historicalBody.record[totalName], 236);
  const historicalTax = formulaByName(historicalBody.formulas, taxName);
  assert.equal(historicalTax.version, 1);
  assert.equal(historicalTax.result, 36);
  assert.equal(historicalTax.steps.formula, taxText);
  const historicalLogs = await runLogs(historicalBody.runUuid);
  assert.equal(historicalLogs.length, 3);
  assert.equal(Number(historicalLogs[2]?.id), Number(historicalLogs[0]?.id) + 2);
  assert.deepEqual(
    historicalLogs.map((row) => row.formula_name),
    [commissionName, taxName, totalName],
  );
  assert.deepEqual(
    historicalLogs.map((row) => Number(row.formula_version)),
    [1, 1, 1],
  );
  assert.deepEqual(historicalLogs.map((row) => row.result), [200, 36, 236]);
  const current = await preview({
    record,
    formulaUuids: [total.body.uuid],
  });
  assert.equal(current.status, 200);
  const currentBody = current.body as {
    runUuid: string;
    record: Record<string, unknown>;
    formulas: FormulaExplanation[];
  };
  assert.equal(currentBody.record[commissionName], 200);
  assert.equal(currentBody.record[taxName], 40);
  assert.equal(currentBody.record[totalName], 240);
  const currentTax = formulaByName(currentBody.formulas, taxName);
  assert.equal(currentTax.version, 2);
  assert.equal(currentTax.result, 40);
  assert.equal(currentTax.steps.formula, changedTaxText);
  const currentLogs = await runLogs(currentBody.runUuid);
  assert.equal(currentLogs.length, 3);
  assert.equal(Number(currentLogs[2]?.id), Number(currentLogs[0]?.id) + 2);
  assert.deepEqual(
    currentLogs.map((row) => Number(row.formula_version)),
    [1, 2, 1],
  );
  assert.deepEqual(currentLogs.map((row) => row.result), [200, 40, 240]);
});

test('POST /formulas/preview isolates failures and returns FAILED, SKIPPED, and SUCCESS', async () => {
  const prefix = uniqueName('preview_failure');
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
  const response = await preview({
    record: { loop: true },
    formulaUuids: [slow.body.uuid, dependent.body.uuid, independent.body.uuid],
  });
  assert.equal(response.status, 200);
  const body = response.body as {
    runUuid: string;
    inputRecord: Record<string, unknown>;
    record: Record<string, unknown>;
    formulas: FormulaExplanation[];
  };
  assert.deepEqual(body.inputRecord, { loop: true });
  assert.deepEqual(body.record, { loop: true, [independentName]: 7 });
  const slowFormula = formulaByName(body.formulas, slowName);
  assert.equal(slowFormula.status, 'FAILED');
  assert.equal(slowFormula.result, null);
  assert.match(String(slowFormula.error), /timed out/i);
  assert.equal(slowFormula.reason, null);
  assert.equal(slowFormula.steps.substituted, null);
  assert.equal(slowFormula.steps.result, null);
  const dependentFormula = formulaByName(body.formulas, dependentName);
  assert.equal(dependentFormula.status, 'SKIPPED');
  assert.equal(dependentFormula.result, null);
  assert.equal(dependentFormula.error, null);
  assert.equal(dependentFormula.reason, `dependency ${slowName} failed`);
  assert.equal(dependentFormula.steps.substituted, null);
  assert.equal(dependentFormula.steps.result, null);
  const independentFormula = formulaByName(body.formulas, independentName);
  assert.equal(independentFormula.status, 'SUCCESS');
  assert.equal(independentFormula.result, 7);
  assert.equal(independentFormula.error, null);
  assert.equal(independentFormula.reason, null);
  const logs = await runLogs(body.runUuid);
  assert.equal(logs.length, 3);
  assert.equal(Number(logs[2]?.id), Number(logs[0]?.id) + 2);
  const slowLog = logs.find((row) => row.formula_name === slowName);
  assert.ok(slowLog);
  assert.equal(slowLog.status, 'FAILED');
  assert.equal(slowLog.result, null);
  assert.match(String(slowLog.error), /timed out/i);
  assert.equal(slowLog.calculation_text, null);
  assert.deepEqual(slowLog.input_json, { loop: true });
  const dependentLog = logs.find((row) => row.formula_name === dependentName);
  assert.ok(dependentLog);
  assert.equal(dependentLog.status, 'SKIPPED');
  assert.equal(dependentLog.result, null);
  assert.equal(dependentLog.error, `dependency ${slowName} failed`);
  assert.equal(dependentLog.calculation_text, null);
  assert.deepEqual(dependentLog.input_json, {
    loop: true,
    [independentName]: 7,
  });
  const independentLog = logs.find((row) => row.formula_name === independentName);
  assert.ok(independentLog);
  assert.equal(independentLog.status, 'SUCCESS');
  assert.deepEqual(independentLog.result, 7);
  assert.equal(independentLog.error, null);
});

test('POST /formulas/preview rejects request errors without writing run logs', async () => {
  const prefix = uniqueName('preview_missing');
  const fieldName = `${prefix}_field`;
  const formulaName = `${prefix}_formula`;
  const created = await createFormula(
    formulaName,
    `return EXTERNAL_VAR.${fieldName}`,
    { [fieldName]: 1 },
  );
  assert.equal(created.status, 200);
  const missing = await preview({
    record: {},
    formulaUuids: [created.body.uuid],
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'MISSING_INPUT');
  assert.deepEqual(missing.body.error.details, { missing: [fieldName] });
  const [countRows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS count FROM formula_runs WHERE formula_uuid = ?',
    [created.body.uuid],
  );
  assert.equal(Number(countRows[0]?.count), 0);
  const unknown = await preview({
    record: {},
    formulaUuids: [randomUUID()],
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'NOT_FOUND');
  const invalid = await preview({});
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
});

test('POST /formulas/preview preserves string results in the response and run log', async () => {
  const name = uniqueName('preview_string');
  const created = await createFormula(name, 'return "123"');
  assert.equal(created.status, 200);
  const response = await preview({
    record: { [name]: 999 },
    formulaUuids: [created.body.uuid],
  });
  assert.equal(response.status, 200);
  const body = response.body as {
    runUuid: string;
    record: Record<string, unknown>;
    formulas: FormulaExplanation[];
  };
  assert.equal(body.record[name], '123');
  assert.equal(body.formulas[0]?.result, '123');
  const logs = await runLogs(body.runUuid);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.result, '123');
});

test('POST /formulas/preview returns an empty result set without writing logs', async () => {
  const response = await preview({
    record: { amount: 10 },
    formulaUuids: [],
  });
  assert.equal(response.status, 200);
  const body = response.body as {
    runUuid: string;
    inputRecord: Record<string, unknown>;
    record: Record<string, unknown>;
    formulas: unknown[];
  };
  assert.match(body.runUuid, /^[0-9a-f-]{36}$/);
  assert.deepEqual(body.inputRecord, { amount: 10 });
  assert.deepEqual(body.record, { amount: 10 });
  assert.deepEqual(body.formulas, []);
  const logs = await runLogs(body.runUuid);
  assert.equal(logs.length, 0);
});
