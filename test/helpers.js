// Shared test helpers: fixture paths and loading.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGerber } from '../src/parse/gerber.js';
import { interpretGerber } from '../src/model/gerber-image.js';
import { parseExcellon } from '../src/parse/excellon.js';
import { interpretExcellon } from '../src/model/drill-image.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = join(ROOT, 'test/fixtures');
export const SYNTH = join(FIXTURES, 'synthetic');
export const SAMPLES = join(ROOT, 'samples');

export function bytes(path) {
  return new Uint8Array(readFileSync(path));
}

export function manifest() {
  return JSON.parse(readFileSync(join(SYNTH, 'manifest.json'), 'utf8'));
}

export function synthFixture(path) {
  return manifest().fixtures.find((f) => f.path === path);
}

/** Parse + interpret Gerber text or bytes. */
export function gerber(input, opts) {
  const parsed = parseGerber(input);
  const image = interpretGerber(parsed, opts);
  return { parsed, image, diag: parsed.diagnostics };
}

export function drill(input) {
  const parsed = parseExcellon(input);
  const image = interpretExcellon(parsed);
  return { parsed, image, diag: parsed.diagnostics };
}

export function synthGerber(path) {
  return gerber(bytes(join(SYNTH, path)));
}

export function synthDrill(path) {
  return drill(bytes(join(SYNTH, path)));
}

export function codes(diag, severity) {
  return diag.list.filter((d) => !severity || d.severity === severity).map((d) => d.code);
}

export function listDir(path) {
  return readdirSync(path);
}

/** Minimal Gerber wrapper: header (FS 4.6 mm) + body lines + M02. */
export function g(...body) {
  return ['%FSLAX46Y46*%', '%MOMM*%', ...body, 'M02*', ''].join('\n');
}

export function near(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}
