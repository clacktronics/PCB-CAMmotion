// Pure-JS 1-bit rasteriser implementing the drawImage target interface. Used by Node tests
// (reference renders, polarity/region/macro checks) and later by round-trip XOR comparisons.
// Pixels are sampled at their centres with the non-zero winding rule, no anti-aliasing.

import { drawImage } from './draw-image.js';

export class Raster {
  /**
   * @param {number} width  pixels
   * @param {number} height pixels
   * @param {{x0:number, y0:number, pxPerMm:number}} map  (x0, y0) = mm at the bottom-left corner
   */
  constructor(width, height, map) {
    this.width = width;
    this.height = height;
    this.x0 = map.x0;
    this.y0 = map.y0;
    this.s = map.pxPerMm;
    this.pixelMm = 1 / map.pxPerMm;
    this.data = new Uint8Array(width * height);
    this.edges = [];
    this.cx = 0;
    this.cy = 0;
    this.sx = 0;
    this.sy = 0;
    this.open = false;
  }

  // mm -> pixel coordinates (y down)
  px(x) {
    return (x - this.x0) * this.s;
  }
  py(y) {
    return this.height - (y - this.y0) * this.s;
  }

  begin() {
    this.edges = [];
    this.open = false;
  }

  moveTo(x, y) {
    this.closePath();
    this.cx = this.sx = this.px(x);
    this.cy = this.sy = this.py(y);
    this.open = true;
  }

  lineTo(x, y) {
    const nx = this.px(x);
    const ny = this.py(y);
    if (!this.open) {
      this.cx = this.sx = nx;
      this.cy = this.sy = ny;
      this.open = true;
      return;
    }
    this.edge(this.cx, this.cy, nx, ny);
    this.cx = nx;
    this.cy = ny;
  }

