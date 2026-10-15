// Canvas 2D implementation of the drawImage target: renders a layer as an opaque-white mask
// (alpha = coverage). Clear polarity uses 'destination-out'. Browser only.

export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

/**
 * View mapping from mm (Y up) to device pixels:
 *   px = ox + sx * x,  py = oy - s * y      with sx = mirror ? -s : s
 * @typedef {{s:number, ox:number, oy:number, mirror:boolean}} ViewMap
 */

export class CanvasTarget {
  /** @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx @param {ViewMap} map */
  constructor(ctx, map) {
    this.ctx = ctx;
    this.map = map;
    this.pixelMm = 1 / map.s;
    this.applyTransform();
    ctx.fillStyle = '#fff';
  }

  applyTransform() {
    const { s, ox, oy, mirror } = this.map;
    this.ctx.setTransform(mirror ? -s : s, 0, 0, -s, ox, oy);
  }

  begin() {
    this.ctx.beginPath();
  }
  moveTo(x, y) {
    this.ctx.moveTo(x, y);
  }
  lineTo(x, y) {
    this.ctx.lineTo(x, y);
  }
  arc(cx, cy, r, a0, a1, anticlockwise) {
    this.ctx.arc(cx, cy, r, a0, a1, anticlockwise);
  }
  closePath() {
    this.ctx.closePath();
  }

  fill(dark) {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = dark ? 'source-over' : 'destination-out';
    ctx.fill('nonzero');
    ctx.globalCompositeOperation = 'source-over';
  }

  stroke(dark, width) {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = dark ? 'source-over' : 'destination-out';
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }

  group(bbox) {
    const { s, ox, oy, mirror } = this.map;
    const xa = ox + (mirror ? -s : s) * bbox[0];
    const xb = ox + (mirror ? -s : s) * bbox[2];
    const x0 = Math.floor(Math.min(xa, xb)) - 1;
    const x1 = Math.ceil(Math.max(xa, xb)) + 1;
    const y0 = Math.floor(oy - s * bbox[3]) - 1;
    const y1 = Math.ceil(oy - s * bbox[1]) + 1;
    const W = this.ctx.canvas.width;
    const H = this.ctx.canvas.height;
    const cx0 = Math.max(0, x0);
    const cy0 = Math.max(0, y0);
    const cx1 = Math.min(W, x1);
    const cy1 = Math.min(H, y1);
    if (cx1 <= cx0 || cy1 <= cy0) return null;
    const canvas = scratch(cx1 - cx0, cy1 - cy0);
    const sub = new CanvasTarget(canvas.getContext('2d'), { s, ox: ox - cx0, oy: oy - cy0, mirror });
    sub.offset = [cx0, cy0, cx1 - cx0, cy1 - cy0];
    return sub;
  }

  endGroup(sub, dark) {
    const ctx = this.ctx;
    const [x, y, w, h] = sub.offset;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = dark ? 'source-over' : 'destination-out';
    ctx.drawImage(sub.ctx.canvas, 0, 0, w, h, x, y, w, h);
    ctx.restore();
    release(sub.ctx.canvas);
  }
}

// small pool of scratch canvases for isolated aperture groups
const pool = [];
function scratch(w, h) {
  const c = pool.pop() || makeCanvas(w, h);
  if (c.width < w || c.height < h) {
    c.width = Math.max(c.width, w);
    c.height = Math.max(c.height, h);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  return c;
}
function release(c) {
  if (pool.length < 4) pool.push(c);
}
