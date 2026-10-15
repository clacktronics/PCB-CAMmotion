// Material colour table: the ONE place colours live (render code must not hard-code colours).
// Values are sRGB [r, g, b] 0–255 plus an opacity where the material is translucent.
// Names follow KiCad's .gbrjob vocabulary ("Green", "Matte Black", "ENIG", "FR4", ...).

export const SOLDER_MASK = {
  green: { rgb: [26, 102, 46], opacity: 0.78 },
  'matte green': { rgb: [34, 92, 48], opacity: 0.9 },
  'light green': { rgb: [72, 150, 74], opacity: 0.82 },
  'dark green': { rgb: [12, 66, 30], opacity: 0.9 },
  red: { rgb: [168, 24, 26], opacity: 0.8 },
  'matte red': { rgb: [140, 30, 30], opacity: 0.9 },
  blue: { rgb: [20, 54, 140], opacity: 0.8 },
  'matte blue': { rgb: [24, 50, 112], opacity: 0.9 },
  black: { rgb: [18, 18, 20], opacity: 0.94 },
  'matte black': { rgb: [28, 28, 30], opacity: 0.96 },
  white: { rgb: [232, 232, 226], opacity: 0.93 },
  'matte white': { rgb: [226, 226, 220], opacity: 0.95 },
  yellow: { rgb: [214, 182, 26], opacity: 0.86 },
  purple: { rgb: [78, 32, 116], opacity: 0.88 },
  'matte purple': { rgb: [72, 36, 100], opacity: 0.9 },
};

export const SILKSCREEN = {
  white: { rgb: [244, 244, 240], opacity: 1 },
  black: { rgb: [20, 20, 20], opacity: 1 },
  yellow: { rgb: [236, 206, 40], opacity: 1 },
  red: { rgb: [200, 30, 30], opacity: 1 },
  blue: { rgb: [30, 70, 180], opacity: 1 },
  green: { rgb: [40, 140, 60], opacity: 1 },
};

/** Exposed copper by surface finish. sheen: highlight strength for the 2D light effect. */
export const FINISH = {
  enig: { rgb: [214, 176, 90], sheen: 0.35, label: 'ENIG (gold)' },
  'hard gold': { rgb: [222, 184, 96], sheen: 0.4, label: 'Hard gold' },
  hasl: { rgb: [196, 198, 200], sheen: 0.35, label: 'HASL (tin/lead)' },
  'hasl lead-free': { rgb: [200, 202, 204], sheen: 0.35, label: 'HASL lead-free' },
  'lead-free hasl': { rgb: [200, 202, 204], sheen: 0.35, label: 'HASL lead-free' },
  'immersion silver': { rgb: [212, 214, 218], sheen: 0.4, label: 'Immersion silver' },
  'immersion tin': { rgb: [190, 192, 196], sheen: 0.3, label: 'Immersion tin' },
  'immersion gold': { rgb: [214, 176, 90], sheen: 0.35, label: 'Immersion gold' },
  osp: { rgb: [196, 120, 74], sheen: 0.25, label: 'OSP (bare copper)' },
  none: { rgb: [186, 110, 64], sheen: 0.2, label: 'Bare copper' },
  'bare copper': { rgb: [186, 110, 64], sheen: 0.2, label: 'Bare copper' },
  'oxidised copper': { rgb: [150, 92, 62], sheen: 0.1, label: 'Oxidised copper' },
};

/** Bare copper (under the mask, or on a home-milled board). */
export const COPPER = { rgb: [184, 115, 51] };

export const SUBSTRATE = {
  fr4: { rgb: [196, 178, 120], opacity: 0.92, label: 'FR4' },
  'fr4-tg': { rgb: [196, 178, 120], opacity: 0.92, label: 'FR4 high-Tg' },
  fr1: { rgb: [168, 120, 70], opacity: 1, label: 'FR1 (paper phenolic)' },
  fr2: { rgb: [168, 120, 70], opacity: 1, label: 'FR2 (paper phenolic)' },
  cem1: { rgb: [210, 196, 160], opacity: 1, label: 'CEM-1' },
  cem3: { rgb: [224, 220, 204], opacity: 1, label: 'CEM-3' },
  polyimide: { rgb: [204, 120, 20], opacity: 0.8, label: 'Polyimide' },
  aluminium: { rgb: [190, 192, 196], opacity: 1, label: 'Aluminium' },
  aluminum: { rgb: [190, 192, 196], opacity: 1, label: 'Aluminium' },
  ptfe: { rgb: [236, 232, 220], opacity: 1, label: 'PTFE' },
  rogers: { rgb: [226, 214, 190], opacity: 1, label: 'Rogers' },
  ceramic: { rgb: [236, 236, 230], opacity: 1, label: 'Ceramic' },
};

/**
 * How each surface reflects light in the 3D view (physically based shading): metalness 0
 * (dielectric) … 1 (metal), roughness 0 (mirror) … 1 (matte), envMapIntensity how strongly
 * it reflects the surroundings. Copper, finishes and plated
 * barrels are metal and mirror the surroundings; mask is glossy lacquer; silkscreen is ink.
 */
