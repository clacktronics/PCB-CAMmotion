// Editor (milestone 4): edit mode, a Photoshop-style tool strip on the board (select, lasso,
// hand, pad or hole, track, region), selection with drag-move, box and lasso select (dragged
// left to right: objects entirely inside; right to left: anything touched), double-click to
// select connected, a right-click menu (same shape, same aperture, connected, select all,
// move by, to region, delete), the current tool's options in the top bar, and the Edit menu's
// actions (undo/redo, unify the layer, revert, export of the edited file). Box and lasso pick
// from the edited layer, every shown layer or the soloed layers (Pick from, in the top bar);
// moving or deleting a selection on several layers edits each of them, as one undo step.
// The edits themselves are DOM-free (src/edit/); this file turns pointer and key input into
// edit ops. Its settings live in settings.edit of the .pcam (src/project/project.js).

import { h, clear } from './dom.js';
import { layerEditor, revertEdits, EDIT_TOOLS } from '../project/project.js';
import { EditError } from '../edit/session.js';
import { describeAperture } from '../analyze/apertures.js';
import { MISC, rgba } from '../model/materials.js';
import { objectsInPolygon, boxPolygon, sameShape, sameAperture, connected, pickLayers } from '../edit/selection.js';
import { openMenu } from './context-menu.js';

const TOOL_LABEL = { select: 'Select', lasso: 'Lasso', hand: 'Hand', pad: 'Pad', track: 'Track', region: 'Region' };
const TOOL_KEY = { v: 'select', l: 'lasso', h: 'hand', p: 'pad', t: 'track', r: 'region' };
const PICK_HELP = 'Shift adds to the selection, Alt or Ctrl takes away';
const PICK_FROM_LABEL = { layer: 'This layer', all: 'All layers', solo: 'Soloed layers' };
const PICK_FROM_TITLE =
  'The layers a box or lasso selects on: the edited layer, every shown Gerber and drill layer, or the soloed layers (none soloed: the edited layer). Moving or deleting the selection edits every layer it is on.';
const TOOL_TITLE = {
  select: `Select (V): click an object, double-click to select everything connected; drag a box left to right to pick objects entirely inside (green), right to left to pick anything it touches (red) (${PICK_HELP}); drag a selected object to move it`,
  lasso: `Lasso (L): draw round the objects to select; start rightwards to pick objects entirely inside (green), leftwards to pick anything it touches (red) (${PICK_HELP})`,
  hand: 'Hand (H): drag to pan the board (any tool: hold Space or drag with the middle button)',
  pad: 'Pad (P): click to place a pad with the chosen aperture (on a drill layer: a hole)',
  track:
    'Track (T): click the points, double-click or Enter to finish, Backspace removes the last point, Shift keeps to 45°',
  region:
    'Region (R): click the corners like a pen tool, click the first point, double-click or Enter to close it; Shift keeps to 45°',
};
// tool strip icons: 24×24 line drawings (currentColor)
const ICON = {
  select: '<path d="M6 3l12 9-5.5 1 3.2 6.3-2.4 1.2-3.2-6.4L6 18z"/>',
  lasso: '<ellipse cx="12" cy="9" rx="8" ry="5" stroke-dasharray="3 2"/><path d="M7 13c-2 2-1 4 1 4s2 2 0 4"/>',
  hand: '<path d="M8 12V5.5a1.5 1.5 0 013 0V11m0-6.5V4a1.5 1.5 0 013 0v7m0-6a1.5 1.5 0 013 0v7m0-3a1.5 1.5 0 013 0v4c0 4-3 7-7 7h-1c-3 0-4.5-1.5-6-4l-2.6-4.4a1.5 1.5 0 012.6-1.5L8 15"/>',
  pad: '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  track: '<path d="M4 18h6l8-8h3" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
  region:
    '<path d="M4 20l3-11 10-4 3 10-9 6z"/><circle cx="4" cy="20" r="1.6"/><circle cx="7" cy="9" r="1.6"/><circle cx="17" cy="5" r="1.6"/><circle cx="20" cy="15" r="1.6"/><circle cx="11" cy="21" r="1.6"/>',
};
const CLOSE_PX = 8;
const LASSO_STEP_PX = 3;
const LASSO_DIR_PX = 4; // how far a lasso must move sideways before its first direction counts

