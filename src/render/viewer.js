// 2D board viewer: canvas, zoom/pan, top/bottom view, selection and hover. Browser only.

import { BoardRenderer } from './board-render.js';
import { emitObject, transformedParts } from './draw-image.js';
import { emitPath } from '../model/path.js';
import { hitTest } from '../model/hit-test.js';
import { MISC, rgba } from '../model/materials.js';
import { CanvasTarget } from './canvas-target.js';

const MIN_SCALE = 0.01; // px per mm
const MAX_SCALE = 20000;

export class Viewer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onCursor?:(x:number,y:number)=>void, onSelect?:(hit:object|null)=>void, onHover?:(hit:object|null)=>void, onView?:(v:object)=>void}} cb
   */
  constructor(canvas, overlay, cb = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.overlay = overlay;
    this.octx = overlay.getContext('2d');
    this.cb = cb;
    this.renderer = new BoardRenderer();
    this.layers = [];
    this.settings = { mode: 'realistic', side: 'top', stackup: {}, showPaste: false };
    this.view = { cx: 0, cy: 0, scale: 10 }; // centre (mm) and CSS px per mm
    this.selected = null;
    this.hover = null;
    this.pending = 0;
    this.snapshot = null; // last rendered frame + its map, used while gestures are in flight
    this.lastRenderMs = 0;
    this.renderCount = 0;
    this.#bind();
    this.resize();
  }

  get dpr() {
    return globalThis.devicePixelRatio || 1;
  }

  /** mm -> device pixel mapping for the current view. */
  map() {
    const s = this.view.scale * this.dpr;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const mirror = this.settings.side === 'bottom';
    const sx = mirror ? -s : s;
    return { s, mirror, ox: w / 2 - sx * this.view.cx, oy: h / 2 + s * this.view.cy };
  }

  toMm(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const px = (clientX - r.left) * this.dpr;
    const py = (clientY - r.top) * this.dpr;
    const m = this.map();
    return [(px - m.ox) / (m.mirror ? -m.s : m.s), (m.oy - py) / m.s];
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * this.dpr));
    const h = Math.max(1, Math.round(r.height * this.dpr));
    if (w !== this.canvas.width || h !== this.canvas.height) {
      this.canvas.width = this.overlay.width = w;
      this.canvas.height = this.overlay.height = h;
      this.renderNow();
    }
  }

  setLayers(layers) {
    this.layers = layers;
    this.renderer.invalidate();
    this.selected = null;
    this.hover = null;
    this.requestRender(true);
  }

  layersChanged() {
    this.requestRender(true);
  }

  setSettings(patch) {
    const sideChanged = patch.side && patch.side !== this.settings.side;
    Object.assign(this.settings, patch);
    if (sideChanged) this.renderer.invalidate();
    this.requestRender(true);
    this.cb.onView?.(this.getView());
  }

  getView() {
    return { ...this.view, side: this.settings.side, mode: this.settings.mode };
  }

  setView(v) {
    if (Number.isFinite(v.cx)) this.view.cx = v.cx;
    if (Number.isFinite(v.cy)) this.view.cy = v.cy;
    if (Number.isFinite(v.scale)) this.view.scale = clamp(v.scale, MIN_SCALE, MAX_SCALE);
    this.requestRender(true);
  }

  boardBounds() {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const l of this.layers) {
      if (!l.visible || !l.image?.bounds) continue;
      const bb = l.image.bounds;
      b[0] = Math.min(b[0], bb[0]);
      b[1] = Math.min(b[1], bb[1]);
      b[2] = Math.max(b[2], bb[2]);
      b[3] = Math.max(b[3], bb[3]);
    }
    return b[0] <= b[2] ? b : null;
  }

  fit() {
    const b = this.boardBounds();
    const r = this.canvas.getBoundingClientRect();
    if (!b || !r.width || !r.height) return;
    const w = Math.max(b[2] - b[0], 1e-3);
    const h = Math.max(b[3] - b[1], 1e-3);
    this.view.cx = (b[0] + b[2]) / 2;
    this.view.cy = (b[1] + b[3]) / 2;
    this.view.scale = clamp(Math.min(r.width / w, r.height / h) * 0.9, MIN_SCALE, MAX_SCALE);
    this.requestRender(true);
    this.cb.onView?.(this.getView());
  }

  zoomAt(clientX, clientY, factor) {
    const [mx, my] = this.toMm(clientX, clientY);
    const scale = clamp(this.view.scale * factor, MIN_SCALE, MAX_SCALE);
    const f = scale / this.view.scale;
    this.view.cx = mx + (this.view.cx - mx) / f;
    this.view.cy = my + (this.view.cy - my) / f;
    this.view.scale = scale;
    this.requestRender(false);
    this.cb.onView?.(this.getView());
  }

  /** Re-render soon. full=false shows a quick preview of the last frame first (gestures). */
  requestRender(full) {
    if (!full && this.snapshot) this.#preview();
    clearTimeout(this.pending);
    this.pending = setTimeout(() => this.renderNow(), full ? 0 : 90);
  }

  renderNow() {
    clearTimeout(this.pending);
    const w = this.canvas.width;
    const h = this.canvas.height;
    const t0 = performance.now();
    const map = this.map();
    this.renderer.render(this.ctx, this.layers, this.settings, map, w, h);
    this.drawOverlay();
    this.lastRenderMs = performance.now() - t0;
    this.renderCount++;
    // keep the frame for fast previews while panning/zooming
    if (!this.snapshot || this.snapshot.canvas.width !== w || this.snapshot.canvas.height !== h) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      this.snapshot = { canvas: c, map };
    }
    const sctx = this.snapshot.canvas.getContext('2d');
    sctx.clearRect(0, 0, w, h);
    sctx.drawImage(this.canvas, 0, 0);
    this.snapshot.map = map;
    this.canvas.dataset.renders = String(this.renderCount);
  }

  #preview() {
    const old = this.snapshot.map;
    const now = this.map();
    if (old.mirror !== now.mirror) return;
    const k = now.s / old.s;
    this.octx.setTransform(1, 0, 0, 1, 0, 0);
    this.octx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = rgba(MISC.background, 1);
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    // device point p_old maps to p_now = now.o + k (p_old - old.o)
    ctx.setTransform(k, 0, 0, k, now.ox - k * old.ox, now.oy - k * old.oy);
    ctx.drawImage(this.snapshot.canvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Hover and selection outlines on the overlay canvas (cheap: no board re-render). */
  drawOverlay() {
    const map = this.map();
    const ctx = this.octx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    for (const [hit, colour, fillAlpha] of [
      [this.hover, MISC.hover, 0.15],
      [this.selected, MISC.selection, 0.3],
    ]) {
      if (!hit) continue;
      const layer = this.layers.find((l) => l.id === hit.layerId);
      const o = layer?.image?.objects[hit.index];
      if (!o) continue;
      const t = new CanvasTarget(ctx, map);
      ctx.beginPath();
      if (o.k === 'F' && o.ap.shape) for (const p of transformedParts(o.ap, o.m)) emitPath(t, p.path, o.x, o.y);
      else emitObject(o, t, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = rgba(colour, fillAlpha);
      ctx.fill('nonzero');
      ctx.strokeStyle = rgba(colour, 1);
      ctx.lineWidth = Math.max(1, this.dpr * 1.5);
      ctx.stroke();
    }
  }

  /** Topmost visible object under a client point. */
  pick(clientX, clientY) {
    const [x, y] = this.toMm(clientX, clientY);
    const tol = 3 / this.view.scale; // 3 CSS px
    const order = this.#pickOrder();
    for (const l of order) {
      const i = hitTest(l.image, x, y, tol);
      if (i >= 0) return { layerId: l.id, index: i, object: l.image.objects[i], x, y };
    }
    return null;
  }

  #pickOrder() {
    const side = this.settings.side;
    const rank = (l) => {
      const r = l.role;
      if (r.type === 'drill') return 0;
      if (r.side === side) return 1 + ({ legend: 0, paste: 1, soldermask: 3, copper: 2 }[r.type] ?? 4) / 10;
      if (r.type === 'profile') return 2;
      if (r.side === 'inner') return 3;
      return 4;
    };
    return this.layers.filter((l) => l.visible && l.image).sort((a, b) => rank(a) - rank(b));
  }

  select(hit) {
    this.selected = hit;
    this.drawOverlay();
    this.cb.onSelect?.(hit);
  }

  #bind() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
        this.zoomAt(e.clientX, e.clientY, factor);
      },
      { passive: false },
    );
    c.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, cx: this.view.cx, cy: this.view.cy, moved: false, id: e.pointerId };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      const [x, y] = this.toMm(e.clientX, e.clientY);
      this.cb.onCursor?.(x, y);
      if (drag) {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 3) return;
        drag.moved = true;
        const sx = this.settings.side === 'bottom' ? -1 : 1;
        this.view.cx = drag.cx - (sx * dx) / this.view.scale;
        this.view.cy = drag.cy + dy / this.view.scale;
        this.requestRender(false);
        return;
      }
      clearTimeout(this.hoverTimer);
      this.hoverTimer = setTimeout(() => {
        const hit = this.pick(e.clientX, e.clientY);
        const same = hit && this.hover && hit.layerId === this.hover.layerId && hit.index === this.hover.index;
        if (!same && (hit || this.hover)) {
          this.hover = hit;
          this.cb.onHover?.(hit);
          this.drawOverlay();
        }
      }, 60);
    });
    const end = (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (c.hasPointerCapture?.(e.pointerId)) c.releasePointerCapture(e.pointerId);
      if (d.moved) {
        this.requestRender(true);
        this.cb.onView?.(this.getView());
      } else if (e.type === 'pointerup') this.select(this.pick(e.clientX, e.clientY));
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      if (this.hover) {
        this.hover = null;
        this.cb.onHover?.(null);
        this.drawOverlay();
      }
    });
    new ResizeObserver(() => this.resize()).observe(c);
  }
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
