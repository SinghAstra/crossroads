import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.ts';
import { closePool } from '../src/data/close-pool.ts';

const app = createApp();

after(async () => {
  await closePool();
});

test('GET /health reports database connectivity', async () => {
  const response = await request(app).get('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok', database: 'connected' });
});

test('unknown routes use the standard error envelope', async () => {
  const response = await request(app).get('/missing');
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'NOT_FOUND');
  assert.equal(typeof response.body.error.message, 'string');
  assert.equal(response.body.error.details, null);
});

test('malformed JSON uses the standard error envelope', async () => {
  const response = await request(app)
    .post('/formulas')
    .set('Content-Type', 'application/json')
    .send('{"broken":');
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_JSON');
  assert.equal(response.body.error.details, null);
});
