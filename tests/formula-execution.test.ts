import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { FormulaRow } from '../src/data/formula-repository.ts';
import { AppError } from '../src/lib/app-error.ts';
import type { FormulaRunResult } from '../src/lib/formula-runner-types.ts';
import { closeFormulaWorkers } from '../src/lib/formula-worker-pool.ts';
import {
  executePreview,
  type PreviewEvaluator,
  type PreviewFormulaOutcome,
} from '../src/services/formula-execution-service.ts';
import type { PreviewSelection } from '../src/services/formula-selection-service.ts';

after(async () => {
  await closeFormulaWorkers();
});

function formulaRow(
  name: string,
  inputs: readonly string[],
  formulaText = 'return 1',
): FormulaRow {
  return {
    id: 1,
    uuid: `${name}-uuid`,
    version: 1,
    name,
    formula_text: formulaText,
    status: 'ACTIVE',
    created_by: 'test',
    first_created_at: new Date(0),
    inserted_at: new Date(0),
    inputs,
  };
}

function selection(formula: FormulaRow, autoAdded = false): PreviewSelection {
  return { formula, autoAdded };
}

function success(
  result: unknown,
  calculation: string | null = 'return 1',
  durationMs = 1,
): FormulaRunResult {
  return { status: 'SUCCESS', result, error: null, calculation, durationMs };
}

function failure(
  error: string,
  calculation: string | null = 'return 1',
  durationMs = 1,
): FormulaRunResult {
  return { status: 'FAILED', result: null, error, calculation, durationMs };
}

function outcomeByName(
  outcomes: readonly PreviewFormulaOutcome[],
  name: string,
): PreviewFormulaOutcome {
  const outcome = outcomes.find((item) => item.formula.name === name);
  assert.ok(outcome);
  return outcome;
}

test('executePreview rejects missing inputs before evaluating anything', async () => {
  const first = selection(formulaRow('first', ['alpha', 'zeta']));
  const second = selection(formulaRow('second', ['beta']));
  let calls = 0;
  const evaluator: PreviewEvaluator = async () => {
    calls += 1;
    return success(1);
  };
  await assert.rejects(
    executePreview([first, second], { amount: 1 }, { evaluator }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'MISSING_INPUT');
      assert.deepEqual(error.details, { missing: ['alpha', 'beta', 'zeta'] });
      return true;
    },
  );
  assert.equal(calls, 0);
});

test('executePreview rounds output results while dependents receive raw values', async () => {
  const first = selection(formulaRow('first', [], 'first'));
  const second = selection(formulaRow('second', ['first'], 'second'));
  const evaluator: PreviewEvaluator = async (formulaText, data) => {
    if (formulaText === 'first') {
      return success(1.234, 'first calculation');
    }
    return success(Number(data.first) * 100, 'second calculation');
  };
  const outcomes = await executePreview([first, second], {}, { evaluator });
  assert.deepEqual(outcomes.map((outcome) => outcome.formula.name), ['first', 'second']);
  assert.equal(outcomes[0]?.status, 'SUCCESS');
  assert.equal(outcomes[0]?.result, 1.23);
  assert.equal(outcomes[0]?.error, null);
  assert.equal(outcomes[0]?.reason, null);
  assert.equal(outcomes[0]?.calculation, 'first calculation');
  assert.equal(outcomes[1]?.result, 123.4);
});

test('executePreview normalizes failed formula results', async () => {
  const failed = selection(formulaRow('failed', [], 'failed'));
  const evaluator: PreviewEvaluator = async () => failure('bad formula', 'failed calculation', 4);
  const [outcome] = await executePreview([failed], {}, { evaluator });
  assert.equal(outcome?.status, 'FAILED');
  assert.equal(outcome?.result, null);
  assert.equal(outcome?.error, 'bad formula');
  assert.equal(outcome?.reason, null);
  assert.equal(outcome?.calculation, 'failed calculation');
  assert.equal(outcome?.durationMs, 4);
});

test('executePreview turns thrown evaluator errors into FAILED', async () => {
  const thrown = selection(formulaRow('thrown', [], 'thrown'));
  const evaluator: PreviewEvaluator = async () => {
    throw new Error('worker crashed');
  };
  const [outcome] = await executePreview([thrown], {}, { evaluator });
  assert.equal(outcome?.status, 'FAILED');
  assert.equal(outcome?.result, null);
  assert.equal(outcome?.error, 'worker crashed');
  assert.equal(outcome?.calculation, null);
  assert.equal(outcome?.durationMs, 0);
});

test('executePreview runs levels in dependency order with bounded concurrency', async () => {
  const a = selection(formulaRow('a', [], 'a'), true);
  const b = selection(formulaRow('b', [], 'b'));
  const c = selection(formulaRow('c', [], 'c'));
  const d = selection(formulaRow('d', [], 'd'));
  const total = selection(formulaRow('total', ['a', 'b', 'c', 'd'], 'total'));
  let active = 0;
  let maxActive = 0;
  const events: string[] = [];
  const evaluator: PreviewEvaluator = async (formulaText, data) => {
    events.push(`start:${formulaText}`);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    events.push(`end:${formulaText}`);
    if (formulaText === 'total') {
      assert.equal(data.a, 1);
      assert.equal(data.b, 2);
      assert.equal(data.c, 3);
      assert.equal(data.d, 4);
      return success(
        Number(data.a) + Number(data.b) + Number(data.c) + Number(data.d),
      );
    }
    return success(formulaText.charCodeAt(0) - 96);
  };
  const outcomes = await executePreview(
    [total, d, c, b, a],
    { a: 99 },
    { evaluator, concurrency: 2 },
  );
  assert.equal(maxActive, 2);
  const lastLevelOneEnd = Math.max(
    events.indexOf('end:a'),
    events.indexOf('end:b'),
    events.indexOf('end:c'),
    events.indexOf('end:d'),
  );
  assert.ok(events.indexOf('start:total') > lastLevelOneEnd);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.formula.name),
    ['a', 'b', 'c', 'd', 'total'],
  );
  assert.deepEqual(outcomes.map((outcome) => outcome.result), [1, 2, 3, 4, 10]);
  assert.equal(outcomes[0]?.autoAdded, true);
  assert.equal(outcomes[4]?.autoAdded, false);
});

