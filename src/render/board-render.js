// Compose layer masks into the board picture: realistic materials (substrate, copper, solder
// mask, surface finish, silkscreen, plated/non-plated holes) or per-layer debug colours.
// Browser only (canvas). Colours come from model/materials.js.

import { drawImage } from './draw-image.js';
import { CanvasTarget, OutlineTarget, makeCanvas } from './canvas-target.js';
import { SOLDER_MASK, SILKSCREEN, SUBSTRATE, COPPER, MISC, lookupMaterial, rgba } from '../model/materials.js';
import { layerColour, backgroundColour, xorLayer, roleColour } from '../model/view-modes.js';

/**
 * @typedef {{id:string, role:{type:string, side:string, plated?:boolean|null, polarity?:string},
 *   image:object, visible:boolean, opacity:number, outline?:{loops:number[][]}}} RenderLayer
 * @typedef {{mode:'realistic'|'debug'|'classic'|'xor'|'outline', side:'top'|'bottom',
 *   stackup:{mask?:string, silk?:string, finish?:string, substrate?:string},
 *   background?:'dark'|'light', solo?:string[], activeLayerId?:string|null}} RenderSettings
 * solo: ids of the soloed layers; when any are soloed only those are drawn.
 * Layers may also carry colour ('#rrggbb', analysis views) and invert (draw the layer's
 * complement inside the board area: e.g. solder mask material instead of mask openings).
 */

export class BoardRenderer {
  constructor() {
    this.masks = new Map(); // layer id -> { key, canvas }
    this.work = [];
  }

  /** Visible area in mm for a view map and canvas size. */
  static viewRect(map, w, h) {
    const sx = map.mirror ? -map.s : map.s;
    const xa = (0 - map.ox) / sx;
    const xb = (w - map.ox) / sx;
    return [Math.min(xa, xb), (map.oy - h) / map.s, Math.max(xa, xb), map.oy / map.s];
  }

  invalidate(id) {
    if (id === undefined) this.masks.clear();
    else this.masks.delete(id);
  }

  /**
   * Mask canvas (white = covered) for one layer at this view; cached until the view changes.
   * A layer with `limit` (step-through playback) is drawn up to that many objects; when the
   * limit grows, only the new objects are drawn on top of the cached mask.
   */
  mask(layer, map, w, h, opts = {}) {
    const key = `${map.s},${map.ox},${map.oy},${map.mirror},${w},${h},${opts.inflateMm || 0}`;
    const id = layer.id + (opts.inflateMm ? ':inflate' : '') + (opts.outline ? ':outline' : '');
    const limit = Number.isInteger(layer.limit) ? layer.limit : null;
    const hit = this.masks.get(id);
    const same = hit && hit.key === key && hit.image === layer.image;
    if (same && hit.limit === limit) return hit.canvas;
    const draw = (canvas, from) => {
      const ctx = canvas.getContext('2d');
      const t = opts.outline ? new OutlineTarget(ctx, map) : new CanvasTarget(ctx, map);
      drawImage(layer.image, t, {
        view: BoardRenderer.viewRect(map, w, h),
        inflateMm: opts.inflateMm || 0,
        from,
        limit: limit ?? undefined,
      });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    };
    if (same && limit !== null && hit.limit !== null && limit > hit.limit) {
      draw(hit.canvas, hit.limit);
      hit.limit = limit;
      return hit.canvas;
    }
    const canvas = hit?.canvas && hit.canvas.width === w && hit.canvas.height === h ? hit.canvas : makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    draw(canvas, 0);
    this.masks.set(id, { key, canvas, limit, image: layer.image });
    return canvas;
  }

