// Excellon edit operations on a normalised command list (src/edit/excellon.js). Ops are the
// same JSON as for Gerber (src/edit/gerber-ops.js) where they apply:
//   { type: 'delete', targets }   { type: 'move', targets, dxMm, dyMm }
//   { type: 'addHit', diaMm, xMm, yMm }   a hole; reuses the tool of that diameter or defines one
// targets are indices of HIT or G85 SLOT commands. Coordinates are mm (the parser converts).

import { objectCommand, commandObjectRange } from '../analyze/commands.js';
import { EditError, spliceMany } from './gerber-ops.js';

const SAME_DIA_MM = 1e-6;

export function excellonTarget(commands, image, oi) {
  const ci = objectCommand(image, oi);
  const c = commands[ci];
  if (!c) return { error: 'This hole is not linked to a command' };
  if (c.type === 'HIT') return { ci, kind: 'hit', objects: commandObjectRange(image, ci) };
  if (c.type === 'SLOT') return { ci, kind: 'slot', objects: commandObjectRange(image, ci) };
  if (c.type === 'ROUTE') return { error: 'Routed paths cannot be edited yet' };
  return { error: 'This object cannot be edited' };
}

function check(commands, targets) {
  if (!Array.isArray(targets) || !targets.length) throw new EditError('Nothing selected');
  const list = [...new Set(targets)];
  for (const ci of list) {
    const c = commands[ci];
    if (c?.type !== 'HIT' && c?.type !== 'SLOT') throw new EditError('Only holes and slots can be edited');
    // a routed segment straight after it would start from this position
    for (let i = ci + 1; i < commands.length; i++) {
      const n = commands[i];
      if (n.type === 'ROUTE') throw new EditError('A routed path starts at this hole; it cannot be edited yet');
      if (['HIT', 'SLOT', 'ROUTE_MOVE', 'END'].includes(n.type)) break;
    }
  }
  return list;
}

function state(commands, upTo) {
  const st = { tool: null, plunged: false, routeMode: false };
  for (let i = 0; i < upTo; i++) {
    const c = commands[i];
    if (c.type === 'TOOL') st.tool = c.tool;
    else if (c.type === 'PLUNGE') st.plunged = true;
    else if (c.type === 'RETRACT') st.plunged = false;
    else if (c.type === 'ROUTE_MOVE') st.routeMode = true;
    else if (c.type === 'DRILL_MODE') {
      st.routeMode = false;
      st.plunged = false;
    }
  }
  return st;
}

/**
 * @param {object[]} commands
 * @param {object} op
 * @param {{units: 'METRIC'|'INCH'}} ctx the file's units: new positions snap to the grid the
 *   writer uses (10^-6 file units), so the saved file holds exactly what is shown
 */
export function applyExcellonOp(commands, op, ctx = { units: 'METRIC' }) {
  const per = ctx.units === 'INCH' ? 25.4 : 1;
  const snap = (mm) => (Math.round((mm / per) * 1e6) / 1e6) * per;
  switch (op.type) {
    case 'delete':
      return spliceMany(
        commands,
        check(commands, op.targets).map((ci) => ({ at: ci, remove: 1, insert: [] })),
      );
    case 'move': {
      const dx = op.dxMm;
      const dy = op.dyMm;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new EditError('Invalid move');
      return spliceMany(
        commands,
        check(commands, op.targets).map((ci) => {
          const c = commands[ci];
          const m =
            c.type === 'HIT'
              ? { ...c, x: snap(c.x + dx), y: snap(c.y + dy) }
              : { ...c, x1: snap(c.x1 + dx), y1: snap(c.y1 + dy), x2: snap(c.x2 + dx), y2: snap(c.y2 + dy) };
          return { at: ci, remove: 1, insert: [m], select: [0] };
        }),
      );
    }
    case 'addHit':
      return addHit(commands, op, snap);
    default:
      throw new EditError(`${op.type} is not available for drill files`);
  }
}

function addHit(commands, op, snap) {
  if (!(op.diaMm > 0) || !Number.isFinite(op.xMm) || !Number.isFinite(op.yMm)) throw new EditError('Invalid hole');
  const [diaMm, xMm, yMm] = [snap(op.diaMm), snap(op.xMm), snap(op.yMm)];
  const edits = [];
  let tool = null;
  let maxTool = 0;
  for (const c of commands) {
    if (c.type !== 'TOOL_DEF') continue;
    maxTool = Math.max(maxTool, c.tool);
    if (Math.abs(c.diaMm - diaMm) < SAME_DIA_MM) tool = c.tool;
  }
  if (tool === null) {
    tool = maxTool + 1;
    const end = commands.findIndex((c) => c.type === 'HEADER_END');
    if (end < 0) throw new EditError('The drill file has no header to define a new tool in');
    edits.push({ at: end, remove: 0, insert: [{ type: 'TOOL_DEF', tool, diaMm, line: 0 }] });
  }
  let at = commands.findLastIndex((c) => c.type === 'END');
  if (at < 0) at = commands.length;
  const st = state(commands, at);
  const insert = [];
  if (st.plunged) insert.push({ type: 'RETRACT', line: 0 });
  if (st.plunged || st.routeMode) insert.push({ type: 'DRILL_MODE', line: 0 });
  if (st.tool !== tool) insert.push({ type: 'TOOL', tool, line: 0 });
  insert.push({ type: 'HIT', x: xMm, y: yMm, line: 0 });
  edits.push({ at, remove: 0, insert, select: [insert.length - 1] });
  return spliceMany(commands, edits);
}
