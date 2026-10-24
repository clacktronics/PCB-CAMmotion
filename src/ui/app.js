// Application shell: toolbar, layer list, inspector, edit tool options, analyser dock, file drop,
// .pcam open/save, autosave.

import { Viewer } from '../render/viewer.js';
import { Viewer3D } from '../render3d/viewer3d.js';
import { EXPLODE_STYLES } from '../model/stack3d.js';
import {
  createProject,
  addSourceFile,
  buildLayers,
  removeSource,
  ensureSettings,
  effectiveStackup,
  commitEdit,
} from '../project/project.js';
import { saveProject, loadProject, isPcamFileName, pcamFileName } from '../project/pcam.js';
import { SCHEMA_VERSION } from '../project/schema.js';
import { APP_VERSION } from '../version.js';
import { saveAutosave, loadAutosave, clearAutosave } from './autosave.js';
import { LAYER_TYPES, detectFileKind } from '../model/layers.js';
import { LAYER_GROUPS, groupOf, shownLayers } from '../model/layer-groups.js';
import { SOLDER_MASK, SILKSCREEN, FINISH, SUBSTRATE, DEBUG, MISC, lookupMaterial } from '../model/materials.js';
import { h, clear } from './dom.js';
import { VIEW_MODES, VIEW_MODE_LABELS, layerColour, toHex, parseHex } from '../model/view-modes.js';
import { AnalyserDock } from './analyser.js';
import { MenuBar } from './menubar.js';
import { EditorPanel } from './editor.js';
import { LayerStrip } from './layer-strip.js';
import { describeAperture } from '../analyze/apertures.js';
import { objectCommand } from '../analyze/commands.js';

const SIDES = ['top', 'bottom', 'inner', 'all'];
const KIND_LABEL = { F: 'Flash (D03)', L: 'Draw (D01, linear)', A: 'Arc (D01, G02/G03)', R: 'Region (G36/G37)' };

export class App {
  constructor(root) {
    this.root = root;
    this.project = createProject();
    this.dirty = false;
    this.layers = [];
    this.job = null;
    this.activeLayerId = null;
    this.selection = null;
    this.fileHandle = null;
    this.textCache = new Map();
    this.#build();
    this.viewer = new Viewer(this.canvas, this.overlay, {
      onCursor: (x, y) => (this.statusPos.textContent = `X ${x.toFixed(3)}  Y ${y.toFixed(3)} mm`),
      onSelect: (hit) => this.#onSelect(hit),
      onHover: (hit) => (this.statusHover.textContent = hit ? describeShort(hit, this.layerById(hit.layerId)) : ''),
      onView: (v) => this.#onView(v),
      // the editor's menu; elsewhere (3D view, empty board) the browser's own
      onContextMenu: (mm, e) => this.editor.contextMenu(mm, e.clientX, e.clientY),
    });
    this.viewer3d = new Viewer3D(this.canvas3d, {
      onCamera: (c) => this.#onCamera(c),
      onError: (m) => this.#message(m, true),
    });
    this.#offerAutosave();
    this.#refresh();
    this.#message(`Ready — drop Gerber, drill, .gbrjob or .pcam files (project schema ${SCHEMA_VERSION})`);
    document.body.dataset.ready = 'true';
  }

  /** The viewer settings stored in the project (settings/project.json). */
  get view() {
    return this.project.settings.view;
  }

  layerById(id) {
    return this.layers.find((l) => l.id === id);
  }

  // ---------------------------------------------------------------- layout

