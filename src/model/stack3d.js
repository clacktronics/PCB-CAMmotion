// Physical stackup for the 3D view: where each layer sits in Z, how the exploded view spreads
// the layers apart, and the drill holes as barrels. Pure data + functions (no DOM, no three.js).
// All lengths in mm; z = 0 is the middle of the board (copper to copper), +z towards the top.

/** Typical thicknesses (mm) when the .gbrjob does not give them. */
export const DEFAULT_THICKNESS_MM = {
  board: 1.6,
  copper: 0.035,
  soldermask: 0.02,
  legend: 0.015,
  paste: 0.1,
  other: 0.01,
};

/** Order of the layers outside the outer copper, from the copper outwards. */
const OUTER = ['soldermask', 'legend', 'paste'];

/**
 * @typedef {{id:string, layerId:string|null, type:string, side:'top'|'bottom'|'inner',
 *   z0Mm:number, z1Mm:number, level:number}} StackItem
 * level: position counted from the middle of the stack (negative below); the exploded view
 * moves each item by level × gap.
 */

/**
 * Lay the board's layers out in Z.
 * Copper planes are top, the inner layers (by index) and bottom, whether or not a file exists
 * for each outer one; dielectric fills the space between neighbouring copper planes so the
 * copper-to-copper height is the board thickness. Mask, silkscreen and paste sit outside.
 * @param {{id:string, role:{type:string, side:string, index?:number}, image?:object}[]} layers
 * @param {{boardThicknessMm?:number, layers?:{type:string, thicknessMm:number|null}[]}} [stackup]
 * @param {{showPaste?:boolean}} [opts]
 * @returns {{items: StackItem[], boardThicknessMm:number}}
 */
export function buildStack3d(layers, stackup = {}, opts = {}) {
  const withImage = layers.filter((l) => l.image);
  const of = (type, side) => withImage.filter((l) => l.role.type === type && l.role.side === side);
  const inner = withImage
    .filter((l) => l.role.type === 'copper' && l.role.side === 'inner')
    .sort((a, b) => (a.role.index || 0) - (b.role.index || 0));

  // copper planes, top first; each holds the files drawn on it (none for a missing outer layer)
  const planes = [
    { side: 'top', files: of('copper', 'top') },
    ...inner.map((l) => ({ side: 'inner', files: [l] })),
    { side: 'bottom', files: of('copper', 'bottom') },
  ];

  const job = jobThicknesses(stackup?.layers, planes.length);
  const boardMm = positive(stackup?.boardThicknessMm) ?? DEFAULT_THICKNESS_MM.board;
  const copperMm = planes.map((_, i) => job?.copper[i] ?? DEFAULT_THICKNESS_MM.copper);
  let dielectricMm = job?.dielectric;
  if (!dielectricMm) {
    // equal cores between the copper planes, filling the board thickness
    const left = Math.max(boardMm - copperMm.reduce((a, b) => a + b, 0), boardMm * 0.2);
    dielectricMm = Array.from({ length: planes.length - 1 }, () => left / (planes.length - 1));
  }

  // build top to bottom, then centre
  const items = [];
  let z = 0;
  const push = (id, layerId, type, side, t) => {
    items.push({ id, layerId, type, side, z0Mm: z - t, z1Mm: z, level: 0 });
    z -= t;
  };
  outerItems(of, 'top', job?.outer.top, opts)
    .reverse()
    .forEach((o) => push(o.id, o.id, o.type, 'top', o.t));
  const boardTop = z;
  for (const [i, p] of planes.entries()) {
    const t = copperMm[i];
    if (p.files.length) for (const f of p.files) items.push(copperItem(f, p.side, z, t));
    z -= t;
    if (i < planes.length - 1) push(`dielectric-${i + 1}`, null, 'dielectric', 'inner', dielectricMm[i]);
  }
  const boardBottom = z;
  for (const o of outerItems(of, 'bottom', job?.outer.bottom, opts)) push(o.id, o.id, o.type, 'bottom', o.t);

  // centre the board itself (copper to copper) on z = 0
  const shift = -(boardTop + boardBottom) / 2;
  for (const it of items) {
    it.z0Mm += shift;
    it.z1Mm += shift;
  }
  assignLevels(items);
  return { items, boardThicknessMm: copperMm.reduce((a, b) => a + b, 0) + dielectricMm.reduce((a, b) => a + b, 0) };
}

function copperItem(layer, side, zTop, t) {
  return { id: layer.id, layerId: layer.id, type: 'copper', side, z0Mm: zTop - t, z1Mm: zTop, level: 0 };
}

