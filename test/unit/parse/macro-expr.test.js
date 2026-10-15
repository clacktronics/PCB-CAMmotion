import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileExpr, evalExpr, MacroExprError } from '../../../src/parse/macro-expr.js';

const ev = (s, vars = {}) => evalExpr(compileExpr(s), new Map(Object.entries(vars).map(([k, v]) => [Number(k), v])));

test('precedence, unary minus, parentheses, x and X multiply', () => {
  assert.equal(ev('1+2x3'), 7);
  assert.equal(ev('(1+2)X3'), 9);
  assert.equal(ev('-2+5'), 3);
  assert.equal(ev('-(2+5)'), -7);
  assert.equal(ev('10/4/5'), 0.5);
  assert.equal(ev('8-3-2'), 3);
  assert.equal(ev('+.5'), 0.5);
});

test('variables, including the synthetic VARS macro values', () => {
  const v = { 1: 2, 2: 0.6, 3: 0.4 };
  const v4 = ev('$1x0.5', v);
  const v5 = ev('($2+$3)/2', v);
  const v6 = ev('-$4+$5x2-(1-$3)/4', { ...v, 4: v4, 5: v5 });
  assert.equal(v4, 1);
  assert.equal(v5, 0.5);
  assert.ok(Math.abs(v6 - -0.15) < 1e-12);
});

test('undefined variables are 0 and reported', () => {
  const seen = [];
  assert.equal(
    evalExpr(compileExpr('$7+1'), new Map(), (n) => seen.push(n)),
    1,
  );
  assert.deepEqual(seen, [7]);
});

test('errors: division by zero, unbalanced parentheses, bad characters', () => {
  assert.throws(() => ev('1/0'), MacroExprError);
  assert.throws(() => compileExpr('(1+2'), MacroExprError);
  assert.throws(() => compileExpr('1+2)'), MacroExprError);
  assert.throws(() => compileExpr('1e3'), MacroExprError);
  assert.throws(() => compileExpr('2+'), MacroExprError);
  assert.throws(() => compileExpr(''), MacroExprError);
});

test('deep nesting and long expressions do not recurse', () => {
  const nest = '('.repeat(20000) + '1' + ')'.repeat(20000);
  assert.equal(ev(nest), 1);
  const long = Array.from({ length: 100000 }, () => '1').join('+');
  assert.equal(ev(long), 100000);
});
