// Project operations on top of the schema-1 project shape (src/project/schema.js):
//   manifest, sources [{ name, bytes }], settings, stackup, tools, extra
// The viewer keeps its per-layer and view settings in `settings` (settings/project.json):
//   settings.layers: { [sourceName]: { opacity, role, colour, invert } }
//                    role = user override or null; colour = '#rrggbb' for the analysis views
//                    or null; invert = draw the layer's complement (e.g. mask material)
//   settings.view:   { side, mode, background, solo, activeLayer, show, cx, cy, scale,
//                      view3d, explode, camera3d }
//                    solo: names of the soloed layers (none = every layer shown). Files from
//                    before multi-solo stored solo: true|false (with activeLayer) and a
//                    per-layer `visible`; ensureSettings converts the first, the second is
//                    ignored (soloing and the group toggles choose what is shown).
//                    show: { legend, soldermask, paste, copper, drill } group toggles
//                    (model/layer-groups.js); files before them stored showPaste, which
//                    ensureSettings turns into show.paste.
//                    mode: realistic | debug | classic | xor | outline (model/view-modes.js)
//                    view3d: show the 3D view; explode: 0..1 how far the 3D layers are spread;
//                    explodeStyle: sheets (apart by copper layer, each on its substrate) | layers;
//                    camera3d: null | { position: [x, y, z], target: [x, y, z] } in mm
//                    autoSelectLayer: clicking a shape on the board selects its layer (in
//                    edit mode: switches the edited layer to it); off keeps the layer
//   settings.edit:   { on, tool, gridMm, aperture: { code, template, sizesMm }, holeDiaMm,
//                      pickFrom, brushMm }
//                    the editor (milestone 4): tool = select | lasso | node | hand | rubber |
//                    pad | track | region | paint (box/lasso pick inside only or touching by drag direction; an
//                    older selectMode setting is dropped on load); aperture = an existing D-code for new
//                    pads/tracks, or (code null) a new C/R/O aperture; pickFrom = layer | all |
//                    solo: the layers a box, lasso or rubber picks from (edit/selection.js pickLayers);
//                    brushMm = rubber and paint brush diameter (edit/brush.js)
//   settings.analyze: { open, tab, highlight, playback }   the analyser dock (milestone 3)
//                    tab: apertures | shapes | commands; highlight: null | { layer, code }
//                    (code = aperture/tool number, or null for regions) marks every use;
//                    playback: { layer, step, by, speed } step-through of a layer's commands:
//                    step = commands run (null = playback off, whole image shown), by =
//                    command | object (object steps skip commands that draw nothing),
//                    speed = commands per second while playing
// `edits` (model/edits.json, schema 2; region corner ops from schema 3, cutOut and paint from 4): per source file the
// edit ops of milestone 4 ({ base, ops, redo }, src/edit/session.js); buildLayers replays them, so layers show the
// edited commands and image while sources/ keeps the original bytes.
// `stackup` is null until set; it is filled from a .gbrjob (source: 'gbrjob') unless the user
// edited it (source: 'user'). Everything derived (parsed images, layers) is rebuilt on load.
// Pure data + functions (no DOM).

import { createEmptyProject } from './schema.js';
import { safeSourceName } from './pcam.js';
import { loadFile } from '../model/load-file.js';
import { LayerEditor } from '../edit/session.js';
import { identifyLayer, detectFileKind, layerSortKey } from '../model/layers.js';
import { extractOutline } from '../model/outline.js';
import { resolveJobFiles } from '../parse/gbrjob.js';
import { DEFAULT_STACKUP } from '../model/materials.js';
import { DEFAULT_SHOW, normaliseShow } from '../model/layer-groups.js';
import { EXPLODE_STYLES } from '../model/stack3d.js';
import { PICK_FROM } from '../edit/selection.js';
import { unzipSync } from '../../vendor/fflate/fflate.js';

export const DEFAULT_VIEW = {
  side: 'top',
  mode: 'realistic',
  background: 'dark',
  solo: [],
  activeLayer: null,
  show: DEFAULT_SHOW,
  cx: null,
  cy: null,
  scale: null,
  view3d: false,
  explode: 0,
  explodeStyle: 'sheets',
  camera3d: null,
  autoSelectLayer: true,
};

export const EDIT_TOOLS = ['select', 'lasso', 'node', 'hand', 'rubber', 'pad', 'track', 'region', 'paint'];

export const DEFAULT_EDIT = {
  on: false,
  tool: 'select',
  gridMm: 0.05,
  aperture: { code: null, template: 'C', sizesMm: [0.25, 0.25] },
  holeDiaMm: 0.8,
  pickFrom: 'layer',
  brushMm: 0.5,
};

