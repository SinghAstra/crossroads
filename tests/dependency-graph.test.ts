import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/lib/app-error.ts';
import {
  assertNoMissingInputs,
  buildGraph,
  collectMissingInputs,
  computeLevels,
  findCyclePath,
  findImpact,
} from '../src/lib/dependency-graph.ts';

test('buildGraph separates formula dependencies from record fields', () => {
  const graph = buildGraph(
    [
      { name: 'base_rate', inputs: ['amount'] },
      { name: 'tax', inputs: ['base_rate', 'rate'] },
      { name: 'total', inputs: ['tax', 'amount'] },
      { name: 'flat_fee', inputs: ['fee'] },
    ],
    ['amount', 'rate', 'fee'],
  );
  assert.deepEqual(graph.dependencies.get('base_rate'), []);
  assert.deepEqual(graph.dependencies.get('tax'), ['base_rate']);
  assert.deepEqual(graph.dependencies.get('total'), ['tax']);
  assert.deepEqual(graph.dependents.get('base_rate'), ['tax']);
  assert.deepEqual(graph.dependents.get('tax'), ['total']);
  assert.deepEqual(graph.recordFields.get('tax'), ['rate']);
  assert.deepEqual(graph.recordFields.get('total'), ['amount']);
  assert.deepEqual(graph.missingInputs.get('tax'), []);
  assert.deepEqual([...graph.recordKeys], ['amount', 'rate', 'fee']);
});

test('buildGraph reports missing record fields without creating formula edges', () => {
  const graph = buildGraph(
    [{ name: 'discount', inputs: ['amount', 'coupon'] }],
    ['amount'],
  );
  assert.deepEqual(graph.dependencies.get('discount'), []);
  assert.deepEqual(graph.recordFields.get('discount'), ['amount', 'coupon']);
  assert.deepEqual(graph.missingInputs.get('discount'), ['coupon']);
});

test('buildGraph treats inactive and differently cased names as record fields', () => {
  const graph = buildGraph(
    [
      { name: 'Tax', inputs: ['base_rate'] },
      { name: 'total', inputs: ['tax'] },
    ],
    ['base_rate', 'tax'],
  );
  assert.deepEqual(graph.dependencies.get('Tax'), []);
  assert.deepEqual(graph.dependencies.get('total'), []);
  assert.deepEqual(graph.recordFields.get('Tax'), ['base_rate']);
  assert.deepEqual(graph.recordFields.get('total'), ['tax']);
  assert.deepEqual(graph.missingInputs.get('total'), []);
});

test('buildGraph deduplicates repeated inputs and reverse edges', () => {
  const graph = buildGraph(
    [
      { name: 'base', inputs: [] },
      { name: 'total', inputs: ['base', 'base', 'amount', 'amount'] },
    ],
    ['amount'],
  );
  assert.deepEqual(graph.dependencies.get('total'), ['base']);
  assert.deepEqual(graph.recordFields.get('total'), ['amount']);
  assert.deepEqual(graph.dependents.get('base'), ['total']);
});

test('buildGraph rejects duplicate active names', () => {
  assert.throws(
    () => buildGraph(
      [
        { name: 'tax', inputs: [] },
        { name: 'tax', inputs: [] },
      ],
      [],
    ),
    (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_ERROR',
  );
});

test('computeLevels orders a chain from its dependencies', () => {
  const graph = buildGraph(
    [
      { name: 'total', inputs: ['tax', 'amount'] },
      { name: 'tax', inputs: ['base_rate', 'rate'] },
      { name: 'base_rate', inputs: ['amount'] },
    ],
    ['amount', 'rate'],
  );
  const levels = computeLevels(graph).map((level) => level.map((formula) => formula.name));
  assert.deepEqual(levels, [['base_rate'], ['tax'], ['total']]);
});

test('computeLevels groups independent formulas and sorts each level by name', () => {
  const graph = buildGraph(
    [
      { name: 'total', inputs: ['tax'] },
      { name: 'flat_fee', inputs: ['fee'] },
      { name: 'tax', inputs: ['base_rate'] },
      { name: 'base_rate', inputs: ['amount'] },
    ],
    ['fee', 'amount'],
  );
  const levels = computeLevels(graph).map((level) => level.map((formula) => formula.name));
  assert.deepEqual(levels, [['base_rate', 'flat_fee'], ['tax'], ['total']]);
});

test('computeLevels keeps sibling dependencies in one level', () => {
  const graph = buildGraph(
    [
      { name: 'total', inputs: ['left', 'right'] },
      { name: 'right', inputs: ['base'] },
      { name: 'left', inputs: ['base'] },
      { name: 'base', inputs: [] },
    ],
    [],
  );
  const levels = computeLevels(graph).map((level) => level.map((formula) => formula.name));
  assert.deepEqual(levels, [['base'], ['left', 'right'], ['total']]);
});

test('findCyclePath returns the exact cycle path', () => {
  const graph = buildGraph(
    [
      { name: 'a', inputs: ['b'] },
      { name: 'b', inputs: ['c'] },
      { name: 'c', inputs: ['a'] },
    ],
    [],
  );
  assert.deepEqual(findCyclePath(graph), ['a', 'b', 'c', 'a']);
  const prefixed = buildGraph(
    [
      { name: 'root', inputs: ['a'] },
      { name: 'a', inputs: ['b'] },
      { name: 'b', inputs: ['a'] },
    ],
    [],
  );
  assert.deepEqual(findCyclePath(prefixed), ['a', 'b', 'a']);
});

test('findCyclePath handles a self-loop', () => {
  const graph = buildGraph([{ name: 'self', inputs: ['self'] }], []);
  assert.deepEqual(findCyclePath(graph), ['self', 'self']);
  assert.throws(
    () => computeLevels(graph),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.deepEqual(error.details, { path: ['self', 'self'] });
      return true;
    },
  );
});

