import express, { type Express } from 'express';
import { errorHandler } from './lib/error-handler.ts';
import { notFoundHandler } from './lib/not-found.ts';
import formulasRouter from './routes/formulas.ts';
import healthRouter from './routes/health.ts';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));
  app.use(healthRouter);
  app.use('/formulas', formulasRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export default createApp;