  #build() {
    const fileInput = h('input', {
      type: 'file',
      multiple: true,
      id: 'add-input',
      class: 'hidden',
      'data-testid': 'file-input',
      onchange: (e) => this.#onFiles(e.target.files, e.target),
    });
    const pcamInput = h('input', {
      type: 'file',
      accept: '.pcam,.PCAM',
      id: 'open-input',
      class: 'hidden',
      'data-testid': 'pcam-input',
      onchange: (e) => this.#onFiles(e.target.files, e.target),
    });
    const modeTitles = {
      realistic: 'The board in its real materials',
      debug: 'One colour per layer function',
      classic: 'Classic Gerber viewer: a palette colour per file on black',
      xor: 'XOR the layer colours: overlaps show as a mixed colour; give two layers the same colour and identical parts cancel to black',
      outline: 'Wireframe: outlines of every object (clear polarity dashed)',
    };
    this.btnMode = Object.fromEntries(
      VIEW_MODES.map((m) => [
        m,
        h(
          'button',
          { onclick: () => this.#setView({ mode: m }), 'data-testid': `mode-${m}`, title: modeTitles[m] },
          VIEW_MODE_LABELS[m],
        ),
      ]),
    );
    this.btnDim = {
      '2d': h(
        'button',
        { onclick: () => this.#setView({ view3d: false }), 'data-testid': 'view-2d', title: 'Flat board view' },
        '2D',
      ),
      '3d': h(
        'button',
        {
          onclick: () => this.#setView({ view3d: true }),
          'data-testid': 'view-3d',
          title: '3D stackup: drag to orbit, right-drag or shift+drag to pan, wheel to zoom',
        },
        '3D',
      ),
    };
    this.explodeInput = h('input', {
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      value: 0,
      'data-testid': 'explode',
      oninput: (e) => this.#setView({ explode: Number(e.target.value) }),
    });
    const styleTitles = {
      sheets:
        'Sheets: the board comes apart by copper layer; each copper layer stays on its own slab of substrate, with the mask and silkscreen on the outer ones',
      layers: 'Layers: every layer comes apart on its own; the substrate stays in the middle',
    };
    this.btnExplodeStyle = Object.fromEntries(
      EXPLODE_STYLES.map((k) => [
        k,
        h(
          'button',
          {
            'data-testid': `explode-${k}`,
            title: styleTitles[k],
            onclick: () => this.#setView({ explodeStyle: k }),
          },
          k === 'sheets' ? 'Sheets' : 'Layers',
        ),
      ]),
    );
    this.explodeBox = h('span', { class: 'explode hidden' }, [
      h('label', { title: 'Explode: spread the layers apart to see each one' }, ['Explode', this.explodeInput]),
      h('span', { class: 'seg' }, Object.values(this.btnExplodeStyle)),
    ]);
    this.btnBg = h(
      'button',
      {
        onclick: () => this.#setView({ background: this.view.background === 'light' ? 'dark' : 'light' }),
        'data-testid': 'background',
        title: 'Light or dark background (Shift+B)',
      },
      'Light background',
    );
    this.btnSave = h(
      'button',
      {
        onclick: () => this.save(),
        id: 'save',
        'data-testid': 'save',
        title: 'Save the project as a .pcam file (Ctrl+S)',
      },
      'Save',
    );
    this.btnSaveAs = h(
      'button',
      { onclick: () => this.save({ as: true }), title: 'Choose where to save; later saves write back to that file' },
      'Save as…',
    );
    this.nameInput = h('input', {
      type: 'text',
      id: 'project-name',
      value: this.project.manifest.name,
      title: 'Project name',
      spellcheck: 'false',
      size: 12,
      oninput: (e) => {
        this.project.manifest.name = e.target.value;
        this.#touch();
      },
    });
    const app = this;
    this.dock = new AnalyserDock({
      settings: () => app.project.settings.analyze,
      layer: () => app.layerById(app.activeLayerId) || null,
      layers: () => app.layers,
      selection: () => app.selection,
      select: (layerId, index) => app.#selectObject(layerId, index),
      get viewer() {
        return app.viewer;
      },
      touch: () => app.#touch(),
      message: (text) => app.#message(text),
    });

    this.editor = new EditorPanel({
      settings: () => app.project.settings.edit,
      layer: () => app.layerById(app.activeLayerId) || null,
      project: () => app.project,
      get viewer() {
        return app.viewer;
      },
      commit: (layer) => app.#afterEdit(layer),
      inspect: (hit) => app.#inspect(hit),
      message: (text, err) => app.#message(text, err),
      download: (text, name) => downloadBytes(new TextEncoder().encode(text), name, 'application/octet-stream'),
      touch: () => app.#touch(),
      layers: () => app.layers,
      editLayer: (id) => id !== app.activeLayerId && app.#setActive(id),
      autoSelectLayer: () => app.view.autoSelectLayer,
      setAutoSelectLayer: (on) => {
        app.view.autoSelectLayer = on;
        app.#touch();
        app.editor.refresh();
      },
    });

    this.layerStrip = new LayerStrip({
      layers: () => app.layers,
      solo: () => app.view.solo,
      side: () => app.view.side,
      colour: (l) => app.#layerRgb(l),
      show: (id, side) => app.#showSheet(id, side),
      toggleSolo: (id) => app.#soloLayer(id),
      showAll: () => app.#setView({ solo: [] }),
    });

    // menu rows: a label on the left, the key that does the same on the right
    const item = (b, hint) => {
      b.classList.add('menu-item');
      if (hint) b.append(h('span', { class: 'hint' }, hint));
      return b;
    };
    const row = (label, children) =>
      h('div', { class: 'menu-row' }, [h('span', { class: 'muted' }, label), h('span', { class: 'seg' }, children)]);
    const editMenu = this.editor.menuItems();
    this.menuBar = new MenuBar([
      {
        key: 'file',
        label: 'File',
        items: [
          item(h('button', { id: 'new', onclick: () => this.newProject(), title: 'Start an empty project' }, 'New')),
          item(h('button', { id: 'open', onclick: () => pcamInput.click(), title: 'Open a .pcam project' }, 'Open…')),
          item(
            h(
              'button',
              {
                id: 'add',
                onclick: () => fileInput.click(),
                title: 'Add Gerber, Excellon, .gbrjob files or a .zip of them',
              },
              'Add files…',
            ),
          ),
          null,
          item(this.btnSave, 'Ctrl+S'),
          item(this.btnSaveAs),
          null,
          item(editMenu.exportFile),
          null,
          h('label', { class: 'menu-row' }, [h('span', { class: 'muted' }, 'Project name'), this.nameInput]),
        ],
        onOpen: () => this.editor.refreshMenu(),
      },
      {
        key: 'view',
        label: 'View',
        items: [
          item(
            h('button', { onclick: () => this.#fit(), 'data-testid': 'fit', title: 'Fit board (F)' }, 'Fit board'),
            'F',
          ),
          row('View', Object.values(this.btnDim)),
          row('Colours', Object.values(this.btnMode)),
          item(this.btnBg, 'Shift+B'),
          null,
          item(this.dock.toolbarButton, 'Shift+A'),
        ],
      },
      {
        key: 'edit',
        label: 'Edit',
        items: [
          item(editMenu.undo, 'Ctrl+Z'),
          item(editMenu.redo, 'Ctrl+Y'),
          null,
          item(editMenu.toRegion),
          item(editMenu.unify),
          null,
          item(editMenu.revert),
          item(editMenu.revertAll),
        ],
        onOpen: () => this.editor.refreshMenu(),
      },
    ]);

    // the menus sit over the layer panel, with the divider in line with its edge; the tool
    // and view options take the rest of the bar
    const toolbar = h('header', { class: 'toolbar' }, [
      h('div', { class: 'toolbar-menus' }, [
        h('span', { class: 'title' }, 'PCB-CAMmotion'),
        this.menuBar.el,
        fileInput,
        pcamInput,
      ]),
      h('div', { class: 'toolbar-options' }, [this.editor.el, this.explodeBox]),
    ]);

    this.btnShow = Object.fromEntries(
      LAYER_GROUPS.map((g) => [
        g.key,
        h(
          'button',
          {
            'data-testid': `show-${g.key}`,
            onclick: () => this.#setShow(g.key, !this.view.show[g.key]),
          },
          g.label,
        ),
      ]),
    );
    this.showBar = h('div', { class: 'show-toggles', 'data-testid': 'show-toggles' }, Object.values(this.btnShow));
    this.layerList = h('ul', { class: 'layers', 'data-testid': 'layers' });
    this.stackPanel = h('div', { class: 'stack' });
    const left = h('aside', { class: 'panel left' }, [
      h('h2', {}, 'Layers'),
      this.showBar,
      this.layerList,
      h('h2', {}, 'Board materials'),
      this.stackPanel,
    ]);

    this.inspector = h('div', { 'data-testid': 'inspector' });
    this.diagPanel = h('div', { 'data-testid': 'diagnostics' });
    // floats over the board (bottom right) so the analyser dock can run the full width
    const inspectorBox = h('aside', { class: 'inspector-box', 'data-testid': 'inspector-box' }, [
      h('details', { open: true }, [h('summary', {}, 'Inspector'), this.inspector]),
      h('details', {}, [h('summary', {}, 'File messages'), this.diagPanel]),
    ]);

    this.canvas = h('canvas', { 'data-testid': 'board' });
    this.canvas3d = h('canvas', { class: 'view3d hidden', 'data-testid': 'board-3d' });
    this.overlay = h('canvas', { class: 'overlay' });
    this.empty = h('div', { class: 'empty', id: 'empty' }, [
      h('div', {}, [
        h('div', {}, 'Drop Gerber, Excellon, .gbrjob or .zip files here'),
        h('div', { class: 'muted' }, 'or a .pcam project · everything stays on this computer'),
      ]),
    ]);
    this.banner = h('div', { class: 'banner hidden' });
    this.main = h('main', { class: 'main' }, [
      this.canvas,
      this.overlay,
      this.canvas3d,
      this.editor.strip,
      this.layerStrip.el,
      inspectorBox,
      this.empty,
      h('div', { class: 'drop' }, 'Drop to load'),
      this.banner,
    ]);

    this.statusPos = h('span', {}, '');
    this.statusZoom = h('span', {}, '');
    this.statusMsg = h('span', { id: 'status', 'data-testid': 'status', role: 'status' }, '');
    this.projectInfo = h('span', { id: 'project-info' }, '');
    this.statusHover = h('span', {}, '');
    const status = h('footer', { class: 'status' }, [
      this.statusPos,
      this.statusZoom,
      this.statusMsg,
      this.statusHover,
      this.projectInfo,
    ]);

    clear(this.root);
    this.root.append(toolbar, left, this.main, this.dock.el, status);
    this.#bindDrop();
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.save();
        return;
      }
      if (!isTyping(e.target) && this.editor.keydown(e)) {
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') return this.viewer.select(null);
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === ',' || k === '.') this.dock.step(k === '.' ? 1 : -1);
      else if (k === 'f') this.#fit();
      else if (k === 's') this.#toggleSolo();
      else if (k === 'a') this.dock.setOpen(!this.project.settings.analyze.open);
      else if (k === 'b') this.#setView({ background: this.view.background === 'light' ? 'dark' : 'light' });
      else if (k === 'i' && this.activeLayerId && this.view.mode !== 'realistic') {
        this.#setLayer(this.activeLayerId, { invert: !this.layerById(this.activeLayerId)?.invert });
        this.#refreshLayers();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // flip through the layers (with one layer soloed, the solo moves too)
        e.preventDefault();
        const i = this.layers.findIndex((l) => l.id === this.activeLayerId);
        const n = this.layers.length;
        if (n) this.#setActive(this.layers[(i + (e.key === 'ArrowDown' ? 1 : n - 1) + n) % n].id);
      }
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.dirty) e.preventDefault();
    });
  }

  #bindDrop() {
    let depth = 0;
    const m = this.main;
    const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      m.classList.add('dragging');
    });
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) m.classList.remove('dragging');
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      m.classList.remove('dragging');
      if (e.dataTransfer?.files) this.#onFiles(e.dataTransfer.files);
    });
  }

  #confirmDiscard() {
    return !this.dirty || window.confirm('Discard unsaved changes to this project?');
  }

  newProject() {
    if (!this.#confirmDiscard()) return;
    this.project = createProject();
    this.fileHandle = null;
    this.nameInput.value = this.project.manifest.name;
    this.#rebuild({});
    this.dirty = false;
    this.#refreshTitle();
    this.#message('New project');
  }

  // ---------------------------------------------------------------- files

  async #onFiles(fileList, input) {
    const files = [...fileList];
    if (input) input.value = '';
    const read = await Promise.all(
      files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
    );
    await this.loadFiles(read);
  }

  /** Load files given as {name, bytes}. A .pcam replaces the project; others are added to it. */
  async loadFiles(files) {
    if (!files.length) return;
    const pcam = files.find((f) => isPcamFileName(f.name));
    if (pcam) {
      if (files.length > 1)
        return this.#message('Open a .pcam project on its own, not together with other files', true);
      if (!this.#confirmDiscard()) return;
      try {
        const project = ensureSettings(loadProject(pcam.bytes));
        this.project = project;
        this.fileHandle = null;
        this.nameInput.value = project.manifest.name;
        this.#rebuild({ keepView: true });
        this.dirty = false;
        this.#refreshTitle();
        const n = project.sources.length;
        this.#message(`Opened ${pcam.name} (${n} source file${n === 1 ? '' : 's'})`);
      } catch (e) {
        this.#message(`Could not open ${pcam.name}: ${e.message}`, true);
      }
      return;
    }
    const skipped = [];
    const notes = [];
    let added = 0;
    for (const f of files) {
      const r = addSourceFile(this.project, f.name, f.bytes);
      added += r.added.length;
      skipped.push(...r.skipped);
      notes.push(...r.notes);
    }
    if (this.project.manifest.name === 'untitled' && added) {
      const guess = guessProjectName(this.project.sources.map((s) => s.name));
      if (guess) this.nameInput.value = this.project.manifest.name = guess;
    }
    this.#rebuild({ fit: true });
    if (added) this.#touch();
    this.#message(
      `Loaded ${added} file${added === 1 ? '' : 's'}${notes.length ? ` · ${notes.join('; ')}` : ''}${skipped.length ? ` · skipped: ${skipped.join('; ')}` : ''}`,
      !!skipped.length && !added,
    );
  }

  #rebuild({ fit = false, keepView = false } = {}) {
    const t0 = performance.now();
    const { layers, job } = buildLayers(this.project);
    this.layers = layers;
    this.job = job;
    this.textCache.clear();
    this.parseMs = performance.now() - t0;
    if (!this.layers.find((l) => l.id === this.activeLayerId)) {
      const saved = this.view.activeLayer;
      this.activeLayerId = this.layers.find((l) => l.id === saved) ? saved : (this.layers[0]?.id ?? null);
    }
    this.viewer.settings.activeLayerId = this.activeLayerId;
    this.viewer.settings.background = this.view.background;
    this.viewer.settings.solo = this.view.solo;
    this.viewer.settings.side = this.view.side;
    this.viewer.settings.mode = this.view.mode;
    this.viewer.settings.stackup = effectiveStackup(this.project);
    this.viewer.setLayers(this.#renderLayers());
    const v = this.view;
    if (keepView && Number.isFinite(v.scale) && v.scale > 0) this.viewer.setView(v);
    else if (fit || keepView) this.viewer.fit();
    if (fit || keepView) this.viewer3d.resetCamera(keepView ? v.camera3d : null);
    Object.assign(this.viewer3d.settings, {
      stackup: this.viewer.settings.stackup,
      solo: v.solo,
      side: v.side,
      background: v.background,
      explode: v.explode,
      explodeStyle: v.explodeStyle,
    });
    this.viewer3d.setLayers(this.#renderLayers());
    this.#showDimension();
    this.selection = null;
    this.dock.layersChanged();
    this.editor.layerChanged();
    this.#refresh();
  }

  /** A layer was edited (or undone/redone): show its new image everywhere and save the ops. */
  #afterEdit(layer) {
    commitEdit(this.project, layer);
    delete layer._analysis;
    this.selection = null;
    this.viewer.hover = null;
    this.viewer.selected = null;
    this.viewer.renderer.invalidate(layer.id);
    this.viewer.renderer.invalidate(layer.id + ':inflate');
    this.viewer.renderer.invalidate(layer.id + ':outline');
    this.viewer.layersChanged();
    this.viewer3d.layersChanged();
    this.dock.layersChanged();
    this.#refreshLayers();
    this.#refreshInspector();
    this.#refreshDiagnostics();
    this.#touch();
  }

  /** The editor's selection: one object shows in the inspector. */
  #inspect(hit) {
    this.selection = hit;
    this.#refreshInspector();
    this.dock.onSelection();
  }

  /** The layers to draw: every layer whose group (silkscreen, mask, …) is switched on. */
  #renderLayers() {
    return shownLayers(this.layers, this.view.show);
  }

  /** Layer panel toggle: show or hide every layer of a group, in 2D and 3D. */
  #setShow(key, on) {
    this.view.show = { ...this.view.show, [key]: on };
    const shown = this.#renderLayers();
    this.viewer.showLayers(shown);
    this.viewer3d.setLayers(shown);
    this.#refreshShow();
    this.#refreshLayers();
    this.#touch();
  }

  // ---------------------------------------------------------------- state changes

  #setView(patch) {
    Object.assign(this.view, patch);
    const flat = { ...patch };
    delete flat.view3d;
    delete flat.explode;
    if (Object.keys(flat).length) this.viewer.setSettings(flat);
    const p3 = { ...flat };
    delete p3.mode;
    if ('explode' in patch) p3.explode = patch.explode;
    if (Object.keys(p3).length) this.viewer3d.setSettings(p3);
    if ('view3d' in patch) this.#showDimension();
    this.#refreshToolbar();
    if ('mode' in patch || 'solo' in patch) this.#refreshLayers();
    this.#touch();
  }

  /**
   * Select a layer. With exactly one layer soloed, the solo follows the selection (clicking
   * another layer or ↑/↓ moves it); with several soloed, the selection changes nothing shown.
   */
  #setActive(id) {
    this.activeLayerId = id;
    this.view.activeLayer = id;
    this.viewer.settings.activeLayerId = id;
    const solo = this.view.solo;
    this.dock.refresh();
    this.editor.layerChanged();
    if (solo.length === 1 && solo[0] !== id) return this.#setView({ solo: [id] });
    this.#refreshLayers();
    this.#refreshDiagnostics();
  }

  /** S key: solo button of the selected layer. */
  #toggleSolo() {
    if (this.activeLayerId) this.#soloLayer(this.activeLayerId);
  }

  /**
   * Mixer-style solo button: adds the layer to the soloed set, or takes it out. Several layers
   * can be soloed at once; with none soloed every layer is shown. In the realistic view the
   * soloed layers show as slices of the board.
   */
  #soloLayer(id) {
    const solo = this.view.solo;
    if (solo.includes(id)) return this.#setView({ solo: solo.filter((n) => n !== id) });
    this.activeLayerId = id;
    this.view.activeLayer = id;
    this.viewer.settings.activeLayerId = id;
    this.#setView({ solo: [...solo, id] });
    this.dock.refresh();
    this.#refreshDiagnostics();
  }

  /**
   * Layer strip: select a copper layer and show it alone, as if soloed; the top and bottom
   * layers also turn the board to their side.
   */
  #showSheet(id, side) {
    this.activeLayerId = id;
    this.view.activeLayer = id;
    this.viewer.settings.activeLayerId = id;
    this.#setView(side === 'top' || side === 'bottom' ? { solo: [id], side } : { solo: [id] });
    this.dock.refresh();
    this.editor.layerChanged();
    this.#refreshDiagnostics();
  }

  /** Show the 2D or the 3D view, as the project's view settings say. */
  #showDimension() {
    const on = !!this.view.view3d;
    this.canvas.classList.toggle('hidden', on);
    this.overlay.classList.toggle('hidden', on);
    this.main.classList.toggle('in-3d', on);
    this.viewer3d.show(on);
  }

  #fit() {
    if (this.view.view3d) this.viewer3d.fit();
    else this.viewer.fit();
  }

  #onCamera(c) {
    const old = JSON.stringify(this.view.camera3d);
    this.view.camera3d = c;
    if (old !== JSON.stringify(c) && this.project.sources.length) this.#touch();
  }

  #onView(v) {
    const changed = this.view.cx !== v.cx || this.view.cy !== v.cy || this.view.scale !== v.scale;
    this.view.cx = v.cx;
    this.view.cy = v.cy;
    this.view.scale = v.scale;
    this.statusZoom.textContent = `${v.scale >= 10 ? v.scale.toFixed(0) : v.scale.toPrecision(3)} px/mm`;
    if (changed && this.project.sources.length) this.#touch();
  }

  #setLayer(id, patch) {
    const s = this.project.settings.layers[id];
    Object.assign(s, patch);
    const l = this.layerById(id);
    if (l) {
      if ('colour' in patch) l.colour = patch.colour;
      if ('invert' in patch) l.invert = patch.invert;
      if ('opacity' in patch) l.opacity = patch.opacity;
    }
    if ('role' in patch) return this.#rebuild({ keepView: true });
    this.viewer.layersChanged();
    this.viewer3d.layersChanged();
    this.#touch();
  }

  #setStackup(patch) {
    this.project.stackup = { ...effectiveStackup(this.project), ...patch, source: 'user' };
    this.viewer.settings.stackup = this.project.stackup;
    this.viewer.layersChanged();
    this.viewer3d.setSettings({ stackup: this.project.stackup });
    this.#refreshStack();
    this.#touch();
  }

  #touch() {
    this.project.manifest.modified = new Date().toISOString();
    this.dirty = true;
    this.#refreshTitle();
    clearTimeout(this.autosaveTimer);
    if (!this.project.sources.length) return;
    this.autosaveTimer = setTimeout(() => {
      try {
        saveAutosave(saveProject(this.project)).catch(() => {});
      } catch {
        // autosave is only a safety net
      }
    }, 1500);
  }

  // ---------------------------------------------------------------- save / autosave

  /**
   * Save = download name.pcam, or write back to the file chosen with "Save as…" (File System
   * Access API, Chrome/Edge) when there is one.
   * @param {{as?: boolean}} [opts] as: ask where to save (picker where supported)
   */
  async save(opts = {}) {
    this.project.manifest.modified = new Date().toISOString();
    const bytes = saveProject(this.project);
    const name = pcamFileName(this.project);
    try {
      if (opts.as && window.showSaveFilePicker) {
        this.fileHandle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'PCB-CAMmotion project', accept: { 'application/zip': ['.pcam'] } }],
        });
      }
      if (this.fileHandle) {
        const w = await this.fileHandle.createWritable();
        await w.write(bytes);
        await w.close();
      } else downloadBytes(bytes, name);
      this.dirty = false;
      this.#refreshTitle();
      this.#message(`Saved ${this.fileHandle?.name || name} (${(bytes.length / 1024).toFixed(1)} KB)`);
      clearAutosave().catch(() => {});
    } catch (e) {
      if (e?.name !== 'AbortError') this.#message(`Save failed: ${e.message}`, true);
    }
  }

  async #offerAutosave() {
    let rec;
    try {
      rec = await loadAutosave();
    } catch {
      return;
    }
    if (!rec || this.project.sources.length) return;
    clear(this.banner);
    this.banner.append(
      h('span', {}, `Recover the unsaved project from ${new Date(rec.savedAt).toLocaleString()}?`),
      h(
        'button',
        {
          onclick: () => (
            this.banner.classList.add('hidden'),
            this.loadFiles([{ name: 'recovered.pcam', bytes: rec.bytes }])
          ),
        },
        'Recover',
      ),
      h('button', { onclick: () => (this.banner.classList.add('hidden'), clearAutosave().catch(() => {})) }, 'Discard'),
    );
    this.banner.classList.remove('hidden');
  }

  #message(text, isError = false) {
    this.statusMsg.textContent = text;
    this.statusMsg.dataset.kind = isError ? 'error' : 'info';
    this.statusMsg.setAttribute('role', isError ? 'alert' : 'status');
  }

  #refreshTitle() {
    const m = this.project.manifest;
    document.title = `${this.dirty ? '• ' : ''}${m.name} — PCB-CAMmotion`;
    this.btnSave.classList.toggle('attention', this.dirty);
    this.menuBar.title('file').classList.toggle('attention', this.dirty);
    this.projectInfo.textContent = `schema ${m.schemaVersion} · ${m.units} · app ${APP_VERSION}`;
  }

  // ---------------------------------------------------------------- panels

  #refresh() {
    this.empty.classList.toggle('hidden', this.layers.length > 0);
    this.btnSaveAs.disabled = !this.project.sources.length;
    this.#refreshTitle();
    this.#refreshToolbar();
    this.#refreshShow();
    this.#refreshLayers();
    this.#refreshStack();
    this.#refreshInspector();
    this.#refreshDiagnostics();
    this.dock.refresh();
  }

  #refreshToolbar() {
    const v = this.view;
    this.layerStrip.refresh();
    for (const [k, b] of Object.entries(this.btnDim)) b.classList.toggle('on', !!v.view3d === (k === '3d'));
    this.explodeBox.classList.toggle('hidden', !v.view3d);
    this.explodeInput.value = String(v.explode ?? 0);
    for (const [k, b] of Object.entries(this.btnExplodeStyle)) b.classList.toggle('on', v.explodeStyle === k);
    for (const [k, b] of Object.entries(this.btnMode)) {
      b.classList.toggle('on', v.mode === k);
      // the 3D view always shows the real materials
      b.disabled = !!v.view3d;
    }
    this.btnBg.classList.toggle('on', v.background === 'light');
  }

  #refreshShow() {
    for (const g of LAYER_GROUPS) {
      const b = this.btnShow[g.key];
      const on = this.view.show[g.key] !== false;
      const count = this.layers.filter((l) => groupOf(l.role) === g.key).length;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('none', !count);
      b.title = count
        ? `${on ? 'Hide' : 'Show'} every ${g.label.toLowerCase()} layer (${count}) in 2D and 3D`
        : `No ${g.label.toLowerCase()} layer loaded`;
    }
  }

  /** A layer's colour in the current view (its row, its layer strip button). */
  #layerRgb(l, index = this.layers.indexOf(l)) {
    return this.view.mode === 'realistic' ? swatchColour(l, this.project).rgb : layerColour(l, this.view.mode, index);
  }

  #refreshLayers() {
    this.layerStrip.refresh();
    clear(this.layerList);
    for (const [index, l] of this.layers.entries()) {
      const errs = l.diagnostics.list.filter((d) => d.severity === 'error').length;
      const warns = l.diagnostics.list.filter((d) => d.severity === 'warning').length;
      const roleSel = h('select', {
        title: `Layer function (found from: ${l.role.source === 'user' ? 'your choice' : l.autoRole.source})`,
        'data-testid': 'role',
        onclick: (e) => e.stopPropagation(),
        onchange: (e) => {
          const [type, side] = e.target.value.split(':');
          const auto = l.autoRole;
          const role = type === auto.type && side === auto.side ? null : { type, side };
          this.#setLayer(l.id, { role });
        },
      });
      for (const t of LAYER_TYPES) {
        for (const s of t === 'profile' || t === 'drill' || t === 'other'
          ? ['all']
          : SIDES.filter((x) => x !== 'all')) {
          roleSel.append(
            h(
              'option',
              { value: `${t}:${s}`, selected: l.role.type === t && l.role.side === s },
              s === 'all' ? t : `${t} ${s}`,
            ),
          );
        }
      }
      const soloed = this.view.solo.includes(l.id);
      const muted = this.view.solo.length > 0 && !soloed;
      const groupOff = this.view.show[groupOf(l.role)] === false;
      // the whole row takes the layer's colour in the current view
      const rgb = this.#layerRgb(l, index);
      const row = h(
        'li',
        {
          class: `layer source-row${l.id === this.activeLayerId ? ' active' : ''}${muted ? ' hidden-layer' : ''}${groupOff ? ' group-off' : ''}${soloed ? ' soloed' : ''}`,
          style: `--layer: ${rgb.join(', ')}`,
          'data-testid': 'layer',
          'data-name': l.name,
          'data-role': `${l.role.type}:${l.role.side}`,
          onclick: () => this.#setActive(l.id),
        },
        [
          // the colour bar on the left edge; in the analysis views it is the colour picker
          this.view.mode === 'realistic'
            ? h('span', { class: 'colour-bar', title: 'Material colour (see Board materials)' })
            : h('input', {
                type: 'color',
                class: 'colour-bar',
                'data-testid': 'layer-colour',
                title: 'Layer colour in this view: click to change',
                value: toHex(rgb),
                onclick: (e) => e.stopPropagation(),
                oninput: (e) => {
                  e.target.closest('.layer').style.setProperty('--layer', parseHex(e.target.value).join(', '));
                  this.#setLayer(l.id, { colour: e.target.value });
                },
              }),
          h('span', { class: 'name', title: l.name }, l.name),
          h('span', { class: 'badges' }, [
            h(
              'button',
              {
                class: `solo-btn${soloed ? ' on' : ''}`,
                'data-testid': 'solo',
                title: soloed
                  ? 'Soloed: press again to take it out of the solo (S)'
                  : 'Solo: show only the soloed layers; press S on several to combine them (S)',
                'aria-pressed': soloed ? 'true' : 'false',
                onclick: (e) => {
                  e.stopPropagation();
                  this.#soloLayer(l.id);
                },
              },
              'S',
            ),
            l.editor?.ops.length
              ? h(
                  'span',
                  {
                    class: 'badge edited',
                    'data-testid': 'edited',
                    title: `${l.editor.ops.length} edits (Edit menu: revert)`,
                  },
                  `✎${l.editor.ops.length}`,
                )
              : null,
            errs ? h('span', { class: 'badge error', title: 'errors' }, String(errs)) : null,
            warns ? h('span', { class: 'badge warning', title: 'warnings' }, String(warns)) : null,
          ]),
          h('span', { class: 'controls' }, [
            roleSel,
            h('input', {
              type: 'range',
              min: 0,
              max: 1,
              step: 0.05,
              value: l.opacity,
              title: 'Opacity',
              onclick: (e) => e.stopPropagation(),
              oninput: (e) => this.#setLayer(l.id, { opacity: Number(e.target.value) }),
            }),
            // invert is an analysis tool: not offered in the realistic view
            this.view.mode === 'realistic'
              ? null
              : h(
                  'label',
                  {
                    class: 'invert',
                    title: 'Invert: show what is not drawn, e.g. the solder mask material instead of its openings (I)',
                    onclick: (e) => e.stopPropagation(),
                  },
                  [
                    h('input', {
                      type: 'checkbox',
                      checked: !!l.invert,
                      'data-testid': 'invert',
                      onchange: (e) => this.#setLayer(l.id, { invert: e.target.checked }),
                    }),
                    'inv',
                  ],
                ),
            h(
              'button',
              {
                title: 'Remove from project',
                onclick: (e) => {
                  e.stopPropagation();
                  removeSource(this.project, l.id);
                  this.#rebuild({ keepView: true });
                  this.#touch();
                },
              },
              '×',
            ),
          ]),
        ],
      );
      this.layerList.append(row);
    }
    const others = this.project.sources.filter((s) => !this.layers.find((l) => l.id === s.name));
    for (const s of others)
      this.layerList.append(
        h('li', { class: 'layer source-row muted', 'data-name': s.name }, [
          h('span', { class: 'name' }, `${s.name} (${detectFileKind(s.name, s.bytes)})`),
        ]),
      );
  }

  #refreshStack() {
    const st = effectiveStackup(this.project);
    clear(this.stackPanel);
    const sel = (label, table, value, onchange) => {
      const s = h('select', {
        onchange: (e) => onchange(e.target.value),
        'data-testid': `stack-${label.toLowerCase().replace(/\W+/g, '-')}`,
      });
      const known = Object.keys(table);
      const cur = String(value || '').toLowerCase();
      if (value && !known.includes(cur)) s.append(h('option', { value, selected: true }, `${value} (unknown)`));
      for (const k of known) s.append(h('option', { value: k, selected: k === cur }, titleCase(table[k].label || k)));
      this.stackPanel.append(h('label', {}, label), s);
    };
    sel('Mask (top)', SOLDER_MASK, st.mask?.top ?? st.mask, (v) => this.#setStackup({ mask: { ...st.mask, top: v } }));
    sel('Mask (bottom)', SOLDER_MASK, st.mask?.bottom ?? st.mask, (v) =>
      this.#setStackup({ mask: { ...st.mask, bottom: v } }),
    );
    sel('Silkscreen', SILKSCREEN, st.silk?.top ?? st.silk, (v) => this.#setStackup({ silk: { top: v, bottom: v } }));
    sel('Finish', FINISH, st.finish, (v) => this.#setStackup({ finish: v }));
    sel('Substrate', SUBSTRATE, st.substrate, (v) => this.#setStackup({ substrate: v }));
    this.stackPanel.append(
      h('span', { class: 'muted' }, 'Source'),
      h(
        'span',
        { class: 'muted' },
        st.source === 'gbrjob' ? 'Gerber job file' : st.source === 'user' ? 'edited' : 'defaults',
      ),
    );
    if (st.boardThicknessMm)
      this.stackPanel.append(
        h('span', { class: 'muted' }, 'Thickness'),
        h('span', { class: 'muted' }, `${st.boardThicknessMm} mm`),
      );
  }

  #onSelect(hit) {
    this.selection = hit;
    const follow = hit && this.view.autoSelectLayer && this.view.solo.length !== 1;
    const layerChanged = follow && hit.layerId !== this.activeLayerId;
    if (follow) {
      this.activeLayerId = hit.layerId;
      this.view.activeLayer = hit.layerId;
      this.viewer.settings.activeLayerId = hit.layerId;
    }
    this.#refreshInspector();
    this.#refreshLayers();
    this.#refreshDiagnostics();
    if (layerChanged) {
      this.dock.refresh();
      this.layerList.querySelector('.layer.active')?.scrollIntoView?.({ block: 'nearest' });
    }
    this.dock.onSelection();
  }

  /** Select one object (from the analyser), as if it had been clicked on the board. */
  #selectObject(layerId, index) {
    const l = this.layerById(layerId);
    const o = l?.image.objects[index];
    if (!o) return;
    if (layerId === this.activeLayerId) return this.editor.select([index]);
    this.viewer.select({ layerId, index, object: o, x: null, y: null });
  }

  #sourceLine(layer, line) {
    let lines = this.textCache.get(layer.id);
    if (!lines) {
      const bytes = this.project.sources.find((s) => s.name === layer.id).bytes;
      lines = new TextDecoder().decode(bytes.subarray(0, 64 * 1024 * 1024)).split('\n');
      this.textCache.set(layer.id, lines);
    }
    const t = lines[line - 1] ?? '';
    return t.length > 400 ? t.slice(0, 400) + '…' : t.replace(/\r$/, '');
  }

  #refreshInspector() {
    clear(this.inspector);
    const hit = this.selection;
    if (!hit) {
      this.inspector.append(
        h('p', { class: 'muted', style: 'margin:0 10px' }, 'Click a pad, track, region or hole to inspect it.'),
      );
      return;
    }
    const l = this.layerById(hit.layerId);
    const o = hit.object;
    const ap = o.ap;
    const rows = [
      ['Layer', l.name],
      ['Function', `${l.role.type} ${l.role.side}`],
      ['Object', KIND_LABEL[o.k]],
      ['Polarity', o.dark ? 'dark (LPD)' : 'clear (LPC)'],
    ];
    if (ap) {
      const label = l.kind === 'excellon' ? `T${ap.code}` : `D${ap.code}`;
      rows.push([l.kind === 'excellon' ? 'Tool' : 'Aperture', `${label} · ${describeAperture(ap)}`]);
      if (ap.attributes?.['.AperFunction']) rows.push(['Function', ap.attributes['.AperFunction'].join(', ')]);
    }
    if (o.k === 'F') rows.push(['Position', `${fmt(o.x)}, ${fmt(o.y)} mm`]);
    if (o.k === 'L' || o.k === 'A') {
      rows.push(['From', `${fmt(o.x1)}, ${fmt(o.y1)} mm`], ['To', `${fmt(o.x2)}, ${fmt(o.y2)} mm`]);
      if (o.k === 'L') rows.push(['Length', `${fmt(Math.hypot(o.x2 - o.x1, o.y2 - o.y1))} mm`]);
      else
        rows.push(
          ['Centre', `${fmt(o.cx)}, ${fmt(o.cy)} mm`],
          ['Radius', `${fmt(o.r)} mm`],
          ['Sweep', `${((o.sw * 180) / Math.PI).toFixed(2)}° ${o.sw > 0 ? 'CCW' : 'CW'}`],
        );
    }
    if (o.k === 'R')
      rows.push(
        ['Contours', String(o.contours.length)],
        ['Vertices', String(o.contours.reduce((a, c) => a + c.length / 2, 0))],
      );
    if (o.m) rows.push(['Transform', 'mirrored/rotated/scaled (LM/LR/LS or block)']);
    const attrs = l.image.objectAttributes?.[o.at];
    if (attrs) for (const [k, v] of Object.entries(attrs)) rows.push([k, v.join(', ')]);
    rows.push(['Source line', o.ln ? String(o.ln) : 'none: added by an edit']);
    const ci = objectCommand(l.image, hit.index);
    if (ci >= 0 && l.commands[ci].line !== o.ln)
      rows.push(['Drawn by', `command ${ci + 1} on line ${l.commands[ci].line}`]);
    this.inspector.append(
      h(
        'dl',
        { class: 'kv' },
        rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]),
      ),
    );
    this.inspector.append(
      h(
        'div',
        { class: 'code', 'data-testid': 'source-line' },
        o.ln ? `${o.ln}: ${this.#sourceLine(l, o.ln)}` : 'Added by an edit (not in the source file)',
      ),
      h('div', { class: 'inspector-actions' }, [
        h(
          'button',
          {
            'data-testid': 'show-command',
            title: 'Open the command list at the command that drew this',
            onclick: () => this.dock.showCommand(l.id, hit.index),
          },
          'Show command',
        ),
        h(
          'button',
          {
            'data-testid': 'show-uses',
            title: ap ? 'Highlight every object drawn with this aperture' : 'Highlight every region',
            onclick: () => this.dock.toggleHighlight(l, ap ? ap.code : null),
          },
          ap ? `All ${l.kind === 'excellon' ? 'T' : 'D'}${ap.code}` : 'All regions',
        ),
      ]),
    );
  }

  #refreshDiagnostics() {
    clear(this.diagPanel);
    const l = this.layerById(this.activeLayerId);
    const jobDiag = this.job?.diagnostics?.list || [];
    if (!l && !jobDiag.length) return;
    if (l) {
      const st = l.image.stats;
      const b = l.image.bounds;
      const facts = [
        ['File', l.name],
        [
          'Format',
          l.kind === 'excellon' ? `Excellon (${l.image.fileUnits || '?'})` : `Gerber (${l.image.fileUnits || '?'})`,
        ],
        ['Objects', l.image.objects.length.toLocaleString('en')],
        ...Object.entries(st).map(([k, v]) => [k, v.toLocaleString('en')]),
        ['Size', b ? `${fmt(b[2] - b[0])} × ${fmt(b[3] - b[1])} mm` : '—'],
      ];
      this.diagPanel.append(
        h(
          'dl',
          { class: 'kv' },
          facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]),
        ),
      );
      const list = l.diagnostics.list;
      this.diagPanel.append(
        h(
          'ul',
          { class: 'diag', 'data-testid': 'diag-list' },
          list.length
            ? list.map((d) =>
                h('li', {}, [
                  h('span', { class: `sev-${d.severity}` }, d.severity),
                  ` ${d.line ? `line ${d.line}: ` : ''}${d.message}${d.count > 1 ? ` (×${d.count})` : ''}`,
                ]),
              )
            : [h('li', { class: 'muted' }, 'No problems found')],
        ),
      );
    }
    if (jobDiag.length) {
      this.diagPanel.append(h('h2', {}, 'Job file'));
      this.diagPanel.append(
        h(
          'ul',
          { class: 'diag' },
          jobDiag.map((d) => h('li', {}, [h('span', { class: `sev-${d.severity}` }, d.severity), ` ${d.message}`])),
        ),
      );
    }
  }
}

