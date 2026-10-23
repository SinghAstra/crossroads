import { randomUUID } from 'node:crypto';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { AppError } from '../lib/app-error.ts';
import { ErrorCodes } from '../lib/error-codes.ts';
import { isDuplicateKeyError } from '../lib/error-guards.ts';
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
  readonly expectedVersion?: number;
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

async function findInsertedRows(
  connection: PoolConnection,
  definition: TableDefinition,
  firstId: number,
  count: number,
): Promise<SavedRecord[]> {
  const table = quoteIdentifier(definition.table);
  const primaryKey = quoteIdentifier(definition.primaryKey);
  const lastId = firstId + count - 1;
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT * FROM ${table} WHERE ${primaryKey} BETWEEN ? AND ? ORDER BY ${primaryKey} ASC`,
    [firstId, lastId],
  );
  if (rows.length !== count) {
    throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'Saved records could not be read back');
  }
  return rows;
}

function duplicateKeyUuid(error: unknown): string | null {
  if (!(error instanceof Error) || !('sqlMessage' in error)) {
    return null;
  }
  const message = (error as { sqlMessage?: unknown }).sqlMessage;
  if (typeof message !== 'string') {
    return null;
  }
  const match = /Duplicate entry '(.+)-(\d+)' for key/.exec(message);
  return match?.[1] ?? null;
}

async function findConflictCurrent(
  connection: PoolConnection,
  definition: TableDefinition,
  rows: Record<string, unknown>[],
  error: unknown,
): Promise<SavedRecord | null> {
  if (definition.versionColumn === null) {
    return null;
  }
  const duplicateUuid = duplicateKeyUuid(error);
  if (duplicateUuid) {
    const current = await findCurrent(connection, definition, duplicateUuid);
    if (current) {
      return current;
    }
  }
  for (const row of rows) {
    const uuid = row[definition.uuidColumn];
    const version = Number(row[definition.versionColumn]);
    if (typeof uuid !== 'string') {
      continue;
    }
    const current = await findCurrent(connection, definition, uuid);
    if (current && Number(current[definition.versionColumn]) >= version) {
      return current;
    }
  }
  return null;
}

async function prepareRows(
  connection: PoolConnection,
  definition: TableDefinition,
  items: Record<string, unknown>[],
  expectedVersion?: number,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (const item of items) {
    if (definition.versionColumn === null) {
      rows.push(appendValues(item, definition));
      continue;
    }
    const uuid = dataUuid(item, definition);
    if (!uuid) {
      rows.push(createValues(item, definition));
      continue;
    }
    const current = await findCurrent(connection, definition, uuid);
    if (!current) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'Record not found', { uuid });
    }
    if (
      expectedVersion !== undefined
      && Number(current[definition.versionColumn]) !== expectedVersion
    ) {
      throw new AppError(409, ErrorCodes.VERSION_CONFLICT, 'A newer version already exists', {
        current,
      });
    }
    rows.push(changeValues(item, current, definition));
  }
  return rows;
}

async function insertRows(
  connection: PoolConnection,
  definition: TableDefinition,
  rows: Record<string, unknown>[],
): Promise<SavedRecord[]> {
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const valuesSql = rows.map((row) => {
    const placeholders = columns.map((column) => (Object.hasOwn(row, column) ? '?' : 'DEFAULT'));
    return `(${placeholders.join(', ')})`;
  }).join(', ');
  const parameters = rows.flatMap((row) => columns
    .filter((column) => Object.hasOwn(row, column))
    .map((column) => (
      definition.jsonColumns.includes(column) ? serializeJson(row[column]) : row[column]
    )));
  const table = quoteIdentifier(definition.table);
  const quotedColumns = columns.map(quoteIdentifier).join(', ');
  const sql = `INSERT INTO ${table} (${quotedColumns}) VALUES ${valuesSql}`;
  const [result] = await connection.query<ResultSetHeader>(sql, parameters);
  return findInsertedRows(connection, definition, result.insertId, result.affectedRows);
}

export function saveRecord(
  table: TableName,
  data: Record<string, unknown>,
  options?: SaveRecordOptions,
): Promise<SavedRecord>;
export function saveRecord(
  table: TableName,
  data: Record<string, unknown>[],
  options?: SaveRecordOptions,
): Promise<SavedRecord[]>;
export async function saveRecord(
  table: TableName,
  data: Record<string, unknown> | Record<string, unknown>[],
  options: SaveRecordOptions = {},
): Promise<SavedRecord | SavedRecord[]> {
  const definition = getTableDefinition(table);
  const items = Array.isArray(data) ? data : [data];
  if (items.length === 0) {
    return [];
  }
  const ownsConnection = options.connection === undefined;
  const connection = options.connection ?? (await pool.getConnection());
  let preparedRows: Record<string, unknown>[] = [];
  try {
    await connection.beginTransaction();
    preparedRows = await prepareRows(connection, definition, items, options.expectedVersion);
    const savedRows = await insertRows(connection, definition, preparedRows);
    await connection.commit();
    const first = savedRows[0];
    if (!first) {
      throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'Saved record could not be read back');
    }
    return Array.isArray(data) ? savedRows : first;
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    if (isDuplicateKeyError(error)) {
      const current = await findConflictCurrent(connection, definition, preparedRows, error).catch(
        () => null,
      );
      if (current) {
        throw new AppError(409, ErrorCodes.VERSION_CONFLICT, 'A newer version already exists', {
          current,
        });
      }
    }
    throw error;
  } finally {
    if (ownsConnection) {
      connection.release();
    }
  }
}
