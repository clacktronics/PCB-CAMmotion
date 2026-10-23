import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { g, gerber, near } from '../../helpers.js';
import { assertSameImage } from '../../helpers/images.js';
import { gerberEditor, assertWritesBack } from './helpers.js';
import { EditError } from '../../../src/edit/session.js';
import { regionNodes, contourPoints, arcOf, arcCentre } from '../../../src/edit/region-nodes.js';
import { contoursArea } from '../../../src/model/polygons.js';

// a pad, a 1 × 1 mm square region from (3,0), a pad
const SQUARE = g(
  '%ADD10C,0.5*%',
  'D10*',
  'X0Y0D03*',
  'G36*',
  'X3000000Y0D02*',
  'X4000000Y0D01*',
  'X4000000Y1000000D01*',
  'X3000000Y1000000D01*',
  'X3000000Y0D01*',
  'G37*',
  'X5000000Y5000000D03*',
);

const regionTarget = (ed, oi) => {
  const t = ed.target(oi);
  assert.equal(t.kind, 'region', t.error);
  return t.ci;
};

/** The corners of a region object (contours are stored anticlockwise), as sorted "x,y" strings. */
const corners = (o, c = 0) => {
  const p = o.contours[c];
  const out = [];
  for (let i = 0; i < p.length; i += 2) out.push(`${+p[i].toFixed(6)},${+p[i + 1].toFixed(6)}`);
  return out.sort();
};

const area = (image, i) => contoursArea(image.objects[i].contours);

test('a square region has 4 corners; the closing D01 is not one of them', () => {
  const ed = gerberEditor(SQUARE);
  const info = regionNodes(ed.commands, regionTarget(ed, 1));
  assert.equal(info.contours.length, 1);
  const c = info.contours[0];
  assert.deepEqual(c.nodes, [0, 1, 2, 3]);
  assert.equal(c.closing, 4);
  assert.ok(c.closed);
  assert.deepEqual(
    [...info.points.values()],
    [
      [3, 0],
      [4, 0],
      [4, 1],
      [3, 1],
    ],
  );
  assert.deepEqual(
    c.path.map((e) => e.k),
    [0, 1, 2, 3, 4],
  );
});

test('move one corner: only the region changes, and it writes back', () => {
  const ed = gerberEditor(SQUARE);
  const before = ed.image.objects;
  const sel = ed.apply({ type: 'moveVertex', target: regionTarget(ed, 1), vertices: [2], dxMm: 0.5, dyMm: 0.5 });
  assert.deepEqual(sel, [1], 'the region stays selected');
  const o = ed.image.objects[1];
  assert.deepEqual(corners(o), ['3,0', '3,1', '4,0', '4.5,1.5'].sort());
  assertSameImage({ objects: [before[0], before[2]] }, { objects: [ed.image.objects[0], ed.image.objects[2]] }, 'pads');
  assert.deepEqual(ed.diagnostics.errors, []);
  assertWritesBack(ed);
});

test('moving the start corner moves the closing point too: the contour stays closed', () => {
  const ed = gerberEditor(SQUARE);
  ed.apply({ type: 'moveVertex', target: regionTarget(ed, 1), vertices: [0], dxMm: -1, dyMm: -1 });
  assert.deepEqual(corners(ed.image.objects[1]), ['2,-1', '3,1', '4,0', '4,1'].sort());
  assert.deepEqual(
    ed.diagnostics.list.filter((d) => d.code === 'CONTOUR_NOT_CLOSED'),
    [],
  );
  // naming the closing D01 is the same as naming the start
  const ed2 = gerberEditor(SQUARE);
  ed2.apply({ type: 'moveVertex', target: regionTarget(ed2, 1), vertices: [4], dxMm: -1, dyMm: -1 });
  assert.deepEqual(ed2.commands, ed.commands);
  assertWritesBack(ed);
});

test('moving every corner moves the region as a move would', () => {
  const a = gerberEditor(SQUARE);
  a.apply({ type: 'moveVertex', target: regionTarget(a, 1), vertices: [0, 1, 2, 3], dxMm: 1.25, dyMm: -2 });
  const b = gerberEditor(SQUARE);
  b.apply({ type: 'move', targets: [regionTarget(b, 1)], dxMm: 1.25, dyMm: -2 });
  assertSameImage(a.image, b.image, 'move corners vs move region');
});

