// G-code safety checker. Runs in tests and in the app before every export; export is
// blocked when `ok` is false. See PROJECT_PLAN.md → Testing & QA → "G-code safety checker".
//
// It simulates the program in a deliberately small G-code dialect (what our post-processors
// emit) and reports anything it cannot prove safe. Codes outside that dialect are errors:
// the checker must never wave through motion it does not understand.
//
// All profile values are in mm and mm/min. Inch programs (G20) are converted on read.

/**
 * @typedef {object} MachineLimits
 * @property {number} safeZMm            Rapid (G0) moves must stay at or above this Z, and the program must end here or higher.
 * @property {number} minZMm             Deepest Z any move may reach (e.g. -2.0 for a 1.6 mm board on a spoilboard).
 * @property {{xMm: [number, number], yMm: [number, number], zMm: [number, number]}} envelope  Machine travel.
 * @property {number} maxFeedMmMin       Highest allowed cutting feed (G1/G2/G3 and drill cycles).
 * @property {[number, number]} spindleRpm  Allowed spindle speed range while the spindle is on.
 * @property {number[]} tools            Tool numbers the machine can change to.
 */

/**
 * @typedef {object} Finding
 * @property {'error'|'warning'} severity
 * @property {string} rule     stable id, e.g. 'rapid-below-safe-z'
 * @property {number} line     1-based source line
 * @property {string} message
 */

const SUPPORTED_G = new Set([0, 1, 2, 3, 4, 17, 20, 21, 40, 49, 54, 80, 81, 82, 83, 90, 91, 94, 98, 99]);
const SUPPORTED_M = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 30]);
const DRILL_CYCLES = new Set([81, 82, 83]);
const EPS = 1e-9;

/**
 * Split one line into words, dropping comments: "(...)" and everything after ";".
 * Returns null if the line is malformed.
 */
export function tokenizeLine(text) {
  const stripped = text.replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '');
  if (/[()]/.test(stripped)) return null;
  const body = stripped.replace(/\s+/g, '').toUpperCase();
  if (body === '' || body === '%') return [];
  const words = [];
  const re = /([A-Z])([-+]?(?:\d+\.?\d*|\.\d+))/gy;
  let m;
  let at = 0;
  while ((m = re.exec(body))) {
    words.push({ letter: m[1], value: Number(m[2]) });
    at = re.lastIndex;
  }
  return at === body.length ? words : null;
}

/**
 * Check a G-code program against machine limits.
 * @param {string} text
 * @param {MachineLimits} limits
 * @returns {{ ok: boolean, findings: Finding[] }}
 */
