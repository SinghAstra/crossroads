import { randomUUID } from 'node:crypto';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { AppError } from '../lib/app-error.ts';
import { ErrorCodes } from '../lib/error-codes.ts';
import pool from './pool.ts';
import {
  getTableDefinition,
  type AppendOnlyTableDefinition,
  type TableDefinition,
  type TableName,
  type VersionedTableDefinition,
} from './table-registry.ts';

export type SavedRecord = Record<string, unknown>;

export interface SaveRecordOptions {
  readonly connection?: PoolConnection;
}

function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll('`', '``')}\``;
}

function serializeJson(value: unknown): string {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value);
}

function hasValue(data: Record<string, unknown>, column: string): boolean {
  return Object.hasOwn(data, column) && data[column] !== undefined;
}

function pickValues(
  data: Record<string, unknown>,
  columns: readonly string[],
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const column of columns) {
    if (hasValue(data, column)) {
      values[column] = data[column];
    }
  }
  return values;
}

function dataUuid(data: Record<string, unknown>, definition: TableDefinition): string | null {
  const value = data[definition.uuidColumn];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function createValues(
  data: Record<string, unknown>,
  definition: VersionedTableDefinition,
): Record<string, unknown> {
  const creationColumns = definition.immutableCreationColumns.filter(
    (column) => column !== definition.firstCreatedAtColumn,
  );
  const values = pickValues(data, [...definition.mergeableColumns, ...creationColumns]);
  values[definition.uuidColumn] = randomUUID();
  values[definition.versionColumn] = 1;
  values[definition.firstCreatedAtColumn] = new Date();
  return values;
}

function appendValues(
  data: Record<string, unknown>,
  definition: AppendOnlyTableDefinition,
): Record<string, unknown> {
  const values = pickValues(data, definition.mergeableColumns);
  values[definition.uuidColumn] = dataUuid(data, definition) ?? randomUUID();
  return values;
}

function changeValues(
  data: Record<string, unknown>,
  current: Record<string, unknown>,
  definition: VersionedTableDefinition,
): Record<string, unknown> {
  const values = pickValues(current, definition.mergeableColumns);
  const sentValues = pickValues(data, definition.mergeableColumns);
  for (const column of definition.mergeableColumns) {
    if (hasValue(sentValues, column)) {
      values[column] = sentValues[column];
    }
  }
  for (const column of definition.immutableCreationColumns) {
    values[column] = current[column];
  }
  values[definition.uuidColumn] = current[definition.uuidColumn];
  values[definition.versionColumn] = Number(current[definition.versionColumn]) + 1;
  return values;
}

async function findCurrent(
  connection: PoolConnection,
  definition: TableDefinition,
  uuid: string,
): Promise<Record<string, unknown> | null> {
  const table = quoteIdentifier(definition.table);
  const uuidColumn = quoteIdentifier(definition.uuidColumn);
  const primaryKey = quoteIdentifier(definition.primaryKey);
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT * FROM ${table} WHERE ${uuidColumn} = ? ORDER BY ${primaryKey} DESC LIMIT 1`,
    [uuid],
  );
  return rows[0] ?? null;
}

async function findById(
  connection: PoolConnection,
  definition: TableDefinition,
  id: number,
): Promise<SavedRecord> {
  const table = quoteIdentifier(definition.table);
  const primaryKey = quoteIdentifier(definition.primaryKey);
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT * FROM ${table} WHERE ${primaryKey} = ? LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'Saved record could not be read back');
  }
  return row;
}

async function insertValues(
  connection: PoolConnection,
  definition: TableDefinition,
  values: Record<string, unknown>,
): Promise<SavedRecord> {
  const columns = Object.keys(values);
  const placeholders = columns.map(() => '?').join(', ');
  const quotedColumns = columns.map(quoteIdentifier).join(', ');
  const parameters = columns.map((column) => (
    definition.jsonColumns.includes(column) ? serializeJson(values[column]) : values[column]
  ));
  const sql = `INSERT INTO ${quoteIdentifier(definition.table)} (${quotedColumns}) VALUES (${placeholders})`;
  const [result] = await connection.query<ResultSetHeader>(sql, parameters);
  return findById(connection, definition, result.insertId);
}

export async function saveRecord(
  table: TableName,
  data: Record<string, unknown>,
  options: SaveRecordOptions = {},
): Promise<SavedRecord> {
  const definition = getTableDefinition(table);
  const ownsConnection = options.connection === undefined;
  const connection = options.connection ?? (await pool.getConnection());
  try {
    if (definition.versionColumn === null) {
      return await insertValues(connection, definition, appendValues(data, definition));
    }
    const uuid = dataUuid(data, definition);
    if (!uuid) {
      return await insertValues(connection, definition, createValues(data, definition));
    }
    const current = await findCurrent(connection, definition, uuid);
    if (!current) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'Record not found', { uuid });
    }
    return await insertValues(connection, definition, changeValues(data, current, definition));
  } finally {
    if (ownsConnection) {
      connection.release();
    }
  }
}
