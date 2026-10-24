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

function createFormula(name: string, formulaText: string): request.Test {
  return request(app).post('/formulas').send({ name, formulaText });
}

function changeFormula(
  uuid: string,
  version: number,
  body: Record<string, unknown>,
): request.Test {
  return request(app).post('/formulas').send({ uuid, version, ...body });
}

function deactivateFormula(
  uuid: string,
  body: Record<string, unknown>,
): request.Test {
  return request(app).post(`/formulas/${uuid}/deactivate`).send(body);
}

function rollbackFormula(
  uuid: string,
  version: number,
  targetVersion: number,
  force?: boolean,
): request.Test {
  const body: Record<string, unknown> = { version, targetVersion };
  if (force !== undefined) {
    body.force = force;
  }
  return request(app).post(`/formulas/${uuid}/rollback`).send(body);
}

async function historyCount(uuid: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS count FROM formulas WHERE uuid = ?',
    [uuid],
  );
  return Number(rows[0]?.count ?? 0);
}

test('POST /formulas/:uuid/deactivate rejects active dependents unless forced', async () => {
  const commission = uniqueName('deact_commission');
  const tax = uniqueName('deact_tax');
  const total = uniqueName('deact_total');
  assert.equal((await createFormula(commission, 'return EXTERNAL_VAR.amount')).status, 200);
  const taxResponse = await createFormula(tax, `return EXTERNAL_VAR.${commission}`);
  assert.equal(taxResponse.status, 200);
  assert.equal((await createFormula(total, `return EXTERNAL_VAR.${tax}`)).status, 200);
  const blocked = await deactivateFormula(taxResponse.body.uuid, { version: 1 });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'DEPENDENTS_EXIST');
  assert.deepEqual(
    blocked.body.error.details.impacted.map((item: { name: string }) => item.name),
    [total],
  );
  assert.equal(await historyCount(taxResponse.body.uuid), 1);
  const forced = await deactivateFormula(taxResponse.body.uuid, { version: 1, force: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.uuid, taxResponse.body.uuid);
  assert.equal(forced.body.version, 2);
  assert.equal(forced.body.name, tax);
  assert.equal(forced.body.status, 'INACTIVE');
  assert.equal(await historyCount(taxResponse.body.uuid), 2);
});

test('deactivate is idempotent and rejects a stale version', async () => {
  const name = uniqueName('deact_idempotent');
  const created = await createFormula(name, 'return 1');
  assert.equal(created.status, 200);
  const first = await deactivateFormula(created.body.uuid, { version: 1 });
  assert.equal(first.status, 200);
  assert.equal(first.body.version, 2);
  assert.equal(first.body.status, 'INACTIVE');
  const second = await deactivateFormula(created.body.uuid, { version: 2 });
  assert.equal(second.status, 200);
  assert.equal(second.body.version, 2);
  assert.equal(second.body.status, 'INACTIVE');
  assert.equal(await historyCount(created.body.uuid), 2);
  const stale = await deactivateFormula(created.body.uuid, { version: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  assert.equal(stale.body.error.details.current.version, 2);
});

test('rollback copies an old version forward as a new version', async () => {
  const name = uniqueName('rollback_value');
  const created = await createFormula(name, 'return 1');
  assert.equal(created.status, 200);
  const changed = await changeFormula(created.body.uuid, 1, { formulaText: 'return 2' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.version, 2);
  const rolled = await rollbackFormula(created.body.uuid, 2, 1);
  assert.equal(rolled.status, 200);
  assert.equal(rolled.body.uuid, created.body.uuid);
  assert.equal(rolled.body.version, 3);
  assert.equal(rolled.body.name, name);
  assert.equal(rolled.body.formula_text, 'return 1');
  assert.equal(rolled.body.status, 'ACTIVE');
  const history = await request(app).get(`/formulas/${created.body.uuid}/history`);
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.map((row: { version: number }) => row.version), [1, 2, 3]);
  assert.deepEqual(
    history.body.map((row: { formula_text: string }) => row.formula_text),
    ['return 1', 'return 2', 'return 1'],
  );
});

test('rollback reruns active name uniqueness', async () => {
  const oldName = uniqueName('rollback_name_old');
  const newName = uniqueName('rollback_name_new');
  const created = await createFormula(oldName, 'return 1');
  assert.equal(created.status, 200);
  const renamed = await changeFormula(created.body.uuid, 1, { name: newName });
  assert.equal(renamed.status, 200);
  const replacement = await createFormula(oldName, 'return 2');
  assert.equal(replacement.status, 200);
  const blocked = await rollbackFormula(created.body.uuid, 2, 1);
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'VALIDATION_ERROR');
  assert.equal(blocked.body.error.details.name, oldName);
  assert.equal(await historyCount(created.body.uuid), 2);
});

test('rollback reruns the dependency cycle guard', async () => {
  const a = uniqueName('rollback_cycle_a');
  const b = uniqueName('rollback_cycle_b');
  const aResponse = await createFormula(a, `return EXTERNAL_VAR.${b}`);
  assert.equal(aResponse.status, 200);
  const bResponse = await createFormula(b, 'return 1');
  assert.equal(bResponse.status, 200);
  const aChanged = await changeFormula(aResponse.body.uuid, 1, { formulaText: 'return 1' });
  assert.equal(aChanged.status, 200);
  const bChanged = await changeFormula(bResponse.body.uuid, 1, {
    formulaText: `return EXTERNAL_VAR.${a}`,
  });
  assert.equal(bChanged.status, 200);
  const blocked = await rollbackFormula(aResponse.body.uuid, 2, 1);
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'DEPENDENCY_CYCLE');
  assert.deepEqual(blocked.body.error.details.path, [a, b, a]);
  assert.equal(await historyCount(aResponse.body.uuid), 2);
});

