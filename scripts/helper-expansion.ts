const helpers: Record<string, string> = {
  ROUND: '((n,d)=>Math.round(n*10**d)/10**d)(',
  INT: '((n)=>Math.trunc(n))(',
  IF: '((c,a,b)=>c?a:b)(',
  AND: '((...a)=>a.every(Boolean))(',
  OR: '((...a)=>a.some(Boolean))(',
  XOR: '((...a)=>a.filter(Boolean).length%2===1)(',
  SUM: '((...a)=>a.reduce((x,y)=>x+y,0))(',
  CONCATSTR: '((...a)=>a.join(""))(',
  STRLENGTH: '((s)=>s.length)(',
};

const reverse = new Map(Object.entries(helpers).map(([name, expansion]) => [expansion, `${name}(`]));

export function expandHelpers(formula: string): string {
  return Object.entries(helpers).reduce(
    (result, [name, expansion]) => result.replace(new RegExp(`\\b${name}\\s*\\(`, 'g'), expansion),
    formula,
  );
}

export function restoreHelpers(calculation: string): string {
  let result = calculation;
  reverse.forEach((original, expansion) => {
    result = result.replaceAll(expansion, original);
  });
  return result;
}
