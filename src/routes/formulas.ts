import { Router } from 'express';
import {
  deactivateFormula,
  formulaHistory,
  formulaImpact,
  listFormulas,
  previewBulkFormulas,
  previewFormula,
  rollbackFormula,
  saveFormula,
} from '../controllers/formula-controller.ts';

const router = Router();

router.post('/', saveFormula);
router.post('/preview', previewFormula);
router.post('/preview/bulk', previewBulkFormulas);
router.post('/:uuid/deactivate', deactivateFormula);
router.post('/:uuid/rollback', rollbackFormula);
router.get('/', listFormulas);
router.get('/:uuid/history', formulaHistory);
router.get('/:uuid/impact', formulaImpact);

export default router;
