// The project: everything that is saved in a .pcam file. Pure data + functions (no DOM).
//
// Original source files are kept byte-for-byte (sources map id -> Uint8Array); everything
// derived from them (layers, images) is rebuilt on load. Settings that change the result live
// in the project object so they are saved.

import { loadFile } from '../model/load-file.js';
import { identifyLayer, detectFileKind, layerSortKey } from '../model/layers.js';
import { extractOutline } from '../model/outline.js';
import { resolveJobFiles } from '../parse/gbrjob.js';
import { DEFAULT_STACKUP } from '../model/materials.js';
import { unzipSync } from '../../vendor/fflate/fflate.js';

export const SCHEMA_VERSION = 1;
export const APP_NAME = 'PCB-CAMmotion';
export const APP_VERSION = '0.2.0';

export function createProject(name = 'Untitled', now = new Date().toISOString()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    app: { name: APP_NAME, version: APP_VERSION },
    name,
    created: now,
    modified: now,
    units: 'mm',
    sources: [],
    layers: {},
    view: { side: 'top', mode: 'realistic', showPaste: false, cx: null, cy: null, scale: null },
    stackup: {
      ...DEFAULT_STACKUP,
      mask: { top: 'Green', bottom: 'Green' },
      silk: { top: 'White', bottom: 'White' },
      source: 'default',
    },
  };
}

/** Default per-layer settings. */
export function defaultLayerSettings() {
  return { visible: true, opacity: 1, role: null };
}

function uniqueName(project, name) {
  const taken = new Set(project.sources.map((s) => s.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const n = `${stem} (${i})${ext}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

/**
 * Add an original file to the project. ZIP archives are expanded (one source per file).
 * @returns {{added: object[], skipped: string[]}}
 */
export function addSourceFile(project, sources, name, bytes, now = new Date().toISOString()) {
  const added = [];
  const skipped = [];
  const base = name.split(/[\\/]/).pop();
  const kind = detectFileKind(base, bytes);
  if (kind === 'zip') {
    let entries;
    try {
      entries = unzipSync(bytes);
    } catch (e) {
      skipped.push(`${base}: not a readable ZIP (${e.message})`);
      return { added, skipped };
    }
    for (const [path, data] of Object.entries(entries)) {
      if (path.endsWith('/') || /(^|\/)(__MACOSX|\.)/.test(path)) continue;
      const r = addSourceFile(project, sources, path.split('/').pop(), data, now);
      added.push(...r.added);
      skipped.push(...r.skipped);
    }
    return { added, skipped };
  }
  if (kind === 'unknown' || kind === 'pcam') {
    skipped.push(`${base}: not a Gerber, Excellon or .gbrjob file`);
    return { added, skipped };
  }
  const id = nextId(project);
  const unique = uniqueName(project, base);
  const src = { id, name: unique, path: `sources/${unique}`, kind, size: bytes.length, addedAt: now };
  project.sources.push(src);
  sources.set(id, bytes);
  project.layers[id] = defaultLayerSettings();
  project.modified = now;
  added.push(src);
  return { added, skipped };
}

function nextId(project) {
  let n = project.sources.length + 1;
  const ids = new Set(project.sources.map((s) => s.id));
  while (ids.has(`s${n}`)) n++;
  return `s${n}`;
}

export function removeSource(project, sources, id) {
  project.sources = project.sources.filter((s) => s.id !== id);
  sources.delete(id);
  delete project.layers[id];
}

/**
 * Parse every source and build the layer list (job file first so it can name the layers).
 * Updates project.stackup from the job file unless the user edited it.
 * @returns {{layers: object[], job: object|null, files: object[]}}
 */
export function buildLayers(project, sources, opts = {}) {
  const loaded = project.sources.map((s) => ({
    src: s,
    file: loadFile(s.name, sources.get(s.id), { kind: s.kind, ...opts }),
  }));
  const jobEntry = loaded.find((l) => l.file.kind === 'gbrjob' && l.file.job?.job);
  const job = jobEntry ? jobEntry.file.job : null;
  if (job) {
    resolveJobFiles(
      job,
      project.sources.map((s) => s.name),
    );
    if (project.stackup.source !== 'user') applyJobStackup(project, job);
  }
  const layers = [];
  for (const { src, file } of loaded) {
    if (!file.image) continue;
    const settings = project.layers[src.id] || (project.layers[src.id] = defaultLayerSettings());
    const auto = identifyLayer(
      {
        name: src.name,
        kind: file.kind,
        fileFunction: file.image.fileAttributes['.FileFunction'],
        filePolarity: file.image.fileAttributes['.FilePolarity']?.[0],
      },
      job ? job.files : [],
    );
    const role = settings.role ? { ...auto, ...settings.role, source: 'user' } : auto;
    const layer = {
      id: src.id,
      name: src.name,
      kind: file.kind,
      role,
      autoRole: auto,
      image: file.image,
      commands: file.commands,
      diagnostics: file.diagnostics,
      visible: settings.visible !== false,
      opacity: settings.opacity ?? 1,
    };
    if (role.type === 'profile') layer.outline = extractOutline(file.image);
    layers.push(layer);
  }
  layers.sort((a, b) => layerSortKey(a.role) - layerSortKey(b.role) || a.name.localeCompare(b.name));
  return { layers, job, files: loaded.map((l) => l.file) };
}

export function applyJobStackup(project, job) {
  const st = job.stackup;
  if (!st) return;
  const s = project.stackup;
  s.mask = {
    top: st.mask.top || s.mask?.top || 'Green',
    bottom: st.mask.bottom || st.mask.top || s.mask?.bottom || 'Green',
  };
  s.silk = {
    top: st.silk.top || s.silk?.top || 'White',
    bottom: st.silk.bottom || st.silk.top || s.silk?.bottom || 'White',
  };
  if (st.finish) s.finish = st.finish;
  if (st.substrate) s.substrate = st.substrate;
  if (st.boardThicknessMm) s.boardThicknessMm = st.boardThicknessMm;
  if (st.layers?.length) s.layers = st.layers;
  s.source = 'gbrjob';
}
