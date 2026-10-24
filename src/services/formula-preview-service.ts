import { randomUUID } from 'node:crypto';
import type { PreviewBody } from '../validation/preview-schemas.ts';
import { executePreview } from './formula-execution-service.ts';
import {
  buildPreviewResponse,
  type PreviewResponse,
} from './formula-preview-response-service.ts';
import { writePreviewRunLog } from './formula-run-log-service.ts';
import { resolvePreviewSelection } from './formula-selection-service.ts';
import { loadPreviewSnapshot } from './formula-snapshot-service.ts';

export async function previewFormulas(body: PreviewBody): Promise<PreviewResponse> {
  const snapshot = await loadPreviewSnapshot(body.asOf);
  const selection = resolvePreviewSelection(snapshot, body.formulaUuids);
  const outcomes = await executePreview(selection, body.record);
  const runUuid = randomUUID();
  await writePreviewRunLog(runUuid, outcomes);
  return buildPreviewResponse(runUuid, body.record, outcomes);
}
