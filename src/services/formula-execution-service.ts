import config from '../config/index.ts';
import type { FormulaRow } from '../data/formula-repository.ts';
import { mapWithConcurrency } from '../lib/concurrency.ts';
import {
  assertNoMissingInputs,
  buildGraph,
  computeLevels,
  type FormulaGraph,
} from '../lib/dependency-graph.ts';
import { runFormula } from '../lib/formula-runner.ts';
import type { FormulaRunResult } from '../lib/formula-runner-types.ts';
import type { PreviewSelection } from './formula-selection-service.ts';

export type PreviewRunStatus = 'SUCCESS' | 'FAILED' | 'SKIPPED';

export interface PreviewFormulaOutcome {
  readonly formula: FormulaRow;
  readonly autoAdded: boolean;
  readonly status: PreviewRunStatus;
  readonly result: unknown;
  readonly error: string | null;
  readonly reason: string | null;
  readonly calculation: string | null;
  readonly durationMs: number;
}

export type PreviewEvaluator = (
  formulaText: string,
  data: Record<string, unknown>,
) => Promise<FormulaRunResult>;

export interface PreviewExecutionOptions {
  readonly evaluator?: PreviewEvaluator;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
}

interface FormulaEvaluation {
  readonly outcome: PreviewFormulaOutcome;
  readonly rawResult: unknown;
}

function defaultEvaluator(timeoutMs: number): PreviewEvaluator {
  return (formulaText, data) => runFormula(formulaText, data, { timeoutMs });
}

function roundResult(result: unknown): unknown {
  if (typeof result === 'number' && Number.isFinite(result)) {
    return Number(result.toFixed(2));
  }
  return result;
}

function makeOutcome(
  selection: PreviewSelection,
  status: PreviewRunStatus,
  result: unknown,
  error: string | null,
  reason: string | null,
  calculation: string | null,
  durationMs: number,
): PreviewFormulaOutcome {
  return {
    formula: selection.formula,
    autoAdded: selection.autoAdded,
    status,
    result,
    error,
    reason,
    calculation,
    durationMs,
  };
}

async function evaluateSelection(
  selection: PreviewSelection,
  values: ReadonlyMap<string, unknown>,
  evaluator: PreviewEvaluator,
): Promise<FormulaEvaluation> {
  const data = Object.fromEntries(values);
  try {
    const run = await evaluator(selection.formula.formula_text, data);
    if (run.status === 'SUCCESS') {
      return {
        outcome: makeOutcome(
          selection,
          'SUCCESS',
          roundResult(run.result),
          null,
          null,
          run.calculation,
          run.durationMs,
        ),
        rawResult: run.result,
      };
    }
    return {
      outcome: makeOutcome(
        selection,
        'FAILED',
        null,
        run.error ?? 'Formula evaluation failed',
        null,
        run.calculation,
        run.durationMs,
      ),
      rawResult: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Formula evaluation failed';
    return {
      outcome: makeOutcome(selection, 'FAILED', null, message, null, null, 0),
      rawResult: null,
    };
  }
}

function firstFailedDependency(
  formulaName: string,
  graph: FormulaGraph<FormulaRow>,
  outcomesByName: ReadonlyMap<string, PreviewFormulaOutcome>,
): string | null {
  for (const dependency of graph.dependencies.get(formulaName) ?? []) {
    const outcome = outcomesByName.get(dependency);
    if (!outcome || outcome.status !== 'SUCCESS') {
      return dependency;
    }
  }
  return null;
}

export function assertPreviewInputs(
  selection: readonly PreviewSelection[],
  record: Record<string, unknown>,
): FormulaGraph<FormulaRow> {
  const graph = buildGraph(
    selection.map((item) => item.formula),
    Object.keys(record),
  );
  assertNoMissingInputs(graph);
  return graph;
}

export async function executePreview(
  selection: readonly PreviewSelection[],
  record: Record<string, unknown>,
  options: PreviewExecutionOptions = {},
): Promise<PreviewFormulaOutcome[]> {
  const graph = assertPreviewInputs(selection, record);
  const levels = computeLevels(graph);
  const evaluator = options.evaluator
    ?? defaultEvaluator(options.timeoutMs ?? config.formula.timeoutMs);
  const concurrency = options.concurrency ?? config.formula.previewConcurrency;
  const selectionByName = new Map(
    selection.map((item) => [item.formula.name, item]),
  );
  const outcomes: PreviewFormulaOutcome[] = [];
  const outcomesByName = new Map<string, PreviewFormulaOutcome>();
  const failureRoots = new Map<string, string>();
  const values = new Map<string, unknown>(Object.entries(record));
  for (const level of levels) {
    const runnable: PreviewSelection[] = [];
    for (const formula of level) {
      const selected = selectionByName.get(formula.name);
      if (!selected) {
        continue;
      }
      const dependency = firstFailedDependency(formula.name, graph, outcomesByName);
      if (dependency) {
        const root = failureRoots.get(dependency) ?? dependency;
        failureRoots.set(formula.name, root);
        outcomesByName.set(
          formula.name,
          makeOutcome(
            selected,
            'SKIPPED',
            null,
            null,
            `dependency ${root} failed`,
            null,
            0,
          ),
        );
        continue;
      }
      runnable.push(selected);
    }
    const evaluations = await mapWithConcurrency(
      runnable,
      concurrency,
      (selected) => evaluateSelection(selected, values, evaluator),
    );
    for (const evaluation of evaluations) {
      const outcome = evaluation.outcome;
      outcomesByName.set(outcome.formula.name, outcome);
      if (outcome.status === 'SUCCESS') {
        values.set(outcome.formula.name, evaluation.rawResult);
      } else {
        failureRoots.set(outcome.formula.name, outcome.formula.name);
      }
    }
    for (const formula of level) {
      const outcome = outcomesByName.get(formula.name);
      if (outcome) {
        outcomes.push(outcome);
      }
    }
  }
  return outcomes;
}
