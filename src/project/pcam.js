// .pcam project file: a ZIP container (vendored fflate).
//
//   project.json         manifest: schema version, app version, dates, units, source list
//   sources/<name>       original files, byte-for-byte untouched
//   settings/layers.json per-layer settings (visibility, opacity, role overrides)
//   settings/view.json   view state (side, mode, zoom/pan)
//   stackup.json         stackup and materials (from .gbrjob, defaults or user edits)
// Unknown fields in JSON files and unknown ZIP entries are kept and written back unchanged.

import { zipSync, unzipSync, strToU8, strFromU8 } from '../../vendor/fflate/fflate.js';
import { SCHEMA_VERSION, createProject, defaultLayerSettings } from './project.js';

export class PcamError extends Error {}

const KNOWN = new Set(['project.json', 'settings/layers.json', 'settings/view.json', 'stackup.json']);

/**
 * Migrations from older schema versions: MIGRATIONS[n] upgrades a version-n manifest object
 * (with its parsed side files) to version n+1. Never reject old files; migrate them forward.
 */
export const MIGRATIONS = {};

/**
 * @param {object} project
 * @param {Map<string, Uint8Array>} sources
 * @returns {Uint8Array}
 */
export function savePcam(project, sources) {
  const { layers, view, stackup, _extra, ...manifest } = project;
  const mtime = new Date(project.modified || Date.now());
  const files = {};
  const json = (o) => [strToU8(JSON.stringify(o, null, 2) + '\n'), { level: 6, mtime }];
  files['project.json'] = json({ ...manifest, schemaVersion: SCHEMA_VERSION });
  files['settings/layers.json'] = json(layers);
  files['settings/view.json'] = json(view);
  files['stackup.json'] = json(stackup);
  for (const s of project.sources) {
    const bytes = sources.get(s.id);
    if (!bytes) throw new PcamError(`Source ${s.name} has no data`);
    files[s.path] = [bytes, { level: 6, mtime }];
  }
  for (const [path, bytes] of Object.entries(_extra || {})) {
    if (!(path in files)) files[path] = [bytes, { level: 6, mtime }];
  }
  return zipSync(files);
}

/**
 * @param {Uint8Array} bytes
 * @returns {{project: object, sources: Map<string, Uint8Array>, migratedFrom: number|null}}
 */
export function loadPcam(bytes) {
  let entries;
  try {
    entries = unzipSync(bytes);
  } catch (e) {
    throw new PcamError(`Not a valid .pcam file (ZIP could not be read: ${e.message})`);
  }
  const read = (path) => {
    if (!entries[path]) return undefined;
    try {
      return JSON.parse(strFromU8(entries[path]));
    } catch (e) {
      throw new PcamError(`${path} in the project is not valid JSON: ${e.message}`);
    }
  };
  const manifest = read('project.json');
  if (!manifest || typeof manifest !== 'object') throw new PcamError('Not a .pcam project: project.json is missing');
  let version = Number(manifest.schemaVersion);
  if (!Number.isInteger(version) || version < 0) throw new PcamError('project.json has no valid schemaVersion');
  if (version > SCHEMA_VERSION) {
    throw new PcamError(
      `This project was saved by a newer version (schema ${version}); this app reads up to ${SCHEMA_VERSION}`,
    );
  }
  let doc = {
    manifest,
    layers: read('settings/layers.json'),
    view: read('settings/view.json'),
    stackup: read('stackup.json'),
  };
  const migratedFrom = version < SCHEMA_VERSION ? version : null;
  while (version < SCHEMA_VERSION) {
    const m = MIGRATIONS[version];
    if (!m) throw new PcamError(`No migration from schema ${version}`);
    doc = m(doc);
    version++;
  }
  const base = createProject(manifest.name);
  const project = {
    ...base,
    ...doc.manifest,
    schemaVersion: SCHEMA_VERSION,
    layers: doc.layers || {},
    view: { ...base.view, ...(doc.view || {}) },
    stackup: { ...base.stackup, ...(doc.stackup || {}) },
  };
  const sources = new Map();
  for (const s of project.sources || []) {
    const data = entries[s.path];
    if (!data) throw new PcamError(`Project source ${s.path} is missing from the file`);
    sources.set(s.id, data);
    project.layers[s.id] ??= defaultLayerSettings();
  }
  const used = new Set([...KNOWN, ...(project.sources || []).map((s) => s.path)]);
  const extra = {};
  for (const [path, data] of Object.entries(entries)) if (!used.has(path) && !path.endsWith('/')) extra[path] = data;
  if (Object.keys(extra).length) project._extra = extra;
  return { project, sources, migratedFrom };
}

/** True for names the app should open as a project (any case). */
export function isPcamName(name) {
  return /\.pcam$/i.test(name);
}