  workCanvas(i, w, h) {
    let c = this.work[i];
    if (!c || c.width !== w || c.height !== h) c = this.work[i] = makeCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);
    return c;
  }

  /**
   * Render into ctx (a canvas of size w×h, device pixels).
   * @param {CanvasRenderingContext2D} ctx
   * @param {RenderLayer[]} layers
   * @param {RenderSettings} settings
   * @param {import('./canvas-target.js').ViewMap} map
   */
  render(ctx, layers, settings, map, w, h) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const mode = settings.mode || 'realistic';
    ctx.fillStyle = rgba({ rgb: backgroundColour(mode, settings.background) }, 1);
    ctx.fillRect(0, 0, w, h);
    if (mode === 'realistic') this.renderRealistic(ctx, layers, settings, map, w, h);
    else this.renderAnalysis(ctx, layers, settings, map, w, h);
  }

  /** Debug, classic, XOR and outline views: one colour per layer, physical order. */
  renderAnalysis(ctx, layers, settings, map, w, h) {
    const mode = settings.mode;
    const shown = analysisLayers(layers, settings);
    const order = debugOrder(shown, settings.side);
    const xor = mode === 'xor' ? ctx.getImageData(0, 0, w, h) : null;
    const profile = layers.find((l) => l.role.type === 'profile' && l.image);
    for (const l of order) {
      let m = this.mask(l, map, w, h, { outline: mode === 'outline' });
      if (l.invert) m = this.inverted(m, layers, profile, map, w, h);
      const rgb = layerColour(l, mode, l.listIndex ?? layers.indexOf(l));
      if (xor) {
        const cov = m.getContext('2d').getImageData(0, 0, w, h).data;
        xorLayer(xor.data, cov, rgb);
        continue;
      }
      const c = tint(this.workCanvas(0, w, h), m, rgba({ rgb }, 1));
      ctx.globalAlpha = mode === 'outline' ? 1 : (l.opacity ?? 1) * (mode === 'classic' ? 0.85 : 0.8);
      ctx.drawImage(c, 0, 0);
    }
    if (xor) ctx.putImageData(xor, 0, 0);
    ctx.globalAlpha = 1;
  }

  /**
   * Soloed layers as slices through the board, in real materials, far side first: substrate,
   * then each layer's material (bare copper for any copper layer, inner ones included; mask,
   * silkscreen or paste otherwise), plated hole barrels through copper, and the holes cut
   * out. Per-layer invert (an analysis-view setting) is ignored here.
   */
  renderSlices(ctx, list, { layers, profile, drills, board, substrate, st, map, w, h }) {
    const out = this.workCanvas(2, w, h);
    const o = out.getContext('2d');
    tintInto(o, board, rgba(substrate, 1), 1, this.workCanvas(3, w, h));
    for (const l of list) this.#sliceLayer(o, l, { layers, profile, st, map, w, h });
    const copper = list.some((l) => l.role.type === 'copper');
    for (const d of drills) {
      if (copper && d.role.plated !== false) {
        // plated barrel: copper ring around every plated hole through a copper layer
        tintInto(o, this.mask(d, map, w, h, { inflateMm: 0.04 }), rgba(COPPER, 1), 1, this.workCanvas(3, w, h));
      }
      o.globalCompositeOperation = 'destination-out';
      o.drawImage(this.mask(d, map, w, h), 0, 0);
      o.globalCompositeOperation = 'source-over';
    }
    o.globalCompositeOperation = 'destination-in';
    o.drawImage(board, 0, 0);
    o.globalCompositeOperation = 'source-over';
    ctx.drawImage(out, 0, 0);
  }

  #sliceLayer(o, l, { layers, profile, st, map, w, h }) {
    const type = l.role.type;
    let m = this.mask(l, map, w, h);
    if (type === 'soldermask') {
      // the mask image shows openings (negative polarity): the material is the rest
      const openings = (l.role.polarity || 'negative') !== 'positive';
      if (openings) m = this.inverted(m, layers, profile, map, w, h);
    }
    // (invert is an analysis-view setting: the realistic slice always shows the real material)
    const side = l.role.side === 'bottom' ? 'bottom' : 'top';
    const colour =
      type === 'copper'
        ? COPPER
        : type === 'soldermask'
          ? lookupMaterial('mask', st.mask?.[side] ?? st.mask).value
          : type === 'legend'
            ? lookupMaterial('silk', st.silk?.[side] ?? st.silk).value
            : type === 'paste'
              ? MISC.paste
              : type === 'drill' || type === 'profile'
                ? null
                : { rgb: roleColour(l.role) };
    if (colour) {
      const c = tint(this.workCanvas(4, w, h), m, rgba(colour, 1));
      if (type === 'copper') sheen(c, 0.2);
      o.globalAlpha = (type === 'soldermask' ? (colour.opacity ?? 0.85) : 1) * (l.opacity ?? 1);
      o.drawImage(c, 0, 0);
      o.globalAlpha = 1;
    }
  }

  /** The layer's complement inside the board area (board outline, or all layers' extent). */
  inverted(mask, layers, profile, map, w, h) {
    const c = this.workCanvas(5, w, h);
    const cx = c.getContext('2d');
    const area = boardArea(layers, profile);
    if (area) {
      const t = new CanvasTarget(cx, map);
      t.begin();
      for (const loop of area) {
        t.moveTo(loop[0], loop[1]);
        for (let i = 2; i < loop.length; i += 2) t.lineTo(loop[i], loop[i + 1]);
        t.closePath();
      }
      cx.fill('evenodd');
      cx.setTransform(1, 0, 0, 1, 0, 0);
    }
    cx.globalCompositeOperation = 'destination-out';
    cx.drawImage(mask, 0, 0);
    cx.globalCompositeOperation = 'source-over';
    return c;
  }

  renderRealistic(ctx, layers, settings, map, w, h) {
    const side = settings.side;
    const vis = (l) => l.image;
    const pick = (type) => layers.find((l) => vis(l) && l.role.type === type && l.role.side === side);
    const copper = pick('copper');
    const mask = pick('soldermask');
    const legend = pick('legend');
    // paste is drawn when its layer is passed in (the layer panel's Paste toggle)
    const paste = pick('paste');
    const profile = layers.find((l) => vis(l) && l.role.type === 'profile');
    const drills = layers.filter((l) => vis(l) && l.role.type === 'drill');
    const st = settings.stackup || {};
    const maskMat = lookupMaterial('mask', st.mask?.[side] ?? st.mask).value || SOLDER_MASK.green;
    const silkMat = lookupMaterial('silk', st.silk?.[side] ?? st.silk).value || SILKSCREEN.white;
    const finish = lookupMaterial('finish', st.finish).value;
    const substrate = lookupMaterial('substrate', st.substrate).value || SUBSTRATE.fr4;

    // board area
    const board = this.workCanvas(1, w, h);
    const bctx = board.getContext('2d');
    const area = boardArea(layers, profile);
    if (area) {
      const t = new CanvasTarget(bctx, map);
      t.begin();
      for (const loop of area) {
        t.moveTo(loop[0], loop[1]);
        for (let i = 2; i < loop.length; i += 2) t.lineTo(loop[i], loop[i + 1]);
        t.closePath();
      }
      bctx.fill('evenodd');
    }
    bctx.setTransform(1, 0, 0, 1, 0, 0);

    // Solo: the soloed layers as slices of the board (inner layers included)
    const soloed = soloedLayers(layers, settings);
    if (soloed.length) {
      return this.renderSlices(ctx, debugOrder(soloed, side), {
        layers,
        profile,
        drills,
        board,
        substrate,
        st,
        map,
        w,
        h,
      });
    }

    // compose on an out canvas: substrate, copper, mask, exposed finish, silk, holes
    const out = this.workCanvas(2, w, h);
    const o = out.getContext('2d');
    tintInto(o, board, rgba(substrate, 1), 1, this.workCanvas(3, w, h));
    let openings = null;
    if (mask) openings = this.mask(mask, map, w, h);
    const maskIsOpenings = !mask || (mask.role.polarity || 'negative') !== 'positive';
    if (copper) {
      const cm = this.mask(copper, map, w, h);
      tintInto(o, cm, rgba(COPPER, 1), copper.opacity ?? 1, this.workCanvas(3, w, h));
    }
    if (mask) {
      // mask material = board area minus openings
      const mm = this.workCanvas(4, w, h);
      const mctx = mm.getContext('2d');
      if (maskIsOpenings) {
        mctx.drawImage(board, 0, 0);
        mctx.globalCompositeOperation = 'destination-out';
        mctx.drawImage(openings, 0, 0);
      } else mctx.drawImage(openings, 0, 0);
      mctx.globalCompositeOperation = 'source-in';
      mctx.fillStyle = rgba(maskMat, 1);
      mctx.fillRect(0, 0, w, h);
      o.globalAlpha = (maskMat.opacity ?? 0.85) * (mask.opacity ?? 1);
      o.drawImage(mm, 0, 0);
      o.globalAlpha = 1;
    }
    if (copper) {
      // exposed copper gets the surface finish, with a light sheen
      const ex = this.workCanvas(4, w, h);
      const ectx = ex.getContext('2d');
      ectx.drawImage(this.mask(copper, map, w, h), 0, 0);
      if (mask) {
        ectx.globalCompositeOperation = maskIsOpenings ? 'destination-in' : 'destination-out';
        ectx.drawImage(openings, 0, 0);
      }
      ectx.globalCompositeOperation = 'source-in';
      ectx.fillStyle = rgba(finish, 1);
      ectx.fillRect(0, 0, w, h);
      ectx.globalCompositeOperation = 'source-atop';
      const g = ectx.createLinearGradient(0, 0, w, h);
      const sh = finish.sheen ?? 0.3;
      g.addColorStop(0, `rgba(255,255,255,${sh})`);
      g.addColorStop(0.45, 'rgba(255,255,255,0)');
      g.addColorStop(1, `rgba(0,0,0,${sh * 0.5})`);
      ectx.fillStyle = g;
      ectx.fillRect(0, 0, w, h);
      o.globalAlpha = copper.opacity ?? 1;
      o.drawImage(ex, 0, 0);
      o.globalAlpha = 1;
    }
    if (legend) {
      const lc = this.workCanvas(4, w, h);
      const lctx = lc.getContext('2d');
      lctx.drawImage(this.mask(legend, map, w, h), 0, 0);
      if (openings && maskIsOpenings) {
        // fabs clip silkscreen off exposed pads
        lctx.globalCompositeOperation = 'destination-out';
        lctx.drawImage(openings, 0, 0);
      }
      lctx.globalCompositeOperation = 'source-in';
      lctx.fillStyle = rgba(silkMat, 1);
      lctx.fillRect(0, 0, w, h);
      o.globalAlpha = legend.opacity ?? 1;
      o.drawImage(lc, 0, 0);
      o.globalAlpha = 1;
    }
    if (paste)
      tintInto(
        o,
        this.mask(paste, map, w, h),
        rgba(MISC.paste, 1),
        (paste.opacity ?? 1) * MISC.paste.opacity,
        this.workCanvas(3, w, h),
      );
    for (const d of drills) {
      if (d.role.plated !== false) {
        // plated barrel: a thin ring of finish around the hole
        tintInto(o, this.mask(d, map, w, h, { inflateMm: 0.04 }), rgba(finish, 1), 1, this.workCanvas(3, w, h));
      }
      o.globalCompositeOperation = 'destination-out';
      o.drawImage(this.mask(d, map, w, h), 0, 0);
      o.globalCompositeOperation = 'source-over';
    }
    // clip to the board
    o.globalCompositeOperation = 'destination-in';
    o.drawImage(board, 0, 0);
    o.globalCompositeOperation = 'source-over';
    ctx.drawImage(out, 0, 0);
  }
}