test('executePreview isolates failures and skips transitive dependents', async () => {
  const boom = selection(formulaRow('boom', [], 'boom'));
  const dependent = selection(formulaRow('dependent', ['boom'], 'dependent'));
  const transitive = selection(formulaRow('transitive', ['dependent'], 'transitive'));
  const independent = selection(formulaRow('independent', [], 'independent'));
  const independentChild = selection(
    formulaRow('independent_child', ['independent'], 'independent_child'),
  );
  const calls: string[] = [];
  const evaluator: PreviewEvaluator = async (formulaText, data) => {
    calls.push(formulaText);
    if (formulaText === 'boom') {
      return failure('boom failed', 'boom calculation');
    }
    if (formulaText === 'independent') {
      return success(5);
    }
    if (formulaText === 'independent_child') {
      return success(Number(data.independent) + 1);
    }
    throw new Error(`unexpected call: ${formulaText}`);
  };
  const outcomes = await executePreview(
    [transitive, dependent, independentChild, independent, boom],
    {},
    { evaluator },
  );
  assert.deepEqual(calls.sort(), ['boom', 'independent', 'independent_child']);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.formula.name),
    ['boom', 'independent', 'dependent', 'independent_child', 'transitive'],
  );
  const failed = outcomeByName(outcomes, 'boom');
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.error, 'boom failed');
  assert.equal(failed.calculation, 'boom calculation');
  assert.equal(failed.reason, null);
  const skipped = outcomeByName(outcomes, 'dependent');
  assert.equal(skipped.status, 'SKIPPED');
  assert.equal(skipped.result, null);
  assert.equal(skipped.error, null);
  assert.equal(skipped.reason, 'dependency boom failed');
  assert.equal(skipped.calculation, null);
  const transitiveSkipped = outcomeByName(outcomes, 'transitive');
  assert.equal(transitiveSkipped.status, 'SKIPPED');
  assert.equal(transitiveSkipped.reason, 'dependency boom failed');
  const independentOutcome = outcomeByName(outcomes, 'independent');
  assert.equal(independentOutcome.status, 'SUCCESS');
  assert.equal(independentOutcome.result, 5);
  const independentChildOutcome = outcomeByName(outcomes, 'independent_child');
  assert.equal(independentChildOutcome.status, 'SUCCESS');
  assert.equal(independentChildOutcome.result, 6);
});

test('executePreview marks timeouts FAILED and skips dependents', async () => {
  const slow = selection(formulaRow('slow', [], 'while (true) {} return 1'));
  const dependent = selection(
    formulaRow('slow_dependent', ['slow'], 'return EXTERNAL_VAR.slow + 1'),
  );
  const independent = selection(formulaRow('slow_independent', [], 'return 7'));
  const outcomes = await executePreview(
    [dependent, independent, slow],
    {},
    { timeoutMs: 100, concurrency: 2 },
  );
  const slowOutcome = outcomeByName(outcomes, 'slow');
  assert.equal(slowOutcome.status, 'FAILED');
  assert.match(slowOutcome.error ?? '', /timed out/i);
  const dependentOutcome = outcomeByName(outcomes, 'slow_dependent');
  assert.equal(dependentOutcome.status, 'SKIPPED');
  assert.equal(dependentOutcome.reason, 'dependency slow failed');
  const independentOutcome = outcomeByName(outcomes, 'slow_independent');
  assert.equal(independentOutcome.status, 'SUCCESS');
  assert.equal(independentOutcome.result, 7);
});

test('executePreview runs the worked example in dependency order', async () => {
  const commission = selection(formulaRow(
    'commission',
    ['amount', 'rate'],
    'return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100',
  ));
  const tax = selection(formulaRow(
    'tax',
    ['commission'],
    'return EXTERNAL_VAR.commission * 0.18',
  ));
  const total = selection(formulaRow(
    'total',
    ['commission', 'tax'],
    'return EXTERNAL_VAR.commission + EXTERNAL_VAR.tax',
  ));
  const outcomes = await executePreview(
    [total, tax, commission],
    { amount: 2000, rate: 10 },
  );
  assert.deepEqual(
    outcomes.map((outcome) => outcome.formula.name),
    ['commission', 'tax', 'total'],
  );
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['SUCCESS', 'SUCCESS', 'SUCCESS'],
  );
  assert.deepEqual(outcomes.map((outcome) => outcome.result), [200, 36, 236]);
  assert.ok(outcomes.every((outcome) => outcome.error === null));
  assert.ok(outcomes.every((outcome) => outcome.reason === null));
  assert.ok(outcomes.every((outcome) => typeof outcome.calculation === 'string'));
});
