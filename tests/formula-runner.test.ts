import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeFormulaWorkers } from '../src/lib/formula-worker-pool.ts';
import { runFormula } from '../src/lib/formula-runner.ts';

after(async () => {
  await closeFormulaWorkers();
});

test('evaluates the worked example', async () => {
  const result = await runFormula(
    'return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100',
    { amount: 2000, rate: 10 },
  );
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.result, 200);
  assert.equal(result.error, null);
  assert.match(result.calculation ?? '', /return EXTERNAL_VAR\.amount/);
  assert.equal(typeof result.durationMs, 'number');
});

test('evaluates a helper formula', async () => {
  const result = await runFormula(
    'return ROUND(EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100, 2)',
    { amount: 2000, rate: 10 },
  );
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.result, 200);
  assert.match(result.calculation ?? '', /ROUND\(/);
});

test('rejects syntax errors', async () => {
  const result = await runFormula('return EXTERNAL_VAR.amount *', { amount: 2000 });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.result, null);
  assert.ok(result.error);
});

test('rejects runtime errors and normalizes input names', async () => {
  const result = await runFormula('return EXTERNAL_VAR.amount.notAFunction()', { amount: 2000 });
  assert.equal(result.status, 'FAILED');
  assert.match(result.error ?? '', /EXTERNAL_VAR\.amount\.notAFunction/);
  assert.doesNotMatch(result.error ?? '', /EXTERNAL_VAR\.CODE/);
});

test('rejects missing inputs', async () => {
  const result = await runFormula('return EXTERNAL_VAR.missing * 2', {});
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error, 'Formula is missing an input value');
});

test('rejects non-finite results', async () => {
  const result = await runFormula('return EXTERNAL_VAR.amount / 0', { amount: 2000 });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error, 'Formula produced a non-finite result');
});

test('times out and recovers the worker', async () => {
  const timedOut = await runFormula('while (true) {} return 1', {}, { timeoutMs: 100 });
  assert.equal(timedOut.status, 'FAILED');
  assert.match(timedOut.error ?? '', /timed out/i);
  const recovered = await runFormula('return EXTERNAL_VAR.amount * 2', { amount: 21 });
  assert.equal(recovered.status, 'SUCCESS');
  assert.equal(recovered.result, 42);
});

test('allows non-numeric results', async () => {
  const result = await runFormula('return "hello"', {});
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.result, 'hello');
});
