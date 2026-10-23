// 2D board viewer: canvas, zoom/pan, top/bottom view, selection and hover. Browser only.

import { BoardRenderer, analysisLayers } from './board-render.js';
import { backgroundColour } from '../model/view-modes.js';
import { emitObject, transformedParts } from './draw-image.js';
import { emitPath } from '../model/path.js';
import { hitTest } from '../model/hit-test.js';
import { MISC, rgba } from '../model/materials.js';
import { CanvasTarget, makeCanvas } from './canvas-target.js';

const MIN_SCALE = 0.01; // px per mm
const MAX_SCALE = 20000;

export class Viewer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onCursor?:(x:number,y:number)=>void, onSelect?:(hit:object|null)=>void, onHover?:(hit:object|null)=>void, onView?:(v:object)=>void, onContextMenu?:(mm:number[], e:MouseEvent)=>boolean}} cb
   */
  constructor(canvas, overlay, cb = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.overlay = overlay;
    this.octx = overlay.getContext('2d');
    this.cb = cb;
    this.renderer = new BoardRenderer();
    this.layers = [];
    this.settings = {
      mode: 'realistic',
      side: 'top',
      stackup: {},
      background: 'dark',
      solo: [],
      activeLayerId: null,
    };
    this.view = { cx: 0, cy: 0, scale: 10 }; // centre (mm) and CSS px per mm
    this.selected = null;
    this.hover = null;
    this.highlight = null; // { layerId, indices: number[] } every use of an aperture
    this.playhead = null; // { layerId, current: [start, end), head: [x, y] | null }
    this.hlCache = null;
    this.editSelection = null; // { layerId, indices } objects selected in the editor
    this.overlayHook = null; // (ctx, map) => void: the editor's previews (src/ui/editor.js)
    /**
     * Edit mode pointer handler, or null. down(mm, e) returns true to take the drag (else the
     * view pans); move(mm, e) and up(mm, e, moved) follow it; click(mm, e) replaces selection
     * by picking; hover(mm, e) on every move without a drag.
     */
    this.edit = null;
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
    this.highlight = null;
    this.playhead = null;
    this.hlCache = null;
    this.requestRender(true);
  }

  /** Mark objects of one layer (e.g. every use of an aperture); null clears. */
  setHighlight(hl) {
    this.highlight = hl && hl.indices.length ? hl : null;
    this.hlCache = null;
    this.drawOverlay();
  }

  /** Step-through playback: the objects of the current command and the plotter head. */
  setPlayhead(p) {
    this.playhead = p;
    this.drawOverlay();
  }

  layersChanged() {
    this.requestRender(true);
  }

  /**
   * Change which layers are drawn (the layer group toggles) without resetting the view,
   * highlight or playback; hover and selection on a layer no longer drawn are cleared.
   */
  showLayers(layers) {
    this.layers = layers;
    const gone = (hit) => hit && !layers.some((l) => l.id === hit.layerId);
    if (gone(this.hover)) this.hover = null;
    if (gone(this.selected)) this.select(null);
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
    ctx.fillStyle = rgba({ rgb: backgroundColour(this.settings.mode, this.settings.background) }, 1);
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    // device point p_old maps to p_now = now.o + k (p_old - old.o)
    ctx.setTransform(k, 0, 0, k, now.ox - k * old.ox, now.oy - k * old.oy);
    ctx.drawImage(this.snapshot.canvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Highlight, playback, hover and selection outlines on the overlay canvas (no board re-render). */
  drawOverlay() {
    const map = this.map();
    const ctx = this.octx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (this.highlight) ctx.drawImage(this.#highlightCanvas(map), 0, 0);
    const pl = this.playhead;
    if (pl) {
      const layer = this.layers.find((l) => l.id === pl.layerId);
      const [a, b] = pl.current;
      if (layer && b > a) this.#outline(ctx, map, layer, range(a, Math.min(b, a + 20000)), MISC.playhead, 0.45);
      if (pl.head) this.#crosshair(ctx, map, pl.head, MISC.playhead);
    }
    for (const [hit, colour, fillAlpha] of [
      [this.hover, MISC.hover, 0.15],
      [this.edit ? null : this.selected, MISC.selection, 0.3],
    ]) {
      if (!hit) continue;
      const layer = this.layers.find((l) => l.id === hit.layerId);
      if (layer?.image?.objects[hit.index]) this.#outline(ctx, map, layer, [hit.index], colour, fillAlpha);
    }
    const es = this.editSelection;
    if (es?.indices.length) {
      const layer = this.layers.find((l) => l.id === es.layerId);
      if (layer?.image) this.#outline(ctx, map, layer, es.indices, MISC.selection, 0.3);
    }
    this.overlayHook?.(ctx, map);
  }

  /** Draw some objects of a layer outlined, optionally moved by (dx, dy) mm (edit previews). */
  outlineObjects(ctx, map, layerId, indices, colour, fillAlpha, dx = 0, dy = 0) {
    const layer = this.layers.find((l) => l.id === layerId);
    if (!layer?.image) return;
    const m = dx || dy ? { ...map, ox: map.ox + (map.mirror ? -map.s : map.s) * dx, oy: map.oy - map.s * dy } : map;
    this.#outline(ctx, m, layer, indices, colour, fillAlpha);
  }

  /** Device pixel position of a board point (mm). */
  toPx(map, x, y) {
    return [map.ox + (map.mirror ? -map.s : map.s) * x, map.oy - map.s * y];
  }

  /** Fill and outline some objects of a layer; objects outside the view are skipped. */
  #outline(ctx, map, layer, indices, colour, fillAlpha) {
    const objs = layer.image.objects;
    const ob = layer.image.objBounds;
    const v = BoardRenderer.viewRect(map, this.canvas.width, this.canvas.height);
    const t = new CanvasTarget(ctx, map);
    ctx.beginPath();
    for (const i of indices) {
      const o = objs[i];
      if (!o) continue;
      if (ob && (ob[i * 4] > v[2] || ob[i * 4 + 2] < v[0] || ob[i * 4 + 1] > v[3] || ob[i * 4 + 3] < v[1])) continue;
      if (o.k === 'F' && o.ap.shape) for (const p of transformedParts(o.ap, o.m)) emitPath(t, p.path, o.x, o.y);
      else emitObject(o, t, t.pixelMm);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = rgba(colour, fillAlpha);
    ctx.fill('nonzero');
    ctx.strokeStyle = rgba(colour, 1);
    ctx.lineWidth = Math.max(1, this.dpr * 1.5);
    ctx.stroke();
  }

  /** The highlighted objects, drawn once per view (there can be many). */
  #highlightCanvas(map) {
    const w = this.overlay.width;
    const h = this.overlay.height;
    const key = `${map.s},${map.ox},${map.oy},${map.mirror},${w},${h}`;
    if (this.hlCache?.key === key) return this.hlCache.canvas;
    const canvas =
      this.hlCache?.canvas?.width === w && this.hlCache.canvas.height === h ? this.hlCache.canvas : makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const layer = this.layers.find((l) => l.id === this.highlight.layerId);
    if (layer?.image) this.#outline(ctx, map, layer, this.highlight.indices, MISC.highlight, 0.35);
    this.hlCache = { key, canvas };
    return canvas;
  }

  #crosshair(ctx, map, [x, y], colour) {
    const px = map.ox + (map.mirror ? -map.s : map.s) * x;
    const py = map.oy - map.s * y;
    const r = 9 * this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = rgba(colour, 1);
    ctx.lineWidth = Math.max(1, this.dpr * 1.5);
    ctx.beginPath();
    ctx.moveTo(px - r, py);
    ctx.lineTo(px + r, py);
    ctx.moveTo(px, py - r);
    ctx.lineTo(px, py + r);
    ctx.moveTo(px + r / 2, py);
    ctx.arc(px, py, r / 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** Topmost visible object under a client point. */
  pick(clientX, clientY) {
    const [x, y] = this.toMm(clientX, clientY);
    return this.pickAt(x, y);
  }

  /**
   * Topmost visible object at a board point (mm), optionally only on layers `accept` takes
   * (e.g. copper only, for "select connected"). In edit mode only the layer being edited can
   * be picked, unless `only` is passed as null (any shown layer).
   */
  pickAt(x, y, accept = null, only = this.settings.pickLayerId) {
    const tol = 3 / this.view.scale; // 3 CSS px
    let order = only ? this.layers.filter((l) => l.id === only && l.image) : this.#pickOrder();
    if (accept) order = order.filter(accept);
    for (const l of order) {
      // editing: an object under the point wins over a near miss on a neighbour (fine pitch)
      let i = only ? hitTest(l.image, x, y, 0) : -1;
      if (i < 0) i = hitTest(l.image, x, y, tol);
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
    const shown = analysisLayers(this.layers, this.settings);
    return shown.sort((a, b) => rank(a) - rank(b));
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
      if (e.button !== 0 && e.button !== 1) return;
      const mm = this.toMm(e.clientX, e.clientY);
      const edit = e.button === 0 && !!this.edit?.down?.(mm, e);
      drag = { x: e.clientX, y: e.clientY, cx: this.view.cx, cy: this.view.cy, moved: false, id: e.pointerId, edit };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('dblclick', (e) => this.edit?.dblclick?.(this.toMm(e.clientX, e.clientY), e));
    // right-click: the app's own menu (src/ui/context-menu.js) instead of the browser's
    c.addEventListener('contextmenu', (e) => {
      if (this.cb.onContextMenu?.(this.toMm(e.clientX, e.clientY), e)) e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      const [x, y] = this.toMm(e.clientX, e.clientY);
      this.cb.onCursor?.(x, y);
      if (drag) {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 3) return;
        drag.moved = true;
        if (drag.edit) {
          this.edit?.move?.([x, y], e);
          return;
        }
        const sx = this.settings.side === 'bottom' ? -1 : 1;
        this.view.cx = drag.cx - (sx * dx) / this.view.scale;
        this.view.cy = drag.cy + dy / this.view.scale;
        this.requestRender(false);
        return;
      }
      this.edit?.hover?.([x, y], e);
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
      if (d.edit) {
        const mm = this.toMm(e.clientX, e.clientY);
        if (!d.moved && e.type === 'pointerup') this.edit?.click?.(mm, e);
        else this.edit?.up?.(mm, e, d.moved && e.type === 'pointerup');
        return;
      }
      if (!d.moved && e.type === 'pointerup' && this.edit?.click) {
        this.edit.click(this.toMm(e.clientX, e.clientY), e);
        return;
      }
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

function range(a, b) {
  const out = new Array(b - a);
  for (let i = a; i < b; i++) out[i - a] = i;
  return out;
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
