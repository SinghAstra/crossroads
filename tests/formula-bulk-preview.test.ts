import test from 'node:test';
import assert from 'node:assert/strict';
import type { FormulaRow } from '../src/data/formula-repository.ts';
import { AppError } from '../src/lib/app-error.ts';
import type { FormulaRunResult } from '../src/lib/formula-runner-types.ts';
import { previewFormulasBulk } from '../src/services/formula-bulk-preview-service.ts';
import {
  createPreviewPlan,
  executePreview,
  type PreviewEvaluator,
} from '../src/services/formula-execution-service.ts';
import { buildPreviewResponse } from '../src/services/formula-preview-response-service.ts';
import {
  resolvePreviewSelection,
  type PreviewSelection,
} from '../src/services/formula-selection-service.ts';
import {
  MAX_BULK_RECORDS,
  bulkPreviewBodySchema,
} from '../src/validation/bulk-preview-schemas.ts';

const validUuid = '00000000-0000-4000-8000-000000000001';

function formulaRow(
  name: string,
  inputs: readonly string[],
  formulaText = name,
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

function success(result: unknown): FormulaRunResult {
  return { status: 'SUCCESS', result, error: null, calculation: 'return 1', durationMs: 1 };
}

function failure(error: string): FormulaRunResult {
  return { status: 'FAILED', result: null, error, calculation: 'return 1', durationMs: 1 };
}

function workedExampleSnapshot(): FormulaRow[] {
  return [
    formulaRow(
      'commission',
      ['amount', 'rate'],
      'return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100',
    ),
    formulaRow('tax', ['commission'], 'return EXTERNAL_VAR.commission * 0.18'),
    formulaRow(
      'total',
      ['commission', 'tax'],
      'return EXTERNAL_VAR.commission + EXTERNAL_VAR.tax',
    ),
  ];
}

function workedExampleEvaluator(): PreviewEvaluator {
  return async (formulaText, data) => {
    if (formulaText.includes('amount')) {
      return success(Number(data.amount) * Number(data.rate) / 100);
    }
    if (formulaText.includes('0.18')) {
      return success(Number(data.commission) * 0.18);
    }
    return success(Number(data.commission) + Number(data.tax));
  };
}

test('bulkPreviewBodySchema accepts 1 to 500 records and optional selectors', () => {
  const minimal = bulkPreviewBodySchema.safeParse({ records: [{ amount: 2000 }] });
  assert.equal(minimal.success, true);
  if (!minimal.success) {
    assert.fail('Expected the minimal bulk body to pass validation');
  }
  assert.deepEqual(minimal.data, { records: [{ amount: 2000 }] });
  const full = bulkPreviewBodySchema.safeParse({
    records: [{ amount: 2000 }],
    formulaUuids: [validUuid],
    asOf: '2026-10-20T10:00:00+02:00',
  });
  assert.equal(full.success, true);
  if (!full.success) {
    assert.fail('Expected the full bulk body to pass validation');
  }
  assert.deepEqual(full.data.formulaUuids, [validUuid]);
  assert.ok(full.data.asOf);
  assert.equal(full.data.asOf.toISOString(), '2026-10-20T08:00:00.000Z');
  const emptySelection = bulkPreviewBodySchema.safeParse({
    records: [{}],
    formulaUuids: [],
  });
  assert.equal(emptySelection.success, true);
  const maximum = bulkPreviewBodySchema.safeParse({
    records: Array.from({ length: MAX_BULK_RECORDS }, () => ({})),
  });
  assert.equal(maximum.success, true);
});

test('bulkPreviewBodySchema rejects malformed bulk bodies', () => {
  const cases: Array<[string, unknown, string]> = [
    ['missing records', {}, 'records'],
    ['non-array records', { records: {} }, 'records'],
    ['empty records', { records: [] }, 'records'],
    [
      'too many records',
      { records: Array.from({ length: MAX_BULK_RECORDS + 1 }, () => ({})) },
      'records',
    ],
    ['null record', { records: [null] }, 'records.0'],
    ['array record', { records: [[]] }, 'records.0'],
    ['scalar record', { records: [1] }, 'records.0'],
    ['bad UUID', { records: [{}], formulaUuids: ['bad'] }, 'formulaUuids.0'],
    ['bad as-of', { records: [{}], asOf: '2026-10-20T10:00:00' }, 'asOf'],
  ];
  for (const [label, body, path] of cases) {
    const result = bulkPreviewBodySchema.safeParse(body);
    assert.equal(result.success, false, label);
    if (result.success) {
      continue;
    }
    assert.ok(
      result.error.issues.some((issue) => issue.path.join('.') === path),
      label,
    );
  }
  const unknownKey = bulkPreviewBodySchema.safeParse({ records: [{}], extra: true });
  assert.equal(unknownKey.success, false);
  if (!unknownKey.success) {
    assert.ok(unknownKey.error.issues.some(
      (issue) => issue.code === 'unrecognized_keys' && issue.keys.includes('extra'),
    ));
  }
});

test('previewFormulasBulk loads the snapshot and builds the plan once', async () => {
  const snapshot = workedExampleSnapshot();
  const asOf = new Date('2026-10-20T08:00:00.000Z');
  let snapshotCalls = 0;
  let planCalls = 0;
  let seenAsOf: Date | undefined;
  const createPlan = (selection: readonly PreviewSelection[]) => {
    planCalls += 1;
    return createPreviewPlan(selection);
  };
  const execution = await previewFormulasBulk(
    {
      records: [
        { amount: 2000, rate: 10 },
        { amount: 1000, rate: 5 },
        { amount: 500, rate: 20 },
      ],
      asOf,
    },
    {
      loadSnapshot: async (value) => {
        snapshotCalls += 1;
        seenAsOf = value;
        return snapshot;
      },
      createPlan,
      evaluator: workedExampleEvaluator(),
    },
  );
  assert.equal(snapshotCalls, 1);
  assert.equal(planCalls, 1);
  assert.equal(seenAsOf?.toISOString(), asOf.toISOString());
  assert.equal(execution.records.length, 3);
  for (const [index, result] of execution.records.entries()) {
    assert.equal(result.recordIndex, index);
    assert.deepEqual(
      result.formulas.map((formula) => formula.name),
      ['commission', 'tax', 'total'],
    );
    assert.ok(result.formulas.every((formula) => formula.status === 'SUCCESS'));
  }
  assert.deepEqual(
    execution.records.map((result) => result.record),
    [
      { amount: 2000, rate: 10, commission: 200, tax: 36, total: 236 },
      { amount: 1000, rate: 5, commission: 50, tax: 9, total: 59 },
      { amount: 500, rate: 20, commission: 100, tax: 18, total: 118 },
    ],
  );
});

test('previewFormulasBulk matches the single-preview explanations', async () => {
  const snapshot = workedExampleSnapshot();
  const record = { amount: 2000, rate: 10 };
  const evaluator = workedExampleEvaluator();
  const selection = resolvePreviewSelection(snapshot);
  const singleOutcomes = await executePreview(selection, record, { evaluator });
  const single = buildPreviewResponse('single-run', record, singleOutcomes);
  const bulk = await previewFormulasBulk(
    { records: [record] },
    {
      loadSnapshot: async () => snapshot,
      evaluator,
    },
  );
  const result = bulk.records[0];
  assert.ok(result);
  assert.deepEqual(result.inputRecord, single.inputRecord);
  assert.deepEqual(result.record, single.record);
  assert.deepEqual(result.formulas, single.formulas);
  assert.notEqual(result.runUuid, single.runUuid);
});

test('previewFormulasBulk rejects missing inputs before evaluating any record', async () => {
  let calls = 0;
  await assert.rejects(
    previewFormulasBulk(
      {
        records: [
          { amount: 2000, rate: 10 },
          { amount: 2000 },
        ],
      },
      {
        loadSnapshot: async () => workedExampleSnapshot(),
        evaluator: async () => {
          calls += 1;
          return success(1);
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'MISSING_INPUT');
      assert.deepEqual(error.details, { missing: ['rate'], recordIndex: 1 });
      return true;
    },
  );
  assert.equal(calls, 0);
});

test('previewFormulasBulk isolates failures per record', async () => {
  const fail = formulaRow('fail', ['trigger']);
  const dependent = formulaRow('dependent', ['fail']);
  const independent = formulaRow('independent', []);
  const evaluator: PreviewEvaluator = async (formulaText, data) => {
    if (formulaText === 'fail') {
      return data.trigger === true ? failure('boom') : success(5);
    }
    if (formulaText === 'dependent') {
      return success(Number(data.fail) + 1);
    }
    return success(7);
  };
  const execution = await previewFormulasBulk(
    { records: [{ trigger: true }, { trigger: false }] },
    {
      loadSnapshot: async () => [fail, dependent, independent],
      evaluator,
    },
  );
  const failedRecord = execution.records[0];
  const successfulRecord = execution.records[1];
  assert.ok(failedRecord);
  assert.ok(successfulRecord);
  assert.deepEqual(
    failedRecord.formulas.map((formula) => [formula.name, formula.status]),
    [
      ['fail', 'FAILED'],
      ['independent', 'SUCCESS'],
      ['dependent', 'SKIPPED'],
    ],
  );
  const skipped = failedRecord.formulas.find((formula) => formula.name === 'dependent');
  assert.equal(skipped?.reason, 'dependency fail failed');
  assert.deepEqual(failedRecord.record, { trigger: true, independent: 7 });
  assert.ok(successfulRecord.formulas.every((formula) => formula.status === 'SUCCESS'));
  assert.deepEqual(
    successfulRecord.formulas.map((formula) => formula.result),
    [5, 7, 6],
  );
  assert.deepEqual(successfulRecord.record, {
    trigger: false,
    fail: 5,
    independent: 7,
    dependent: 6,
  });
});

test('previewFormulasBulk bounds record and formula concurrency', async () => {
  const formulas = ['a', 'b', 'c', 'd'].map((name) => formulaRow(name, []));
  let activeFormulas = 0;
  let maxActiveFormulas = 0;
  const activeRecords = new Map<number, number>();
  let maxActiveRecords = 0;
  const evaluator: PreviewEvaluator = async (_formulaText, data) => {
    const recordId = Number(data.recordId);
    activeFormulas += 1;
    maxActiveFormulas = Math.max(maxActiveFormulas, activeFormulas);
    const recordActive = activeRecords.get(recordId) ?? 0;
    activeRecords.set(recordId, recordActive + 1);
    maxActiveRecords = Math.max(maxActiveRecords, activeRecords.size);
    await new Promise((resolve) => setTimeout(resolve, 15));
    activeFormulas -= 1;
    const remaining = (activeRecords.get(recordId) ?? 1) - 1;
    if (remaining === 0) {
      activeRecords.delete(recordId);
    } else {
      activeRecords.set(recordId, remaining);
    }
    return success(1);
  };
  const execution = await previewFormulasBulk(
    { records: [{ recordId: 1 }, { recordId: 2 }, { recordId: 3 }, { recordId: 4 }] },
    {
      loadSnapshot: async () => formulas,
      evaluator,
      recordConcurrency: 2,
      formulaConcurrency: 3,
      previewConcurrency: 4,
    },
  );
  assert.equal(maxActiveFormulas, 3);
  assert.equal(maxActiveRecords, 2);
  assert.equal(execution.records.length, 4);
  assert.ok(execution.records.every((record) => record.formulas.length === 4));
  assert.ok(execution.records.every(
    (record) => record.formulas.every((formula) => formula.status === 'SUCCESS'),
  ));
});

test('previewFormulasBulk supports an empty formula selection', async () => {
  const execution = await previewFormulasBulk(
    { records: [{ amount: 2000 }], formulaUuids: [] },
    { loadSnapshot: async () => workedExampleSnapshot() },
  );
  const result = execution.records[0];
  assert.ok(result);
  assert.deepEqual(result.formulas, []);
  assert.deepEqual(result.inputRecord, { amount: 2000 });
  assert.deepEqual(result.record, { amount: 2000 });
  assert.ok(result.runUuid.length > 0);
});