test('findCyclePath returns null for an acyclic graph', () => {
  const graph = buildGraph(
    [
      { name: 'base', inputs: [] },
      { name: 'total', inputs: ['base'] },
    ],
    [],
  );
  assert.equal(findCyclePath(graph), null);
});

test('computeLevels includes the exact cycle path in the error', () => {
  const graph = buildGraph(
    [
      { name: 'a', inputs: ['b'] },
      { name: 'b', inputs: ['c'] },
      { name: 'c', inputs: ['a'] },
    ],
    [],
  );
  assert.throws(
    () => computeLevels(graph),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'DEPENDENCY_CYCLE');
      assert.equal(error.message, 'Dependency cycle detected: a -> b -> c -> a');
      assert.deepEqual(error.details, { path: ['a', 'b', 'c', 'a'] });
      return true;
    },
  );
});

test('collectMissingInputs returns all missing names once', () => {
  const graph = buildGraph(
    [
      { name: 'tax', inputs: ['amount', 'rate', 'commission'] },
      { name: 'total', inputs: ['tax', 'discount', 'rate'] },
    ],
    ['amount'],
  );
  assert.deepEqual(collectMissingInputs(graph), ['commission', 'discount', 'rate']);
  assert.throws(
    () => assertNoMissingInputs(graph),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'MISSING_INPUT');
      assert.deepEqual(error.details, { missing: ['commission', 'discount', 'rate'] });
      return true;
    },
  );
});

test('assertNoMissingInputs passes when every input is present', () => {
  const graph = buildGraph(
    [
      { name: 'base', inputs: [] },
      { name: 'total', inputs: ['base', 'amount'] },
    ],
    ['amount'],
  );
  assert.deepEqual(collectMissingInputs(graph), []);
  assert.doesNotThrow(() => assertNoMissingInputs(graph));
});

test('findImpact returns direct and indirect dependents with depth and path', () => {
  const graph = buildGraph(
    [
      { name: 'base', inputs: [] },
      { name: 'left', inputs: ['base'] },
      { name: 'right', inputs: ['base'] },
      { name: 'total', inputs: ['left', 'right'] },
      { name: 'independent', inputs: [] },
    ],
    [],
  );
  const impact = findImpact(graph, 'base');
  assert.deepEqual(impact.map((entry) => entry.formula.name), ['left', 'right', 'total']);
  assert.deepEqual(impact.map((entry) => entry.depth), [1, 1, 2]);
  assert.deepEqual(impact.find((entry) => entry.formula.name === 'total')?.path, [
    'base',
    'left',
    'total',
  ]);
  assert.equal(impact.filter((entry) => entry.formula.name === 'total').length, 1);
  assert.deepEqual(findImpact(graph, 'total'), []);
  assert.deepEqual(findImpact(graph, 'missing'), []);
});

test('worked example runs commission before tax before total', () => {
  const graph = buildGraph(
    [
      { name: 'total', inputs: ['commission', 'tax'] },
      { name: 'tax', inputs: ['commission'] },
      { name: 'commission', inputs: ['amount', 'rate'] },
    ],
    ['amount', 'rate'],
  );
  const levels = computeLevels(graph).map((level) => level.map((formula) => formula.name));
  assert.deepEqual(levels, [['commission'], ['tax'], ['total']]);
});

test('computeLevels returns no levels for an empty graph', () => {
  assert.deepEqual(computeLevels(buildGraph([], [])), []);
});
