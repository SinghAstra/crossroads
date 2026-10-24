import type { FormulaRow } from '../data/formula-repository.ts';
import { buildGraph } from '../lib/dependency-graph.ts';
import { formulasNotFound } from './formula-errors.ts';

export interface PreviewSelection {
  readonly formula: FormulaRow;
  readonly autoAdded: boolean;
}

function compareSelections(first: PreviewSelection, second: PreviewSelection): number {
  if (first.formula.name < second.formula.name) {
    return -1;
  }
  if (first.formula.name > second.formula.name) {
    return 1;
  }
  if (first.formula.uuid < second.formula.uuid) {
    return -1;
  }
  if (first.formula.uuid > second.formula.uuid) {
    return 1;
  }
  return 0;
}

export function resolvePreviewSelection(
  snapshot: readonly FormulaRow[],
  requestedUuids?: readonly string[],
): PreviewSelection[] {
  if (requestedUuids === undefined) {
    return snapshot
      .map((formula) => ({ formula, autoAdded: false }))
      .sort(compareSelections);
  }
  const byUuid = new Map(snapshot.map((formula) => [formula.uuid, formula]));
  const unknown = [...new Set(requestedUuids.filter((uuid) => !byUuid.has(uuid)))];
  if (unknown.length > 0) {
    throw formulasNotFound(unknown);
  }
  if (requestedUuids.length === 0) {
    return [];
  }
  const selected = new Map<string, PreviewSelection>();
  for (const uuid of requestedUuids) {
    const formula = byUuid.get(uuid);
    if (formula) {
      selected.set(uuid, { formula, autoAdded: false });
    }
  }
  const graph = buildGraph(snapshot, []);
  const queue = [...selected.values()].map((selection) => selection.formula);
  let index = 0;
  while (index < queue.length) {
    const formula = queue[index];
    index += 1;
    if (!formula) {
      continue;
    }
    for (const dependencyName of graph.dependencies.get(formula.name) ?? []) {
      const dependency = graph.formulas.get(dependencyName);
      if (!dependency || selected.has(dependency.uuid)) {
        continue;
      }
      selected.set(dependency.uuid, { formula: dependency, autoAdded: true });
      queue.push(dependency);
    }
  }
  return [...selected.values()].sort(compareSelections);
}
