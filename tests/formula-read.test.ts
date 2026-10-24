import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.ts';
import { closePool } from '../src/data/close-pool.ts';
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

test('GET /formulas returns the current version of every formula', async () => {
  const changedName = uniqueName('list_changed');
  const inactiveName = uniqueName('list_inactive');
  const changed = await createFormula(changedName, 'return 1');
  assert.equal(changed.status, 200);
  const updated = await changeFormula(changed.body.uuid, 1, { formulaText: 'return 2' });
  assert.equal(updated.status, 200);
  const inactive = await createFormula(inactiveName, 'return 3');
  assert.equal(inactive.status, 200);
  const deactivated = await deactivateFormula(inactive.body.uuid, { version: 1 });
  assert.equal(deactivated.status, 200);
  const response = await request(app).get('/formulas');
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body));
  const changedRow = response.body.find(
    (row: { uuid: string }) => row.uuid === changed.body.uuid,
  );
  assert.equal(changedRow.version, 2);
  assert.equal(changedRow.formula_text, 'return 2');
  assert.equal(changedRow.status, 'ACTIVE');
  assert.deepEqual(changedRow.inputs, []);
  const inactiveRow = response.body.find(
    (row: { uuid: string }) => row.uuid === inactive.body.uuid,
  );
  assert.equal(inactiveRow.version, 2);
  assert.equal(inactiveRow.status, 'INACTIVE');
});

test('GET /formulas/:uuid/history returns every version oldest first', async () => {
  const name = uniqueName('history');
  const created = await createFormula(name, 'return 1');
  assert.equal(created.status, 200);
  const changed = await changeFormula(created.body.uuid, 1, { formulaText: 'return 2' });
  assert.equal(changed.status, 200);
  const response = await request(app).get(`/formulas/${created.body.uuid}/history`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.map((row: { version: number }) => row.version), [1, 2]);
  assert.deepEqual(
    response.body.map((row: { formula_text: string }) => row.formula_text),
    ['return 1', 'return 2'],
  );
  assert.ok(response.body.every(
    (row: { uuid: string }) => row.uuid === created.body.uuid,
  ));
});

test('GET /formulas/:uuid/impact returns direct and indirect dependents', async () => {
  const commission = uniqueName('impact_commission');
  const tax = uniqueName('impact_tax');
  const total = uniqueName('impact_total');
  const commissionResponse = await createFormula(commission, 'return EXTERNAL_VAR.amount');
  assert.equal(commissionResponse.status, 200);
  const taxResponse = await createFormula(tax, `return EXTERNAL_VAR.${commission}`);
  assert.equal(taxResponse.status, 200);
  const totalResponse = await createFormula(total, `return EXTERNAL_VAR.${tax} * 2`);
  assert.equal(totalResponse.status, 200);
  const commissionImpact = await request(app).get(
    `/formulas/${commissionResponse.body.uuid}/impact`,
  );
  assert.equal(commissionImpact.status, 200);
  assert.deepEqual(
    commissionImpact.body.map((entry: { formula: { name: string } }) => entry.formula.name),
    [tax, total],
  );
  assert.deepEqual(
    commissionImpact.body.map((entry: { depth: number }) => entry.depth),
    [1, 2],
  );
  assert.deepEqual(commissionImpact.body[0].path, [commission, tax]);
  assert.deepEqual(commissionImpact.body[1].path, [commission, tax, total]);
  assert.equal(commissionImpact.body[1].formula.uuid, totalResponse.body.uuid);
  const taxImpact = await request(app).get(`/formulas/${taxResponse.body.uuid}/impact`);
  assert.equal(taxImpact.status, 200);
  assert.deepEqual(
    taxImpact.body.map((entry: { formula: { name: string } }) => entry.formula.name),
    [total],
  );
  const totalImpact = await request(app).get(`/formulas/${totalResponse.body.uuid}/impact`);
  assert.equal(totalImpact.status, 200);
  assert.deepEqual(totalImpact.body, []);
  const forced = await deactivateFormula(commissionResponse.body.uuid, {
    version: 1,
    force: true,
  });
  assert.equal(forced.status, 200);
  const inactiveImpact = await request(app).get(
    `/formulas/${commissionResponse.body.uuid}/impact`,
  );
  assert.equal(inactiveImpact.status, 200);
  assert.deepEqual(inactiveImpact.body, []);
});

test('GET /formulas/:uuid/impact does not confuse an inactive name with an active one', async () => {
  const name = uniqueName('impact_reuse');
  const dependent = uniqueName('impact_reuse_use');
  const inactive = await createFormula(name, 'return 1');
  assert.equal(inactive.status, 200);
  const deactivated = await deactivateFormula(inactive.body.uuid, { version: 1 });
  assert.equal(deactivated.status, 200);
  const active = await createFormula(name, 'return 2');
  assert.equal(active.status, 200);
  assert.equal((await createFormula(dependent, `return EXTERNAL_VAR.${name}`)).status, 200);
  const inactiveImpact = await request(app).get(`/formulas/${inactive.body.uuid}/impact`);
  assert.equal(inactiveImpact.status, 200);
  assert.deepEqual(inactiveImpact.body, []);
  const activeImpact = await request(app).get(`/formulas/${active.body.uuid}/impact`);
  assert.equal(activeImpact.status, 200);
  assert.deepEqual(
    activeImpact.body.map((entry: { formula: { name: string } }) => entry.formula.name),
    [dependent],
  );
});

test('formula endpoints use consistent 404, 400, and 409 errors', async () => {
  const unknown = randomUUID();
  const responses = await Promise.all([
    request(app).post(`/formulas/${unknown}/deactivate`).send({ version: 1 }),
    request(app).post(`/formulas/${unknown}/rollback`).send({
      version: 1,
      targetVersion: 1,
    }),
    request(app).get(`/formulas/${unknown}/history`),
    request(app).get(`/formulas/${unknown}/impact`),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
    assert.equal(response.body.error.details.uuid, unknown);
  }
  const invalidUuid = await request(app).get('/formulas/not-a-uuid/history');
  assert.equal(invalidUuid.status, 400);
  assert.equal(invalidUuid.body.error.code, 'VALIDATION_ERROR');
  const invalidBody = await request(app).post(
    `/formulas/${unknown}/deactivate`,
  ).send({ version: 0 });
  assert.equal(invalidBody.status, 400);
  assert.equal(invalidBody.body.error.code, 'VALIDATION_ERROR');
  const name = uniqueName('error_conflict');
  const created = await createFormula(name, 'return 1');
  assert.equal(created.status, 200);
  const changed = await changeFormula(created.body.uuid, 1, { formulaText: 'return 2' });
  assert.equal(changed.status, 200);
  const staleDeactivate = await deactivateFormula(created.body.uuid, { version: 1 });
  assert.equal(staleDeactivate.status, 409);
  assert.equal(staleDeactivate.body.error.code, 'VERSION_CONFLICT');
  assert.equal(staleDeactivate.body.error.details.current.version, 2);
  const staleRollback = await request(app).post(
    `/formulas/${created.body.uuid}/rollback`,
  ).send({ version: 1, targetVersion: 1 });
  assert.equal(staleRollback.status, 409);
  assert.equal(staleRollback.body.error.code, 'VERSION_CONFLICT');
  assert.equal(staleRollback.body.error.details.current.version, 2);
});