/** Mask, silkscreen and paste on one side, from the copper outwards. */
function outerItems(of, side, jobOuter, opts) {
  const out = [];
  for (const type of OUTER) {
    if (type === 'paste' && !opts.showPaste) continue;
    const t = jobOuter?.[type] ?? DEFAULT_THICKNESS_MM[type];
    for (const l of of(type, side)) out.push({ id: l.id, type, t });
  }
  return out;
}

/**
 * Levels count outwards from the middle of the board's dielectric (so the core stays put and
 * the top and bottom sides move apart evenly): items that share a Z range (several files
 * with the same role) share a level, so they stay together when exploded.
 */
function assignLevels(items) {
  const slotOf = (i) => `${i.z0Mm.toFixed(6)}:${i.z1Mm.toFixed(6)}`;
  const slots = [...new Set(items.map(slotOf))]; // top-to-bottom order
  const cores = items.filter((i) => i.type === 'dielectric').map((i) => slots.indexOf(slotOf(i)));
  const mid = cores.length ? (Math.min(...cores) + Math.max(...cores)) / 2 : (slots.length - 1) / 2;
  for (const it of items) {
    const k = slots.indexOf(slotOf(it));
    it.level = mid - k;
  }
}

/**
 * Thicknesses from the .gbrjob MaterialStackup (top to bottom), when it matches the copper
 * layers found: copper per plane, dielectric between planes (summed when there are several
 * sheets), and mask / silkscreen per side. Returns null when it does not match.
 */
export function jobThicknesses(jobLayers, copperCount) {
  if (!Array.isArray(jobLayers) || !jobLayers.length) return null;
  const copper = [];
  const dielectric = [];
  const outer = { top: {}, bottom: {} };
  let between = null;
  for (const l of jobLayers) {
    const type = String(l.type || '');
    const t = positive(l.thicknessMm);
    if (type === 'Copper') {
      if (between !== null) dielectric.push(between);
      copper.push(t);
      between = 0;
    } else if (type === 'Dielectric') {
      if (between !== null && t) between += t;
    } else {
      const kind = type === 'SolderMask' ? 'soldermask' : type === 'Legend' ? 'legend' : null;
      if (kind && t) outer[copper.length ? 'bottom' : 'top'][kind] = t;
    }
  }
  if (copper.length !== copperCount || copper.some((t) => !t) || dielectric.some((t) => !(t > 0))) return null;
  return { copper, dielectric, outer };
}

/**
 * Z offset of each item in the exploded view.
 * @param {StackItem[]} items
 * @param {number} amount 0 (assembled) … 1 (fully exploded)
 * @param {number} gapMm extra space between neighbouring levels at amount = 1
 * @returns {Map<string, number>} item id -> dz (mm)
 */
export function explodeOffsets(items, amount, gapMm) {
  const a = Math.min(1, Math.max(0, Number(amount) || 0));
  return new Map(items.map((it) => [it.id, it.level * gapMm * a]));
}

/** Gap between levels at full explode, from the board's size (mm). */
export function explodeGapMm(widthMm, heightMm) {
  const size = Math.max(widthMm || 0, heightMm || 0);
  return Math.min(25, Math.max(1.5, size * 0.08));
}

/**
 * Round drill hits as holes: {x, y, diaMm, plated}. Slots and routed paths are left out
 * (they still cut the layer pictures). plated: from the drill layer's role (null = unknown,
 * drawn as plated, as most PCB drill files are).
 * @param {{role:{type:string, plated?:boolean|null}, image?:{objects:object[]}}[]} layers
 */
export function drillHoles(layers) {
  const holes = [];
  for (const l of layers) {
    if (l.role.type !== 'drill' || !l.image) continue;
    const plated = l.role.plated !== false;
    for (const o of l.image.objects) {
      if (o.k !== 'F' || !o.dark || o.ap?.kind !== 'C' || !(o.ap.dia > 0)) continue;
      holes.push({ x: o.x, y: o.y, diaMm: o.ap.dia, plated });
    }
  }
  return holes;
}

/**
 * Triangles for the board edge between z0 and z1: one quad per outline segment.
 * @param {number[][]} loops flat [x0, y0, x1, y1, ...] closed loops (mm)
 * @returns {{positions: Float32Array, normals: Float32Array}}
 */
export function edgeWalls(loops, z0Mm, z1Mm) {
  const pos = [];
  const nrm = [];
  for (const loop of loops) {
    const n = loop.length / 2;
    if (n < 2) continue;
    const ccw = signedArea(loop) >= 0;
    for (let i = 0; i < n; i++) {
      const ax = loop[2 * i];
      const ay = loop[2 * i + 1];
      const bx = loop[(2 * (i + 1)) % loop.length];
      const by = loop[(2 * (i + 1) + 1) % loop.length];
      const len = Math.hypot(bx - ax, by - ay);
      if (!(len > 0)) continue;
      // outward normal for a counter-clockwise loop is (dy, -dx); the material side is
      // unknown for nested loops, so the walls are drawn double-sided anyway
      const nx = ((ccw ? 1 : -1) * (by - ay)) / len;
      const ny = ((ccw ? 1 : -1) * -(bx - ax)) / len;
      pos.push(ax, ay, z0Mm, bx, by, z0Mm, bx, by, z1Mm, ax, ay, z0Mm, bx, by, z1Mm, ax, ay, z1Mm);
      for (let k = 0; k < 6; k++) nrm.push(nx, ny, 0);
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nrm) };
}

