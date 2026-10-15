// Aperture macro arithmetic expressions (Gerber spec 4.5.4.3).
// Operators: unary + and -, binary + - x / with the usual precedence, parentheses,
// decimal constants and variables $n. Compiled with the shunting-yard algorithm to an
// RPN array so that neither compiling nor evaluating recurses (hostile files nest
// thousands of parentheses).

const PREC = { '+': 1, '-': 1, x: 2, '/': 2, neg: 3 };

export class MacroExprError extends Error {}

/**
 * @param {string} src
 * @returns {(number|string|{v:number})[]} RPN program: numbers, {v:n} variable refs, operator strings
 */
export function compileExpr(src) {
  const out = [];
  const ops = [];
  let i = 0;
  let expectOperand = true;
  const s = src;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i;
      while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || s[j] === '.')) j++;
      const t = s.slice(i, j);
      if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) throw new MacroExprError(`Invalid number "${t}"`);
      if (!expectOperand) throw new MacroExprError(`Unexpected number "${t}"`);
      out.push(Number(t));
      i = j;
      expectOperand = false;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
      if (j === i + 1) throw new MacroExprError('"$" without a variable number');
      if (!expectOperand) throw new MacroExprError('Unexpected variable');
      out.push({ v: Number(s.slice(i + 1, j)) });
      i = j;
      expectOperand = false;
      continue;
    }
    if (c === '(') {
      if (!expectOperand) throw new MacroExprError('Unexpected "("');
      ops.push('(');
      i++;
      continue;
    }
    if (c === ')') {
      if (expectOperand) throw new MacroExprError('Unexpected ")"');
      while (ops.length && ops[ops.length - 1] !== '(') out.push(ops.pop());
      if (!ops.length) throw new MacroExprError('Unbalanced ")"');
      ops.pop();
      i++;
      continue;
    }
    let op = c === 'X' ? 'x' : c;
    if (op === '+' || op === '-' || op === 'x' || op === '/') {
      if (expectOperand) {
        if (op === 'x' || op === '/') throw new MacroExprError(`Operator "${c}" without left operand`);
        if (op === '-') ops.push('neg'); // unary plus is a no-op
        i++;
        continue;
      }
      while (ops.length) {
        const top = ops[ops.length - 1];
        if (top === '(' || PREC[top] < PREC[op]) break;
        out.push(ops.pop());
      }
      ops.push(op);
      i++;
      expectOperand = true;
      continue;
    }
    throw new MacroExprError(`Invalid character "${c}" in expression`);
  }
  if (expectOperand) throw new MacroExprError(src.trim() ? 'Expression ends with an operator' : 'Empty expression');
  while (ops.length) {
    const op = ops.pop();
    if (op === '(') throw new MacroExprError('Unbalanced "("');
    out.push(op);
  }
  return out;
}

/**
 * @param {ReturnType<typeof compileExpr>} rpn
 * @param {Map<number, number>} vars
 * @param {(n:number)=>void} [onUndefined] called for each undefined variable (its value is 0)
 */
export function evalExpr(rpn, vars, onUndefined) {
  const st = [];
  for (const t of rpn) {
    if (typeof t === 'number') st.push(t);
    else if (typeof t === 'object') {
      if (vars.has(t.v)) st.push(vars.get(t.v));
      else {
        onUndefined?.(t.v);
        st.push(0);
      }
    } else if (t === 'neg') st.push(-st.pop());
    else {
      const b = st.pop();
      const a = st.pop();
      if (t === '+') st.push(a + b);
      else if (t === '-') st.push(a - b);
      else if (t === 'x') st.push(a * b);
      else {
        if (b === 0) throw new MacroExprError('Division by zero');
        st.push(a / b);
      }
    }
  }
  return st[0];
}
