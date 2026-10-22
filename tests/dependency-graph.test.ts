import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/lib/app-error.ts';
import { buildGraph, computeLevels } from '../src/lib/dependency-graph.ts';

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

test('computeLevels rejects a cycle instead of returning partial levels', () => {
  const graph = buildGraph(
    [
      { name: 'a', inputs: ['c'] },
      { name: 'b', inputs: ['a'] },
      { name: 'c', inputs: ['b'] },
    ],
    [],
  );
  assert.throws(
    () => computeLevels(graph),
    (error: unknown) => error instanceof AppError && error.code === 'DEPENDENCY_CYCLE',
  );
});

test('computeLevels returns no levels for an empty graph', () => {
  assert.deepEqual(computeLevels(buildGraph([], [])), []);
});
