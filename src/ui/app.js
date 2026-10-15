// Application shell: toolbar, layer list, inspector, file drop, .pcam open/save, autosave.

import { Viewer } from '../render/viewer.js';
import { createProject, addSourceFile, buildLayers, removeSource } from '../project/project.js';
import { savePcam, loadPcam, isPcamName, PcamError } from '../project/pcam.js';
import { saveAutosave, loadAutosave, clearAutosave } from './autosave.js';
import { LAYER_TYPES } from '../model/layers.js';
import { SOLDER_MASK, SILKSCREEN, FINISH, SUBSTRATE, DEBUG, lookupMaterial, rgba } from '../model/materials.js';
import { h, clear } from './dom.js';

const SIDES = ['top', 'bottom', 'inner', 'all'];
const KIND_LABEL = { F: 'Flash (D03)', L: 'Draw (D01, linear)', A: 'Arc (D01, G02/G03)', R: 'Region (G36/G37)' };

export class App {
  constructor(root) {
    this.root = root;
    this.project = createProject();
    this.sources = new Map();
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
    });
    this.#offerAutosave();
    this.#refresh();
  }

  layerById(id) {
    return this.layers.find((l) => l.id === id);
  }

  // ---------------------------------------------------------------- layout

  #build() {
    const fileInput = h('input', {
      type: 'file',
      multiple: true,
      class: 'hidden',
      'data-testid': 'file-input',
      onchange: (e) => this.#onFiles(e.target.files, e.target),
    });
    const pcamInput = h('input', {
      type: 'file',
      accept: '.pcam,.PCAM',
      class: 'hidden',
      'data-testid': 'pcam-input',
      onchange: (e) => this.#onFiles(e.target.files, e.target),
    });
    this.btnSide = {
      top: h('button', { onclick: () => this.#setView({ side: 'top' }), 'data-testid': 'view-top' }, 'Top'),
      bottom: h('button', { onclick: () => this.#setView({ side: 'bottom' }), 'data-testid': 'view-bottom' }, 'Bottom'),
    };
    this.btnMode = {
      realistic: h(
        'button',
        {
          onclick: () => this.#setView({ mode: 'realistic' }),
          'data-testid': 'mode-realistic',
          title: 'Board in its real colours',
        },
        'Realistic',
      ),
      debug: h(
        'button',
        { onclick: () => this.#setView({ mode: 'debug' }), 'data-testid': 'mode-debug', title: 'One colour per layer' },
        'Debug colours',
      ),
    };
    this.btnPaste = h(
      'button',
      {
        onclick: () => this.#setView({ showPaste: !this.project.view.showPaste }),
        title: 'Show solder paste in the realistic view',
      },
      'Paste',
    );
    this.btnSave = h(
      'button',
      { onclick: () => this.save(), 'data-testid': 'save', title: 'Save the project as a .pcam file (Ctrl+S)' },
      'Save project',
    );
    this.btnSaveAs = h(
      'button',
      { onclick: () => this.save({ as: true }), title: 'Choose where to save; later saves write back to that file' },
      'Save as…',
    );
    this.nameInput = h('input', {
      type: 'text',
      value: this.project.name,
      title: 'Project name',
      size: 16,
      onchange: (e) => {
        this.project.name = e.target.value.trim() || 'Untitled';
        this.#touch();
      },
    });
    const toolbar = h('header', { class: 'toolbar' }, [
      h('span', { class: 'title' }, 'PCB-CAMmotion'),
      h(
        'button',
        { onclick: () => fileInput.click(), title: 'Gerber, Excellon, .gbrjob or a .zip of them' },
        'Open files…',
      ),
      h('button', { onclick: () => pcamInput.click() }, 'Open project…'),
      this.btnSave,
      this.btnSaveAs,
      fileInput,
      pcamInput,
      h('span', { class: 'sep' }),
      h('button', { onclick: () => this.viewer.fit(), 'data-testid': 'fit', title: 'Fit board (F)' }, 'Fit'),
      h('span', { class: 'seg' }, [this.btnSide.top, this.btnSide.bottom]),
      h('span', { class: 'seg' }, [this.btnMode.realistic, this.btnMode.debug]),
      this.btnPaste,
      h('span', { class: 'spacer' }),
      this.nameInput,
    ]);

    this.layerList = h('ul', { class: 'layers', 'data-testid': 'layers' });
    this.stackPanel = h('div', { class: 'stack' });
    const left = h('aside', { class: 'panel left' }, [
      h('h2', {}, 'Layers'),
      this.layerList,
      h('h2', {}, 'Board materials'),
      this.stackPanel,
    ]);

    this.inspector = h('div', { 'data-testid': 'inspector' });
    this.diagPanel = h('div', { 'data-testid': 'diagnostics' });
    const right = h('aside', { class: 'panel right' }, [
      h('h2', {}, 'Inspector'),
      this.inspector,
      h('h2', {}, 'File messages'),
      this.diagPanel,
    ]);

    this.canvas = h('canvas', { 'data-testid': 'board' });
    this.overlay = h('canvas', { class: 'overlay' });
    this.empty = h('div', { class: 'empty' }, [
      h('div', {}, [
        h('div', {}, 'Drop Gerber, Excellon, .gbrjob or .zip files here'),
        h('div', { class: 'muted' }, 'or a .pcam project · everything stays on this computer'),
      ]),
    ]);
    this.banner = h('div', { class: 'banner hidden' });
    this.main = h('main', { class: 'main' }, [
      this.canvas,
      this.overlay,
      this.empty,
      h('div', { class: 'drop' }, 'Drop to load'),
      this.banner,
    ]);

    this.statusPos = h('span', {}, '');
    this.statusZoom = h('span', {}, '');
    this.statusMsg = h('span', { 'data-testid': 'status' }, '');
    this.statusHover = h('span', {}, '');
    const status = h('footer', { class: 'status' }, [
      this.statusPos,
      this.statusZoom,
      this.statusMsg,
      this.statusHover,
    ]);

    clear(this.root);
    this.root.append(toolbar, left, this.main, right, status);
    this.#bindDrop();
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.save();
      } else if (e.target === document.body && e.key.toLowerCase() === 'f') this.viewer.fit();
      else if (e.key === 'Escape') this.viewer.select(null);
    });
  }

  #bindDrop() {
    let depth = 0;
    const m = this.main;
    m.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      m.classList.add('dragging');
    });
    m.addEventListener('dragover', (e) => e.preventDefault());
    m.addEventListener('dragleave', () => {
      if (--depth <= 0) m.classList.remove('dragging');
    });
    m.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      m.classList.remove('dragging');
      this.#onFiles(e.dataTransfer.files);
    });
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
    const pcam = files.find((f) => isPcamName(f.name));
    if (pcam) {
      try {
        const { project, sources, migratedFrom } = loadPcam(pcam.bytes);
        this.project = project;
        this.sources = sources;
        this.fileHandle = null;
        this.nameInput.value = project.name;
        this.#rebuild({ keepView: true });
        this.#message(`Opened ${pcam.name}${migratedFrom !== null ? ` (migrated from schema ${migratedFrom})` : ''}`);
      } catch (e) {
        this.#message(e instanceof PcamError ? e.message : `Could not open ${pcam.name}: ${e.message}`, true);
      }
      return;
    }
    const skipped = [];
    let added = 0;
    for (const f of files) {
      const r = addSourceFile(this.project, this.sources, f.name, f.bytes);
      added += r.added.length;
      skipped.push(...r.skipped);
    }
    if (this.project.name === 'Untitled' && added) {
      const guess = guessProjectName(this.project.sources.map((s) => s.name));
      if (guess) this.nameInput.value = this.project.name = guess;
    }
    this.#rebuild({ fit: true });
    this.#message(
      `Loaded ${added} file${added === 1 ? '' : 's'}${skipped.length ? ` · skipped: ${skipped.join('; ')}` : ''}`,
      !!skipped.length && !added,
    );
  }

  #rebuild({ fit = false, keepView = false } = {}) {
    const t0 = performance.now();
    const { layers, job } = buildLayers(this.project, this.sources);
    this.layers = layers;
    this.job = job;
    this.textCache.clear();
    this.parseMs = performance.now() - t0;
    if (!this.layers.find((l) => l.id === this.activeLayerId)) this.activeLayerId = this.layers[0]?.id ?? null;
    this.viewer.settings.side = this.project.view.side;
    this.viewer.settings.mode = this.project.view.mode;
    this.viewer.settings.showPaste = !!this.project.view.showPaste;
    this.viewer.settings.stackup = this.project.stackup;
    this.viewer.setLayers(this.#renderLayers());
    const v = this.project.view;
    if (keepView && Number.isFinite(v.scale) && v.scale > 0) this.viewer.setView(v);
    else if (fit || keepView) this.viewer.fit();
    this.selection = null;
    this.#refresh();
    this.#touch(false);
  }

  #renderLayers() {
    return this.layers;
  }

  // ---------------------------------------------------------------- state changes

  #setView(patch) {
    Object.assign(this.project.view, patch);
    this.viewer.setSettings(patch);
    this.#refreshToolbar();
    this.#touch();
  }

  #onView(v) {
    this.project.view.cx = v.cx;
    this.project.view.cy = v.cy;
    this.project.view.scale = v.scale;
    this.statusZoom.textContent = `${v.scale >= 10 ? v.scale.toFixed(0) : v.scale.toPrecision(3)} px/mm`;
    this.#touch();
  }

  #setLayer(id, patch) {
    const s = this.project.layers[id];
    Object.assign(s, patch);
    const l = this.layerById(id);
    if (l) {
      if ('visible' in patch) l.visible = patch.visible;
      if ('opacity' in patch) l.opacity = patch.opacity;
    }
    if ('role' in patch) return this.#rebuild({ keepView: true });
    this.viewer.layersChanged();
    this.#touch();
  }

  #setStackup(patch) {
    Object.assign(this.project.stackup, patch, { source: 'user' });
    this.viewer.settings.stackup = this.project.stackup;
    this.viewer.layersChanged();
    this.#refreshStack();
    this.#touch();
  }

  #touch(modified = true) {
    if (modified) this.project.modified = new Date().toISOString();
    clearTimeout(this.autosaveTimer);
    if (!this.project.sources.length) return;
    this.autosaveTimer = setTimeout(() => {
      try {
        saveAutosave(savePcam(this.project, this.sources)).catch(() => {});
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
    if (!this.project.sources.length) return this.#message('Nothing to save yet: load some files first', true);
    const bytes = savePcam(this.project, this.sources);
    const name = `${safeFileName(this.project.name)}.pcam`;
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
            this.banner.classList.add('hidden'), this.loadFiles([{ name: 'recovered.pcam', bytes: rec.bytes }])
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
    this.statusMsg.style.color = isError ? 'var(--err)' : '';
  }

  // ---------------------------------------------------------------- panels

  #refresh() {
    this.empty.classList.toggle('hidden', this.layers.length > 0);
    this.btnSave.disabled = this.btnSaveAs.disabled = !this.project.sources.length;
    this.#refreshToolbar();
    this.#refreshLayers();
    this.#refreshStack();
    this.#refreshInspector();
    this.#refreshDiagnostics();
  }

  #refreshToolbar() {
    const v = this.project.view;
    for (const [k, b] of Object.entries(this.btnSide)) b.classList.toggle('on', v.side === k);
    for (const [k, b] of Object.entries(this.btnMode)) b.classList.toggle('on', v.mode === k);
    this.btnPaste.classList.toggle('on', !!v.showPaste);
  }

  #refreshLayers() {
    clear(this.layerList);
    for (const l of this.layers) {
      const errs = l.diagnostics.list.filter((d) => d.severity === 'error').length;
      const warns = l.diagnostics.list.filter((d) => d.severity === 'warning').length;
      const roleSel = h('select', {
        title: `Layer function (detected from ${l.autoRole.source})`,
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
      const row = h(
        'li',
        {
          class: `layer${l.id === this.activeLayerId ? ' active' : ''}`,
          'data-testid': 'layer',
          'data-name': l.name,
          'data-role': `${l.role.type}:${l.role.side}`,
          onclick: () => {
            this.activeLayerId = l.id;
            this.#refreshLayers();
            this.#refreshDiagnostics();
          },
        },
        [
          h('input', {
            type: 'checkbox',
            checked: l.visible,
            title: 'Show layer',
            onclick: (e) => e.stopPropagation(),
            onchange: (e) => this.#setLayer(l.id, { visible: e.target.checked }),
          }),
          h('span', { class: 'swatch', style: `background:${rgba(swatchColour(l, this.project), 1)}` }),
          h('span', { class: 'name', title: l.name }, l.name),
          h('span', { class: 'badges' }, [
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
            h('span', { class: 'source', title: 'How the layer function was found' }, l.role.source),
            h(
              'button',
              {
                title: 'Remove from project',
                onclick: (e) => {
                  e.stopPropagation();
                  removeSource(this.project, this.sources, l.id);
                  this.#rebuild({ keepView: true });
                },
              },
              '×',
            ),
          ]),
        ],
      );
      this.layerList.append(row);
    }
    const others = this.project.sources.filter((s) => !this.layers.find((l) => l.id === s.id));
    for (const s of others)
      this.layerList.append(
        h('li', { class: 'layer muted' }, [
          h('span'),
          h('span'),
          h('span', { class: 'name' }, `${s.name} (${s.kind})`),
        ]),
      );
  }

  #refreshStack() {
    const st = this.project.stackup;
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
    if (hit) this.activeLayerId = hit.layerId;
    this.#refreshInspector();
    this.#refreshLayers();
    this.#refreshDiagnostics();
  }

  #sourceLine(layer, line) {
    let lines = this.textCache.get(layer.id);
    if (!lines) {
      const bytes = this.sources.get(layer.id);
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
      const desc =
        ap.kind === 'macro'
          ? `macro ${ap.template}(${ap.params.join(', ')})`
          : ap.kind === 'C'
            ? `circle ⌀${fmt(ap.dia)} mm`
            : ap.kind === 'R' || ap.kind === 'O'
              ? `${ap.kind === 'R' ? 'rectangle' : 'obround'} ${fmt(ap.w)} × ${fmt(ap.h)} mm`
              : `${ap.template} ${ap.params.join(' × ')}`;
      rows.push([l.kind === 'excellon' ? 'Tool' : 'Aperture', `${label} · ${desc}`]);
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
    rows.push(['Source line', String(o.ln)]);
    this.inspector.append(
      h(
        'dl',
        { class: 'kv' },
        rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]),
      ),
    );
    this.inspector.append(
      h('div', { class: 'code', 'data-testid': 'source-line' }, `${o.ln}: ${this.#sourceLine(l, o.ln)}`),
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
  if (project.view.mode === 'debug') {
    if (l.role.type === 'profile') return DEBUG.profile;
    if (l.role.type === 'drill') return DEBUG.drill;
    return DEBUG[`${l.role.type}_${l.role.side}`] || DEBUG.other;
  }
  const st = project.stackup;
  if (l.role.type === 'soldermask') return lookupMaterial('mask', st.mask?.[l.role.side] ?? st.mask).value;
  if (l.role.type === 'legend') return lookupMaterial('silk', st.silk?.[l.role.side] ?? st.silk).value;
  if (l.role.type === 'copper') return lookupMaterial('finish', st.finish).value;
  if (l.role.type === 'substrate') return lookupMaterial('substrate', st.substrate).value;
  return DEBUG[l.role.type] || DEBUG.other;
}

function describeShort(hit, layer) {
  const o = hit.object;
  const ap = o.ap ? `${layer.kind === 'excellon' ? 'T' : 'D'}${o.ap.code} ` : '';
  return `${layer.name} · ${ap}${KIND_LABEL[o.k]} · line ${o.ln}`;
}

function fmt(v) {
  return Number.isFinite(v) ? (Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(4).replace(/\.?0+$/, '')) : '—';
}

function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function safeFileName(s) {
  return s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'project';
}

function guessProjectName(names) {
  const job = names.find((n) => /\.gbrjob$/i.test(n));
  if (job) return job.replace(/(-job)?\.gbrjob$/i, '');
  const kicad = names.map((n) => /^(.*?)-(F|B|In\d+|Edge)[_.]/.exec(n)?.[1]).find(Boolean);
  if (kicad) return kicad;
  const stems = names.map((n) => n.replace(/\.[^.]+$/, ''));
  return stems.length && stems.every((s) => s === stems[0]) ? stems[0] : null;
}

function downloadBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
