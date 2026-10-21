import { Router } from 'express';
import { pingDatabase } from '../data/ping.ts';
import { AppError } from '../lib/app-error.ts';
import { ErrorCodes } from '../lib/error-codes.ts';

const router = Router();

router.get('/health', async (_req, res, next) => {
  try {
    await pingDatabase();
    res.status(200).json({ status: 'ok', database: 'connected' });
  } catch {
    next(new AppError(503, ErrorCodes.DATABASE_UNAVAILABLE, 'Database health check failed'));
  }
});

export default router;
