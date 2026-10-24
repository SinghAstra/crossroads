import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { createApp } from '../src/app.ts';
import { closePool } from '../src/data/close-pool.ts';
import type { FormulaRow } from '../src/data/formula-repository.ts';
import pool from '../src/data/pool.ts';
import { AppError } from '../src/lib/app-error.ts';
import { closeFormulaWorkers } from '../src/lib/formula-worker-pool.ts';
import {
  resolvePreviewSelection,
  type PreviewSelection,
} from '../src/services/formula-selection-service.ts';
import { loadPreviewSnapshot } from '../src/services/formula-snapshot-service.ts';
import { previewBodySchema } from '../src/validation/preview-schemas.ts';

const app = createApp();
const uuid = '00000000-0000-4000-8000-000000000001';

after(async () => {
  await closeFormulaWorkers();
  await closePool();
});

function uniqueName(prefix: string): string {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  return `${prefix}_${suffix}`;
}

function formulaRow(
  name: string,
  inputs: readonly string[],
  formulaUuid = `${name}-uuid`,
): FormulaRow {
  return {
    id: 1,
    uuid: formulaUuid,
    version: 1,
    name,
    formula_text: 'return 1',
    status: 'ACTIVE',
    created_by: 'test',
    first_created_at: new Date(0),
    inserted_at: new Date(0),
    inputs,
  };
}

function selectionPairs(selection: readonly PreviewSelection[]): Array<[string, boolean]> {
  return selection.map((item) => [item.formula.name, item.autoAdded]);
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

async function changeFormula(
  formulaUuid: string,
  version: number,
  formulaText: string,
): Promise<request.Response> {
  return request(app).post('/formulas').send({ uuid: formulaUuid, version, formulaText });
}

async function deactivateFormula(
  formulaUuid: string,
  version: number,
): Promise<request.Response> {
  return request(app)
    .post(`/formulas/${formulaUuid}/deactivate`)
    .send({ version });
}

async function insertedAt(formulaUuid: string, version: number): Promise<Date> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT inserted_at FROM formulas WHERE uuid = ? AND version = ? LIMIT 1',
    [formulaUuid, version],
  );
  const value = rows[0]?.inserted_at;
  if (value instanceof Date) {
    return value;
  }
  return new Date(String(value));
}

test('previewBodySchema requires a record and accepts optional selectors', () => {
  const minimal = previewBodySchema.safeParse({ record: { amount: 2000 } });
  assert.equal(minimal.success, true);
  if (!minimal.success) {
    assert.fail('Expected the minimal preview body to pass validation');
  }
  assert.deepEqual(minimal.data, { record: { amount: 2000 } });
  const full = previewBodySchema.safeParse({
    record: { amount: 2000 },
    formulaUuids: [uuid],
    asOf: '2026-10-20T10:00:00+02:00',
  });
  assert.equal(full.success, true);
  if (!full.success) {
    assert.fail('Expected the full preview body to pass validation');
  }
  assert.deepEqual(full.data.formulaUuids, [uuid]);
  assert.ok(full.data.asOf);
  assert.equal(full.data.asOf.toISOString(), '2026-10-20T08:00:00.000Z');
  const emptySelection = previewBodySchema.safeParse({
    record: {},
    formulaUuids: [],
  });
  assert.equal(emptySelection.success, true);
});

test('previewBodySchema reports readable errors for bad input', () => {
  const missingRecord = previewBodySchema.safeParse({});
  assert.equal(missingRecord.success, false);
  if (missingRecord.success) {
    assert.fail('Expected a missing record to be rejected');
  }
  assert.ok(missingRecord.error.issues.some(
    (issue) => issue.path.join('.') === 'record' && /record/.test(issue.message),
  ));
  const arrayRecord = previewBodySchema.safeParse({ record: [1, 2] });
  assert.equal(arrayRecord.success, false);
  if (arrayRecord.success) {
    assert.fail('Expected an array record to be rejected');
  }
  assert.ok(arrayRecord.error.issues.some(
    (issue) => issue.path.join('.') === 'record',
  ));
  const badUuid = previewBodySchema.safeParse({
    record: {},
    formulaUuids: ['not-a-uuid'],
  });
  assert.equal(badUuid.success, false);
  if (badUuid.success) {
    assert.fail('Expected an invalid formula UUID to be rejected');
  }
  assert.ok(badUuid.error.issues.some(
    (issue) => issue.path.join('.') === 'formulaUuids.0',
  ));
  const badList = previewBodySchema.safeParse({
    record: {},
    formulaUuids: 'not-a-list',
  });
  assert.equal(badList.success, false);
  if (badList.success) {
    assert.fail('Expected a non-array formulaUuids value to be rejected');
  }
  assert.ok(badList.error.issues.some(
    (issue) => issue.path.join('.') === 'formulaUuids',
  ));
  const badAsOf = previewBodySchema.safeParse({
    record: {},
    asOf: '2026-10-20T10:00:00',
  });
  assert.equal(badAsOf.success, false);
  if (badAsOf.success) {
    assert.fail('Expected an as-of timestamp without a timezone to be rejected');
  }
  assert.ok(badAsOf.error.issues.some(
    (issue) => issue.path.join('.') === 'asOf' && /ISO 8601/.test(issue.message),
  ));
  const extraField = previewBodySchema.safeParse({ record: {}, extra: true });
  assert.equal(extraField.success, false);
  if (extraField.success) {
    assert.fail('Expected an unknown field to be rejected');
  }
  assert.ok(extraField.error.issues.some(
    (issue) => issue.code === 'unrecognized_keys' && issue.keys.includes('extra'),
  ));
});

