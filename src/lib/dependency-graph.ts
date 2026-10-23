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
    const path = findCyclePath(graph);
    if (path) {
      throw new AppError(
        400,
        ErrorCodes.DEPENDENCY_CYCLE,
        `Dependency cycle detected: ${path.join(' -> ')}`,
        { path },
      );
    }
    const remaining = [...graph.formulas.keys()]
      .filter((name) => (indegree.get(name) ?? 0) > 0)
      .sort(compareNames);
    throw new AppError(400, ErrorCodes.DEPENDENCY_CYCLE, 'Dependency cycle detected', {
      formulas: remaining,
    });
  }
  return levels;
}

export function findCyclePath<T extends FormulaNode>(graph: FormulaGraph<T>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();
  const visit = (name: string): string[] | null => {
    state.set(name, 1);
    stackIndex.set(name, stack.length);
    stack.push(name);
    const dependencies = [...(graph.dependencies.get(name) ?? [])].sort(compareNames);
    for (const dependency of dependencies) {
      const dependencyState = state.get(dependency);
      if (dependencyState === 1) {
        const start = stackIndex.get(dependency);
        if (start === undefined) {
          return [dependency, dependency];
        }
        return [...stack.slice(start), dependency];
      }
      if (dependencyState === undefined) {
        const cycle = visit(dependency);
        if (cycle) {
          return cycle;
        }
      }
    }
    stack.pop();
    stackIndex.delete(name);
    state.set(name, 2);
    return null;
  };
  const names = [...graph.formulas.keys()].sort(compareNames);
  for (const name of names) {
    if (state.has(name)) {
      continue;
    }
    const cycle = visit(name);
    if (cycle) {
      return cycle;
    }
  }
  return null;
}

export function collectMissingInputs<T extends FormulaNode>(graph: FormulaGraph<T>): string[] {
  const missing = new Set<string>();
  for (const names of graph.missingInputs.values()) {
    for (const name of names) {
      missing.add(name);
    }
  }
  return [...missing].sort(compareNames);
}

export function assertNoMissingInputs<T extends FormulaNode>(graph: FormulaGraph<T>): void {
  const missing = collectMissingInputs(graph);
  if (missing.length > 0) {
    throw new AppError(400, ErrorCodes.MISSING_INPUT, `Missing inputs: ${missing.join(', ')}`, {
      missing,
    });
  }
}

export interface ImpactEntry<T extends FormulaNode = FormulaNode> {
  readonly formula: T;
  readonly depth: number;
  readonly path: readonly string[];
}

interface ImpactQueueEntry {
  readonly name: string;
  readonly depth: number;
  readonly path: readonly string[];
}

export function findImpact<T extends FormulaNode>(
  graph: FormulaGraph<T>,
  targetName: string,
): ImpactEntry<T>[] {
  if (!graph.formulas.has(targetName)) {
    return [];
  }
  const visited = new Set<string>([targetName]);
  const queue: ImpactQueueEntry[] = [{ name: targetName, depth: 0, path: [targetName] }];
  const impact: ImpactEntry<T>[] = [];
  let index = 0;
  while (index < queue.length) {
    const current = queue[index];
    index += 1;
    if (!current) {
      continue;
    }
    const dependents = [...(graph.dependents.get(current.name) ?? [])].sort(compareNames);
    for (const dependentName of dependents) {
      if (visited.has(dependentName)) {
        continue;
      }
      const formula = graph.formulas.get(dependentName);
      if (!formula) {
        continue;
      }
      visited.add(dependentName);
      const depth = current.depth + 1;
      const path = [...current.path, dependentName];
      impact.push({ formula, depth, path });
      queue.push({ name: dependentName, depth, path });
    }
  }
  impact.sort(
    (first, second) => first.depth - second.depth
      || compareNames(first.formula.name, second.formula.name),
  );
  return impact;
}