test('moves land on the file grid (1 nm)', () => {
  const ed = gerberEditor(SQUARE);
  ed.apply({ type: 'moveVertex', target: regionTarget(ed, 1), vertices: [1], dxMm: 0.0000004, dyMm: 0.1234567 });
  assert.ok(corners(ed.image.objects[1]).includes('4,0.123457'));
  assertWritesBack(ed);
});

test('insert a corner on an edge and on the closing edge', () => {
  const ed = gerberEditor(SQUARE);
  // edge 2 runs from (4,0) to (4,1)
  ed.apply({ type: 'insertVertex', target: regionTarget(ed, 1), segment: 2, xMm: 4.5, yMm: 0.5 });
  assert.deepEqual(corners(ed.image.objects[1]), ['3,0', '3,1', '4,0', '4,1', '4.5,0.5'].sort());
  let info = regionNodes(ed.commands, regionTarget(ed, 1));
  assert.deepEqual(info.contours[0].nodes, [0, 1, 2, 3, 4], 'the new corner takes the edge number');
  assert.deepEqual(info.points.get(2), [4.5, 0.5]);
  // the closing edge, (3,1) back to (3,0)
  ed.apply({ type: 'insertVertex', target: regionTarget(ed, 1), segment: 5, xMm: 2.5, yMm: 0.5 });
  info = regionNodes(ed.commands, regionTarget(ed, 1));
  assert.deepEqual(info.contours[0].nodes, [0, 1, 2, 3, 4, 5]);
  assert.ok(near(area(ed.image, 1), 1.5, 1e-9));
  assertWritesBack(ed);
});

test('inserting on top of an existing corner is refused', () => {
  const ed = gerberEditor(SQUARE);
  assert.throws(
    () => ed.apply({ type: 'insertVertex', target: regionTarget(ed, 1), segment: 2, xMm: 4, yMm: 1 }),
    /already a corner/,
  );
});

test('delete a corner, the start corner, and refuse to leave fewer than 3', () => {
  const pent = g(
    'G36*',
    'X0Y0D02*',
    'X2000000Y0D01*',
    'X2000000Y2000000D01*',
    'X1000000Y3000000D01*',
    'X0Y2000000D01*',
    'X0Y0D01*',
    'G37*',
  );
  const ed = gerberEditor(pent);
  ed.apply({ type: 'deleteVertex', target: regionTarget(ed, 0), vertices: [3] });
  assert.deepEqual(corners(ed.image.objects[0]), ['0,0', '0,2', '2,0', '2,2'].sort());
  ed.apply({ type: 'deleteVertex', target: regionTarget(ed, 0), vertices: [0] });
  assert.deepEqual(corners(ed.image.objects[0]), ['0,2', '2,0', '2,2'].sort());
  assert.deepEqual(ed.diagnostics.errors, []);
  assertWritesBack(ed);
  assert.throws(
    () => ed.apply({ type: 'deleteVertex', target: regionTarget(ed, 0), vertices: [1] }),
    /at least 3 corners/,
  );
  // deleting the start and the corner after it at once
  const ed2 = gerberEditor(pent);
  ed2.apply({ type: 'deleteVertex', target: regionTarget(ed2, 0), vertices: [0, 1] });
  assert.deepEqual(corners(ed2.image.objects[0]), ['0,2', '1,3', '2,2'].sort());
  assertWritesBack(ed2);
});

const QUARTER_DISC = (mode, ij) =>
  g(mode, 'G36*', 'X0Y0D02*', 'G01X1000000Y0D01*', `G03X0Y1000000${ij}D01*`, 'G01X0Y0D01*', 'G37*');

test('arc edges keep their sweep when a corner moves (G75)', () => {
  // a quarter disc: (0,0) → (1,0), anticlockwise quarter arc to (0,1), back to (0,0)
  const ed = gerberEditor(QUARTER_DISC('G75*', 'I-1000000J0'));
  ed.apply({ type: 'moveVertex', target: regionTarget(ed, 0), vertices: [1], dxMm: 1, dyMm: 0 });
  // the quarter arc from (2,0) to (0,1) has its centre at (0.5,-0.5)
  const expected = gerber(
    g('G75*', 'G36*', 'X0Y0D02*', 'G01X2000000Y0D01*', 'G03X0Y1000000I-1500000J-500000D01*', 'G01X0Y0D01*', 'G37*'),
  );
  assertSameImage(ed.image, expected.image, 'moved corner');
  assert.deepEqual(ed.diagnostics.errors, []);
  assertWritesBack(ed);
});