function swatchColour(l, project) {
  const st = effectiveStackup(project);
  if (l.role.type === 'soldermask') return lookupMaterial('mask', st.mask?.[l.role.side] ?? st.mask).value;
  if (l.role.type === 'legend') return lookupMaterial('silk', st.silk?.[l.role.side] ?? st.silk).value;
  if (l.role.type === 'copper') return lookupMaterial('finish', st.finish).value;
  if (l.role.type === 'substrate') return lookupMaterial('substrate', st.substrate).value;
  if (l.role.type === 'paste') return MISC.paste;
  return DEBUG[l.role.type] || DEBUG.other;
}

function describeShort(hit, layer) {
  const o = hit.object;
  const ap = o.ap ? `${layer.kind === 'excellon' ? 'T' : 'D'}${o.ap.code} ${describeAperture(o.ap)} · ` : '';
  return `${layer.name} · ${ap}${KIND_LABEL[o.k]} · ${o.dark ? 'dark' : 'clear'} · ${o.ln ? `line ${o.ln}` : 'added'}`;
}

function fmt(v) {
  return Number.isFinite(v) ? (Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(4).replace(/\.?0+$/, '')) : '—';
}

function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function guessProjectName(names) {
  const job = names.find((n) => /\.gbrjob$/i.test(n));
  if (job) return job.replace(/(-job)?\.gbrjob$/i, '');
  const kicad = names.map((n) => /^(.*?)-(F|B|In\d+|Edge)[_.]/.exec(n)?.[1]).find(Boolean);
  if (kicad) return kicad;
  const stems = names.map((n) => n.replace(/\.[^.]+$/, ''));
  return stems.length && stems.every((s) => s === stems[0]) ? stems[0] : null;
}

function downloadBytes(bytes, name, type = 'application/zip') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Keyboard shortcuts must not fire while the user types or uses a control that takes keys. */
function isTyping(el) {
  if (!el || el === document.body) return false;
  if (el.isContentEditable || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && !['checkbox', 'button', 'color'].includes(el.type);
}
