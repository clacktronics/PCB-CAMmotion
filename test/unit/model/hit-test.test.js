import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthGerber, synthDrill, synthFixture } from '../../helpers.js';
import { hitTest } from '../../../src/model/hit-test.js';

const top = synthGerber('board/synthetic-board-F_Cu.gbr').image;
const facts = synthFixture('board/synthetic-board-job.gbrjob').facts;

test('flashes: drill-ladder pads are hit at their centre and edge, missed outside', () => {
  facts.drillsMm.forEach((d, i) => {
    const x = 8 + i * 7;
    const r = (d + 0.6) / 2;
    const hit = hitTest(top, x, 20);
    assert.ok(hit >= 0, `pad ${i}`);
    assert.equal(top.objects[hit].ap.code, 30 + i);
    assert.ok(hitTest(top, x + r * 0.95, 20) >= 0, `edge ${i}`);
    assert.equal(hitTest(top, x + r * 1.1, 20.0), -1, `outside ${i}`);
  });
});

test('draws: the trace width ladder is hit within half the width', () => {
  facts.traceWidthsMm.forEach((w, i) => {
    const y = 74 - i * 2.5;
    const hit = hitTest(top, 15, y + w * 0.45);
    assert.ok(hit >= 0, `trace ${w}`);
    assert.equal(top.objects[hit].ap.dia, w);
    assert.equal(hitTest(top, 15, y + w * 0.6), -1, `miss ${w}`);
  });
});

test('regions and topmost-object order: thermal flash beats the pour', () => {
  const pour = hitTest(top, 70, 35);
  assert.equal(top.objects[pour].k, 'R');
  const t = hitTest(top, 75 + 0.7, 45);
  assert.equal(top.objects[t].ap.code, 61, 'thermal spoke area');
});

test('tolerance makes tiny objects clickable', () => {
  const d = synthDrill('board/synthetic-board-PTH.drl').image;
  assert.ok(hitTest(d, 8.2, 20, 0) === -1);
  assert.ok(hitTest(d, 8.2, 20, 0.1) >= 0);
  assert.equal(d.objects[hitTest(d, 42, 30)].k, 'L', 'routed slot');
});