test('resolvePreviewSelection defaults to all active and adds subset dependencies', () => {
  const base = formulaRow('base', [], 'uuid-base');
  const tax = formulaRow('tax', ['base'], 'uuid-tax');
  const total = formulaRow('total', ['tax', 'amount'], 'uuid-total');
  const other = formulaRow('other', [], 'uuid-other');
  const snapshot = [total, tax, base, other];
  const subset = resolvePreviewSelection(snapshot, ['uuid-total']);
  assert.deepEqual(selectionPairs(subset), [
    ['base', true],
    ['tax', true],
    ['total', false],
  ]);
  const requestedPair = resolvePreviewSelection(snapshot, ['uuid-tax', 'uuid-total']);
  assert.deepEqual(selectionPairs(requestedPair), [
    ['base', true],
    ['tax', false],
    ['total', false],
  ]);
  const all = resolvePreviewSelection(snapshot);
  assert.deepEqual(selectionPairs(all), [
    ['base', false],
    ['other', false],
    ['tax', false],
    ['total', false],
  ]);
  assert.deepEqual(resolvePreviewSelection(snapshot, []), []);
});

test('resolvePreviewSelection returns 404 with the unknown requested UUIDs', () => {
  const snapshot = [formulaRow('base', [], 'uuid-base')];
  assert.throws(
    () => resolvePreviewSelection(
      snapshot,
      ['uuid-missing', 'uuid-missing', 'uuid-base'],
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, 'NOT_FOUND');
      assert.deepEqual(error.details, { uuids: ['uuid-missing'] });
      return true;
    },
  );
});

test('loadPreviewSnapshot returns only current active formulas', async () => {
  const activeName = uniqueName('snapshot_active');
  const inactiveName = uniqueName('snapshot_inactive');
  const active = await createFormula(activeName, 'return 1');
  assert.equal(active.status, 200);
  const inactive = await createFormula(inactiveName, 'return 1');
  assert.equal(inactive.status, 200);
  const deactivated = await deactivateFormula(inactive.body.uuid, 1);
  assert.equal(deactivated.status, 200);
  const snapshot = await loadPreviewSnapshot();
  assert.ok(snapshot.some((formula) => formula.uuid === active.body.uuid));
  assert.ok(snapshot.every((formula) => formula.uuid !== inactive.body.uuid));
  assert.ok(snapshot.every((formula) => formula.status === 'ACTIVE'));
});

test('loadPreviewSnapshot uses the highest row at or before the as-of time', async () => {
  const name = uniqueName('snapshot_asof');
  const created = await createFormula(name, 'return 1');
  assert.equal(created.status, 200);
  const versionOneAt = await insertedAt(created.body.uuid, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const changed = await changeFormula(created.body.uuid, 1, 'return 2');
  assert.equal(changed.status, 200);
  const versionTwoAt = await insertedAt(created.body.uuid, 2);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const deactivated = await deactivateFormula(created.body.uuid, 2);
  assert.equal(deactivated.status, 200);
  const versionThreeAt = await insertedAt(created.body.uuid, 3);
  const versionOne = (await loadPreviewSnapshot(versionOneAt)).find(
    (formula) => formula.uuid === created.body.uuid,
  );
  assert.equal(versionOne?.version, 1);
  assert.equal(versionOne?.formula_text, 'return 1');
  const versionTwo = (await loadPreviewSnapshot(versionTwoAt)).find(
    (formula) => formula.uuid === created.body.uuid,
  );
  assert.equal(versionTwo?.version, 2);
  assert.equal(versionTwo?.formula_text, 'return 2');
  const versionThree = (await loadPreviewSnapshot(versionThreeAt)).find(
    (formula) => formula.uuid === created.body.uuid,
  );
  assert.equal(versionThree, undefined);
  const current = (await loadPreviewSnapshot()).find(
    (formula) => formula.uuid === created.body.uuid,
  );
  assert.equal(current, undefined);
  const future = (await loadPreviewSnapshot(new Date(Date.now() + 60_000))).find(
    (formula) => formula.uuid === created.body.uuid,
  );
  assert.equal(future, undefined);
  assert.deepEqual(
    await loadPreviewSnapshot(new Date('2000-01-01T00:00:00Z')),
    [],
  );
});

test('resolvePreviewSelection adds dependencies from the loaded snapshot', async () => {
  const prefix = uniqueName('closure');
  const baseName = `${prefix}_a`;
  const taxName = `${prefix}_b`;
  const totalName = `${prefix}_c`;
  const total = await createFormula(totalName, `return EXTERNAL_VAR.${taxName} + 1`);
  assert.equal(total.status, 200);
  const tax = await createFormula(taxName, `return EXTERNAL_VAR.${baseName} * 0.18`);
  assert.equal(tax.status, 200);
  const base = await createFormula(baseName, 'return EXTERNAL_VAR.amount', {
    amount: 100,
  });
  assert.equal(base.status, 200);
  const snapshot = await loadPreviewSnapshot();
  const selection = resolvePreviewSelection(snapshot, [total.body.uuid]);
  assert.deepEqual(selectionPairs(selection), [
    [baseName, true],
    [taxName, true],
    [totalName, false],
  ]);
  assert.deepEqual(
    selection.map((item) => item.formula.uuid),
    [base.body.uuid, tax.body.uuid, total.body.uuid],
  );
});