function tint(canvas, mask, colour) {
  const c = canvas.getContext('2d');
  c.globalCompositeOperation = 'source-over';
  c.drawImage(mask, 0, 0);
  c.globalCompositeOperation = 'source-in';
  c.fillStyle = colour;
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.globalCompositeOperation = 'source-over';
  return canvas;
}

function tintInto(ctx, mask, colour, alpha, scratch) {
  tint(scratch, mask, colour);
  ctx.globalAlpha = alpha;
  ctx.drawImage(scratch, 0, 0);
  ctx.globalAlpha = 1;
}

/** Layers in painting order for the debug view (far side first). */
export function debugOrder(layers, side) {
  const rank = (l) => {
    const r = l.role;
    const far = side === 'top' ? 'bottom' : 'top';
    const depth = { legend: 3, paste: 2, soldermask: 1, copper: 0 }[r.type] ?? 0;
    if (r.side === far) return 0 + (3 - depth) / 10;
    if (r.side === 'inner') return 1 + (side === 'top' ? -(r.index || 0) : r.index || 0) / 1000;
    if (r.side === side) return 2 + depth / 10;
    if (r.type === 'profile') return 3;
    if (r.type === 'drill') return 4;
    return 5;
  };
  return layers.slice().sort((a, b) => rank(a) - rank(b));
}

