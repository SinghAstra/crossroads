export interface TableDefinitionBase {
  readonly table: string;
  readonly primaryKey: string;
  readonly uuidColumn: string;
  readonly immutableCreationColumns: readonly string[];
  readonly mergeableColumns: readonly string[];
  readonly jsonColumns: readonly string[];
}

export interface VersionedTableDefinition extends TableDefinitionBase {
  readonly versionColumn: string;
  readonly firstCreatedAtColumn: string;
}

export interface AppendOnlyTableDefinition extends TableDefinitionBase {
  readonly versionColumn: null;
  readonly firstCreatedAtColumn: null;
}

export type TableDefinition = VersionedTableDefinition | AppendOnlyTableDefinition;

const tableDefinitions = {
  formulas: {
    table: 'formulas',
    primaryKey: 'id',
    uuidColumn: 'uuid',
    versionColumn: 'version',
    firstCreatedAtColumn: 'first_created_at',
    immutableCreationColumns: ['created_by', 'first_created_at'],
    mergeableColumns: ['name', 'formula_text', 'status', 'inputs'],
    jsonColumns: ['inputs'],
  },
  formula_runs: {
    table: 'formula_runs',
    primaryKey: 'id',
    uuidColumn: 'run_uuid',
    versionColumn: null,
    firstCreatedAtColumn: null,
    immutableCreationColumns: [],
    mergeableColumns: [
      'formula_uuid',
      'formula_name',
      'formula_version',
      'record_index',
      'input_json',
      'result',
      'calculation_text',
      'error',
      'status',
    ],
    jsonColumns: ['input_json', 'result'],
  },
} as const satisfies Record<string, TableDefinition>;

export type TableName = keyof typeof tableDefinitions;

export function getTableDefinition(table: TableName): TableDefinition {
  return tableDefinitions[table];
}
