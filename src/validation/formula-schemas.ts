import { z } from 'zod';

export const FORMULA_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const MAX_FORMULA_TEXT_LENGTH = 10_000;
export const MAX_CREATED_BY_LENGTH = 100;

export const formulaNameSchema = z.string().regex(
  FORMULA_NAME_PATTERN,
  'name must be a valid identifier of at most 64 characters',
);
export const formulaTextSchema = z.string()
  .min(1, 'formulaText is required')
  .max(
    MAX_FORMULA_TEXT_LENGTH,
    `formulaText must be at most ${MAX_FORMULA_TEXT_LENGTH} characters`,
  );
export const formulaUuidSchema = z.uuid('uuid must be a valid UUID');
export const formulaVersionSchema = z.number()
  .int('version must be an integer')
  .min(1, 'version must be a positive integer');
export const targetVersionSchema = z.number()
  .int('targetVersion must be an integer')
  .min(1, 'targetVersion must be a positive integer');
export const createdBySchema = z.string()
  .min(1, 'createdBy must not be empty')
  .max(MAX_CREATED_BY_LENGTH, `createdBy must be at most ${MAX_CREATED_BY_LENGTH} characters`);
export const sampleDataSchema = z.record(z.string(), z.unknown());
export const forceSchema = z.boolean('force must be a boolean');

export const createFormulaBodySchema = z.strictObject({
  name: formulaNameSchema,
  formulaText: formulaTextSchema,
  createdBy: createdBySchema.optional(),
  sampleData: sampleDataSchema.optional(),
});

export const changeFormulaBodySchema = z.strictObject({
  uuid: formulaUuidSchema,
  version: formulaVersionSchema,
  name: formulaNameSchema.optional(),
  formulaText: formulaTextSchema.optional(),
  sampleData: sampleDataSchema.optional(),
  force: forceSchema.optional(),
});

export const deactivateFormulaBodySchema = z.strictObject({
  version: formulaVersionSchema,
  force: forceSchema.optional(),
});

export const rollbackFormulaBodySchema = z.strictObject({
  version: formulaVersionSchema,
  targetVersion: targetVersionSchema,
  force: forceSchema.optional(),
});

export const formulaUuidParamsSchema = z.strictObject({
  uuid: formulaUuidSchema,
});

export type CreateFormulaBody = z.infer<typeof createFormulaBodySchema>;
export type ChangeFormulaBody = z.infer<typeof changeFormulaBodySchema>;
export type DeactivateFormulaBody = z.infer<typeof deactivateFormulaBodySchema>;
export type RollbackFormulaBody = z.infer<typeof rollbackFormulaBodySchema>;
