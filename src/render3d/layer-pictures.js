// Pictures of each stack item for the 3D view: the layer's material in its real colour, clipped
// to the board and with the drill holes cut out (transparent). Drawn with the same 2D code as
// the realistic view, at a fixed scale covering the board. Browser only (canvas).

import { BoardRenderer, boardArea } from '../render/board-render.js';
import { CanvasTarget, makeCanvas } from '../render/canvas-target.js';
import { SOLDER_MASK, SILKSCREEN, SUBSTRATE, COPPER, MISC, SURFACE, lookupMaterial, rgba } from '../model/materials.js';
import { roleColour } from '../model/view-modes.js';

/**
 * Pixel frame covering the board: bounds (mm), size (px) and the mm -> px map.
 * @param {number[]} bounds [x0, y0, x1, y1] mm
 * @param {number} maxPx longest side in pixels
 */
export function pictureFrame(bounds, maxPx = 2048, maxPxPerMm = 25) {
  const wMm = Math.max(bounds[2] - bounds[0], 1e-3);
  const hMm = Math.max(bounds[3] - bounds[1], 1e-3);
  const s = Math.min(maxPxPerMm, maxPx / Math.max(wMm, hMm));
  const w = Math.max(1, Math.ceil(wMm * s));
  const h = Math.max(1, Math.ceil(hMm * s));
  return { bounds, w, h, map: { s, mirror: false, ox: -bounds[0] * s, oy: bounds[3] * s } };
}

/** Bounding box of the board area loops. */
export function loopsBounds(loops) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const loop of loops)
    for (let i = 0; i < loop.length; i += 2) {
      b[0] = Math.min(b[0], loop[i]);
      b[1] = Math.min(b[1], loop[i + 1]);
      b[2] = Math.max(b[2], loop[i]);
      b[3] = Math.max(b[3], loop[i + 1]);
    }
  return b[0] <= b[2] ? b : null;
}

export class LayerPictures {
  /**
   * @param {object[]} layers all layers of the project
   * @param {object} stackup effective stackup
   * @param {ReturnType<typeof pictureFrame>} frame
   */
  constructor(layers, stackup, frame) {
    this.layers = layers;
    this.st = stackup || {};
    this.frame = frame;
    this.renderer = new BoardRenderer();
    this.profile = layers.find((l) => l.image && l.role.type === 'profile');
    this.drills = layers.filter((l) => l.image && l.role.type === 'drill');
    this.area = boardArea(layers, this.profile);
    this.base = this.#baseArea();
  }

  dispose() {
    this.renderer.invalidate();
  }

  #mask(layer) {
    const { map, w, h } = this.frame;
    return this.renderer.mask(layer, map, w, h);
  }

  /** Board area minus every drilled hole (white = material). */
  #baseArea() {
    const { map, w, h } = this.frame;
    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d');
    if (this.area) {
      const t = new CanvasTarget(ctx, map);
      t.begin();
      for (const loop of this.area) {
        t.moveTo(loop[0], loop[1]);
        for (let i = 2; i < loop.length; i += 2) t.lineTo(loop[i], loop[i + 1]);
        t.closePath();
      }
      ctx.fill('evenodd');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.globalCompositeOperation = 'destination-out';
    for (const d of this.drills) ctx.drawImage(this.#mask(d), 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    return c;
  }

  /** The mask layer on a side, if any. */
  #maskLayer(side) {
    return this.layers.find((l) => l.image && l.role.type === 'soldermask' && l.role.side === side);
  }

  /** Mask openings on a side as a coverage canvas (null without a negative mask layer). */
  #openings(side) {
    const m = this.#maskLayer(side);
    if (!m || (m.role.polarity || 'negative') === 'positive') return null;
    return this.#mask(m);
  }

  /**
   * Picture for one stack item.
   * @param {{type:string, side:string, layerId:string|null}} item
   * @returns {{canvas: HTMLCanvasElement|OffscreenCanvas, opacity:number, surface:{metalness:number, roughness:number}}}
   */
  picture(item) {
    const { w, h } = this.frame;
    const st = this.st;
    const layer = item.layerId ? this.layers.find((l) => l.id === item.layerId) : null;
    const side = item.side === 'bottom' ? 'bottom' : 'top';
    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d');
    const paint = (coverage, colour, op = 'source-over') => {
      const tmp = makeCanvas(w, h);
      const t = tmp.getContext('2d');
      t.drawImage(coverage, 0, 0);
      t.globalCompositeOperation = 'source-in';
      t.fillStyle = colour;
      t.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = op;
      ctx.drawImage(tmp, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    };
    const clipTo = (coverage, op) => {
      ctx.globalCompositeOperation = op;
      ctx.drawImage(coverage, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    };
    const opacity = layer?.opacity ?? 1;

    if (item.type === 'dielectric') {
      const sub = lookupMaterial('substrate', st.substrate).value || SUBSTRATE.fr4;
      paint(this.base, rgba(sub, 1));
      return { canvas: c, opacity: 1, surface: SURFACE.substrate };
    }
    if (item.type === 'copper') {
      paint(this.#mask(layer), rgba(COPPER, 1));
      const outer = item.side !== 'inner';
      const open = outer ? this.#openings(side) : null;
      if (outer && !this.#maskLayer(side)) {
        // no solder mask on this side (none loaded, or switched off): all copper is exposed
        // and carries the surface finish, as in the 2D realistic view
        paint(this.#mask(layer), rgba(lookupMaterial('finish', st.finish).value, 1));
      } else if (open) {
        // exposed copper carries the surface finish
        const finish = lookupMaterial('finish', st.finish).value;
        const ex = makeCanvas(w, h);
        const e = ex.getContext('2d');
        e.drawImage(this.#mask(layer), 0, 0);
        e.globalCompositeOperation = 'destination-in';
        e.drawImage(open, 0, 0);
        paint(ex, rgba(finish, 1));
      }
      clipTo(this.base, 'destination-in');
      return { canvas: c, opacity, surface: SURFACE.copper };
    }
    if (item.type === 'soldermask') {
      const mat = lookupMaterial('mask', st.mask?.[side] ?? st.mask).value || SOLDER_MASK.green;
      if ((layer.role.polarity || 'negative') !== 'positive') {
        paint(this.base, rgba(mat, 1));
        clipTo(this.#mask(layer), 'destination-out');
      } else {
        paint(this.#mask(layer), rgba(mat, 1));
        clipTo(this.base, 'destination-in');
      }
      return { canvas: c, opacity: (mat.opacity ?? 0.85) * opacity, surface: SURFACE.soldermask };
    }
    if (item.type === 'legend') {
      const mat = lookupMaterial('silk', st.silk?.[side] ?? st.silk).value || SILKSCREEN.white;
      paint(this.#mask(layer), rgba(mat, 1));
      const open = this.#openings(side);
      if (open) clipTo(open, 'destination-out'); // fabs clip silkscreen off exposed pads
      clipTo(this.base, 'destination-in');
      return { canvas: c, opacity, surface: SURFACE.legend };
    }
    if (item.type === 'paste') {
      paint(this.#mask(layer), rgba(MISC.paste, 1));
      clipTo(this.base, 'destination-in');
      return { canvas: c, opacity: (MISC.paste.opacity ?? 1) * opacity, surface: SURFACE.paste };
    }
    paint(this.#mask(layer), rgba({ rgb: roleColour(layer.role) }, 1));
    clipTo(this.base, 'destination-in');
    return { canvas: c, opacity, surface: SURFACE.other };
  }
}