test('arc edges keep their sweep in single-quadrant mode (G74)', () => {
  const src = QUARTER_DISC('G74*', 'I1000000J0');
  const ed = gerberEditor(src);
  ed.apply({ type: 'moveVertex', target: regionTarget(ed, 0), vertices: [1], dxMm: 1, dyMm: 0 });
  const arcCmd = ed.commands.find((c) => c.type === 'D' && c.i !== undefined);
  assert.ok(arcCmd.i >= 0 && arcCmd.j >= 0, 'G74 offsets are unsigned');
  const arc = arcOf({ x: 2e6, y: 0 }, { ...arcCmd, interp: 3, quadrant: 'single' });
  assert.ok(near(arc.sw, Math.PI / 2, 1e-6), `sweep ${arc.sw}`);
  assert.ok(arc.err <= 2, 'start and end on the circle (within rounding)');
  assert.deepEqual(ed.diagnostics.errors, []);
  assertWritesBack(ed);
  // every corner moved: the same as moving the region
  const a = gerberEditor(src);
  a.apply({ type: 'moveVertex', target: regionTarget(a, 0), vertices: [0, 1, 2], dxMm: 0.5, dyMm: 0.5 });
  const b = gerberEditor(src);
  b.apply({ type: 'move', targets: [regionTarget(b, 0)], dxMm: 0.5, dyMm: 0.5 });
  assertSameImage(a.image, b.image, 'G74 corners vs region');
});

test('a corner inserted at an arc midpoint splits it into two arcs of the same circle', () => {
  const ed = gerberEditor(QUARTER_DISC('G75*', 'I-1000000J0'));
  const m = Math.SQRT1_2;
  ed.apply({ type: 'insertVertex', target: regionTarget(ed, 0), segment: 2, xMm: m, yMm: m });
  const info = regionNodes(ed.commands, regionTarget(ed, 0));
  const arcs = info.contours[0].path.filter((e) => e.sw !== null);
  assert.equal(arcs.length, 2);
  for (const e of arcs) {
    assert.ok(near(e.sw, Math.PI / 4, 1e-6), `sweep ${e.sw}`);
    assert.ok(near(e.c[0], 0, 2e-6) && near(e.c[1], 0, 2e-6), `centre ${e.c}`);
  }
  assert.deepEqual(ed.diagnostics.errors, []);
  assertWritesBack(ed);
});

test('a full circle region (one corner) moves as a whole', () => {
  const ed = gerberEditor(g('%ADD10C,2*%', 'D10*', 'X0Y0D03*'));
  ed.apply({ type: 'toRegion', targets: [ed.target(0).ci] });
  const t = regionTarget(ed, 0);
  const info = regionNodes(ed.commands, t);
  assert.equal(info.contours[0].nodes.length, 1);
  const a0 = area(ed.image, 0);
  ed.apply({ type: 'moveVertex', target: t, vertices: info.contours[0].nodes, dxMm: 3, dyMm: 1 });
  const b = ed.image.bounds;
  assert.ok(near(b[0], 2, 1e-6) && near(b[2], 4, 1e-6) && near(b[1], 0, 1e-6) && near(b[3], 2, 1e-6), `${b}`);
  assert.ok(near(area(ed.image, 0), a0, 1e-9));
  assertWritesBack(ed);
});

test('a region starting at the current point gets an explicit start', () => {
  const ed = gerberEditor(g('X0Y0D02*', 'G36*', 'X1000000Y0D01*', 'Y1000000D01*', 'X0D01*', 'Y0D01*', 'G37*'));
  const t = regionTarget(ed, 0);
  assert.deepEqual(regionNodes(ed.commands, t).contours[0].nodes, [0, 1, 2, 3]);
  ed.apply({ type: 'moveVertex', target: t, vertices: [0], dxMm: -1, dyMm: 0 });
  assert.deepEqual(corners(ed.image.objects[0]), ['-1,0', '0,1', '1,0', '1,1'].sort());
  assertWritesBack(ed);
});