export class EditorPanel {
  /**
   * @param {{settings:()=>object, layer:()=>object|null, project:()=>object, viewer:object,
   *   commit:(layer:object)=>void, inspect:(hit:object|null)=>void, message:(t:string, err?:boolean)=>void,
   *   download:(text:string, name:string)=>void, touch:()=>void, changed:()=>void,
   *   layers:()=>object[], editLayer:(id:string)=>void, autoSelectLayer:()=>boolean}} host
   */
  constructor(host) {
    this.host = host;
    this.selected = new Map(); // layer id → selected object indices (sorted, never empty)
    this.groups = new WeakMap(); // op → [{ layerId, op }]: ops made together on several layers
    this.sketch = []; // points of the track/region being drawn (mm)
    this.cursor = null;
    this.drag = null; // { kind: 'move'|'box'|'lasso', start, dx, dy, end, points, x0, mode }
    this.busy = false;
    this.space = false; // Space held: drags pan, whatever the tool
    // the current tool's options, right-aligned in the top bar
    this.el = h('div', {
      class: 'edit-options hidden',
      role: 'toolbar',
      'aria-label': 'Tool options',
      'data-testid': 'editor',
    });
    this.strip = h('nav', { class: 'tool-strip hidden', 'data-testid': 'tool-strip', 'aria-label': 'Edit tools' });
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') this.space = false;
    });
    window.addEventListener('blur', () => (this.space = false));
    this.toolbarButton = h(
      'button',
      {
        'data-testid': 'edit-toggle',
        title: 'Edit mode (E): select, move, delete and add pads, tracks, regions and holes on the selected layer',
        onclick: () => this.setOn(!this.s.on),
      },
      'Edit',
    );
  }

  get s() {
    return this.host.settings();
  }

  /** Selected object indices on the edited layer. */
  get sel() {
    const l = this.layer();
    return (l && this.selected.get(l.id)) || [];
  }

  /** Number of selected objects on every layer. */
  get selCount() {
    let n = 0;
    for (const indices of this.selected.values()) n += indices.length;
    return n;
  }

  get on() {
    return !!this.s.on;
  }

  layer() {
    const l = this.host.layer();
    return l && (l.kind === 'gerber' || l.kind === 'excellon') ? l : null;
  }

  setOn(on) {
    this.s.on = on;
    this.cancelSketch();
    this.#setSelection([]);
    this.host.touch();
    this.refresh();
  }

  setTool(tool) {
    if (!EDIT_TOOLS.includes(tool)) return;
    this.s.tool = tool;
    this.cancelSketch();
    this.host.touch();
    this.refresh();
  }

  /** The edited layer changed (another layer selected, or the layers were rebuilt). */
  layerChanged() {
    this.cancelSketch();
    this.#setSelection([]);
    this.refresh();
  }

  cancelSketch() {
    this.sketch = [];
    this.drag = null;
    this.host.viewer.drawOverlay();
  }

  // ---------------------------------------------------------------- panel

  refresh() {
    const v = this.host.viewer;
    const on = this.on;
    const layer = this.layer();
    this.toolbarButton.classList.toggle('on', on);
    this.toolbarButton.setAttribute('aria-pressed', on ? 'true' : 'false');
    this.el.classList.toggle('hidden', !on);
    v.edit = on ? this.#handler() : null;
    v.overlayHook = on ? (ctx, map) => this.#drawOverlay(ctx, map) : null;
    v.settings.pickLayerId = on && layer ? layer.id : null;
    v.editSelection = on ? this.#viewSelection() : null;
    v.canvas.classList.toggle('editing', on);
    v.canvas.dataset.tool = on ? this.s.tool : '';
    v.drawOverlay();
    this.#refreshStrip();
    this.refreshMenu();
    clear(this.el);
    if (!on) return;
    if (!layer) {
      this.el.append(h('span', { class: 'muted' }, 'Select a Gerber or drill layer to edit it'));
      return;
    }
    const ed = layer.editor;
    const problems = ed ? ed.problems : [];
    const tool = this.s.tool;
    const n = this.selCount;
    const onLayers = this.selected.size;
    this.el.append(h('span', { class: 'tool-name', 'data-testid': 'edit-tool' }, this.#toolLabel(tool)));
    if (tool === 'pad' || tool === 'track') this.el.append(this.#apertureRow(layer));
    if (tool === 'select' || tool === 'lasso') {
      const pickFrom = h(
        'select',
        {
          'data-testid': 'pick-from',
          onchange: (e) => {
            this.s.pickFrom = e.target.value;
            this.host.touch();
          },
        },
        Object.entries(PICK_FROM_LABEL).map(([value, label]) =>
          h('option', { value, selected: this.s.pickFrom === value }, label),
        ),
      );
      this.el.append(h('label', { title: PICK_FROM_TITLE }, ['Pick from ', pickFrom]));
    }
    this.el.append(
      h('label', { title: 'Positions and moves snap to this grid (0 = no snapping)' }, [
        'Grid ',
        numInput(this.s.gridMm, 'grid', (v) => {
          this.s.gridMm = Math.max(0, v);
          this.host.touch();
        }),
        ' mm',
      ]),
      h(
        'span',
        { class: 'muted', 'data-testid': 'edit-selection' },
        n ? `${n} selected${onLayers > 1 ? ` on ${onLayers} layers` : ''}` : 'Nothing selected',
      ),
      h(
        'span',
        {
          class: `edit-status${problems.length ? ' error' : ' muted'}`,
          'data-testid': 'edit-status',
          title: problems.length
            ? problems.join('; ')
            : 'Edits are saved in the project; the original file is kept (Edit menu: revert)',
        },
        problems.length
          ? `${layer.name} cannot be edited: ${problems.join('; ')}`
          : ed?.ops.length
            ? `${layer.name}: ${ed.ops.length} edit${ed.ops.length === 1 ? '' : 's'}`
            : `${layer.name}: no edits`,
      ),
    );
  }

  /**
   * Items of the top bar's Edit menu (built once; their state follows refresh() and
   * refreshMenu()). Selection actions live in the board's right-click menu.
   */
  menuItems() {
    const btn = (label, testid, title, onclick) => h('button', { 'data-testid': testid, title, onclick }, label);
    this.menu = {
      undo: btn('Undo', 'edit-undo', 'Undo the last edit of this layer (Ctrl+Z)', () => this.undo()),
      redo: btn('Redo', 'edit-redo', 'Redo (Ctrl+Shift+Z or Ctrl+Y)', () => this.redo()),
      toRegion: btn(
        'Selection to regions',
        'edit-to-region',
        'Turn the selected pads, tracks and fills into G36/G37 regions; overlapping ones are unified into one outline',
        () => this.toRegion(),
      ),
      unify: btn(
        'Unify layer to regions',
        'edit-unify',
        'Replace everything on this layer with non-overlapping G36/G37 regions: tracks, pads, fills and clear polarity merged into outlines (arcs within 0.5 µm)',
        () => this.unifyLayer(),
      ),
      revert: btn(
        'Revert edits on current layer',
        'edit-revert',
        'Drop every edit of this layer: back to the original file',
        () => this.revert(),
      ),
      revertAll: btn(
        'Revert all edits',
        'edit-revert-all',
        'Drop the edits of every layer: back to the original files',
        () => this.revertAll(),
      ),
      exportFile: btn('Export edited layer…', 'edit-export', 'Download the current layer with its edits', () =>
        this.exportFile(),
      ),
    };
    this.refreshMenu();
    return this.menu;
  }

  /** Enable the Edit menu's items for the current layer and selection. */
  refreshMenu() {
    const m = this.menu;
    if (!m) return;
    const layer = this.layer();
    const ed = layer?.editor;
    const drill = layer?.kind === 'excellon';
    m.undo.disabled = !ed?.canUndo;
    m.redo.disabled = !ed?.canRedo;
    m.toRegion.disabled = !layer || drill || !this.on || !this.sel.length;
    m.unify.disabled = !layer || drill;
    m.revert.disabled = !ed?.ops.length;
    m.revertAll.disabled = !this.host.layers().some((l) => l.editor?.ops.length);
    m.exportFile.disabled = !layer;
    m.exportFile.title = layer
      ? `Download ${layer.name} with its edits (${drill ? 'Excellon' : 'Gerber RS-274X'})`
      : 'Select a Gerber or drill layer';
  }

  /** Tools of the edited layer: drill layers have no tracks or regions. */
  #tools(layer) {
    return layer?.kind === 'excellon' ? EDIT_TOOLS.filter((t) => t !== 'track' && t !== 'region') : EDIT_TOOLS;
  }

  #toolLabel(tool) {
    return tool === 'pad' && this.layer()?.kind === 'excellon' ? 'Hole' : TOOL_LABEL[tool];
  }

  /** The tool strip on the board's left edge (Photoshop-style). */
  #refreshStrip() {
    const layer = this.layer();
    const on = this.on;
    clear(this.strip);
    this.strip.classList.toggle('hidden', !on);
    if (!on) return;
    const tools = this.#tools(layer);
    if (!tools.includes(this.s.tool)) this.s.tool = 'select';
    const icon = (name) => {
      const s = h('span', { class: 'icon', 'aria-hidden': 'true' });
      // fixed markup from ICON above, never user data
      s.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6">${ICON[name]}</svg>`;
      return s;
    };
    const button = (name, label, attrs) => h('button', { ...attrs, 'aria-label': label }, [icon(name)]);
    const groups = [
      ['select', 'lasso', 'hand'],
      ['pad', 'track', 'region'],
    ];
    for (const g of groups) {
      const shown = g.filter((t) => tools.includes(t));
      if (!shown.length) continue;
      if (this.strip.childElementCount) this.strip.append(h('span', { class: 'strip-sep' }));
      for (const t of shown) {
        this.strip.append(
          button(t, this.#toolLabel(t), {
            class: this.s.tool === t ? 'on' : '',
            'aria-pressed': this.s.tool === t ? 'true' : 'false',
            'data-testid': `tool-${t}`,
            title: TOOL_TITLE[t],
            disabled: !layer,
            onclick: () => this.setTool(t),
          }),
        );
      }
    }
  }

  #apertureRow(layer) {
    if (layer.kind === 'excellon') {
      return h('div', { class: 'edit-row' }, [
        h('label', {}, [
          'Hole ⌀ ',
          numInput(this.s.holeDiaMm, 'hole-dia', (v) => {
            this.s.holeDiaMm = v;
            this.host.touch();
          }),
          ' mm',
        ]),
      ]);
    }
    const a = this.s.aperture;
    const usable = [...layer.image.apertures.values()].filter((ap) =>
      this.s.tool === 'track' ? ap.kind === 'C' || ap.kind === 'R' : ap.kind !== 'block' && ap.shape,
    );
    const current = usable.some((ap) => ap.code === a.code) ? String(a.code) : 'new';
    const sel = h(
      'select',
      {
        'data-testid': 'edit-aperture',
        onchange: (e) => {
          a.code = e.target.value === 'new' ? null : Number(e.target.value);
          this.host.touch();
          this.refresh();
        },
      },
      [
        ...usable.map((ap) =>
          h(
            'option',
            { value: String(ap.code), selected: current === String(ap.code) },
            `D${ap.code} · ${describeAperture(ap)}`,
          ),
        ),
        h('option', { value: 'new', selected: current === 'new' }, 'New aperture…'),
      ],
    );
    const row = [h('label', {}, ['Aperture ', sel])];
    if (current === 'new') {
      const templates = this.s.tool === 'track' ? ['C', 'R'] : ['C', 'R', 'O'];
      if (!templates.includes(a.template)) a.template = 'C';
      row.push(
        h(
          'select',
          {
            'data-testid': 'edit-template',
            onchange: (e) => {
              a.template = e.target.value;
              this.host.touch();
              this.refresh();
            },
          },
          templates.map((t) =>
            h('option', { value: t, selected: a.template === t }, { C: 'Circle', R: 'Rectangle', O: 'Obround' }[t]),
          ),
        ),
        numInput(a.sizesMm[0], 'edit-size-w', (v) => {
          a.sizesMm[0] = v;
          this.host.touch();
        }),
      );
      if (a.template !== 'C')
        row.push(
          '×',
          numInput(a.sizesMm[1], 'edit-size-h', (v) => {
            a.sizesMm[1] = v;
            this.host.touch();
          }),
        );
      row.push(' mm');
    }
    return h('div', { class: 'edit-row' }, row);
  }

  /** The aperture reference for new pads and tracks (an op's `aperture`). */
  #apertureRef(layer) {
    const a = this.s.aperture;
    if (a.code !== null && layer.image.apertures.get(a.code)?.shape) return { code: a.code };
    return { template: a.template, paramsMm: a.template === 'C' ? [a.sizesMm[0]] : [a.sizesMm[0], a.sizesMm[1]] };
  }

  /** Half sizes (mm) of the aperture new objects use, for the previews. */
  #apertureHalf(layer) {
    if (layer.kind === 'excellon') return { round: true, w: this.s.holeDiaMm / 2, h: this.s.holeDiaMm / 2 };
    const ref = this.#apertureRef(layer);
    if (ref.code !== undefined) {
      const ap = layer.image.apertures.get(ref.code);
      const b = ap.shape.bbox;
      return { round: ap.kind === 'C', w: (b[2] - b[0]) / 2, h: (b[3] - b[1]) / 2 };
    }
    const [w, hh = w] = ref.paramsMm;
    return { round: ref.template === 'C', w: w / 2, h: hh / 2 };
  }

  // ---------------------------------------------------------------- actions

  /** Select objects of the edited layer only (the selection on other layers is dropped). */
  #setSelection(indices) {
    const layer = this.layer();
    this.#setSelected(new Map(layer ? [[layer.id, indices]] : []));
  }

  /** Change the edited layer's part of the selection, keeping the other layers'. */
  #setLayerSelection(indices) {
    const layer = this.layer();
    if (!layer) return;
    this.#setSelected(new Map([...this.selected, [layer.id, indices]]));
  }

  /** Set the whole selection: layer id → object indices. One selected object is inspected. */
  #setSelected(byLayer) {
    this.selected = new Map();
    for (const [id, indices] of byLayer) {
      const sorted = [...new Set(indices)].sort((a, b) => a - b);
      if (sorted.length) this.selected.set(id, sorted);
    }
    const v = this.host.viewer;
    v.editSelection = this.#viewSelection();
    v.drawOverlay();
    const [only] = this.selCount === 1 ? this.selected : [];
    const layer = only && this.#layerById(only[0]);
    const o = layer?.image?.objects[only[1][0]];
    this.host.inspect(o ? { layerId: layer.id, index: only[1][0], object: o, x: null, y: null } : null);
  }

  #viewSelection() {
    return [...this.selected].map(([layerId, indices]) => ({ layerId, indices }));
  }

  #layerById(id) {
    return this.host.layers().find((l) => l.id === id) || null;
  }

  /** Selected layers with their indices, the edited layer first. */
  #selectedLayers() {
    const active = this.layer()?.id;
    const out = [];
    for (const [id, indices] of this.selected) {
      const layer = this.#layerById(id);
      if (layer?.image) out[id === active ? 'unshift' : 'push']({ layer, indices });
    }
    return out;
  }

  /** The layers a box or lasso picks from (Pick from in the top bar). */
  #pickFromLayers() {
    const v = this.host.viewer;
    return pickLayers(v.layers, { from: this.s.pickFrom, activeId: this.layer()?.id ?? null, solo: v.settings.solo });
  }

  /** Select objects of the edited layer (e.g. from the analyser's command list). */
  select(indices) {
    this.#setSelection(indices);
    this.refresh();
  }

  selectAll() {
    const layer = this.layer();
    if (!layer) return;
    this.#setSelection(layer.image.objects.map((_, i) => i));
    this.refresh();
  }

  invertSelection() {
    const layer = this.layer();
    if (!layer) return;
    const sel = new Set(this.sel);
    this.#setSelection(layer.image.objects.map((_, i) => i).filter((i) => !sel.has(i)));
    this.refresh();
  }

  /**
   * Select by a query on the selection (src/edit/selection.js): same shape, same aperture,
   * connected. The result replaces the selection and is reported in the status bar.
   */
  selectBy(kind) {
    const layer = this.layer();
    if (!layer || !this.sel.length) return;
    const query = { shape: sameShape, aperture: sameAperture, connected }[kind];
    const found = query(layer.image, this.sel);
    this.#setSelection(found);
    this.refresh();
    const what = { shape: 'with the same shape', aperture: 'with the same aperture', connected: 'connected' }[kind];
    this.host.message(`${found.length} object${found.length === 1 ? '' : 's'} ${what}`);
  }

  /**
   * Box or lasso: combine what the polygon picks (mode enclose: entirely inside; touch: anything
   * touched) with the selection (Shift adds, Alt/Ctrl removes).
   */
  #pickPolygon(poly, mode, e) {
    if (!this.layer()) return;
    const take = e.altKey || e.ctrlKey || e.metaKey;
    const next = take || e.shiftKey ? new Map(this.selected) : new Map();
    for (const l of this.#pickFromLayers()) {
      const picked = objectsInPolygon(l.image, poly, mode);
      const had = this.selected.get(l.id) || [];
      if (take) {
        const drop = new Set(picked);
        next.set(
          l.id,
          had.filter((i) => !drop.has(i)),
        );
      } else next.set(l.id, e.shiftKey ? [...had, ...picked] : picked);
    }
    this.#setSelected(next);
    this.refresh();
  }

  /**
   * Right-click on the board. In edit mode: a menu for the object under the pointer (it is
   * selected first unless already part of the selection) or for the selection. Outside edit
   * mode: the same selection queries, which switch to editing that object's layer.
   */
  contextMenu(mm, clientX, clientY) {
    const v = this.host.viewer;
    const hit = v.pickAt(mm[0], mm[1]);
    if (!this.on) {
      const l = hit && this.host.layers().find((x) => x.id === hit.layerId);
      if (!l || (l.kind !== 'gerber' && l.kind !== 'excellon')) return false;
      // connectivity is a copper question: a hole, mask opening or legend on top of a pad
      // must not stand in for the pad, so look for the topmost copper object under the pointer
      const copper = v.pickAt(mm[0], mm[1], (x) => x.kind === 'gerber' && x.role?.type === 'copper');
      const edit =
        (then, h = hit) =>
        () => {
          this.host.editLayer(h.layerId);
          if (!this.on) this.setOn(true);
          this.select([h.index]);
          then?.();
        };
      openMenu(clientX, clientY, [
        { label: `Edit ${l.name}`, hint: 'E', testid: 'ctx-edit', action: edit() },
        null,
        { label: 'Select same shape', testid: 'ctx-same-shape', action: edit(() => this.selectBy('shape')) },
        {
          label: 'Select same aperture',
          testid: 'ctx-same-aperture',
          disabled: !hit.object.ap,
          action: edit(() => this.selectBy('aperture')),
        },
        {
          label: 'Select connected',
          testid: 'ctx-connected',
          disabled: !copper,
          action: copper && edit(() => this.selectBy('connected'), copper),
        },
      ]);
      return true;
    }
    const layer = this.layer();
    if (!layer) return false;
    if (this.sketch.length) this.cancelSketch();
    if (hit && !this.sel.includes(hit.index)) this.select([hit.index]);
    const objs = this.sel.map((i) => layer.image.objects[i]);
    const n = this.sel.length;
    const all = this.selCount; // move, delete and deselect take the selection on every layer
    const codes = [...new Set(objs.filter((o) => o.ap).map((o) => o.ap.code))];
    const drill = layer.kind === 'excellon';
    openMenu(clientX, clientY, [
      { label: 'Select same shape', testid: 'ctx-same-shape', disabled: !n, action: () => this.selectBy('shape') },
      {
        label: 'Select same aperture',
        hint: codes.length === 1 ? `${drill ? 'T' : 'D'}${codes[0]}` : '',
        testid: 'ctx-same-aperture',
        disabled: !codes.length,
        action: () => this.selectBy('aperture'),
      },
      { label: 'Select connected', testid: 'ctx-connected', disabled: !n, action: () => this.selectBy('connected') },
      null,
      { label: 'Select all', hint: 'Ctrl+A', testid: 'ctx-select-all', action: () => this.selectAll() },
      { label: 'Invert selection', hint: 'Ctrl+I', testid: 'ctx-invert', action: () => this.invertSelection() },
      {
        label: 'Deselect',
        hint: 'Esc',
        testid: 'ctx-deselect',
        disabled: !all,
        action: () => (this.#setSelection([]), this.refresh()),
      },
      null,
      { label: 'Move by…', hint: '←↑→↓', testid: 'ctx-move', disabled: !all, action: () => this.promptMove() },
      ...(drill ? [] : [{ label: 'To region', testid: 'ctx-to-region', disabled: !n, action: () => this.toRegion() }]),
      { label: 'Delete', hint: 'Del', testid: 'ctx-delete', disabled: !all, action: () => this.deleteSelection() },
    ]);
    return true;
  }

  /** Command targets of the selection, or null (with a message) if one cannot be edited. */
  #targets(layer, indices = this.sel, named = false) {
    const ed = layerEditor(layer);
    const out = new Set();
    for (const i of indices) {
      const t = ed.target(i);
      if (t.error) {
        this.host.message(named ? `${layer.name}: ${t.error}` : t.error, true);
        return null;
      }
      out.add(t.ci);
    }
    return [...out];
  }

  /** Run one op on the active layer; on success the objects it made or moved are selected. */
  apply(op, done) {
    const layer = this.layer();
    if (!layer || this.busy) return false;
    const ed = layerEditor(layer);
    try {
      const sel = ed.apply(op);
      this.host.commit(layer);
      this.#setSelection(op.type === 'unifyLayer' ? [] : sel);
      this.refresh();
      if (done) this.host.message(typeof done === 'function' ? done() : done);
      return true;
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      this.host.message(e.message, true);
      return false;
    }
  }

  /**
   * Run one op on every layer with selected objects (makeOp gets that layer's command
   * targets). All or nothing: if one layer cannot take it, the others are undone. Ops made on
   * several layers are one undo step. The objects the ops made or moved are selected.
   */
  #applySelected(makeOp, done) {
    if (this.busy) return false;
    const jobs = [];
    const selected = this.#selectedLayers();
    for (const { layer, indices } of selected) {
      const targets = this.#targets(layer, indices, selected.length > 1);
      if (!targets) return false;
      jobs.push({ layer, op: makeOp(targets) });
    }
    if (!jobs.length) return false;
    const next = new Map();
    const made = [];
    try {
      for (const j of jobs) {
        const ed = layerEditor(j.layer);
        const redo = ed.redoOps;
        next.set(j.layer.id, ed.apply(j.op));
        made.push({ ...j, redo });
      }
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      for (const m of made) {
        m.layer.editor.undo();
        m.layer.editor.redoOps = m.redo;
      }
      this.host.message(made.length ? `${jobs[made.length].layer.name}: ${e.message}` : e.message, true);
      return false;
    } finally {
      for (const m of made) this.host.commit(m.layer);
    }
    if (jobs.length > 1) {
      const group = jobs.map((j) => ({ layerId: j.layer.id, op: j.op }));
      for (const j of jobs) this.groups.set(j.op, group);
    }
    this.#setSelected(next);
    this.refresh();
    const on = jobs.length > 1 ? ` on ${jobs.length} layers` : '';
    if (done) this.host.message(done + on);
    return true;
  }

  deleteSelection() {
    const n = this.selCount;
    if (n) this.#applySelected((targets) => ({ type: 'delete', targets }), `Deleted ${n} object${n === 1 ? '' : 's'}`);
  }

  moveSelection(dxMm, dyMm) {
    if (!this.selCount || !Number.isFinite(dxMm) || !Number.isFinite(dyMm) || (!dxMm && !dyMm)) return;
    this.#applySelected((targets) => ({ type: 'move', targets, dxMm, dyMm }), `Moved by ${fmt(dxMm)}, ${fmt(dyMm)} mm`);
  }

  /** Ask for an X, Y offset in mm and move the selection by it. */
  promptMove() {
    if (!this.selCount) return;
    const answer = window.prompt('Move the selection by X, Y (mm)', '0, 0');
    if (answer === null) return;
    const parts = answer
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length !== 2 || !parts.every(Number.isFinite))
      return this.host.message(`Move by: expected two numbers in mm, e.g. "1.5, -0.5"`, true);
    this.moveSelection(parts[0], parts[1]);
  }

  toRegion() {
    const layer = this.layer();
    const targets = layer && this.sel.length && this.#targets(layer);
    if (targets)
      this.#slow('Converting to regions…', () => this.apply({ type: 'toRegion', targets }, 'Converted to regions'));
  }

  unifyLayer() {
    const layer = this.layer();
    if (!layer) return;
    this.#slow(`Unifying ${layer.name}…`, () =>
      this.apply({ type: 'unifyLayer' }, () => `${layer.name}: unified into ${layer.image.objects.length} regions`),
    );
  }

  /** Let the status message paint before a long computation. */
  #slow(text, fn) {
    this.host.message(text);
    this.busy = true;
    setTimeout(() => {
      this.busy = false;
      fn();
    }, 30);
  }

  /**
   * The layers an undo or redo of the edited layer's next op takes: every layer of an op made
   * on several layers at once (while that op is still next on them), else just this one.
   */
  #stepLayers(layer, next) {
    const group = this.groups.get(next(layer.editor));
    if (!group) return [layer];
    return group
      .map((m) => ({ m, l: this.#layerById(m.layerId) }))
      .filter(({ m, l }) => l?.editor && next(l.editor) === m.op)
      .map(({ l }) => l);
  }

  undo() {
    const layer = this.layer();
    if (!layer?.editor?.canUndo) return;
    const layers = this.#stepLayers(layer, (ed) => ed.ops.at(-1));
    for (const l of layers) {
      l.editor.undo();
      this.host.commit(l);
    }
    this.#setSelection([]);
    this.refresh();
    this.host.message(layers.length > 1 ? `Undone on ${layers.length} layers` : 'Undone');
  }

  redo() {
    const layer = this.layer();
    if (!layer?.editor?.canRedo) return;
    const next = new Map();
    try {
      for (const l of this.#stepLayers(layer, (ed) => ed.redoOps.at(-1))) {
        next.set(l.id, l.editor.redo());
        this.host.commit(l);
      }
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      this.host.message(e.message, true);
    }
    this.#setSelected(next);
    this.refresh();
    if (next.size) this.host.message(next.size > 1 ? `Redone on ${next.size} layers` : 'Redone');
  }

  revert() {
    const layer = this.layer();
    if (!layer?.editor?.ops.length || !window.confirm(`Drop every edit of ${layer.name}?`)) return;
    revertEdits(this.host.project(), layer);
    this.host.commit(layer);
    this.#setSelection([]);
    this.refresh();
    this.host.message(`${layer.name}: back to the original file`);
  }

  revertAll() {
    const edited = this.host.layers().filter((l) => l.editor?.ops.length);
    if (
      !edited.length ||
      !window.confirm(`Drop every edit of ${edited.length} layer${edited.length === 1 ? '' : 's'}?`)
    )
      return;
    for (const layer of edited) {
      revertEdits(this.host.project(), layer);
      this.host.commit(layer);
    }
    this.#setSelection([]);
    this.refresh();
    this.host.message(`All layers back to the original files`);
  }

  exportFile() {
    const layer = this.layer();
    if (!layer) return;
    try {
      this.host.download(layerEditor(layer).write(), layer.name);
      this.host.message(`Exported ${layer.name}`);
    } catch (e) {
      this.host.message(`Export failed: ${e.message}`, true);
    }
  }

  #finishSketch() {
    const layer = this.layer();
    const pts = dedupe(this.sketch);
    const tool = this.s.tool;
    this.sketch = [];
    if (!layer) return;
    if (tool === 'track' && pts.length >= 2)
      this.apply({ type: 'addTrack', aperture: this.#apertureRef(layer), pointsMm: pts.flat() }, 'Track added');
    else if (tool === 'region' && pts.length >= 3)
      this.apply({ type: 'addRegion', pointsMm: pts.flat() }, 'Region added');
    this.host.viewer.drawOverlay();
  }

  // ---------------------------------------------------------------- input

  snap(v) {
    const g = this.s.gridMm;
    return g > 0 ? Math.round(v / g) * g : v;
  }

  #snapPt([x, y]) {
    return [round6(this.snap(x)), round6(this.snap(y))];
  }

  /** Keyboard in edit mode; returns true when the key was used. */
  keydown(e) {
    if (!this.on) return false;
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && k.toLowerCase() === 'z') {
      if (e.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if (mod && k.toLowerCase() === 'y') return (this.redo(), true);
    if (mod && k.toLowerCase() === 'a') return (this.selectAll(), true);
    if (mod && k.toLowerCase() === 'i') return (this.invertSelection(), true);
    if (mod || e.altKey) return false;
    if (k === ' ') {
      this.space = true;
      return e.target?.tagName !== 'BUTTON'; // Space still presses a focused button
    }
    if (k === 'Escape') {
      if (this.sketch.length || this.drag) this.cancelSketch();
      else (this.#setSelected(new Map()), this.refresh());
      return true;
    }
    if (k === 'Enter' && this.sketch.length) return (this.#finishSketch(), true);
    if (k === 'Delete' || k === 'Backspace') {
      if (this.sketch.length) {
        this.sketch.pop();
        this.host.viewer.drawOverlay();
      } else this.deleteSelection();
      return true;
    }
    if (k.startsWith('Arrow') && this.selCount) {
      const step = (this.s.gridMm || 0.01) * (e.shiftKey ? 10 : 1);
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[k];
      // the bottom view is mirrored: left on screen is +X on the board
      if (this.host.viewer.settings.side === 'bottom') d[0] = -d[0];
      this.moveSelection(round6(d[0]), round6(d[1]));
      return true;
    }
    const tool = TOOL_KEY[k.toLowerCase()];
    if (tool && this.#tools(this.layer()).includes(tool)) {
      this.setTool(tool);
      return true;
    }
    return false;
  }

  /**
   * Snap a new track or region point to the grid; with Shift, keep the segment from the last
   * point to a multiple of 45°.
   */
  #placePt(mm, e) {
    const last = this.sketch.at(-1);
    if (!e?.shiftKey || !last) return this.#snapPt(mm);
    const dx = mm[0] - last[0];
    const dy = mm[1] - last[1];
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    // direction as whole steps (-1, 0, 1): a 45° step moves X and Y by the same amount, so
    // a grid-snapped step count keeps the point on the grid
    const ux = Math.round(Math.cos(a));
    const uy = Math.round(Math.sin(a));
    const t = (dx * ux + dy * uy) / (ux * ux + uy * uy);
    const g = this.s.gridMm;
    const k = g > 0 ? Math.round(t / g) * g : t;
    return [round6(last[0] + ux * k), round6(last[1] + uy * k)];
  }

  #handler() {
    const v = this.host.viewer;
    return {
      down: (mm, e) => {
        const layer = this.layer();
        const tool = this.s.tool;
        if (!layer || this.space || (tool !== 'select' && tool !== 'lasso')) return false;
        // drag direction on screen (not board X: the bottom view is mirrored) picks the mode,
        // as in CAD tools: rightwards = entirely inside, leftwards = anything touched
        if (tool === 'lasso') {
          this.drag = { kind: 'lasso', points: [mm], x0: e.clientX, mode: null };
          return true;
        }
        const hit = v.pickAt(mm[0], mm[1]);
        if (hit && !e.altKey && (!e.shiftKey || this.sel.includes(hit.index))) {
          this.drag = { kind: 'move', start: mm, dx: 0, dy: 0, hit: hit.index };
          return true;
        }
        // a selected object on another layer moves the selection too
        const other = !e.altKey && v.pickAt(mm[0], mm[1], (l) => this.selected.has(l.id), null);
        if (other && this.selected.get(other.layerId).includes(other.index)) {
          this.drag = { kind: 'move', start: mm, dx: 0, dy: 0, hit: null };
          return true;
        }
        this.drag = { kind: 'box', start: mm, end: mm, x0: e.clientX, mode: 'enclose' };
        return true;
      },
      move: (mm, e) => {
        const d = this.drag;
        if (!d) return;
        if (d.kind === 'move') {
          if (d.hit !== null && !this.sel.includes(d.hit)) this.#setSelection([d.hit]);
          d.dx = round6(this.snap(mm[0] - d.start[0]));
          d.dy = round6(this.snap(mm[1] - d.start[1]));
        } else if (d.kind === 'lasso') {
          const last = d.points.at(-1);
          if (Math.hypot(mm[0] - last[0], mm[1] - last[1]) * v.view.scale >= LASSO_STEP_PX) d.points.push(mm);
          if (!d.mode && e && Math.abs(e.clientX - d.x0) >= LASSO_DIR_PX)
            d.mode = e.clientX > d.x0 ? 'enclose' : 'touch';
        } else {
          d.end = mm;
          if (e) d.mode = e.clientX >= d.x0 ? 'enclose' : 'touch';
        }
        v.drawOverlay();
      },
      up: (mm, e, moved) => {
        const d = this.drag;
        this.drag = null;
        if (!d || !moved) return v.drawOverlay();
        if (d.kind === 'move') {
          if (d.dx || d.dy) this.moveSelection(d.dx, d.dy);
          else v.drawOverlay();
          return;
        }
        if (d.kind === 'lasso') {
          d.points.push(mm);
          this.#pickPolygon(d.points.flat(), d.mode ?? 'enclose', e);
        } else this.#pickPolygon(boxPolygon(d.start, d.end), d.mode, e);
        v.drawOverlay();
      },
      click: (mm, e) => {
        const layer = this.layer();
        if (!layer) return;
        const tool = this.s.tool;
        if (tool === 'hand') return;
        if (tool === 'select' || tool === 'lasso') {
          let hit = v.pickAt(mm[0], mm[1]);
          const modifier = e.shiftKey || e.ctrlKey || e.metaKey || e.altKey;
          if (!hit && !modifier && this.host.autoSelectLayer()) {
            // auto select layer: nothing of the edited layer here, so edit the shape's own layer
            const other = v.pickAt(mm[0], mm[1], null, null);
            const l = other && this.host.layers().find((x) => x.id === other.layerId);
            if (l && (l.kind === 'gerber' || l.kind === 'excellon')) {
              this.host.editLayer(l.id);
              hit = other;
            }
          }
          if (e.shiftKey || e.ctrlKey || e.metaKey) {
            if (hit)
              this.#setLayerSelection(
                this.sel.includes(hit.index) ? this.sel.filter((i) => i !== hit.index) : [...this.sel, hit.index],
              );
          } else if (e.altKey) {
            if (hit) this.#setLayerSelection(this.sel.filter((i) => i !== hit.index));
          } else this.#setSelection(hit ? [hit.index] : []);
          this.refresh();
          return;
        }
        const p = tool === 'pad' ? this.#snapPt(mm) : this.#placePt(mm, e);
        if (tool === 'pad') {
          if (layer.kind === 'excellon')
            this.apply({ type: 'addHit', diaMm: this.s.holeDiaMm, xMm: p[0], yMm: p[1] }, 'Hole added');
          else this.apply({ type: 'addFlash', aperture: this.#apertureRef(layer), xMm: p[0], yMm: p[1] }, 'Pad added');
          return;
        }
        if (tool === 'region' && this.sketch.length >= 3) {
          const m = v.map();
          const [ax, ay] = v.toPx(m, ...this.sketch[0]);
          const [bx, by] = v.toPx(m, ...p);
          if (Math.hypot(ax - bx, ay - by) <= CLOSE_PX * v.dpr) return this.#finishSketch();
        }
        this.sketch.push(p);
        v.drawOverlay();
      },
      dblclick: (mm) => {
        if (this.sketch.length) return this.#finishSketch();
        const tool = this.s.tool;
        if (tool !== 'select' && tool !== 'lasso') return;
        // the clicks before it have already selected the shape (switching layer if need be)
        const hit = this.layer() && this.host.viewer.pickAt(mm[0], mm[1]);
        if (!hit) return;
        this.#setSelection([hit.index]);
        this.selectBy('connected');
      },
      hover: (mm, e) => {
        this.cursor = this.s.tool === 'pad' ? this.#snapPt(mm) : this.#placePt(mm, e);
        if (this.s.tool === 'pad' || this.s.tool === 'track' || this.s.tool === 'region') v.drawOverlay();
      },
    };
  }

  // ---------------------------------------------------------------- previews

  #drawOverlay(ctx, map) {
    const v = this.host.viewer;
    const layer = this.layer();
    if (!layer) return;
    const d = this.drag;
    const colour = rgba(MISC.selection, 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (d?.kind === 'move' && (d.dx || d.dy)) {
      for (const [id, indices] of this.selected)
        v.outlineObjects(ctx, map, id, indices, MISC.selection, 0.15, d.dx, d.dy);
    }
    if (d?.kind === 'box' || d?.kind === 'lasso') {
      // inside-only picks draw green and solid, touching picks red and dashed (as in CAD tools)
      const touch = d.mode === 'touch';
      const pick = touch ? MISC.selectTouch : MISC.selectInside;
      const pts = d.kind === 'box' ? [d.start, [d.end[0], d.start[1]], d.end, [d.start[0], d.end[1]]] : d.points;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.beginPath();
      pts.forEach((p, i) => {
        const [x, y] = v.toPx(map, ...p);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = rgba(pick, 0.12);
      ctx.fill();
      if (touch) ctx.setLineDash([4 * v.dpr, 4 * v.dpr]);
      ctx.strokeStyle = rgba(pick, 1);
      ctx.lineWidth = v.dpr;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const tool = this.s.tool;
    if (tool !== 'pad' && tool !== 'track' && tool !== 'region') return;
    const half = this.#apertureHalf(layer);
    const pts = this.cursor ? [...this.sketch, this.cursor] : [...this.sketch];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = colour;
    ctx.fillStyle = rgba(MISC.selection, 0.3);
    ctx.lineWidth = Math.max(1, v.dpr);
    if (tool === 'pad' && this.cursor) {
      const [x, y] = v.toPx(map, ...this.cursor);
      ctx.beginPath();
      if (half.round) ctx.arc(x, y, Math.max(2, half.w * map.s), 0, Math.PI * 2);
      else ctx.rect(x - half.w * map.s, y - half.h * map.s, 2 * half.w * map.s, 2 * half.h * map.s);
      ctx.fill();
      ctx.stroke();
    }
    if ((tool === 'track' || tool === 'region') && pts.length) {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const [x, y] = v.toPx(map, ...p);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      if (tool === 'track') {
        ctx.lineCap = half.round ? 'round' : 'square';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = rgba(MISC.selection, 0.45);
        ctx.lineWidth = Math.max(2, 2 * half.w * map.s);
        ctx.stroke();
      } else {
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.strokeStyle = colour;
      ctx.lineWidth = Math.max(1, v.dpr);
      for (const p of this.sketch) {
        const [x, y] = v.toPx(map, ...p);
        ctx.strokeRect(x - 3 * v.dpr, y - 3 * v.dpr, 6 * v.dpr, 6 * v.dpr);
      }
    }
  }
}

function numInput(value, testid, onchange) {
  return h('input', {
    type: 'number',
    step: 'any',
    value: String(value),
    class: 'num',
    'data-testid': testid,
    onchange: onchange ? (e) => Number.isFinite(Number(e.target.value)) && onchange(Number(e.target.value)) : undefined,
  });
}

function dedupe(pts) {
  return pts.filter((p, i) => !i || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

function fmt(v) {
  return String(round6(v));
}
