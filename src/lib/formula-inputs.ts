export function stripStringsAndComments(formula: string): string {
  let result = '';
  let index = 0;
  while (index < formula.length) {
    const char = formula.charAt(index);
    const next = formula.charAt(index + 1);
    if (char === '/' && next === '/') {
      result += '  ';
      index += 2;
      while (
        index < formula.length
        && formula.charAt(index) !== '\n'
        && formula.charAt(index) !== '\r'
      ) {
        result += ' ';
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      result += '  ';
      index += 2;
      while (index < formula.length) {
        const current = formula.charAt(index);
        if (current === '*' && formula.charAt(index + 1) === '/') {
          result += '  ';
          index += 2;
          break;
        }
        result += current === '\n' || current === '\r' ? current : ' ';
        index += 1;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      result += ' ';
      index += 1;
      while (index < formula.length) {
        const current = formula.charAt(index);
        if (current === '\\') {
          result += ' ';
          index += 1;
          if (index < formula.length) {
            const escaped = formula.charAt(index);
            result += escaped === '\n' || escaped === '\r' ? escaped : ' ';
            index += 1;
          }
          continue;
        }
        if (current === quote) {
          result += ' ';
          index += 1;
          break;
        }
        result += current === '\n' || current === '\r' ? current : ' ';
        index += 1;
      }
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

export function extractInputs(formula: string): string[] {
  const inputs: string[] = [];
  const seen = new Set<string>();
  const pattern = /\bEXTERNAL_VAR\.(?!CODE\b)([A-Za-z_$][\w$]*)/g;
  for (const match of stripStringsAndComments(formula).matchAll(pattern)) {
    const name = match[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      inputs.push(name);
    }
  }
  return inputs;
}
