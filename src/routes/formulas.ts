import { Router } from 'express';
import { saveFormula } from '../controllers/formula-controller.ts';

const router = Router();

router.post('/', saveFormula);

export default router;