export function checkGcode(text, limits) {
  const findings = [];
  const report = (severity, rule, line, message) => findings.push({ severity, rule, line, message });
  const error = (rule, line, message) => report('error', rule, line, message);

  const st = {
    unitScale: null, // mm per program unit; null = units not declared yet
    absolute: true,
    motion: null, // 0 | 1 | 2 | 3 | 81 | 82 | 83
    feed: null, // mm/min
    spindleOn: false,
    rpm: null,
    tool: null, // active tool (after M6)
    nextTool: null, // selected with T, not yet changed
    pos: { x: null, y: null, z: null }, // mm; null = unknown
    retractToR: false, // G99 (true) / G98 (false)
    cycle: { r: null, z: null }, // drill cycle modal R and Z (mm, absolute)
    ended: false,
  };
  let lastLine = 0;
  const fmt = (v) => `${+v.toFixed(4)} mm`;

  const checkPoint = (lineNo, p) => {
    const { xMm, yMm, zMm } = limits.envelope;
    for (const [axis, range] of [
      ['x', xMm],
      ['y', yMm],
      ['z', zMm],
    ]) {
      const v = p[axis];
      if (v != null && (v < range[0] - EPS || v > range[1] + EPS)) {
        error(
          'outside-envelope',
          lineNo,
          `${axis.toUpperCase()} ${fmt(v)} is outside the machine travel [${range[0]}, ${range[1]}] mm`,
        );
      }
    }
    if (p.z != null && p.z < limits.minZMm - EPS) {
      error('too-deep', lineNo, `Z ${fmt(p.z)} is below the deepest allowed Z ${limits.minZMm} mm`);
    }
  };

  const checkCutting = (lineNo, what) => {
    if (!st.spindleOn) error('cut-spindle-off', lineNo, `${what} with the spindle off`);
    if (st.tool == null) error('cut-no-tool', lineNo, `${what} before any tool change (M6)`);
    if (st.feed == null) error('feed-missing', lineNo, `${what} without a feed rate (F)`);
    else if (st.feed > limits.maxFeedMmMin + EPS) {
      error(
        'feed-too-high',
        lineNo,
        `Feed ${+st.feed.toFixed(1)} mm/min exceeds the limit ${limits.maxFeedMmMin} mm/min`,
      );
    } else if (st.feed <= 0) error('feed-missing', lineNo, `${what} with a zero feed rate`);
  };

  // Arc extremes: the endpoints plus any axis-crossing points the arc sweeps through.
  const arcExtremes = (from, to, cx, cy, clockwise) => {
    const r = Math.hypot(from.x - cx, from.y - cy);
    const a0 = Math.atan2(from.y - cy, from.x - cx);
    const a1 = Math.atan2(to.y - cy, to.x - cx);
    let sweep = clockwise ? a0 - a1 : a1 - a0;
    while (sweep <= EPS) sweep += 2 * Math.PI; // equal endpoints = full circle
    const pts = [];
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      let d = clockwise ? a0 - a : a - a0;
      d = ((d % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (d <= sweep) pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return pts;
  };

  const lines = text.split(/\r\n|\r|\n/);
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const words = tokenizeLine(raw);
    if (words === null) {
      error('syntax', lineNo, `Cannot parse line: ${raw.trim()}`);
      return;
    }
    if (words.length === 0) return;
    lastLine = lineNo;
    if (st.ended) {
      error('after-end', lineNo, 'Code after program end (M2/M30)');
      return;
    }

    const g = [];
    const m = [];
    const axes = {};
    for (const w of words) {
      if (w.letter === 'G') g.push(w.value);
      else if (w.letter === 'M') m.push(w.value);
      else if (w.letter === 'N') continue;
      else if ('XYZIJRFSTP'.includes(w.letter) || w.letter === 'Q') {
        if (w.letter in axes) error('syntax', lineNo, `Word ${w.letter} appears twice`);
        axes[w.letter] = w.value;
      } else error('unsupported', lineNo, `Unsupported word ${w.letter}${w.value}: the checker cannot verify it`);
    }
    for (const code of g)
      if (!SUPPORTED_G.has(code)) error('unsupported', lineNo, `Unsupported G${code}: the checker cannot verify it`);
    for (const code of m)
      if (!SUPPORTED_M.has(code)) error('unsupported', lineNo, `Unsupported M${code}: the checker cannot verify it`);

    // --- modal settings, in execution order (RS274/NGC: units, distance mode, feed, speed, tool, spindle) ---
    if (g.includes(20)) st.unitScale = 25.4;
    if (g.includes(21)) st.unitScale = 1;
    if (g.includes(90)) st.absolute = true;
    if (g.includes(91)) st.absolute = false;
    if (g.includes(98)) st.retractToR = false;
    if (g.includes(99)) st.retractToR = true;
    if (g.includes(80)) st.motion = null;

    const hasCoords = 'X' in axes || 'Y' in axes || 'Z' in axes;
    if ((hasCoords || 'F' in axes || 'I' in axes || 'J' in axes || 'R' in axes) && st.unitScale == null) {
      error('units-missing', lineNo, 'Coordinates or feed before units are set (G20/G21)');
      st.unitScale = 1; // assume mm so later checks still run
    }
    const k = st.unitScale ?? 1;
    if ('F' in axes) st.feed = axes.F * k;
    if ('S' in axes) st.rpm = axes.S;
    if ('T' in axes) st.nextTool = axes.T;

    if (m.includes(6)) {
      if (st.spindleOn) error('toolchange-spindle-on', lineNo, 'Tool change (M6) with the spindle running');
      if (st.pos.z == null || st.pos.z < limits.safeZMm - EPS) {
        error('toolchange-low-z', lineNo, `Tool change (M6) below safe Z ${limits.safeZMm} mm`);
      }
      if (st.nextTool == null) error('toolchange-no-tool', lineNo, 'Tool change (M6) without a tool number (T)');
      else if (!limits.tools.includes(st.nextTool)) {
        error('toolchange-unknown-tool', lineNo, `Tool T${st.nextTool} is not in the machine's tool list`);
      }
      st.tool = st.nextTool;
    }
    if (m.includes(3) || m.includes(4)) {
      st.spindleOn = true;
      if (st.tool == null) error('spindle-no-tool', lineNo, 'Spindle started before any tool change (M6)');
    }
    if (m.includes(5)) st.spindleOn = false;
    if (st.spindleOn && (m.includes(3) || m.includes(4) || 'S' in axes)) {
      const [lo, hi] = limits.spindleRpm;
      if (st.rpm == null) error('spindle-speed', lineNo, 'Spindle on without a speed (S)');
      else if (st.rpm < lo || st.rpm > hi) {
        error('spindle-speed', lineNo, `Spindle speed S${st.rpm} is outside the machine range ${lo}–${hi} rpm`);
      }
    }

    // --- motion ---
    const motionCodes = g.filter((c) => c <= 3 || DRILL_CYCLES.has(c));
    if (motionCodes.length > 1) error('syntax', lineNo, `Conflicting motion codes G${motionCodes.join(' G')}`);
    if (motionCodes.length) st.motion = motionCodes[0];

    if (g.includes(4)) {
      // Dwell: P is the time, no motion.
    } else if (hasCoords) {
      if (st.motion == null)
        error('motion-mode-missing', lineNo, 'Coordinates without an active motion mode (G0/G1/G2/G3/G81–G83)');
      else if (DRILL_CYCLES.has(st.motion)) drillCycle(lineNo, axes, k);
      else move(lineNo, axes, k);
    }

    if (m.includes(2) || m.includes(30)) {
      st.ended = true;
      if (st.spindleOn) error('end-spindle-on', lineNo, 'Program ends with the spindle running (missing M5)');
      if (st.pos.z == null || st.pos.z < limits.safeZMm - EPS) {
        error('end-low-z', lineNo, `Program ends below safe Z ${limits.safeZMm} mm`);
      }
    }
  });

  if (!st.ended) error('no-end', lastLine || 1, 'Program has no end (M2 or M30)');

  return { ok: !findings.some((f) => f.severity === 'error'), findings };

  // Resolve one axis word to an absolute mm target, or keep the current value.
  function target(axes, k, axis) {
    const word = axes[axis.toUpperCase()];
    if (word === undefined) return st.pos[axis];
    const v = word * k;
    if (st.absolute) return v;
    return st.pos[axis] == null ? null : st.pos[axis] + v;
  }

  function move(lineNo, axes, k) {
    const from = { ...st.pos };
    const to = { x: target(axes, k, 'x'), y: target(axes, k, 'y'), z: target(axes, k, 'z') };
    if (!st.absolute && ['X', 'Y', 'Z'].some((a) => a in axes && from[a.toLowerCase()] == null)) {
      error('position-unknown', lineNo, 'Incremental move from an unknown position');
    }
    const movesXY = ('X' in axes || 'Y' in axes) && (to.x !== from.x || to.y !== from.y);
    if (st.motion === 0) {
      if (movesXY) {
        // Axes move together, so the whole rapid must be clear: check both ends.
        const lowest = Math.min(from.z, to.z);
        if (from.z == null || to.z == null) {
          error('rapid-z-unknown', lineNo, 'Rapid XY move before Z is known: move to safe Z first');
        } else if (lowest < limits.safeZMm - EPS) {
          error('rapid-below-safe-z', lineNo, `Rapid XY move at Z ${fmt(lowest)}, below safe Z ${limits.safeZMm} mm`);
        }
      } else if (to.z != null && to.z < limits.safeZMm - EPS) {
        error('rapid-below-safe-z', lineNo, `Rapid Z move to ${fmt(to.z)}, below safe Z ${limits.safeZMm} mm`);
      }
    } else {
      checkCutting(lineNo, `G${st.motion} move`);
      if (from.x == null || from.y == null || from.z == null) {
        error('position-unknown', lineNo, `G${st.motion} move from an unknown position`);
      }
    }
    checkPoint(lineNo, to);
    if ((st.motion === 2 || st.motion === 3) && from.x != null && from.y != null && to.x != null && to.y != null) {
      if ('R' in axes) {
        error('unsupported', lineNo, 'Arcs with R are not supported: use I/J centre offsets');
      } else if (!('I' in axes) && !('J' in axes)) {
        error('arc-centre-missing', lineNo, 'Arc without I/J centre offsets');
      } else {
        // Centre offsets are always incremental from the start point (RS274/NGC 3.5.3).
        const cx = from.x + (axes.I ?? 0) * k;
        const cy = from.y + (axes.J ?? 0) * k;
        const r0 = Math.hypot(from.x - cx, from.y - cy);
        const r1 = Math.hypot(to.x - cx, to.y - cy);
        if (Math.abs(r0 - r1) > 0.002)
          error('arc-radius', lineNo, `Arc start and end radii differ (${fmt(r0)} vs ${fmt(r1)})`);
        for (const p of arcExtremes(from, to, cx, cy, st.motion === 2)) checkPoint(lineNo, { ...p, z: null });
      }
    }
    st.pos = to;
  }

  // Canned drill cycles G81/G82/G83 (RS274/NGC 3.5.16). In G91 mode R and Z would be
  // incremental; our posts never emit that, so it is rejected rather than guessed.
  function drillCycle(lineNo, axes, k) {
    if (!st.absolute) {
      error('unsupported', lineNo, 'Drill cycles in incremental mode (G91) are not supported');
      return;
    }
    if ('R' in axes) st.cycle.r = axes.R * k;
    if ('Z' in axes) st.cycle.z = axes.Z * k;
    const startZ = st.pos.z;
    const { r, z } = st.cycle;
    if (r == null || z == null) {
      error('drill-cycle-incomplete', lineNo, 'Drill cycle without R and Z');
      return;
    }
    checkCutting(lineNo, `G${st.motion} drill cycle`);
    if (startZ == null) error('rapid-z-unknown', lineNo, 'Drill cycle before Z is known: move to safe Z first');
    else if (startZ < limits.safeZMm - EPS) {
      error('rapid-below-safe-z', lineNo, `Drill cycle starts at Z ${fmt(startZ)}, below safe Z ${limits.safeZMm} mm`);
    }
    if (r < z)
      error('drill-cycle-r-below-z', lineNo, `Drill cycle retract R ${fmt(r)} is below the hole bottom Z ${fmt(z)}`);
    if (startZ != null && r > startZ + EPS)
      error('drill-cycle-r-above-start', lineNo, 'Drill cycle R plane is above the start height');
    if (st.retractToR && r < limits.safeZMm - EPS) {
      error(
        'rapid-below-safe-z',
        lineNo,
        `G99 retracts to R ${fmt(r)} and the next rapid would be below safe Z ${limits.safeZMm} mm`,
      );
    }
    const x = 'X' in axes ? axes.X * k : st.pos.x;
    const y = 'Y' in axes ? axes.Y * k : st.pos.y;
    if (x == null || y == null) error('position-unknown', lineNo, 'Drill cycle at an unknown XY position');
    checkPoint(lineNo, { x, y, z });
    const endZ = st.retractToR || startZ == null ? r : Math.max(startZ, r);
    st.pos = { x, y, z: endZ };
  }
}
