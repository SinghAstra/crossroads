import { AppError } from '../lib/app-error.ts';
import {
  buildGraph,
  computeLevels,
  findImpact,
  type FormulaGraph,
  type ImpactEntry,
} from '../lib/dependency-graph.ts';
import { ErrorCodes } from '../lib/error-codes.ts';
import { runFormula } from '../lib/formula-runner.ts';
import type { FormulaSnapshot } from '../lib/formula-types.ts';

export interface ImpactedFormula {
  readonly uuid: string;
  readonly name: string;
  readonly depth: number;
  readonly path: readonly string[];
}

function activeNames(
  formulas: readonly FormulaSnapshot[],
  proposed: FormulaSnapshot,
): Set<string> {
  const names = new Set(
    formulas
      .filter((formula) => formula.uuid !== proposed.uuid)
      .map((formula) => formula.name),
  );
  if (proposed.status === 'ACTIVE') {
    names.add(proposed.name);
  }
  return names;
}

export function assertActiveNameAvailable(
  formulas: readonly FormulaSnapshot[],
  name: string,
  uuid?: string,
): void {
  const conflict = formulas.find((formula) => formula.name === name && formula.uuid !== uuid);
  if (!conflict) {
    return;
  }
  throw new AppError(
    400,
    ErrorCodes.VALIDATION_ERROR,
    `An active formula named "${name}" already exists`,
    { name, uuid: conflict.uuid },
  );
}

export function sampleRecordFields(
  formulas: readonly FormulaSnapshot[],
  proposed: FormulaSnapshot,
): string[] {
  const names = activeNames(formulas, proposed);
  return proposed.inputs.filter((input) => !names.has(input));
}

export function buildProposedGraph(
  formulas: readonly FormulaSnapshot[],
  proposed: FormulaSnapshot,
): FormulaGraph<FormulaSnapshot> {
  const nodes = formulas.filter((formula) => formula.uuid !== proposed.uuid);
  if (proposed.status === 'ACTIVE') {
    nodes.push(proposed);
  }
  return buildGraph(nodes, new Set());
}

export function assertSaveGraphAcyclic(
  formulas: readonly FormulaSnapshot[],
  proposed: FormulaSnapshot,
): void {
  if (proposed.status === 'INACTIVE' && proposed.inputs.includes(proposed.name)) {
    throw new AppError(
      400,
      ErrorCodes.DEPENDENCY_CYCLE,
      `Dependency cycle detected: ${proposed.name} -> ${proposed.name}`,
      { path: [proposed.name, proposed.name] },
    );
  }
  computeLevels(buildProposedGraph(formulas, proposed));
}

export async function validateFormulaSample(
  formulas: readonly FormulaSnapshot[],
  proposed: FormulaSnapshot,
  sampleData?: Record<string, unknown>,
): Promise<void> {
  const recordFields = sampleRecordFields(formulas, proposed);
  const data: Record<string, unknown> = sampleData ? { ...sampleData } : {};
  if (sampleData) {
    const missing = recordFields.filter((field) => !Object.hasOwn(sampleData, field));
    if (missing.length > 0) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        'sampleData is missing referenced fields',
        { missing },
      );
    }
  }
  for (const input of proposed.inputs) {
    if (!Object.hasOwn(data, input)) {
      data[input] = 1;
    }
  }
  const result = await runFormula(proposed.formula_text, data);
  if (result.status === 'FAILED') {
    throw new AppError(
      400,
      ErrorCodes.FORMULA_INVALID,
      `Formula validation failed: ${result.error ?? 'unknown error'}`,
      {
        error: result.error,
        calculation: result.calculation,
        durationMs: result.durationMs,
      },
    );
  }
}

function toImpactedFormula(entry: ImpactEntry<FormulaSnapshot>): ImpactedFormula {
  return {
    uuid: entry.formula.uuid,
    name: entry.formula.name,
    depth: entry.depth,
    path: entry.path,
  };
}

export function assertNoDependentBreakage(
  formulas: readonly FormulaSnapshot[],
  formulaName: string,
  force: boolean,
): void {
  if (force) {
    return;
  }
  const graph = buildGraph(formulas, new Set());
  const impact = findImpact(graph, formulaName);
  if (impact.length === 0) {
    return;
  }
  throw new AppError(
    400,
    ErrorCodes.DEPENDENTS_EXIST,
    `Formula "${formulaName}" is used by active formulas`,
    { impacted: impact.map(toImpactedFormula) },
  );
}
