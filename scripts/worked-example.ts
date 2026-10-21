import { runFormula } from './formula-adapter.ts';

const response = await runFormula(
  'return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100',
  { amount: 2000, rate: 10 },
);
console.log(JSON.stringify(response, null, 2));
console.log(`result field: ${Object.hasOwn(response, 'data') ? 'data' : 'missing'}`);
