import { runFormula } from './formula-adapter.ts';

const response = await runFormula(
  'return ROUND(EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100, 2)',
  { amount: 2000, rate: 10 },
);
console.log(JSON.stringify(response, null, 2));
console.log('--- raw calculation ---');
console.log(response.calculation);
