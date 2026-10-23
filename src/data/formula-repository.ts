import type { RowDataPacket } from 'mysql2/promise';
import type { FormulaSnapshot, FormulaStatus } from '../lib/formula-types.ts';
import pool from './pool.ts';

export interface FormulaRow extends FormulaSnapshot {
  readonly id: number;
  readonly created_by: string;
  readonly first_created_at: Date | string;
  readonly inserted_at: Date | string;
}

const formulaColumns = [
  'id',
  'uuid',
  'version',
  'name',
  'formula_text',
  'status',
  'created_by',
  'first_created_at',
  'inserted_at',
  'inputs',
].join(', ');

function parseInputs(value: unknown): string[] {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is string => typeof item === 'string');
}

function parseStatus(value: unknown): FormulaStatus {
  return value === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
}

export function normalizeFormulaRow(row: Record<string, unknown>): FormulaRow {
  return {
    id: Number(row.id),
    uuid: String(row.uuid),
    version: Number(row.version),
    name: String(row.name),
    formula_text: String(row.formula_text),
    status: parseStatus(row.status),
    created_by: String(row.created_by),
    first_created_at: row.first_created_at as Date | string,
    inserted_at: row.inserted_at as Date | string,
    inputs: parseInputs(row.inputs),
  };
}

export async function listActiveFormulas(): Promise<FormulaRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${formulaColumns} FROM current_formulas_window WHERE status = 'ACTIVE' ORDER BY name ASC, uuid ASC`,
  );
  return rows.map((row) => normalizeFormulaRow(row));
}

export async function findCurrentFormula(uuid: string): Promise<FormulaRow | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${formulaColumns} FROM current_formulas_window WHERE uuid = ? LIMIT 1`,
    [uuid],
  );
  const row = rows[0];
  return row ? normalizeFormulaRow(row) : null;
}
