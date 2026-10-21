import { runFormula } from './formula-adapter.ts';

const response = await runFormula(
  'return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100',
  { amount: 2000, rate: 10 },
);
console.log('--- raw calculation ---');
console.log(response.calculation);
