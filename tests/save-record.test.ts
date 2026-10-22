import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { closePool } from '../src/data/close-pool.ts';
import pool from '../src/data/pool.ts';
import { saveRecord, type SavedRecord } from '../src/data/save-record.ts';

after(async () => {
  await closePool();
});

function timestamp(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  return new Date(String(value)).getTime();
}

function parsedJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function createTestFormula(): Promise<SavedRecord> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  return saveRecord('formulas', {
    name: `save_create_${suffix}`,
    formula_text: 'return 1',
    created_by: 'save-record-test',
    inputs: ['amount'],
  });
}

test('saveRecord creates a generated version 1 formula', async () => {
  const created = await createTestFormula();
  assert.equal(typeof created.id, 'number');
  assert.equal(typeof created.uuid, 'string');
  assert.equal(created.version, 1);
  assert.equal(created.status, 'ACTIVE');
  assert.equal(created.created_by, 'save-record-test');
  assert.equal(created.formula_text, 'return 1');
  assert.deepEqual(parsedJson(created.inputs), ['amount']);
  assert.ok(timestamp(created.first_created_at) > 0);
  assert.ok(timestamp(created.inserted_at) > 0);
});

test('saveRecord changes only sent fields and inserts the next version', async () => {
  const created = await createTestFormula();
  const changed = await saveRecord('formulas', {
    uuid: created.uuid,
    formula_text: 'return 2',
    status: undefined,
    created_by: 'ignored-change',
    first_created_at: new Date(0),
    version: 99,
  });
  assert.equal(changed.uuid, created.uuid);
  assert.equal(changed.version, 2);
  assert.equal(changed.formula_text, 'return 2');
  assert.equal(changed.name, created.name);
  assert.equal(changed.status, created.status);
  assert.equal(changed.created_by, created.created_by);
  assert.deepEqual(parsedJson(changed.inputs), parsedJson(created.inputs));
  assert.equal(timestamp(changed.first_created_at), timestamp(created.first_created_at));
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT version, name, formula_text, status, created_by FROM formulas WHERE uuid = ? ORDER BY version ASC',
    [created.uuid],
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.version, 1);
  assert.equal(rows[0]?.formula_text, 'return 1');
  assert.equal(rows[1]?.version, 2);
  assert.equal(rows[1]?.formula_text, 'return 2');
  assert.equal(rows[1]?.name, created.name);
  assert.equal(rows[1]?.status, created.status);
  assert.equal(rows[1]?.created_by, created.created_by);
});

test('saveRecord appends rows for a table without a row version', async () => {
  const runUuid = randomUUID();
  const run = await saveRecord('formula_runs', {
    run_uuid: runUuid,
    formula_uuid: randomUUID(),
    formula_name: 'save_run_demo',
    formula_version: 1,
    input_json: { amount: 1 },
    result: 42,
    calculation_text: 'return 42',
    error: null,
    status: 'SUCCESS',
  });
  assert.equal(run.run_uuid, runUuid);
  assert.equal(run.formula_version, 1);
  assert.equal(run.record_index, 0);
  assert.equal(run.status, 'SUCCESS');
  assert.deepEqual(parsedJson(run.input_json), { amount: 1 });
  assert.equal(parsedJson(run.result), 42);
});