export const SURFACE = {
  copper: { metalness: 1, roughness: 0.14, envMapIntensity: 1.8 },
  soldermask: { metalness: 0, roughness: 0.3, envMapIntensity: 0.2 },
  legend: { metalness: 0, roughness: 0.85, envMapIntensity: 0.3 },
  paste: { metalness: 0.8, roughness: 0.55, envMapIntensity: 1 },
  substrate: { metalness: 0, roughness: 0.7, envMapIntensity: 0.35 },
  holeWall: { metalness: 0, roughness: 0.9, envMapIntensity: 0.3 },
  other: { metalness: 0, roughness: 0.7, envMapIntensity: 0.35 },
};

/** Paste (shown only when enabled), drill hole wall, board edge and viewer background. */
export const MISC = {
  paste: { rgb: [170, 170, 176], opacity: 0.85 },
  holeWall: { rgb: [120, 92, 60] },
  background: { rgb: [30, 32, 36] },
  backgroundLight: { rgb: [236, 238, 242] },
  selection: { rgb: [0, 200, 255] },
  hover: { rgb: [255, 255, 255] },
  highlight: { rgb: [255, 0, 200] }, // analyser: every use of an aperture
  playhead: { rgb: [255, 140, 0] }, // step-through playback: the last command's objects
  thumbnail: { rgb: [214, 160, 92] }, // analyser shape gallery
};

/** Debug colours per layer role (the "debug colours" toggle). */
export const DEBUG = {
  copper_top: { rgb: [220, 60, 50] },
  copper_bottom: { rgb: [50, 110, 230] },
  copper_inner: { rgb: [230, 170, 40] },
  soldermask_top: { rgb: [150, 60, 200] },
  soldermask_bottom: { rgb: [60, 200, 160] },
  legend_top: { rgb: [240, 240, 240] },
  legend_bottom: { rgb: [200, 200, 120] },
  paste_top: { rgb: [160, 160, 160] },
  paste_bottom: { rgb: [120, 120, 120] },
  profile: { rgb: [255, 230, 0] },
  drill: { rgb: [240, 240, 240] },
  other: { rgb: [120, 200, 120] },
};

/**
 * Classic Gerber-viewer palette (gerbv's default layer colours), assigned to layers in list
 * order in the Classic and XOR views.
 */
export const CLASSIC = [
  { rgb: [115, 115, 222] },
  { rgb: [255, 127, 115] },
  { rgb: [193, 0, 224] },
  { rgb: [117, 242, 103] },
  { rgb: [0, 195, 195] },
  { rgb: [213, 253, 51] },
  { rgb: [209, 27, 104] },
  { rgb: [255, 197, 51] },
  { rgb: [186, 186, 186] },
  { rgb: [211, 211, 255] },
  { rgb: [253, 210, 206] },
  { rgb: [236, 194, 242] },
  { rgb: [208, 249, 204] },
  { rgb: [183, 255, 255] },
  { rgb: [241, 255, 183] },
  { rgb: [255, 202, 225] },
  { rgb: [253, 219, 142] },
  { rgb: [226, 226, 226] },
];

/** Background of the Classic and XOR views (classic viewers draw on black). */
export const CLASSIC_BACKGROUND = { rgb: [0, 0, 0] };

/** Default stackup used when no .gbrjob is present. */
export const DEFAULT_STACKUP = {
  mask: 'Green',
  silk: 'White',
  finish: 'HASL',
  substrate: 'FR4',
  boardThicknessMm: 1.6,
};

function key(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, ' ');
}

function hexColour(name) {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(name || '').trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return { rgb: [(v >> 16) & 255, (v >> 8) & 255, v & 255], opacity: m[2] ? parseInt(m[2], 16) / 255 : 0.88 };
}

/**
 * Look a material up by name. Returns { value, known }. Unknown names fall back to the default
 * (known = false) so callers can warn.
 * @param {'mask'|'silk'|'finish'|'substrate'} kind
 */
export function lookupMaterial(kind, name) {
  const table = { mask: SOLDER_MASK, silk: SILKSCREEN, finish: FINISH, substrate: SUBSTRATE }[kind];
  const fallback = { mask: 'green', silk: 'white', finish: 'hasl', substrate: 'fr4' }[kind];
  const k = key(name);
  if (table[k]) return { value: table[k], known: true };
  if (kind === 'substrate' && /^fr-?4/.test(k)) return { value: table.fr4, known: true };
  if (kind === 'substrate' && /^(rogers|ro\d)/.test(k)) return { value: table.rogers, known: true };
  if (kind === 'finish' && /enig|gold/.test(k)) return { value: table.enig, known: true };
  if (kind === 'finish' && /hasl|hal\b/.test(k)) return { value: table.hasl, known: true };
  if ((kind === 'mask' || kind === 'silk') && hexColour(name)) return { value: hexColour(name), known: true };
  return { value: table[fallback], known: false };
}

export function rgba(c, alpha = c.opacity ?? 1) {
  return `rgba(${c.rgb[0]},${c.rgb[1]},${c.rgb[2]},${alpha})`;
}