test('a draw after the region still starts where it did', () => {
  // the D01 after G37 draws from the region's last point, (3,0)
  const ed = gerberEditor(
    g(
      '%ADD10C,0.1*%',
      'D10*',
      'G36*',
      'X3000000Y0D02*',
      'X4000000Y0D01*',
      'X4000000Y1000000D01*',
      'X3000000Y0D01*',
      'G37*',
      'X6000000Y0D01*',
    ),
  );
  ed.apply({ type: 'moveVertex', target: regionTarget(ed, 0), vertices: [0], dxMm: 0, dyMm: -1 });
  const l = ed.image.objects[1];
  assert.deepEqual([l.x1, l.y1, l.x2, l.y2], [3, 0, 6, 0]);
  assertWritesBack(ed);
});

test('corners of every contour of a region are numbered and can be edited', () => {
  const ed = gerberEditor(
    g(
      'G36*',
      'X0Y0D02*',
      'X1000000Y0D01*',
      'X1000000Y1000000D01*',
      'X0Y0D01*',
      'X5000000Y0D02*',
      'X6000000Y0D01*',
      'X6000000Y1000000D01*',
      'X5000000Y0D01*',
      'G37*',
    ),
  );
  const t = regionTarget(ed, 0);
  const info = regionNodes(ed.commands, t);
  assert.deepEqual(
    info.contours.map((c) => c.nodes),
    [
      [0, 1, 2],
      [4, 5, 6],
    ],
  );
  ed.apply({ type: 'moveVertex', target: t, vertices: [6], dxMm: -1, dyMm: 0 });
  assert.deepEqual(corners(ed.image.objects[0], 1), ['5,0', '5,1', '6,0'].sort());
  assertWritesBack(ed);
});

test('bad node ops are refused and change nothing', () => {
  const ed = gerberEditor(SQUARE);
  const before = ed.commands;
  const t = regionTarget(ed, 1);
  const pad = ed.target(0).ci;
  for (const [op, re] of [
    [{ type: 'moveVertex', target: pad, vertices: [0], dxMm: 1, dyMm: 0 }, /Only regions/],
    [{ type: 'moveVertex', target: t, vertices: [9], dxMm: 1, dyMm: 0 }, /not part of this region/],
    [{ type: 'moveVertex', target: t, vertices: [], dxMm: 1, dyMm: 0 }, /No corner/],
    [{ type: 'moveVertex', target: t, vertices: [1], dxMm: NaN, dyMm: 0 }, /Invalid coordinate/],
    [{ type: 'insertVertex', target: t, segment: 0, xMm: 1, yMm: 1 }, /not part of this region/],
  ]) {
    assert.throws(
      () => ed.apply(op),
      (e) => e instanceof EditError && re.test(e.message),
      JSON.stringify(op),
    );
  }
  assert.equal(ed.commands, before);
  assert.equal(ed.ops.length, 0);
});

test('undo, redo and replaying stored node ops rebuild the same file', () => {
  const ed = gerberEditor(SQUARE);
  ed.apply({ type: 'moveVertex', target: regionTarget(ed, 1), vertices: [1], dxMm: 0.5, dyMm: 0 });
  ed.apply({ type: 'insertVertex', target: regionTarget(ed, 1), segment: 3, xMm: 3.5, yMm: 1.5 });
  ed.apply({ type: 'deleteVertex', target: regionTarget(ed, 1), vertices: [2] });
  const text = ed.write();
  const record = JSON.parse(JSON.stringify(ed.record(new Uint8Array())));
  const again = gerberEditor(SQUARE);
  again.load(record);
  assert.equal(again.write(), text);
  ed.undo();
  ed.undo();
  ed.redo();
  ed.redo();
  assert.equal(ed.write(), text);
});

