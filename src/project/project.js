// Project operations on top of the schema-1 project shape (src/project/schema.js):
//   manifest, sources [{ name, bytes }], settings, stackup, tools, extra
// The viewer keeps its per-layer and view settings in `settings` (settings/project.json):
//   settings.layers: { [sourceName]: { visible, opacity, role, colour, invert } }
//                    role = user override or null; colour = '#rrggbb' for the analysis views
//                    or null; invert = draw the layer's complement (e.g. mask material)
//   settings.view:   { side, mode, background, solo, activeLayer, showPaste, cx, cy, scale }
//                    mode: realistic | debug | classic | xor | outline (model/view-modes.js)
// `stackup` is null until set; it is filled from a .gbrjob (source: 'gbrjob') unless the user
// edited it (source: 'user'). Everything derived (parsed images, layers) is rebuilt on load.
// Pure data + functions (no DOM).

import { createEmptyProject } from './schema.js';
import { safeSourceName } from './pcam.js';
import { loadFile } from '../model/load-file.js';
import { identifyLayer, detectFileKind, layerSortKey } from '../model/layers.js';
import { extractOutline } from '../model/outline.js';
import { resolveJobFiles } from '../parse/gbrjob.js';
import { DEFAULT_STACKUP } from '../model/materials.js';
import { unzipSync } from '../../vendor/fflate/fflate.js';

export const DEFAULT_VIEW = {
  side: 'top',
  mode: 'realistic',
  background: 'dark',
  solo: false,
  activeLayer: null,
  showPaste: false,
  cx: null,
  cy: null,
  scale: null,
};

export function createProject(name = 'untitled', now = new Date()) {
  const p = createEmptyProject({ name, now: now instanceof Date ? now : new Date(now) });
  ensureSettings(p);
  return p;
}

/** Fill in the viewer's settings (works on projects loaded from any schema-1 file). */
export function ensureSettings(project) {
  const s = (project.settings ??= {});
  s.layers ??= {};
  s.view = { ...DEFAULT_VIEW, ...(s.view || {}) };
  for (const src of project.sources) s.layers[src.name] ??= defaultLayerSettings();
  return project;
}

export function defaultLayerSettings() {
  return { visible: true, opacity: 1, role: null, colour: null, invert: false };
}

/** The stackup to draw with: the project's, or the defaults. */
export function effectiveStackup(project) {
  return (
    project.stackup ?? {
      ...DEFAULT_STACKUP,
      mask: { top: DEFAULT_STACKUP.mask, bottom: DEFAULT_STACKUP.mask },
      silk: { top: DEFAULT_STACKUP.silk, bottom: DEFAULT_STACKUP.silk },
      source: 'default',
    }
  );
}

function touch(project, now) {
  project.manifest.modified = (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

/**
 * Add an original file to the project (mutates it). ZIP archives are expanded; a file with
 * the same name as an existing source replaces it (re-import). Unknown files are skipped.
 * @returns {{added: string[], skipped: string[]}} added source names, skip reasons
 */
export function addSourceFile(project, name, bytes, now = new Date()) {
  ensureSettings(project);
  const added = [];
  const skipped = [];
  const base = String(name).split(/[\\/]/).pop();
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
      const r = addSourceFile(project, path, data, now);
      added.push(...r.added);
      skipped.push(...r.skipped);
    }
    return { added, skipped };
  }
  if (kind === 'unknown' || kind === 'pcam') {
    skipped.push(`${base}: not a Gerber, Excellon or .gbrjob file`);
    return { added, skipped };
  }
  const clean = safeSourceName(base);
  project.sources = project.sources.filter((s) => s.name !== clean);
  project.sources.push({ name: clean, bytes });
  project.settings.layers[clean] ??= defaultLayerSettings();
  touch(project, now);
  added.push(clean);
  return { added, skipped };
}

export function removeSource(project, name, now = new Date()) {
  project.sources = project.sources.filter((s) => s.name !== name);
  delete project.settings?.layers?.[name];
  touch(project, now);
}

/**
 * Parse every source and build the layer list (job file first so it can name the layers).
 * Fills project.stackup from the job file unless the user edited it.
 * @returns {{layers: object[], job: object|null, files: object[]}}
 */
export function buildLayers(project, opts = {}) {
  ensureSettings(project);
  const loaded = project.sources.map((src) => ({ src, file: loadFile(src.name, src.bytes, opts) }));
  const jobEntry = loaded.find((l) => l.file.kind === 'gbrjob' && l.file.job?.job);
  const job = jobEntry ? jobEntry.file.job : null;
  if (job) {
    resolveJobFiles(
      job,
      project.sources.map((s) => s.name),
    );
    if (project.stackup?.source !== 'user') applyJobStackup(project, job);
  }
  const layers = [];
  for (const { src, file } of loaded) {
    if (!file.image) continue;
    const settings = project.settings.layers[src.name];
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
      id: src.name,
      name: src.name,
      kind: file.kind,
      role,
      autoRole: auto,
      image: file.image,
      commands: file.commands,
      diagnostics: file.diagnostics,
      visible: settings.visible !== false,
      opacity: settings.opacity ?? 1,
      colour: settings.colour ?? null,
      invert: !!settings.invert,
    };
    if (role.type === 'profile') layer.outline = extractOutline(file.image);
    layers.push(layer);
  }
  layers.sort((a, b) => layerSortKey(a.role) - layerSortKey(b.role) || a.name.localeCompare(b.name));
  return { layers, job, files: loaded.map((l) => ({ name: l.src.name, ...l.file })) };
}

export function applyJobStackup(project, job) {
  const st = job.stackup;
  if (!st) return;
  const base = effectiveStackup(project);
  const s = {
    ...base,
    mask: {
      top: st.mask.top || base.mask?.top || 'Green',
      bottom: st.mask.bottom || st.mask.top || base.mask?.bottom || 'Green',
    },
    silk: {
      top: st.silk.top || base.silk?.top || 'White',
      bottom: st.silk.bottom || st.silk.top || base.silk?.bottom || 'White',
    },
    source: 'gbrjob',
  };
  if (st.finish) s.finish = st.finish;
  if (st.substrate) s.substrate = st.substrate;
  if (st.boardThicknessMm) s.boardThicknessMm = st.boardThicknessMm;
  if (st.layers?.length) s.layers = st.layers;
  project.stackup = s;
}
