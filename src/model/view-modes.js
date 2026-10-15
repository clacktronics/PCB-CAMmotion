// View modes and per-layer colours for the analysis views (no DOM: used by the renderer and
// tested in Node). Colours come from the materials table (model/materials.js).
//
//   realistic  the board in its real materials
//   debug      one fixed colour per layer function (top copper red, bottom copper blue, …)
//   classic    gerbv-style: a palette colour per file, alpha-blended on black
//   xor        layer colours combined with bitwise XOR (as in classic viewers): overlaps show
//              as a mixed colour; two layers given the same colour cancel where identical, so
//              any difference between them (misregistration, revisions) stands out
//   outline    wireframe: every object's outline, clear-polarity objects dashed

import { CLASSIC, DEBUG, MISC, CLASSIC_BACKGROUND } from './materials.js';

export const VIEW_MODES = ['realistic', 'debug', 'classic', 'xor', 'outline'];

export const VIEW_MODE_LABELS = {
  realistic: 'Realistic',
  debug: 'Layers',
  classic: 'Classic',
  xor: 'XOR',
  outline: 'Outline',
};

/** Parse '#rrggbb' to [r, g, b], or null. */
export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function toHex(rgb) {
  return '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
}

/** Fixed colour for a layer function (the 'debug' view). */
export function roleColour(role) {
  if (role.type === 'profile') return DEBUG.profile.rgb;
  if (role.type === 'drill') return DEBUG.drill.rgb;
  return (DEBUG[`${role.type}_${role.side}`] || DEBUG.other).rgb;
}

/**
 * Colour of a layer in an analysis view: the user's colour if set, else the classic palette
 * (classic, xor) by list position, else the colour of its function.
 * @param {{role:object, colour?:string|null}} layer
 * @param {number} index position of the layer in the project's layer list
 */
export function layerColour(layer, mode, index) {
  const own = parseHex(layer.colour);
  if (own) return own;
  if (mode === 'classic' || mode === 'xor') return CLASSIC[index % CLASSIC.length].rgb;
  return roleColour(layer.role);
}

/** Background colour for a mode and the dark/light preference. */
export function backgroundColour(mode, background) {
  if (background === 'light') return MISC.backgroundLight.rgb;
  if (mode === 'classic' || mode === 'xor') return CLASSIC_BACKGROUND.rgb;
  return MISC.background.rgb;
}

/**
 * XOR one layer into an RGBA pixel buffer: wherever the layer covers a pixel (alpha ≥ 50 %),
 * the pixel's RGB is XORed with the layer colour. Two identical layers cancel exactly.
 * @param {Uint8ClampedArray} dst RGBA accumulator
 * @param {Uint8ClampedArray} coverage RGBA layer mask (alpha channel used)
 * @param {number[]} rgb
 */
export function xorLayer(dst, coverage, rgb) {
  const [r, g, b] = rgb;
  for (let i = 0; i < dst.length; i += 4) {
    if (coverage[i + 3] >= 128) {
      dst[i] ^= r;
      dst[i + 1] ^= g;
      dst[i + 2] ^= b;
    }
  }
  return dst;
}
