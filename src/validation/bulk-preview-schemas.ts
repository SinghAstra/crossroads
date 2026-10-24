import { z } from 'zod';
import {
  previewAsOfSchema,
  previewFormulaUuidsSchema,
} from './preview-schemas.ts';

export const MAX_BULK_RECORDS = 500;

export const bulkPreviewRecordsSchema = z.array(
  z.record(z.string(), z.unknown(), 'records must contain only objects'),
  'records must be an array of objects',
).min(1, 'records must contain at least 1 record').max(
  MAX_BULK_RECORDS,
  `records must contain at most ${MAX_BULK_RECORDS} records`,
);

export const bulkPreviewBodySchema = z.strictObject({
  records: bulkPreviewRecordsSchema,
  formulaUuids: previewFormulaUuidsSchema.optional(),
  asOf: previewAsOfSchema.optional(),
});

export type BulkPreviewBody = z.infer<typeof bulkPreviewBodySchema>;