/** Board area as loops (even-odd): profile outline, or the bounding box of all layers. */
export function boardArea(layers, profile) {
  if (profile) {
    profile.outline ??= null;
    if (profile.outline?.loops?.length) return profile.outline.loops;
  }
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const l of layers) {
    const bb = l.image?.bounds;
    if (!bb || l.role.type === 'other') continue;
    b[0] = Math.min(b[0], bb[0]);
    b[1] = Math.min(b[1], bb[1]);
    b[2] = Math.max(b[2], bb[2]);
    b[3] = Math.max(b[3], bb[3]);
  }
  if (!(b[0] <= b[2])) return null;
  return [[b[0], b[1], b[2], b[1], b[2], b[3], b[0], b[3]]];
}

/** The soloed layers (empty when nothing is soloed). */
export function soloedLayers(layers, settings) {
  const solo = Array.isArray(settings.solo) ? settings.solo : [];
  return solo.length ? layers.filter((l) => l.image && solo.includes(l.id)) : [];
}

/** Layers drawn in an analysis view: the soloed ones, or every layer when none is soloed. */
export function analysisLayers(layers, settings) {
  const soloed = soloedLayers(layers, settings);
  return soloed.length ? soloed : layers.filter((l) => l.image);
}

export { roleColour };

/** Light sheen over metal (a gradient over what is already drawn). */
function sheen(canvas, strength) {
  const c = canvas.getContext('2d');
  c.globalCompositeOperation = 'source-atop';
  const g = c.createLinearGradient(0, 0, canvas.width, canvas.height);
  g.addColorStop(0, `rgba(255,255,255,${strength})`);
  g.addColorStop(0.45, 'rgba(255,255,255,0)');
  g.addColorStop(1, `rgba(0,0,0,${strength * 0.5})`);
  c.fillStyle = g;
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.globalCompositeOperation = 'source-over';
}
