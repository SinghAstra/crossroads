import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.ts';

test('loads the test environment against the test database', () => {
  assert.equal(config.env, 'test');
  assert.equal(config.isTest, true);
  assert.equal(config.db.database, 'crossroads_test');
});

test('uses safe defaults for timeouts and concurrency', () => {
  assert.ok(config.formula.timeoutMs > 0);
  assert.ok(config.formula.previewConcurrency > 0);
  assert.ok(config.formula.bulkRecordConcurrency > 0);
  assert.ok(config.formula.formulaConcurrency > 0);
});
