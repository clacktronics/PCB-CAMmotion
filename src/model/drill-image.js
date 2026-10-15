// Drill image: Excellon commands -> the same object model as Gerber images, so drills render,
// hit-test and analyse with the same code. Tools become circular apertures; hits are flashes,
// G85 slots and routed segments are draws/arcs. All in mm. image.commandEnds as for Gerber
// (src/model/gerber-image.js): objects in the image after each command.

import { standardShape } from './aperture.js';
import { computeBounds } from './gerber-image.js';

const TAU = Math.PI * 2;

/** @param {ReturnType<import('../parse/excellon.js').parseExcellon>} parsed */
export function interpretExcellon(parsed) {
  const diag = parsed.diagnostics;
  const image = {
    format: 'excellon',
    fileUnits: parsed.units,
    apertures: new Map(),
    objects: [],
    fileAttributes: { ...parsed.attributes },
    objectAttributes: [null],
    negative: false,
    truncated: false,
    bounds: null,
    stats: { holes: 0, slots: 0, routes: 0, tools: 0 },
    diagnostics: diag,
  };
  const tools = image.apertures;
  let tool = null;
  let toolMissing = false;
  let x = 0;
  let y = 0;
  let plunged = false;
  let routeHasSegments = false;
  let warnedNoTool = false;
  const hit = (hx, hy, line) => {
    image.objects.push({ k: 'F', dark: true, ap: tool, x: hx, y: hy, m: null, ln: line, at: 0 });
    image.stats.holes++;
  };
  const needTool = (line) => {
    if (tool) return true;
    if (!toolMissing && !warnedNoTool) {
      diag.error('NO_TOOL', 'Drill hit before any tool is selected', line);
      warnedNoTool = true;
    }
    return false;
  };

  // Some generators route (G00 then G01/G02/G03) without M15/M16 Z commands. If the file never
  // plunges explicitly, treat route moves after G00 as cutting, and say so.
  const usesPlunge = parsed.commands.some((c) => c.type === 'PLUNGE');
  let routeMode = false;
  const ends = (image.commandEnds = new Int32Array(parsed.commands.length));
  for (let ci = 0; ci < parsed.commands.length; ci++) {
    const c = parsed.commands[ci];
    switch (c.type) {
      case 'TOOL_DEF': {
        const ap = {
          code: c.tool,
          template: 'C',
          kind: 'C',
          params: [c.diaMm],
          mm: [c.diaMm],
          dia: c.diaMm,
          line: c.line,
          attributes: {},
          shape: standardShape('C', [c.diaMm]),
        };
        tools.set(c.tool, ap);
        break;
      }
      case 'TOOL':
        if (c.tool === 0) {
          tool = null;
          toolMissing = false;
          break;
        }
        tool = tools.get(c.tool) || null;
        toolMissing = !tool;
        if (!tool) diag.error('TOOL_UNDEFINED', `Tool T${c.tool} is selected but not defined in the header`, c.line);
        break;
      case 'HIT': {
        x = c.x ?? x;
        y = c.y ?? y;
        if (plunged) diag.warn('HIT_WHILE_ROUTING', 'Drill hit while the tool is plunged (M15) for routing', c.line);
        if (needTool(c.line)) hit(x, y, c.line);
        break;
      }
      case 'REPEAT':
        if (!needTool(c.line)) break;
        for (let k = 0; k < c.count; k++) {
          x += c.dx;
          y += c.dy;
          hit(x, y, c.line);
        }
        break;
      case 'SLOT': {
        const x1 = c.x1 ?? x;
        const y1 = c.y1 ?? y;
        const x2 = c.x2 ?? x1;
        const y2 = c.y2 ?? y1;
        x = x2;
        y = y2;
        if (!needTool(c.line)) break;
        image.objects.push({ k: 'L', dark: true, ap: tool, x1, y1, x2, y2, m: null, ln: c.line, at: 0 });
        image.stats.slots++;
        break;
      }
      case 'ROUTE_MOVE':
        if (plunged && usesPlunge) diag.warn('RAPID_WHILE_PLUNGED', 'G00 move while the tool is plunged (M15)', c.line);
        if (!usesPlunge) {
          if (plunged && routeHasSegments) {
            image.stats.routes++;
            image.stats.slots++;
          }
          plunged = false;
          routeMode = true;
        }
        x = c.x ?? x;
        y = c.y ?? y;
        break;
      case 'PLUNGE':
        plunged = true;
        routeHasSegments = false;
        break;
      case 'RETRACT':
        if (plunged && routeHasSegments) {
          image.stats.routes++;
          image.stats.slots++;
        }
        plunged = false;
        break;
      case 'DRILL_MODE':
      case 'END':
        if (!usesPlunge && plunged && routeHasSegments) {
          image.stats.routes++;
          image.stats.slots++;
        }
        plunged = false;
        routeMode = false;
        break;
      case 'ROUTE': {
        const x2 = c.x ?? x;
        const y2 = c.y ?? y;
        if (!usesPlunge && routeMode && !plunged) {
          diag.warn('ROUTE_WITHOUT_PLUNGE', 'Routed path without M15/M16 (tool down/up): assumed to cut', c.line);
          plunged = true;
          routeHasSegments = false;
        }
        if (plunged && needTool(c.line)) {
          routeHasSegments = true;
          if (c.g === 1) {
            image.objects.push({ k: 'L', dark: true, ap: tool, x1: x, y1: y, x2, y2, m: null, ln: c.line, at: 0 });
          } else {
            const arc = routeArc(x, y, x2, y2, c, c.g === 3);
            if (arc) image.objects.push({ k: 'A', dark: true, ap: tool, ...arc, m: null, ln: c.line, at: 0 });
            else diag.error('BAD_ARC', 'Routed arc needs a radius (A) or centre (I/J)', c.line);
          }
        }
        x = x2;
        y = y2;
        break;
      }
      default:
        break;
    }
    ends[ci] = image.objects.length;
  }
  image.stats.tools = tools.size;
  computeBounds(image);
  return image;
}

function routeArc(x1, y1, x2, y2, c, ccw) {
  let cx;
  let cy;
  if (c.a !== undefined) {
    // radius form: choose the centre that gives the minor arc in the given direction
    const r = Math.abs(c.a);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const d = Math.hypot(x2 - x1, y2 - y1);
    if (d === 0 || d > 2 * r + 1e-9) return null;
    const h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
    const ux = -(y2 - y1) / d;
    const uy = (x2 - x1) / d;
    // centre on the left of the chord gives a CCW minor arc
    const side = ccw ? 1 : -1;
    cx = mx + side * h * ux;
    cy = my + side * h * uy;
  } else if (c.i !== undefined || c.j !== undefined) {
    cx = x1 + (c.i ?? 0);
    cy = y1 + (c.j ?? 0);
  } else return null;
  const r = Math.hypot(x1 - cx, y1 - cy);
  const a0 = Math.atan2(y1 - cy, x1 - cx);
  let sw = Math.atan2(y2 - cy, x2 - cx) - a0;
  if (ccw && sw <= 0) sw += TAU;
  if (!ccw && sw >= 0) sw -= TAU;
  return { x1, y1, x2, y2, cx, cy, r, a0, sw };
}
