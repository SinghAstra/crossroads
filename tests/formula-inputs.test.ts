import test from 'node:test';
import assert from 'node:assert/strict';
import { extractInputs, stripStringsAndComments } from '../src/lib/formula-inputs.ts';

test('extractInputs returns each name in first-appearance order', () => {
  const inputs = extractInputs(
    'return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate + EXTERNAL_VAR.amount',
  );
  assert.deepEqual(inputs, ['amount', 'rate']);
});

test('extractInputs ignores names inside strings and comments', () => {
  const formula = [
    'const doubleQuoted = "EXTERNAL_VAR.double";',
    "const singleQuoted = 'EXTERNAL_VAR.single';",
    'const template = `EXTERNAL_VAR.template`;',
    '// EXTERNAL_VAR.line',
    '/* EXTERNAL_VAR.block */',
    'return EXTERNAL_VAR.real;',
  ].join('\n');
  assert.deepEqual(extractInputs(formula), ['real']);
});

test('stripStringsAndComments handles escapes and nested markers', () => {
  const formula = [
    'const text = "a \\" // EXTERNAL_VAR.hidden";',
    'const other = "/* EXTERNAL_VAR.hidden */";',
    'return EXTERNAL_VAR.real;',
  ].join('\n');
  const stripped = stripStringsAndComments(formula);
  assert.doesNotMatch(stripped, /EXTERNAL_VAR\.hidden/);
  assert.match(stripped, /EXTERNAL_VAR\.real/);
  assert.equal(stripped.split('\n').length, 3);
});

test('extractInputs ignores bracket notation and the internal CODE path', () => {
  const inputs = extractInputs(
    'return EXTERNAL_VAR["bracket"] + EXTERNAL_VAR.CODE + EXTERNAL_VAR.real;',
  );
  assert.deepEqual(inputs, ['real']);
});

test('stripStringsAndComments keeps code and line breaks', () => {
  const formula = 'const text = "EXTERNAL_VAR.hidden";\n// EXTERNAL_VAR.line\nreturn EXTERNAL_VAR.real;';
  const stripped = stripStringsAndComments(formula);
  assert.doesNotMatch(stripped, /EXTERNAL_VAR\.hidden/);
  assert.doesNotMatch(stripped, /EXTERNAL_VAR\.line/);
  assert.match(stripped, /EXTERNAL_VAR\.real/);
  assert.equal(stripped.split('\n').length, 3);
});

test('extractInputs returns no names from unterminated strings or comments', () => {
  assert.deepEqual(extractInputs('return "EXTERNAL_VAR.hidden'), []);
  assert.deepEqual(extractInputs('return /* EXTERNAL_VAR.hidden'), []);
});