  arc(cx, cy, r, a0, a1, anticlockwise) {
    // anticlockwise=false: angle increases from a0 to a1 (Y-up maths convention)
    let sw = a1 - a0;
    const TAU = Math.PI * 2;
    if (!anticlockwise) {
      if (sw < 0) sw += TAU * Math.ceil(-sw / TAU);
      if (sw > TAU) sw = TAU;
    } else {
      if (sw > 0) sw -= TAU * Math.ceil(sw / TAU);
      if (sw < -TAU) sw = -TAU;
    }
    const rpx = r * this.s;
    const tol = 0.2;
    const step = rpx > tol ? 2 * Math.acos(1 - tol / rpx) : Math.PI / 2;
    const n = Math.min(4096, Math.max(1, Math.ceil(Math.abs(sw) / step)));
    for (let k = 0; k <= n; k++) {
      const a = a0 + (sw * k) / n;
      this.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
  }

  closePath() {
    if (this.open && (this.cx !== this.sx || this.cy !== this.sy)) this.edge(this.cx, this.cy, this.sx, this.sy);
    this.cx = this.sx;
    this.cy = this.sy;
    this.open = false;
  }

  edge(x0, y0, x1, y1) {
    if (y0 === y1) return;
    this.edges.push(x0, y0, x1, y1);
  }

  fill(dark) {
    this.closePath();
    const e = this.edges;
    const W = this.width;
    const H = this.height;
    const v = dark ? 1 : 0;
    const n = e.length / 4;
    if (!n) return;
    // bucket edges by first row whose centre they cover
    const buckets = new Map();
    for (let k = 0; k < n; k++) {
      const ya = Math.min(e[k * 4 + 1], e[k * 4 + 3]);
      const yb = Math.max(e[k * 4 + 1], e[k * 4 + 3]);
      const r0 = Math.max(0, Math.ceil(ya - 0.5));
      const r1 = Math.min(H - 1, Math.ceil(yb - 0.5) - 1);
      if (r1 < r0) continue;
      let b = buckets.get(r0);
      if (!b) buckets.set(r0, (b = []));
      b.push(k, r1);
    }
    const rows = [...buckets.keys()].sort((a, b) => a - b);
    let active = []; // [edgeIndex, lastRow]
    let ri = 0;
    const xs = [];
    for (let row = rows.length ? rows[0] : H; row < H; row++) {
      if (ri < rows.length && rows[ri] === row) {
        const b = buckets.get(row);
        for (let q = 0; q < b.length; q += 2) active.push([b[q], b[q + 1]]);
        ri++;
      }
      if (!active.length) {
        if (ri >= rows.length) break;
        row = rows[ri] - 1;
        continue;
      }
      const yc = row + 0.5;
      xs.length = 0;
      for (const [k] of active) {
        const x0 = e[k * 4];
        const y0 = e[k * 4 + 1];
        const x1 = e[k * 4 + 2];
        const y1 = e[k * 4 + 3];
        const x = x0 + ((yc - y0) * (x1 - x0)) / (y1 - y0);
        xs.push(x, y1 > y0 ? 1 : -1);
      }
      const idx = [];
      for (let q = 0; q < xs.length; q += 2) idx.push(q);
      idx.sort((a, b) => xs[a] - xs[b]);
      let wind = 0;
      let start = 0;
      const base = row * W;
      for (const q of idx) {
        const was = wind;
        wind += xs[q + 1];
        if (was === 0 && wind !== 0) start = xs[q];
        else if (was !== 0 && wind === 0) {
          const c0 = Math.max(0, Math.ceil(start - 0.5));
          const c1 = Math.min(W - 1, Math.ceil(xs[q] - 0.5) - 1);
          if (c1 >= c0) this.data.fill(v, base + c0, base + c1 + 1);
        }
      }
      active = active.filter(([, last]) => last > row);
    }
    this.edges = [];
  }

  group(bbox) {
    const c0 = Math.max(0, Math.floor(this.px(bbox[0])) - 1);
    const c1 = Math.min(this.width, Math.ceil(this.px(bbox[2])) + 1);
    const r0 = Math.max(0, Math.floor(this.py(bbox[3])) - 1);
    const r1 = Math.min(this.height, Math.ceil(this.py(bbox[1])) + 1);
    if (c1 <= c0 || r1 <= r0) return null;
    const sub = new Raster(c1 - c0, r1 - r0, {
      x0: this.x0 + c0 / this.s,
      y0: this.y0 + (this.height - r1) / this.s,
      pxPerMm: this.s,
    });
    sub.offset = [c0, r0];
    return sub;
  }

  endGroup(sub, dark) {
    const [c0, r0] = sub.offset;
    const v = dark ? 1 : 0;
    for (let r = 0; r < sub.height; r++) {
      for (let c = 0; c < sub.width; c++) {
        if (sub.data[r * sub.width + c]) this.data[(r + r0) * this.width + c + c0] = v;
      }
    }
  }

  /** Pixel value at a point in mm (0 outside). */
  at(x, y) {
    const c = Math.floor(this.px(x));
    const r = Math.floor(this.py(y));
    if (c < 0 || r < 0 || c >= this.width || r >= this.height) return 0;
    return this.data[r * this.width + c];
  }

  count() {
    let n = 0;
    for (let i = 0; i < this.data.length; i++) n += this.data[i];
    return n;
  }

  /** Dark area in mm². */
  areaMm2() {
    return this.count() / (this.s * this.s);
  }
}

/**
 * Rasterise a whole image.
 * @param {object} image
 * @param {{pxPerMm?: number, bounds?: number[], marginMm?: number, maxPixels?: number}} [opts]
 */
export function rasterizeImage(image, opts = {}) {
  const b = opts.bounds || image.bounds || [0, 0, 1, 1];
  const margin = opts.marginMm ?? 0.5;
  const x0 = b[0] - margin;
  const y0 = b[1] - margin;
  const wMm = b[2] - b[0] + 2 * margin;
  const hMm = b[3] - b[1] + 2 * margin;
  let s = opts.pxPerMm || 20;
  const maxPixels = opts.maxPixels || 16e6;
  if (wMm * hMm * s * s > maxPixels) s = Math.sqrt(maxPixels / (wMm * hMm));
  const r = new Raster(Math.max(1, Math.ceil(wMm * s)), Math.max(1, Math.ceil(hMm * s)), { x0, y0, pxPerMm: s });
  drawImage(image, r, { view: [x0, y0, x0 + wMm, y0 + hMm] });
  return r;
}
