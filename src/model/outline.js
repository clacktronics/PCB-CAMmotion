// Board outline from a profile (Edge.Cuts) layer: chain the drawn segments and arcs into closed
// loops. Filled with the even-odd rule, the loops give the board area (outer edge plus cut-outs).

import { arcSegments } from './path.js';

const JOIN_TOL_MM = 0.01;
const ARC_TOL_MM = 0.002;

/**
 * @param {object} image profile layer image
 * @returns {{loops: number[][], openChains: number}} loops: flat [x0,y0,x1,y1,...] point lists
 */
export function extractOutline(image) {
  const segs = []; // each: flat polyline points [x0,y0,...,xn,yn]
  const loops = [];
  for (const o of image.objects) {
    if (!o.dark) continue;
    if (o.k === 'L') segs.push([o.x1, o.y1, o.x2, o.y2]);
    else if (o.k === 'A') {
      const n = arcSegments(o.r, o.sw, ARC_TOL_MM);
      const pts = [];
      for (let k = 0; k <= n; k++) {
        const a = o.a0 + (o.sw * k) / n;
        pts.push(
          k === 0 ? o.x1 : k === n ? o.x2 : o.cx + o.r * Math.cos(a),
          k === 0 ? o.y1 : k === n ? o.y2 : o.cy + o.r * Math.sin(a),
        );
      }
      if (Math.abs(o.sw) >= Math.PI * 2 - 1e-9) loops.push(pts.slice(0, -2));
      else segs.push(pts);
    } else if (o.k === 'R') for (const c of o.contours) loops.push(c.slice());
  }
  const key = (x, y) => `${Math.round(x / JOIN_TOL_MM)},${Math.round(y / JOIN_TOL_MM)}`;
  const ends = new Map(); // point key -> [segment index, which end (0 start, 1 end)]
  const addEnd = (k, v) => {
    let l = ends.get(k);
    if (!l) ends.set(k, (l = []));
    l.push(v);
  };
  segs.forEach((s, i) => {
    if (s.length < 4) return;
    addEnd(key(s[0], s[1]), [i, 0]);
    addEnd(key(s[s.length - 2], s[s.length - 1]), [i, 1]);
  });
  const used = new Uint8Array(segs.length);
  let openChains = 0;
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    // skip zero-length segments
    const s0 = segs[i];
    if (s0.length === 4 && s0[0] === s0[2] && s0[1] === s0[3]) {
      used[i] = 1;
      continue;
    }
    used[i] = 1;
    const pts = s0.slice();
    const startKey = key(pts[0], pts[1]);
    let closed = false;
    for (let guard = 0; guard < segs.length; guard++) {
      const k = key(pts[pts.length - 2], pts[pts.length - 1]);
      if (k === startKey && pts.length > 4) {
        closed = true;
        break;
      }
      const next = (ends.get(k) || []).find(([j]) => !used[j]);
      if (!next) break;
      const [j, which] = next;
      used[j] = 1;
      const s = segs[j];
      if (which === 0) for (let q = 2; q < s.length; q++) pts.push(s[q]);
      else for (let q = s.length - 4; q >= 0; q -= 2) pts.push(s[q], s[q + 1]);
    }
    if (closed) loops.push(pts.slice(0, -2));
    else openChains++;
  }
  return { loops: loops.filter((l) => l.length >= 6), openChains };
}
