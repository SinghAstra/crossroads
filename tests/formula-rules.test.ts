import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/lib/app-error.ts';
import type { FormulaSnapshot } from '../src/lib/formula-types.ts';
import {
  assertActiveNameAvailable,
  assertNoDependentBreakage,
  assertSaveGraphAcyclic,
} from '../src/services/formula-rules.ts';

function formula(
  name: string,
  inputs: readonly string[] = [],
  uuid = name,
): FormulaSnapshot {
  return {
    uuid,
    version: 1,
    name,
    formula_text: 'return 1',
    status: 'ACTIVE',
    inputs,
  };
}

test('active name rules are case-sensitive and allow the same uuid', () => {
  const active = [formula('tax'), formula('Tax', [], 'tax-upper')];
  assert.throws(
    () => assertActiveNameAvailable(active, 'tax', 'other'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.deepEqual(error.details, { name: 'tax', uuid: 'tax' });
      return true;
    },
  );
  assert.doesNotThrow(() => assertActiveNameAvailable(active, 'Tax', 'tax-upper'));
  assert.doesNotThrow(() => assertActiveNameAvailable(active, 'TAX'));
});

test('dependent guard lists direct dependents unless forced', () => {
  const active = [formula('tax'), formula('total', ['tax'], 'total-uuid')];
  assert.throws(
    () => assertNoDependentBreakage(active, 'tax', false),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'DEPENDENTS_EXIST');
      const details = error.details as {
        impacted: Array<{ name: string; depth: number; path: readonly string[] }>;
      };
      assert.deepEqual(details.impacted.map((item) => item.name), ['total']);
      assert.deepEqual(details.impacted[0]?.path, ['tax', 'total']);
      return true;
    },
  );
  assert.doesNotThrow(() => assertNoDependentBreakage(active, 'tax', true));
});

test('inactive formulas still reject a self-loop', () => {
  const proposed: FormulaSnapshot = {
    ...formula('self'),
    status: 'INACTIVE',
    inputs: ['self'],
  };
  assert.throws(
    () => assertSaveGraphAcyclic([], proposed),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'DEPENDENCY_CYCLE');
      assert.deepEqual(error.details, { path: ['self', 'self'] });
      return true;
    },
  );
});