export const ANALYZE_TABS = ['apertures', 'shapes', 'commands'];
export const PLAYBACK_SPEEDS = [1, 5, 20, 100, 1000, 10000];

export const DEFAULT_ANALYZE = {
  open: true,
  tab: 'apertures',
  highlight: null,
  playback: { layer: null, step: null, by: 'command', speed: 20 },
};

export function createProject(name = 'untitled', now = new Date()) {
  const p = createEmptyProject({ name, now: now instanceof Date ? now : new Date(now) });
  ensureSettings(p);
  return p;
}

/** Fill in the viewer's settings (works on projects loaded from any schema-1 file). */
export function ensureSettings(project) {
  project.edits ??= {};
  const s = (project.settings ??= {});
  s.layers ??= {};
  s.view = { ...DEFAULT_VIEW, ...(s.view || {}) };
  s.view.solo = normaliseSolo(s.view.solo, s.view.activeLayer);
  s.view.show = normaliseShow(s.view.show, s.view.showPaste);
  delete s.view.showPaste; // replaced by show.paste
  const explode = Number(s.view.explode);
  s.view.explode = Number.isFinite(explode) ? Math.min(1, Math.max(0, explode)) : 0;
  s.view.view3d = s.view.view3d === true;
  if (typeof s.view.autoSelectLayer !== 'boolean') s.view.autoSelectLayer = DEFAULT_VIEW.autoSelectLayer;
  if (!EXPLODE_STYLES.includes(s.view.explodeStyle)) s.view.explodeStyle = DEFAULT_VIEW.explodeStyle;
  s.analyze = normaliseAnalyze(s.analyze);
  s.edit = normaliseEdit(s.edit);
  for (const src of project.sources) s.layers[src.name] ??= defaultLayerSettings();
  return project;
}

/** Analyser dock settings with defaults filled in and nonsense values replaced. */
export function normaliseAnalyze(a) {
  const d = DEFAULT_ANALYZE;
  const src = a && typeof a === 'object' ? a : {};
  const pb = src.playback && typeof src.playback === 'object' ? src.playback : {};
  const step = Number.isInteger(pb.step) && pb.step >= 0 ? pb.step : null;
  const hl = src.highlight;
  return {
    ...src,
    open: typeof src.open === 'boolean' ? src.open : d.open,
    tab: ANALYZE_TABS.includes(src.tab) ? src.tab : d.tab,
    highlight:
      hl && typeof hl.layer === 'string' && (hl.code === null || Number.isInteger(hl.code))
        ? { layer: hl.layer, code: hl.code }
        : null,
    playback: {
      ...pb,
      layer: typeof pb.layer === 'string' && step !== null ? pb.layer : null,
      step: typeof pb.layer === 'string' ? step : null,
      by: pb.by === 'object' ? 'object' : 'command',
      speed: PLAYBACK_SPEEDS.includes(pb.speed) ? pb.speed : d.playback.speed,
    },
  };
}

/** Editor settings (src/ui/editor.js) with defaults filled in and nonsense values replaced. */
export function normaliseEdit(e) {
  const d = DEFAULT_EDIT;
  const src = e && typeof e === 'object' ? e : {};
  const a = src.aperture && typeof src.aperture === 'object' ? src.aperture : {};
  const pos = (v, dv) => (Number.isFinite(v) && v > 0 ? v : dv);
  const sizes = Array.isArray(a.sizesMm) ? a.sizesMm : [];
  const rest = { ...src };
  delete rest.selectMode; // retired: box/lasso now pick by drag direction
  return {
    ...rest,
    on: src.on === true,
    tool: EDIT_TOOLS.includes(src.tool) ? src.tool : d.tool,
    gridMm: Number.isFinite(src.gridMm) && src.gridMm >= 0 ? src.gridMm : d.gridMm,
    aperture: {
      code: Number.isInteger(a.code) ? a.code : null,
      template: ['C', 'R', 'O'].includes(a.template) ? a.template : d.aperture.template,
      sizesMm: [pos(sizes[0], d.aperture.sizesMm[0]), pos(sizes[1], d.aperture.sizesMm[1])],
    },
    holeDiaMm: pos(src.holeDiaMm, d.holeDiaMm),
    pickFrom: PICK_FROM.includes(src.pickFrom) ? src.pickFrom : d.pickFrom,
    brushMm: pos(src.brushMm, d.brushMm),
  };
}

export function defaultLayerSettings() {
  return { opacity: 1, role: null, colour: null, invert: false };
}