function signedArea(loop) {
  let a = 0;
  const n = loop.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += loop[2 * i] * loop[2 * j + 1] - loop[2 * j] * loop[2 * i + 1];
  }
  return a / 2;
}

function positive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Explode styles: sheets (the board comes apart by copper layer, each copper layer on its
 * own slab of substrate with the outer sheets keeping their mask and silkscreen) or layers
 * (every layer comes apart on its own, the substrate stays in the middle).
 */
export const EXPLODE_STYLES = ['sheets', 'layers'];

/**
 * Group the stack into sheets, one per copper plane, for the sheets explode style.
 * Dielectric in the top half of the board goes with the copper above it (copper on top of
 * its substrate), in the bottom half with the copper below it, so every copper layer faces
 * outwards and can be seen; the core at the middle is split in two (with an odd number of
 * copper layers, the core under the middle copper).
 * Mask, silkscreen and paste go with the outer copper of their side.
 * @param {StackItem[]} items from buildStack3d
 * @returns {{count:number, levels:number[], sheetOf:Map<string, number>,
 *   pieces:{id:string, itemId:string, sheet:number, z0Mm:number, z1Mm:number}[]}}
 *   levels: per sheet, counted from the middle (top positive); sheetOf: non-dielectric item
 *   id -> sheet; pieces: the dielectric, cut and assigned to sheets
 */
export function buildSheets(items) {
  const cores = items.filter((i) => i.type === 'dielectric').sort((a, b) => b.z1Mm - a.z1Mm);
  const count = cores.length + 1;
  const mid = (count - 1) / 2;
  const centre = (i) => (i.z0Mm + i.z1Mm) / 2;
  const sheetOf = new Map();
  for (const it of items) {
    if (it.type === 'dielectric') continue;
    // copper plane index = number of cores above the item
    sheetOf.set(it.id, cores.filter((c) => centre(c) > centre(it)).length);
  }
  const pieces = [];
  // the core that is cut in two: the middle one (even plane count), or the one under the
  // middle copper (odd count) so that copper still sits on substrate
  const cut = count % 2 ? mid + 0.5 : mid;
  cores.forEach((c, i) => {
    const at = i + 0.5; // the core lies between plane i and plane i + 1
    if (at < cut) pieces.push({ id: c.id, itemId: c.id, sheet: i, z0Mm: c.z0Mm, z1Mm: c.z1Mm });
    else if (at > cut) pieces.push({ id: c.id, itemId: c.id, sheet: i + 1, z0Mm: c.z0Mm, z1Mm: c.z1Mm });
    else {
      const zm = centre(c);
      pieces.push({ id: `${c.id}:upper`, itemId: c.id, sheet: i, z0Mm: zm, z1Mm: c.z1Mm });
      pieces.push({ id: `${c.id}:lower`, itemId: c.id, sheet: i + 1, z0Mm: c.z0Mm, z1Mm: zm });
    }
  });
  const levels = Array.from({ length: count }, (_, k) => mid - k);
  return { count, levels, sheetOf, pieces };
}

/**
 * Z offset of each sheet in the sheets explode style.
 * @param {number} amount 0 (assembled) … 1 (fully exploded)
 * @param {number} gapMm extra space between neighbouring sheets at amount = 1
 */
export function sheetOffsets(sheets, amount, gapMm) {
  const a = Math.min(1, Math.max(0, Number(amount) || 0));
  return sheets.levels.map((level) => level * gapMm * a + 0); // + 0: no -0
}

/**
 * Height range of each sheet (unexploded): its dielectric and copper, for the hole barrels.
 * @returns {{plated:[number, number]|null, bare:[number, number]|null}[]}
 */
export function sheetSpans(items, sheets) {
  return sheets.levels.map((_, k) => {
    const ps = sheets.pieces.filter((p) => p.sheet === k);
    const cu = items.filter((i) => i.type === 'copper' && sheets.sheetOf.get(i.id) === k);
    const range = (list) =>
      list.length ? [Math.min(...list.map((i) => i.z0Mm)), Math.max(...list.map((i) => i.z1Mm))] : null;
    return { plated: range([...ps, ...cu]), bare: range(ps) };
  });
}
