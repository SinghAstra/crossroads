import test from 'node:test';
import assert from 'node:assert/strict';
import {
  changeFormulaBodySchema,
  createFormulaBodySchema,
  deactivateFormulaBodySchema,
  rollbackFormulaBodySchema,
} from '../src/validation/formula-schemas.ts';

const uuid = '00000000-0000-4000-8000-000000000001';

test('createFormulaBodySchema accepts the required fields and optional metadata', () => {
  const result = createFormulaBodySchema.safeParse({
    name: 'tax',
    formulaText: 'return EXTERNAL_VAR.commission * 0.18;',
    createdBy: 'admin',
    sampleData: { commission: 100 },
  });
  assert.equal(result.success, true);
  if (!result.success) {
    assert.fail('Expected the create body to pass validation');
  }
  assert.deepEqual(result.data, {
    name: 'tax',
    formulaText: 'return EXTERNAL_VAR.commission * 0.18;',
    createdBy: 'admin',
    sampleData: { commission: 100 },
  });
});

test('createFormulaBodySchema rejects uuid and version', () => {
  const withVersion = createFormulaBodySchema.safeParse({
    name: 'tax',
    formulaText: 'return 1;',
    version: 1,
  });
  assert.equal(withVersion.success, false);
  if (withVersion.success) {
    assert.fail('Expected version to be rejected');
  }
  assert.ok(withVersion.error.issues.some(
    (issue) => issue.code === 'unrecognized_keys' && issue.keys.includes('version'),
  ));
  const withUuid = createFormulaBodySchema.safeParse({
    name: 'tax',
    formulaText: 'return 1;',
    uuid,
  });
  assert.equal(withUuid.success, false);
  if (withUuid.success) {
    assert.fail('Expected uuid to be rejected');
  }
  assert.ok(withUuid.error.issues.some(
    (issue) => issue.code === 'unrecognized_keys' && issue.keys.includes('uuid'),
  ));
});

test('createFormulaBodySchema rejects invalid names and oversized text', () => {
  const badName = createFormulaBodySchema.safeParse({
    name: '1tax',
    formulaText: 'return 1;',
  });
  assert.equal(badName.success, false);
  if (badName.success) {
    assert.fail('Expected the invalid name to be rejected');
  }
  assert.ok(badName.error.issues.some((issue) => issue.path.join('.') === 'name'));
  const longText = createFormulaBodySchema.safeParse({
    name: 'tax',
    formulaText: 'x'.repeat(10_001),
  });
  assert.equal(longText.success, false);
  if (longText.success) {
    assert.fail('Expected the oversized formula to be rejected');
  }
  assert.ok(longText.error.issues.some((issue) => issue.path.join('.') === 'formulaText'));
});

test('changeFormulaBodySchema accepts a uuid, base version, and optional fields', () => {
  const result = changeFormulaBodySchema.safeParse({
    uuid,
    version: 2,
    name: 'tax',
    formulaText: 'return EXTERNAL_VAR.commission * 0.12;',
    sampleData: { commission: 100 },
    force: true,
  });
  assert.equal(result.success, true);
  if (!result.success) {
    assert.fail('Expected the change body to pass validation');
  }
  assert.deepEqual(result.data, {
    uuid,
    version: 2,
    name: 'tax',
    formulaText: 'return EXTERNAL_VAR.commission * 0.12;',
    sampleData: { commission: 100 },
    force: true,
  });
});

test('changeFormulaBodySchema requires uuid and version', () => {
  const noUuid = changeFormulaBodySchema.safeParse({ version: 2, name: 'tax' });
  assert.equal(noUuid.success, false);
  if (noUuid.success) {
    assert.fail('Expected uuid to be required');
  }
  assert.ok(noUuid.error.issues.some((issue) => issue.path.join('.') === 'uuid'));
  const noVersion = changeFormulaBodySchema.safeParse({ uuid, name: 'tax' });
  assert.equal(noVersion.success, false);
  if (noVersion.success) {
    assert.fail('Expected version to be required');
  }
  assert.ok(noVersion.error.issues.some((issue) => issue.path.join('.') === 'version'));
  const badUuid = changeFormulaBodySchema.safeParse({
    uuid: 'not-a-uuid',
    version: 2,
    name: 'tax',
  });
  assert.equal(badUuid.success, false);
  if (badUuid.success) {
    assert.fail('Expected an invalid uuid to be rejected');
  }
  assert.ok(badUuid.error.issues.some((issue) => issue.path.join('.') === 'uuid'));
});

test('deactivateFormulaBodySchema requires a version and rejects other fields', () => {
  const valid = deactivateFormulaBodySchema.safeParse({ version: 2, force: true });
  assert.equal(valid.success, true);
  const unknown = deactivateFormulaBodySchema.safeParse({ version: 2, name: 'tax' });
  assert.equal(unknown.success, false);
  if (unknown.success) {
    assert.fail('Expected the unknown field to be rejected');
  }
  assert.ok(unknown.error.issues.some(
    (issue) => issue.code === 'unrecognized_keys' && issue.keys.includes('name'),
  ));
});

test('rollbackFormulaBodySchema requires a base and target version', () => {
  const valid = rollbackFormulaBodySchema.safeParse({
    version: 3,
    targetVersion: 1,
    force: true,
  });
  assert.equal(valid.success, true);
  const missingTarget = rollbackFormulaBodySchema.safeParse({ version: 3 });
  assert.equal(missingTarget.success, false);
  if (missingTarget.success) {
    assert.fail('Expected targetVersion to be required');
  }
  assert.ok(missingTarget.error.issues.some(
    (issue) => issue.path.join('.') === 'targetVersion',
  ));
  const invalidTarget = rollbackFormulaBodySchema.safeParse({
    version: 3,
    targetVersion: 0,
  });
  assert.equal(invalidTarget.success, false);
  if (invalidTarget.success) {
    assert.fail('Expected targetVersion 0 to be rejected');
  }
  assert.ok(invalidTarget.error.issues.some(
    (issue) => issue.path.join('.') === 'targetVersion',
  ));
});

test('sampleData must be an object and force must be a boolean', () => {
  const sampleArray = createFormulaBodySchema.safeParse({
    name: 'tax',
    formulaText: 'return 1;',
    sampleData: [1, 2],
  });
  assert.equal(sampleArray.success, false);
  if (sampleArray.success) {
    assert.fail('Expected an array sampleData to be rejected');
  }
  assert.ok(sampleArray.error.issues.some(
    (issue) => issue.path.join('.') === 'sampleData',
  ));
  const badForce = deactivateFormulaBodySchema.safeParse({
    version: 1,
    force: 'true',
  });
  assert.equal(badForce.success, false);
  if (badForce.success) {
    assert.fail('Expected a string force to be rejected');
  }
  assert.ok(badForce.error.issues.some((issue) => issue.path.join('.') === 'force'));
});
