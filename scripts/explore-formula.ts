import { interpretor } from 'formula-interpreter';

const response = await interpretor('return 1 + 1', [], {});
console.log(JSON.stringify(response, null, 2));
