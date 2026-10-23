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

after(async () => {
  await closeFormulaWorkers();
  await closePool();
});

function uniqueName(prefix: string): string {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  return `${prefix}_${suffix}`;
}

async function createFormula(
  name: string,
  formulaText: string,
  sampleData?: Record<string, unknown>,
): Promise<request.Response> {
  const body: Record<string, unknown> = { name, formulaText };
  if (sampleData !== undefined) {
    body.sampleData = sampleData;
  }
  return request(app).post('/formulas').send(body);
}

async function countByName(name: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS count FROM formulas WHERE name = ?',
    [name],
  );
  return Number(rows[0]?.count ?? 0);
}

test('POST /formulas creates a formula through the save path', async () => {
  const name = uniqueName('create');
  const response = await request(app).post('/formulas').send({
    name,
    formulaText: 'return EXTERNAL_VAR.amount * 2',
    sampleData: { amount: 5 },
    createdBy: 'api-test',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.name, name);
  assert.equal(response.body.version, 1);
  assert.equal(response.body.status, 'ACTIVE');
  assert.equal(response.body.created_by, 'api-test');
  assert.deepEqual(response.body.inputs, ['amount']);
  assert.equal(typeof response.body.uuid, 'string');
  assert.equal(await countByName(name), 1);
});

test('POST /formulas rejects duplicate active names case-sensitively', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const lower = `case_tax_${suffix}`;
  const upper = `CASE_TAX_${suffix}`;
  const first = await createFormula(lower, 'return 1');
  assert.equal(first.status, 200);
  const duplicate = await createFormula(lower, 'return 2');
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.body.error.code, 'VALIDATION_ERROR');
  assert.match(duplicate.body.error.message, /already exists/);
  assert.equal(await countByName(lower), 1);
  const differentCase = await createFormula(upper, 'return 1');
  assert.equal(differentCase.status, 200);
  assert.equal(await countByName(upper), 1);
});

