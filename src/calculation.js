export const CALCULATION_TOOL = {
  type: 'function', function: { name: 'calculate',
    description: 'Evaluate a numeric expression locally. Supports + - * / ^ and parentheses, including decimal/scientific notation. ^ means exponentiation. Uses finite IEEE-754 numbers, not symbolic algebra or proof verification. No variables, code, or external service.',
    parameters: { type: 'object', properties: { expression: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['expression'], additionalProperties: false } },
};

export function calculate(args) {
  const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_EXPRESSION', status: 400 }); };
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'expression') ||
    typeof args.expression !== 'string' || !args.expression.trim() || args.expression.length > 256) fail('Expected expression string of 1–256 characters');
  const text = args.expression;
  let index = 0;
  const space = () => { while (/\s/.test(text[index] || '') && index < text.length) index++; };
  const take = symbol => { space(); if (text[index] !== symbol) return false; index++; return true; };
  const finite = value => { if (!Number.isFinite(value)) fail('Non-finite result or division by zero'); return value; };
  function atom() {
    if (take('(')) { const value = sum(); if (!take(')')) fail('Missing closing parenthesis'); return value; }
    space();
    const number = text.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (!number) fail('Expected number or parenthesis');
    index += number[0].length;
    return finite(Number(number[0]));
  }
  function power() { const base = atom(); return take('^') ? finite(base ** unary()) : base; }
  function unary() { if (take('+')) return unary(); if (take('-')) return -unary(); return power(); }
  function product() {
    let value = unary();
    while (true) {
      if (take('*')) value = finite(value * unary());
      else if (take('/')) value = finite(value / unary());
      else return value;
    }
  }
  function sum() {
    let value = product();
    while (true) {
      if (take('+')) value = finite(value + product());
      else if (take('-')) value = finite(value - product());
      else return value;
    }
  }
  const value = finite(sum()); space();
  if (index !== text.length) fail('Unexpected expression token');
  return { ok: true, expression: text, value, arithmetic: 'IEEE754_FLOAT64', proofVerified: false };
}
