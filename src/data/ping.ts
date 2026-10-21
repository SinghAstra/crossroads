import pool from './pool.ts';

export async function pingDatabase(): Promise<void> {
  await pool.query('SELECT 1');
}
