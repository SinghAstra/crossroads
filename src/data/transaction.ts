import type { PoolConnection } from 'mysql2/promise';
import pool from './pool.ts';

export async function withTransaction<T>(
  work: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}
