import { performance } from 'node:perf_hooks';
import { runFormula } from './formula-adapter.ts';

const formula = 'return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100';
const inputs = { amount: 2000, rate: 10 };

async function measure(count: number, concurrency: number) {
  let failures = 0;
  const start = performance.now();
  for (let offset = 0; offset < count; offset += concurrency) {
    const size = Math.min(concurrency, count - offset);
    const batch = await Promise.all(Array.from({ length: size }, () => runFormula(formula, inputs)));
    failures += batch.filter((response) => response.status !== 1 || response.data !== 200).length;
  }
  const elapsed = performance.now() - start;
  return { count, concurrency, elapsed, average: elapsed / count, failures };
}

await runFormula(formula, inputs);
const cases: Array<[number, number]> = [
  [1, 1],
  [10, 1],
  [100, 1],
  [100, 4],
  [100, 8],
];
const measurements = [];
for (const [count, concurrency] of cases) {
  measurements.push(await measure(count, concurrency));
}
console.table(measurements.map((item) => ({
  calls: item.count,
  concurrency: item.concurrency,
  elapsedMs: item.elapsed.toFixed(1),
  averageMs: item.average.toFixed(1),
  failures: item.failures,
})));
const best = measurements
  .filter((item) => item.count === 100)
  .reduce((left, right) => (left.average < right.average ? left : right));
const estimate = (best.average * 5000) / 1000;
const requiredConcurrency = Math.ceil((best.concurrency * best.average) / 6);
console.log(`best 100-call average: ${best.average.toFixed(1)} ms at concurrency ${best.concurrency}`);
console.log(`5000-call estimate: ${estimate.toFixed(1)} s`);
console.log(`30-second budget feasible: ${estimate <= 30 ? 'yes' : 'no'}`);
console.log(`rough concurrency needed for 30 s: ${requiredConcurrency}`);