test('POST /formulas rejects invalid identifiers without inserting', async () => {
  const name = `1bad_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const response = await createFormula(name, 'return 1');
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  assert.ok(response.body.error.details.some(
    (issue: { path: string }) => issue.path === 'name',
  ));
  assert.equal(await countByName(name), 0);
});

test('POST /formulas rejects syntax, runtime, non-finite, and timeout formulas', async () => {
  const cases = [
    ['syntax', 'return EXTERNAL_VAR.amount *'],
    ['runtime', 'return EXTERNAL_VAR.amount.notAFunction()'],
    ['nonfinite', 'return EXTERNAL_VAR.amount / 0'],
    ['timeout', 'while (true) {} return 1'],
  ] as const;
  for (const [prefix, formulaText] of cases) {
    const name = uniqueName(prefix);
    const response = await createFormula(name, formulaText, { amount: 1 });
    assert.equal(response.status, 400, prefix);
    assert.equal(response.body.error.code, 'FORMULA_INVALID', prefix);
    assert.equal(await countByName(name), 0, prefix);
  }
});

test('POST /formulas rejects sampleData missing a referenced field', async () => {
  const name = uniqueName('sample_missing');
  const response = await createFormula(name, 'return EXTERNAL_VAR.amount * 2', {});
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(response.body.error.details.missing, ['amount']);
  assert.equal(await countByName(name), 0);
});

test('POST /formulas accepts dependency-order creation without sample data', async () => {
  const commission = uniqueName('commission');
  const tax = uniqueName('tax');
  const total = uniqueName('total');
  const commissionResponse = await createFormula(
    commission,
    'return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100',
  );
  assert.equal(commissionResponse.status, 200);
  const taxResponse = await createFormula(
    tax,
    `return EXTERNAL_VAR.${commission} * 0.18`,
  );
  assert.equal(taxResponse.status, 200);
  const totalResponse = await createFormula(
    total,
    `return EXTERNAL_VAR.${commission} + EXTERNAL_VAR.${tax}`,
  );
  assert.equal(totalResponse.status, 200);
  assert.deepEqual(totalResponse.body.inputs, [commission, tax]);
});

test('POST /formulas changes a formula and keeps the old version', async () => {
  const commission = uniqueName('change_commission');
  const tax = uniqueName('change_tax');
  const commissionResponse = await createFormula(commission, 'return EXTERNAL_VAR.amount');
  assert.equal(commissionResponse.status, 200);
  const created = await createFormula(tax, `return EXTERNAL_VAR.${commission} * 0.18`);
  assert.equal(created.status, 200);
  const response = await request(app).post('/formulas').send({
    uuid: created.body.uuid,
    version: 1,
    formulaText: `return EXTERNAL_VAR.${commission} * 0.12`,
    sampleData: { [commission]: 100 },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.uuid, created.body.uuid);
  assert.equal(response.body.version, 2);
  assert.equal(response.body.formula_text, `return EXTERNAL_VAR.${commission} * 0.12`);
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT version, formula_text FROM formulas WHERE uuid = ? ORDER BY version ASC',
    [created.body.uuid],
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.formula_text, `return EXTERNAL_VAR.${commission} * 0.18`);
  assert.equal(rows[1]?.formula_text, `return EXTERNAL_VAR.${commission} * 0.12`);
});

test('POST /formulas returns 404 for an unknown change uuid', async () => {
  const response = await request(app).post('/formulas').send({
    uuid: randomUUID(),
    version: 1,
    formulaText: 'return 1',
  });
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'NOT_FOUND');
});

test('POST /formulas rejects a stale base version with the current row', async () => {
  const name = uniqueName('stale');
  const created = await createFormula(name, 'return 1');
  assert.equal(created.status, 200);
  const changed = await request(app).post('/formulas').send({
    uuid: created.body.uuid,
    version: 1,
    formulaText: 'return 2',
  });
  assert.equal(changed.status, 200);
  const stale = await request(app).post('/formulas').send({
    uuid: created.body.uuid,
    version: 1,
    formulaText: 'return 3',
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  assert.equal(stale.body.error.details.current.version, 2);
  assert.equal(stale.body.error.details.current.formula_text, 'return 2');
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS count FROM formulas WHERE uuid = ?',
    [created.body.uuid],
  );
  assert.equal(rows[0]?.count, 2);
});

test('POST /formulas serializes simultaneous changes on the same base version', async () => {
  const name = uniqueName('race');
  const created = await createFormula(name, 'return 1');
  assert.equal(created.status, 200);
  const first = request(app).post('/formulas').send({
    uuid: created.body.uuid,
    version: 1,
    formulaText: 'return 2',
  });
  const second = request(app).post('/formulas').send({
    uuid: created.body.uuid,
    version: 1,
    formulaText: 'return 3',
  });
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  const statuses = [firstResponse.status, secondResponse.status].sort((left, right) => left - right);
  assert.deepEqual(statuses, [200, 409]);
  const conflict = firstResponse.status === 409 ? firstResponse : secondResponse;
  const winner = firstResponse.status === 200 ? firstResponse : secondResponse;
  assert.equal(conflict.body.error.code, 'VERSION_CONFLICT');
  assert.equal(conflict.body.error.details.current.version, 2);
  assert.equal(winner.body.version, 2);
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS count FROM formulas WHERE uuid = ?',
    [created.body.uuid],
  );
  assert.equal(rows[0]?.count, 2);
});

test('POST /formulas rejects a cycle with the full path', async () => {
  const a = uniqueName('a');
  const b = uniqueName('b');
  const c = uniqueName('c');
  assert.equal((await createFormula(a, `return EXTERNAL_VAR.${b}`)).status, 200);
  assert.equal((await createFormula(b, `return EXTERNAL_VAR.${c}`)).status, 200);
  const response = await createFormula(c, `return EXTERNAL_VAR.${a}`);
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'DEPENDENCY_CYCLE');
  assert.deepEqual(response.body.error.details.path, [a, b, c, a]);
  assert.match(response.body.error.message, new RegExp(`${a} -> ${b} -> ${c} -> ${a}`));
  assert.equal(await countByName(c), 0);
  assert.equal(await countByName(a), 1);
  assert.equal(await countByName(b), 1);
});

test('POST /formulas rejects an unforced rename and allows force', async () => {
  const commission = uniqueName('guard_commission');
  const tax = uniqueName('guard_tax');
  const total = uniqueName('guard_total');
  assert.equal((await createFormula(commission, 'return EXTERNAL_VAR.amount')).status, 200);
  const taxResponse = await createFormula(tax, `return EXTERNAL_VAR.${commission}`);
  assert.equal(taxResponse.status, 200);
  assert.equal((await createFormula(total, `return EXTERNAL_VAR.${tax}`)).status, 200);
  const renamed = uniqueName('guard_tax_renamed');
  const blocked = await request(app).post('/formulas').send({
    uuid: taxResponse.body.uuid,
    version: 1,
    name: renamed,
  });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'DEPENDENTS_EXIST');
  assert.deepEqual(
    blocked.body.error.details.impacted.map((item: { name: string }) => item.name),
    [total],
  );
  assert.equal(await countByName(tax), 1);
  const forced = await request(app).post('/formulas').send({
    uuid: taxResponse.body.uuid,
    version: 1,
    name: renamed,
    force: true,
  });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.name, renamed);
  assert.equal(forced.body.version, 2);
});