test('contourPoints previews exactly what the op makes', () => {
  const src = g('G75*', 'G36*', 'X0Y0D02*', 'G01X1000000Y0D01*', 'G03X0Y1000000I-1000000J0D01*', 'G01X0Y0D01*', 'G37*');
  const ed = gerberEditor(src);
  const t = regionTarget(ed, 0);
  const contour = regionNodes(ed.commands, t).contours[0];
  const pts = contourPoints(contour, { pos: new Map([[1, [2, 0]]]) }, 0.0005);
  ed.apply({ type: 'moveVertex', target: t, vertices: [1], dxMm: 1, dyMm: 0 });
  const poly = (p) => contoursArea([p]);
  assert.ok(near(Math.abs(poly(pts)), area(ed.image, 0), 1e-4), `${poly(pts)} vs ${area(ed.image, 0)}`);
  // insert preview on the arc
  const ed2 = gerberEditor(src);
  const c2 = regionNodes(ed2.commands, t).contours[0];
  const ins = contourPoints(c2, { insert: { segment: 2, x: 1, y: 1 } }, 0.0005);
  ed2.apply({ type: 'insertVertex', target: t, segment: 2, xMm: 1, yMm: 1 });
  assert.ok(near(Math.abs(poly(ins)), area(ed2.image, 0), 1e-4), `${poly(ins)} vs ${area(ed2.image, 0)}`);
});

test('arcCentre: the centre of a quarter arc either way round', () => {
  const p = { x: 1, y: 0 };
  const q = { x: 0, y: 1 };
  const ccw = arcCentre(p, q, Math.PI / 2);
  assert.ok(near(ccw.x, 0, 1e-12) && near(ccw.y, 0, 1e-12));
  const cw = arcCentre(p, q, -Math.PI / 2);
  assert.ok(near(cw.x, 1, 1e-12) && near(cw.y, 1, 1e-12));
  const big = arcCentre(p, q, (3 * Math.PI) / 2);
  assert.ok(near(big.x, 1, 1e-12) && near(big.y, 1, 1e-12));
  assert.equal(arcCentre(p, p, Math.PI), null);
});

test('random corner edits keep regions closed, arcs valid and the file writing back (property)', () => {
  // two contours (one with a G75 arc) and a draw after the region that starts at its last point
  const src = g(
    '%ADD10C,0.1*%',
    'D10*',
    'G75*',
    'G36*',
    'X0Y0D02*',
    'G01X1000000Y0D01*',
    'G03X0Y1000000I-1000000J0D01*',
    'G01X0Y0D01*',
    'X3000000Y0D02*',
    'X4000000Y0D01*',
    'X4000000Y1000000D01*',
    'X3000000Y1000000D01*',
    'X3000000Y0D01*',
    'G37*',
    'X6000000Y0D01*',
  );
  const step = fc.record({
    kind: fc.constantFrom('move', 'insert', 'delete'),
    pick: fc.nat(),
    dx: fc.integer({ min: -500, max: 500 }),
    dy: fc.integer({ min: -500, max: 500 }),
  });
  fc.assert(
    fc.property(fc.array(step, { minLength: 1, maxLength: 8 }), (steps) => {
      const ed = gerberEditor(src);
      for (const s of steps) {
        const target = regionTarget(ed, 0);
        const info = regionNodes(ed.commands, target);
        const nodes = info.contours.flatMap((c) => c.nodes);
        const edges = info.contours.flatMap((c) => c.path.slice(1).map((e) => e.k));
        const v = nodes[s.pick % nodes.length];
        const op =
          s.kind === 'move'
            ? { type: 'moveVertex', target, vertices: [v], dxMm: s.dx / 1000, dyMm: s.dy / 1000 }
            : s.kind === 'delete'
              ? { type: 'deleteVertex', target, vertices: [v] }
              : (() => {
                  const k = edges[s.pick % edges.length];
                  const [x, y] = info.points.get(nodes.find((n) => n === k) ?? info.contours[0].nodes[0]);
                  return { type: 'insertVertex', target, segment: k, xMm: x + s.dx / 1000, yMm: y + s.dy / 1000 };
                })();
        try {
          ed.apply(op);
        } catch (e) {
          if (!(e instanceof EditError)) throw e;
          continue;
        }
        const bad = ed.diagnostics.list.filter((d) => ['ARC_BAD_CENTER', 'CONTOUR_NOT_CLOSED'].includes(d.code));
        assert.deepEqual(bad, [], JSON.stringify(op));
        const l = ed.image.objects.at(-1);
        assert.equal(l.k, 'L');
        assert.deepEqual([l.x1, l.y1], [3, 0], 'the draw after the region still starts at (3,0)');
        assertWritesBack(ed, JSON.stringify(op));
      }
    }),
    { numRuns: 150 },
  );
});
