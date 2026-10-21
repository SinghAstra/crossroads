import { performance } from 'node:perf_hooks';
import { runFormula } from './formula-adapter.ts';

const start = performance.now();
const response = await runFormula('while (true) {} return 1', {}, { timeout: 250 });
const elapsed = performance.now() - start;
console.log(JSON.stringify(response, null, 2));
console.log(`elapsed: ${elapsed.toFixed(1)} ms`);
