import { z } from 'zod';

export const previewRecordSchema = z.record(
  z.string(),
  z.unknown(),
  'record is required and must be an object',
);

export const previewFormulaUuidsSchema = z.array(
  z.uuid('formulaUuids must contain only valid UUIDs'),
  'formulaUuids must be an array of UUIDs',
);

export const previewAsOfSchema = z.iso.datetime({
  offset: true,
  error: 'asOf must be an ISO 8601 timestamp with a timezone',
}).transform((value) => new Date(value));

export const previewBodySchema = z.strictObject({
  record: previewRecordSchema,
  formulaUuids: previewFormulaUuidsSchema.optional(),
  asOf: previewAsOfSchema.optional(),
});

export type PreviewBody = z.infer<typeof previewBodySchema>;
