import { performance } from 'node:perf_hooks';
import { runFormula } from './formula-adapter.ts';

const cases: Array<{ name: string; formula: string; inputs: Record<string, unknown> }> = [
  { name: 'syntax error', formula: 'return EXTERNAL_VAR.amount *', inputs: { amount: 2000 } },
  { name: 'runtime throw', formula: 'return EXTERNAL_VAR.amount.notAFunction()', inputs: { amount: 2000 } },
  { name: 'missing variable', formula: 'return EXTERNAL_VAR.missing * 2', inputs: {} },
  { name: 'divide by zero', formula: 'return EXTERNAL_VAR.amount / 0', inputs: { amount: 2000 } },
  { name: 'non-numeric return', formula: 'return "hello"', inputs: {} },
];
for (const item of cases) {
  const start = performance.now();
  const response = await runFormula(item.formula, item.inputs);
  const elapsed = performance.now() - start;
  console.log(`--- ${item.name} ---`);
  console.log(JSON.stringify(response, null, 2));
  console.log(`data type: ${typeof response.data}`);
  console.log(`data string: ${String(response.data)}`);
  console.log(`elapsed: ${elapsed.toFixed(1)} ms`);
}
