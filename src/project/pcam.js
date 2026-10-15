// .pcam save/load: a ZIP container holding the whole project.
// No DOM here — runs in Node (tests) and in the browser (app).

import { zipSync, unzipSync, strToU8, strFromU8 } from '../../vendor/fflate/fflate.js';
import { PCAM_FORMAT, SCHEMA_VERSION, migrate } from './schema.js';

export class PcamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PcamError';
  }
}

const MANIFEST = 'project.json';
const SETTINGS = 'settings/project.json';
const STACKUP = 'stackup.json';
const TOOLS = 'tools.json';
const SOURCES = 'sources/';
const KNOWN = new Set([MANIFEST, SETTINGS, STACKUP, TOOLS]);

/** True for names ending in .pcam, any case. */
export function isPcamFileName(name) {
  return /\.pcam$/i.test(name);
}

/** File name for downloading a project, e.g. "My board" → "My board.pcam". */
export function pcamFileName(project) {
  const base = String(project.manifest.name || 'untitled')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .trim();
  return `${base || 'untitled'}.pcam`;
}

const json = (value) => strToU8(JSON.stringify(value, null, 2) + '\n');

/**
 * A source file name as stored under sources/: no directories, no traversal.
 * The original name is kept as far as possible so the file can be re-exported as-is.
 */
export function safeSourceName(name) {
  const base = String(name).split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\x00-\x1f]/g, '_');
  if (!clean || clean === '.' || clean === '..')
    throw new PcamError(`Invalid source file name: ${JSON.stringify(name)}`);
  return clean;
}

/**
 * Serialise a project to .pcam bytes. Output is deterministic for a given project
 * (entry order is fixed and every entry's timestamp is the manifest's `modified`).
 * @returns {Uint8Array}
 */
export function saveProject(project) {
  const mtime = new Date(project.manifest.modified);
  const entries = {};
  const put = (path, data, level = 6) => {
    if (path in entries) throw new PcamError(`Duplicate entry in project: ${path}`);
    entries[path] = [data, { level, mtime }];
  };
  put(MANIFEST, json({ ...project.manifest, schemaVersion: SCHEMA_VERSION, format: PCAM_FORMAT }));
  put(SETTINGS, json(project.settings ?? {}));
  if (project.stackup != null) put(STACKUP, json(project.stackup));
  put(TOOLS, json(project.tools ?? {}));
  for (const { name, bytes } of project.sources ?? []) put(SOURCES + safeSourceName(name), bytes);
  for (const [path, bytes] of Object.entries(project.extra ?? {})) put(path, bytes);
  return zipSync(entries);
}

function parseJson(entries, path, required) {
  const bytes = entries[path];
  if (!bytes) {
    if (required) throw new PcamError(`Not a valid .pcam project: ${path} is missing`);
    return undefined;
  }
  try {
    return JSON.parse(strFromU8(bytes));
  } catch (e) {
    throw new PcamError(`Not a valid .pcam project: ${path} is not valid JSON (${e.message})`);
  }
}

/**
 * Read .pcam bytes into a project, migrating older schema versions forward.
 * @param {Uint8Array} bytes
 */
export function loadProject(bytes) {
  let entries;
  try {
    entries = unzipSync(bytes);
  } catch (e) {
    throw new PcamError(`Not a valid .pcam project: not a ZIP file (${e.message})`);
  }
  for (const path of Object.keys(entries)) {
    if (path.startsWith('/') || path.split('/').includes('..')) {
      throw new PcamError(`Not a valid .pcam project: unsafe entry path ${JSON.stringify(path)}`);
    }
  }
  const manifest = parseJson(entries, MANIFEST, true);
  if (manifest?.format !== PCAM_FORMAT)
    throw new PcamError('Not a valid .pcam project: project.json has no "pcam" format tag');
  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 1) {
    throw new PcamError(`Not a valid .pcam project: bad schemaVersion ${JSON.stringify(manifest.schemaVersion)}`);
  }
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new PcamError(
      `This project was saved by a newer version of PCB-CAMmotion (schema ${manifest.schemaVersion}; this app reads up to ${SCHEMA_VERSION}). Update the app to open it.`,
    );
  }
  const raw = migrate({ manifest, entries });
  return fromEntries(raw.manifest, raw.entries);
}

function fromEntries(manifest, entries) {
  const project = {
    manifest,
    sources: [],
    settings: parseJson(entries, SETTINGS, false) ?? {},
    stackup: parseJson(entries, STACKUP, false) ?? null,
    tools: parseJson(entries, TOOLS, false) ?? {},
    extra: {},
  };
  for (const [path, bytes] of Object.entries(entries)) {
    if (KNOWN.has(path)) continue;
    if (path.startsWith(SOURCES) && path.length > SOURCES.length && !path.slice(SOURCES.length).includes('/')) {
      project.sources.push({ name: path.slice(SOURCES.length), bytes });
    } else if (!path.endsWith('/')) {
      project.extra[path] = bytes;
    }
  }
  return project;
}

/**
 * Add an imported file to the project's sources. A file with the same name replaces the
 * older one (the user re-imported it). Returns a new project; the input is not mutated.
 */
export function addSource(project, name, bytes, now = new Date()) {
  const clean = safeSourceName(name);
  const sources = project.sources.filter((s) => s.name !== clean);
  sources.push({ name: clean, bytes });
  return { ...project, sources, manifest: { ...project.manifest, modified: now.toISOString() } };
}
