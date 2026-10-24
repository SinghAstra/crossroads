import {
  findCurrentFormula,
  findFormulaHistory,
  listActiveFormulas,
  listCurrentFormulas,
  type FormulaRow,
} from '../data/formula-repository.ts';
import { buildGraph, findImpact, type ImpactEntry } from '../lib/dependency-graph.ts';
import { formulaNotFound } from './formula-errors.ts';

export type FormulaImpact = ImpactEntry<FormulaRow>;

export async function listFormulas(): Promise<FormulaRow[]> {
  return listCurrentFormulas();
}

export async function getFormulaHistory(uuid: string): Promise<FormulaRow[]> {
  const history = await findFormulaHistory(uuid);
  if (history.length === 0) {
    throw formulaNotFound(uuid);
  }
  return history;
}

export async function getFormulaImpact(uuid: string): Promise<FormulaImpact[]> {
  const current = await findCurrentFormula(uuid);
  if (!current) {
    throw formulaNotFound(uuid);
  }
  if (current.status !== 'ACTIVE') {
    return [];
  }
  const active = await listActiveFormulas();
  const graph = buildGraph(active, new Set());
  return findImpact(graph, current.name);
}