test('rollback reruns the dependent guard unless forced', async () => {
  const oldName = uniqueName('rollback_dependent_old');
  const newName = uniqueName('rollback_dependent_new');
  const dependent = uniqueName('rollback_dependent_use');
  const created = await createFormula(oldName, 'return 1');
  assert.equal(created.status, 200);
  const renamed = await changeFormula(created.body.uuid, 1, { name: newName });
  assert.equal(renamed.status, 200);
  assert.equal((await createFormula(dependent, `return EXTERNAL_VAR.${newName}`)).status, 200);
  const blocked = await rollbackFormula(created.body.uuid, 2, 1);
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'DEPENDENTS_EXIST');
  assert.deepEqual(
    blocked.body.error.details.impacted.map((item: { name: string }) => item.name),
    [dependent],
  );
  assert.equal(await historyCount(created.body.uuid), 2);
  const forced = await rollbackFormula(created.body.uuid, 2, 1, true);
  assert.equal(forced.status, 200);
  assert.equal(forced.body.version, 3);
  assert.equal(forced.body.name, oldName);
  assert.equal(forced.body.status, 'ACTIVE');
  assert.equal(await historyCount(created.body.uuid), 3);
});

test('rollback can reactivate and requires force for an inactive target', async () => {
  const name = uniqueName('rollback_inactive');
  const created = await createFormula(name, 'return 1');
  assert.equal(created.status, 200);
  const deactivated = await deactivateFormula(created.body.uuid, { version: 1 });
  assert.equal(deactivated.status, 200);
  assert.equal(deactivated.body.version, 2);
  assert.equal(deactivated.body.status, 'INACTIVE');
  const reactivated = await rollbackFormula(created.body.uuid, 2, 1);
  assert.equal(reactivated.status, 200);
  assert.equal(reactivated.body.version, 3);
  assert.equal(reactivated.body.status, 'ACTIVE');
  const blocked = await rollbackFormula(created.body.uuid, 3, 2);
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'VALIDATION_ERROR');
  assert.equal(blocked.body.error.details.targetVersion, 2);
  assert.equal(blocked.body.error.details.status, 'INACTIVE');
  assert.equal(await historyCount(created.body.uuid), 3);
  const forced = await rollbackFormula(created.body.uuid, 3, 2, true);
  assert.equal(forced.status, 200);
  assert.equal(forced.body.version, 4);
  assert.equal(forced.body.status, 'INACTIVE');
  assert.equal(await historyCount(created.body.uuid), 4);
});

test('rollback rejects the current target and stale base versions', async () => {
  const name = uniqueName('rollback_errors');
  const created = await createFormula(name, 'return 1');
  assert.equal(created.status, 200);
  const currentTarget = await rollbackFormula(created.body.uuid, 1, 1);
  assert.equal(currentTarget.status, 400);
  assert.equal(currentTarget.body.error.code, 'VALIDATION_ERROR');
  assert.equal(currentTarget.body.error.details.targetVersion, 1);
  assert.equal(currentTarget.body.error.details.currentVersion, 1);
  const changed = await changeFormula(created.body.uuid, 1, { formulaText: 'return 2' });
  assert.equal(changed.status, 200);
  const stale = await rollbackFormula(created.body.uuid, 1, 1);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  assert.equal(stale.body.error.details.current.version, 2);
  assert.equal(await historyCount(created.body.uuid), 2);
});
