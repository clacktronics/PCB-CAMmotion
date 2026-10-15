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
