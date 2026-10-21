import pool from './pool.ts';

export async function closePool(): Promise<void> {
  await pool.end();
}
