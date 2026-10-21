import { closePool } from '../data/close-pool.ts';
import { closeFormulaWorkers } from './formula-worker-pool.ts';

export async function closeResources(): Promise<void> {
  await Promise.all([closePool(), closeFormulaWorkers()]);
}