/** Soloed layer names; converts the old single-solo boolean. */
export function normaliseSolo(solo, activeLayer) {
  if (Array.isArray(solo)) return [...new Set(solo.filter((n) => typeof n === 'string'))];
  return solo === true && typeof activeLayer === 'string' ? [activeLayer] : [];
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
 * @returns {{added: string[], skipped: string[], notes: string[]}} added source names, skip
 *   reasons, other things to tell the user (edits discarded by a re-import)
 */
export function addSourceFile(project, name, bytes, now = new Date()) {
  ensureSettings(project);
  const added = [];
  const skipped = [];
  const notes = [];
  const base = String(name).split(/[\\/]/).pop();
  const kind = detectFileKind(base, bytes);
  if (kind === 'zip') {
    let entries;
    try {
      entries = unzipSync(bytes);
    } catch (e) {
      skipped.push(`${base}: not a readable ZIP (${e.message})`);
      return { added, skipped, notes };
    }
    for (const [path, data] of Object.entries(entries)) {
      if (path.endsWith('/') || /(^|\/)(__MACOSX|\.)/.test(path)) continue;
      const r = addSourceFile(project, path, data, now);
      added.push(...r.added);
      skipped.push(...r.skipped);
      notes.push(...r.notes);
    }
    return { added, skipped, notes };
  }
  if (kind === 'unknown' || kind === 'pcam') {
    skipped.push(`${base}: not a Gerber, Excellon or .gbrjob file`);
    return { added, skipped, notes };
  }
  const clean = safeSourceName(base);
  // edits refer to the commands of the file they were made on: a re-import drops them
  if (project.edits[clean] && project.sources.some((s) => s.name === clean)) {
    delete project.edits[clean];
    notes.push(`${clean} replaced: its edits were discarded`);
  }
  project.sources = project.sources.filter((s) => s.name !== clean);
  project.sources.push({ name: clean, bytes });
  project.settings.layers[clean] ??= defaultLayerSettings();
  touch(project, now);
  added.push(clean);
  return { added, skipped, notes };
}

export function removeSource(project, name, now = new Date()) {
  project.sources = project.sources.filter((s) => s.name !== name);
  delete project.settings?.layers?.[name];
  if (project.edits) delete project.edits[name];
  if (project.settings?.view?.solo) project.settings.view.solo = project.settings.view.solo.filter((n) => n !== name);
  const a = project.settings?.analyze;
  if (a?.highlight?.layer === name) a.highlight = null;
  if (a?.playback?.layer === name) Object.assign(a.playback, { layer: null, step: null });
  touch(project, now);
}

/**
 * Parse every source and build the layer list (job file first so it can name the layers).
 * Fills project.stackup from the job file unless the user edited it.
 * @returns {{layers: object[], job: object|null, files: object[]}}
 */
export function buildLayers(project, opts = {}) {
  ensureSettings(project);
  const loaded = project.sources.map((src) => ({
    src,
    file: loadFile(src.name, src.bytes, { ...opts, edits: project.edits[src.name] }),
  }));
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
      parsed: file.parsed,
      editor: file.editor ?? null,
      visible: true, // what is shown is chosen by soloing (settings.view.solo)
      opacity: settings.opacity ?? 1,
      colour: settings.colour ?? null,
      invert: !!settings.invert,
    };
    if (role.type === 'profile') layer.outline = extractOutline(file.image);
    layers.push(layer);
  }
  layers.sort((a, b) => layerSortKey(a.role) - layerSortKey(b.role) || a.name.localeCompare(b.name));
  // position in the full list: the classic palette colour stays with the file when some
  // layers are not drawn (group toggles)
  layers.forEach((l, i) => (l.listIndex = i));
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

/** The layer's editor (src/edit/session.js), created on first use. */
export function layerEditor(layer) {
  layer.editor ??= new LayerEditor(layer.kind, layer.parsed);
  return layer.editor;
}

/**
 * After an edit (or undo/redo): store the layer's edit ops in the project and show the edited
 * commands and image. A layer back at its original state keeps no record (redo is kept).
 */
export function commitEdit(project, layer, now = new Date()) {
  const ed = layer.editor;
  const src = project.sources.find((s) => s.name === layer.id);
  if (ed.ops.length || ed.redoOps.length) project.edits[layer.id] = ed.record(src.bytes);
  else delete project.edits[layer.id];
  layer.commands = ed.commands;
  layer.image = ed.image;
  layer.diagnostics = ed.diagnostics;
  if (layer.role.type === 'profile') layer.outline = extractOutline(layer.image);
  touch(project, now);
}

/** Drop every edit of a layer: back to the source file. */
export function revertEdits(project, layer, now = new Date()) {
  delete project.edits[layer.id];
  layer.editor = new LayerEditor(layer.kind, layer.parsed);
  commitEdit(project, layer, now);
}
