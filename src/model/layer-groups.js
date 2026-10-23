// Layer groups for the "show" toggles in the layer panel: switch every silkscreen, solder
// mask, paste, copper or drill layer on or off at once, in 2D and 3D. Pure data + functions.

/** Toggle groups in panel order; `types` are layer role types (model/layers.js). */
export const LAYER_GROUPS = [
  { key: 'legend', label: 'Silkscreen', types: ['legend'] },
  { key: 'soldermask', label: 'Mask', types: ['soldermask'] },
  { key: 'paste', label: 'Paste', types: ['paste'] },
  { key: 'copper', label: 'Copper', types: ['copper'] },
  { key: 'drill', label: 'Holes', types: ['drill'] },
];

/** Paste starts hidden: over the pads it hides the finish, and it is only for stencils. */
export const DEFAULT_SHOW = { legend: true, soldermask: true, paste: false, copper: true, drill: true };

/** The group a layer belongs to, or null (board outline and other layers are always shown). */
export function groupOf(role) {
  return LAYER_GROUPS.find((g) => g.types.includes(role?.type))?.key ?? null;
}

/**
 * Clean up stored toggles: booleans only, defaults for missing groups. `showPaste` is the
 * single paste toggle of earlier versions of the app (used when `show.paste` is not set).
 */
export function normaliseShow(show, showPaste) {
  const out = { ...DEFAULT_SHOW };
  if (typeof showPaste === 'boolean') out.paste = showPaste;
  if (show && typeof show === 'object')
    for (const k of Object.keys(DEFAULT_SHOW)) if (typeof show[k] === 'boolean') out[k] = show[k];
  return out;
}

/** The layers to draw: those whose group is switched on (and every layer not in a group). */
export function shownLayers(layers, show) {
  return layers.filter((l) => {
    const g = groupOf(l.role);
    return !g || show?.[g] !== false;
  });
}

/**
 * The copper layers for the layer strip beside the board, top-down: T, the inner layers
 * numbered 1, 2, … in stack order, then B. `layers` are in display order (layerSortKey).
 * @returns {{id: string, side: string, label: string, title: string}[]}
 */
export function copperSheets(layers) {
  const copper = layers.filter((l) => l.role?.type === 'copper');
  const inner = copper.filter((l) => l.role.side === 'inner').sort((a, b) => (a.role.index || 0) - (b.role.index || 0));
  const sheet = (l, label, what) => ({ id: l.id, side: l.role.side, label, title: `${what}: ${l.name}` });
  return [
    ...copper.filter((l) => l.role.side === 'top').map((l) => sheet(l, 'T', 'Top copper')),
    ...inner.map((l, i) => sheet(l, String(i + 1), `Inner copper ${i + 1}`)),
    ...copper.filter((l) => l.role.side === 'bottom').map((l) => sheet(l, 'B', 'Bottom copper')),
  ];
}
