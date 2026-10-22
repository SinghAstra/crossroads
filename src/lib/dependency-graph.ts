import { AppError } from './app-error.ts';
import { ErrorCodes } from './error-codes.ts';

export interface FormulaNode {
  readonly name: string;
  readonly inputs: readonly string[];
}

export interface FormulaGraph<T extends FormulaNode = FormulaNode> {
  readonly formulas: ReadonlyMap<string, T>;
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
  readonly dependents: ReadonlyMap<string, readonly string[]>;
  readonly recordFields: ReadonlyMap<string, readonly string[]>;
  readonly missingInputs: ReadonlyMap<string, readonly string[]>;
  readonly recordKeys: ReadonlySet<string>;
}

function addUnique(map: Map<string, string[]>, key: string, value: string): void {
  const values = map.get(key);
  if (values && !values.includes(value)) {
    values.push(value);
  }
}

function compareNames(first: string, second: string): number {
  if (first < second) {
    return -1;
  }
  if (first > second) {
    return 1;
  }
  return 0;
}

export function buildGraph<T extends FormulaNode>(
  formulas: readonly T[],
  recordKeys: Iterable<string>,
): FormulaGraph<T> {
  const formulaMap = new Map<string, T>();
  const dependencies = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const recordFields = new Map<string, string[]>();
  const missingInputs = new Map<string, string[]>();
  const keys = new Set(recordKeys);
  for (const formula of formulas) {
    if (formulaMap.has(formula.name)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Duplicate formula name', {
        name: formula.name,
      });
    }
    formulaMap.set(formula.name, formula);
    dependencies.set(formula.name, []);
    dependents.set(formula.name, []);
    recordFields.set(formula.name, []);
    missingInputs.set(formula.name, []);
  }
  for (const formula of formulas) {
    const formulaDependencies = dependencies.get(formula.name);
    const formulaRecordFields = recordFields.get(formula.name);
    const formulaMissingInputs = missingInputs.get(formula.name);
    if (!formulaDependencies || !formulaRecordFields || !formulaMissingInputs) {
      continue;
    }
    for (const input of formula.inputs) {
      if (formulaMap.has(input)) {
        if (!formulaDependencies.includes(input)) {
          formulaDependencies.push(input);
          addUnique(dependents, input, formula.name);
        }
        continue;
      }
      if (!formulaRecordFields.includes(input)) {
        formulaRecordFields.push(input);
      }
      if (!keys.has(input) && !formulaMissingInputs.includes(input)) {
        formulaMissingInputs.push(input);
      }
    }
  }
  return {
    formulas: formulaMap,
    dependencies,
    dependents,
    recordFields,
    missingInputs,
    recordKeys: keys,
  };
}

export function computeLevels<T extends FormulaNode>(graph: FormulaGraph<T>): T[][] {
  const indegree = new Map<string, number>();
  for (const [name, dependencies] of graph.dependencies) {
    indegree.set(name, dependencies.length);
  }
  let current = [...graph.formulas.keys()].filter((name) => (indegree.get(name) ?? 0) === 0);
  const levels: T[][] = [];
  let processed = 0;
  while (current.length > 0) {
    current.sort(compareNames);
    const level: T[] = [];
    for (const name of current) {
      const formula = graph.formulas.get(name);
      if (formula) {
        level.push(formula);
      }
    }
    levels.push(level);
    const next = new Set<string>();
    for (const name of current) {
      processed += 1;
      for (const dependent of graph.dependents.get(name) ?? []) {
        const remaining = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, remaining);
        if (remaining === 0) {
          next.add(dependent);
        }
      }
    }
    current = [...next];
  }
  if (processed !== graph.formulas.size) {
    const remaining = [...graph.formulas.keys()]
      .filter((name) => (indegree.get(name) ?? 0) > 0)
      .sort(compareNames);
    throw new AppError(400, ErrorCodes.DEPENDENCY_CYCLE, 'Dependency cycle detected', {
      formulas: remaining,
    });
  }
  return levels;
}
