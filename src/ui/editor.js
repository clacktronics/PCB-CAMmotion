// Editor panel (milestone 4): edit mode, tools (select / pad or hole / track / region),
// selection with drag-move and box select, the edit actions (delete, move by, convert to
// regions, unify the layer), undo/redo, export of the edited file.
// The edits themselves are DOM-free (src/edit/); this file turns pointer and key input into
// edit ops. Its settings live in settings.edit of the .pcam (src/project/project.js).

import { h, clear } from './dom.js';
import { layerEditor, revertEdits, EDIT_TOOLS } from '../project/project.js';
import { EditError } from '../edit/session.js';
import { describeAperture } from '../analyze/apertures.js';
import { MISC, rgba } from '../model/materials.js';

const TOOL_LABEL = { select: 'Select', pad: 'Pad', track: 'Track', region: 'Region' };
const TOOL_KEY = { v: 'select', p: 'pad', t: 'track', r: 'region' };
const TOOL_TITLE = {
  select:
    'Select (V): click an object, Shift+click to add or remove, Shift+drag a box; drag a selected object to move it',
  pad: 'Pad (P): click to place a pad with the chosen aperture (on a drill layer: a hole)',
  track: 'Track (T): click the points, double-click or Enter to finish, Backspace removes the last point',
  region: 'Region (R): click the corners, click the first point, double-click or Enter to close it',
};
const CLOSE_PX = 8;

export class EditorPanel {
  /**
   * @param {{settings:()=>object, layer:()=>object|null, project:()=>object, viewer:object,
   *   commit:(layer:object)=>void, inspect:(hit:object|null)=>void, message:(t:string, err?:boolean)=>void,
   *   download:(text:string, name:string)=>void, touch:()=>void, changed:()=>void}} host
   */
  constructor(host) {
    this.host = host;
    this.sel = []; // selected object indices on the edited layer
    this.sketch = []; // points of the track/region being drawn (mm)
    this.cursor = null;
    this.drag = null; // { kind: 'move'|'box', start, dx, dy, end }
    this.busy = false;
    this.el = h('section', { class: 'editor hidden', 'data-testid': 'editor' });
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
    v.editSelection = on && layer ? { layerId: layer.id, indices: this.sel } : null;
    v.canvas.classList.toggle('editing', on);
    v.canvas.dataset.tool = on ? this.s.tool : '';
    v.drawOverlay();
    clear(this.el);
    if (!on) return;
    this.el.append(h('h2', {}, 'Edit'));
    if (!layer) {
      this.el.append(h('p', { class: 'muted pad' }, 'Select a Gerber or drill layer to edit it.'));
      return;
    }
    const ed = layer.editor;
    const drill = layer.kind === 'excellon';
    const problems = ed ? ed.problems : [];
    const tools = drill ? ['select', 'pad'] : EDIT_TOOLS;
    if (!tools.includes(this.s.tool)) this.s.tool = 'select';
    const btn = (label, attrs) => h('button', attrs, label);
    this.el.append(
      h('div', { class: 'edit-row' }, [
        h(
          'span',
          { class: 'seg' },
          tools.map((t) =>
            btn(drill && t === 'pad' ? 'Hole' : TOOL_LABEL[t], {
              class: this.s.tool === t ? 'on' : '',
              'data-testid': `tool-${t}`,
              title: TOOL_TITLE[t],
              onclick: () => this.setTool(t),
            }),
          ),
        ),
      ]),
    );
    if (this.s.tool === 'pad' || this.s.tool === 'track') this.el.append(this.#apertureRow(layer));
    this.el.append(
      h('div', { class: 'edit-row' }, [
        h('label', { title: 'Positions and moves snap to this grid (0 = no snapping)' }, [
          'Grid ',
          numInput(this.s.gridMm, 'grid', (v) => {
            this.s.gridMm = Math.max(0, v);
            this.host.touch();
          }),
          ' mm',
        ]),
      ]),
    );
    const n = this.sel.length;
    const dx = numInput(0, 'move-dx');
    const dy = numInput(0, 'move-dy');
    this.el.append(
      h('div', { class: 'edit-row' }, [
        h('span', { class: 'muted', 'data-testid': 'edit-selection' }, n ? `${n} selected` : 'Nothing selected'),
        btn('Select all', { onclick: () => this.selectAll(), title: 'Select every object on this layer (Ctrl+A)' }),
      ]),
      h('div', { class: 'edit-row' }, [
        btn('Delete', {
          disabled: !n,
          'data-testid': 'edit-delete',
          title: 'Delete the selection (Del)',
          onclick: () => this.deleteSelection(),
        }),
        drill
          ? null
          : btn('To region', {
              disabled: !n,
              'data-testid': 'edit-to-region',
              title:
                'Turn the selected pads, tracks and fills into G36/G37 regions; overlapping ones are unified into one outline',
              onclick: () => this.toRegion(),
            }),
      ]),
      h('div', { class: 'edit-row' }, [
        'Move by ',
        dx,
        ' ',
        dy,
        ' mm ',
        btn('Move', {
          disabled: !n,
          'data-testid': 'edit-move',
          title: 'Move the selection by X, Y mm (arrow keys: one grid step, Shift: ten)',
          onclick: () => this.moveSelection(Number(dx.value), Number(dy.value)),
        }),
      ]),
    );
    if (!drill)
      this.el.append(
        h('div', { class: 'edit-row' }, [
          btn('Unify layer → regions', {
            'data-testid': 'edit-unify',
            title:
              'Replace everything on this layer with non-overlapping G36/G37 regions: tracks, pads, fills and clear polarity merged into outlines (arcs within 0.5 µm)',
            onclick: () => this.unifyLayer(),
          }),
        ]),
      );
    this.el.append(
      h('div', { class: 'edit-row' }, [
        btn('Undo', {
          disabled: !ed?.canUndo,
          'data-testid': 'edit-undo',
          title: 'Undo (Ctrl+Z)',
          onclick: () => this.undo(),
        }),
        btn('Redo', {
          disabled: !ed?.canRedo,
          'data-testid': 'edit-redo',
          title: 'Redo (Ctrl+Shift+Z or Ctrl+Y)',
          onclick: () => this.redo(),
        }),
        btn('Export file', {
          'data-testid': 'edit-export',
          title: `Download ${layer.name} with the edits (${drill ? 'Excellon' : 'Gerber RS-274X'})`,
          onclick: () => this.exportFile(),
        }),
        btn('Revert', {
          disabled: !ed?.ops.length,
          title: 'Drop every edit of this layer: back to the original file',
          onclick: () => this.revert(),
        }),
      ]),
      h(
        'p',
        { class: `muted pad${problems.length ? ' error' : ''}`, 'data-testid': 'edit-status' },
        problems.length
          ? `This file cannot be edited: ${problems.join('; ')}`
          : ed?.ops.length
            ? `${ed.ops.length} edit${ed.ops.length === 1 ? '' : 's'} on ${layer.name}, saved in the project; the original file is kept`
            : `${layer.name}: no edits`,
      ),
    );
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

  #setSelection(indices) {
    this.sel = [...new Set(indices)].sort((a, b) => a - b);
    const v = this.host.viewer;
    const layer = this.layer();
    v.editSelection = layer ? { layerId: layer.id, indices: this.sel } : null;
    v.drawOverlay();
    const o = layer && this.sel.length === 1 ? layer.image.objects[this.sel[0]] : null;
    this.host.inspect(o ? { layerId: layer.id, index: this.sel[0], object: o, x: null, y: null } : null);
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

  /** Command targets of the selection, or null (with a message) if one cannot be edited. */
  #targets(layer) {
    const ed = layerEditor(layer);
    const out = new Set();
    for (const i of this.sel) {
      const t = ed.target(i);
      if (t.error) {
        this.host.message(t.error, true);
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

  deleteSelection() {
    const layer = this.layer();
    const targets = layer && this.sel.length && this.#targets(layer);
    if (!targets) return;
    const n = this.sel.length;
    if (this.apply({ type: 'delete', targets })) this.host.message(`Deleted ${n} object${n === 1 ? '' : 's'}`);
  }

  moveSelection(dxMm, dyMm) {
    const layer = this.layer();
    if (!layer || !this.sel.length || !Number.isFinite(dxMm) || !Number.isFinite(dyMm) || (!dxMm && !dyMm)) return;
    const targets = this.#targets(layer);
    if (targets) this.apply({ type: 'move', targets, dxMm, dyMm }, `Moved by ${fmt(dxMm)}, ${fmt(dyMm)} mm`);
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

  undo() {
    const layer = this.layer();
    if (!layer?.editor?.undo()) return;
    this.host.commit(layer);
    this.#setSelection([]);
    this.refresh();
    this.host.message('Undone');
  }

  redo() {
    const layer = this.layer();
    if (!layer?.editor?.canRedo) return;
    try {
      const sel = layer.editor.redo();
      this.host.commit(layer);
      this.#setSelection(sel);
      this.refresh();
      this.host.message('Redone');
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      this.host.message(e.message, true);
    }
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
    if (mod || e.altKey) return false;
    if (k === 'Escape') {
      if (this.sketch.length || this.drag) this.cancelSketch();
      else (this.#setSelection([]), this.refresh());
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
    if (k.startsWith('Arrow') && this.sel.length) {
      const step = (this.s.gridMm || 0.01) * (e.shiftKey ? 10 : 1);
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[k];
      // the bottom view is mirrored: left on screen is +X on the board
      if (this.host.viewer.settings.side === 'bottom') d[0] = -d[0];
      this.moveSelection(round6(d[0]), round6(d[1]));
      return true;
    }
    const tool = TOOL_KEY[k.toLowerCase()];
    if (tool && (tool === 'select' || tool === 'pad' || this.layer()?.kind === 'gerber')) {
      this.setTool(tool);
      return true;
    }
    return false;
  }

  #handler() {
    const v = this.host.viewer;
    return {
      down: (mm, e) => {
        const layer = this.layer();
        if (!layer || this.s.tool !== 'select') return false;
        const hit = v.pickAt(mm[0], mm[1]);
        if (hit && (!e.shiftKey || this.sel.includes(hit.index))) {
          this.drag = { kind: 'move', start: mm, dx: 0, dy: 0, hit: hit.index };
          return true;
        }
        if (!hit && e.shiftKey) {
          this.drag = { kind: 'box', start: mm, end: mm };
          return true;
        }
        return false;
      },
      move: (mm) => {
        const d = this.drag;
        if (!d) return;
        if (d.kind === 'move') {
          if (!this.sel.includes(d.hit)) this.#setSelection([d.hit]);
          d.dx = round6(this.snap(mm[0] - d.start[0]));
          d.dy = round6(this.snap(mm[1] - d.start[1]));
        } else d.end = mm;
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
        const layer = this.layer();
        const ob = layer.image.objBounds;
        const [x0, x1] = [Math.min(d.start[0], d.end[0]), Math.max(d.start[0], d.end[0])];
        const [y0, y1] = [Math.min(d.start[1], d.end[1]), Math.max(d.start[1], d.end[1])];
        const inside = [];
        for (let i = 0; i < layer.image.objects.length; i++)
          if (ob[i * 4] >= x0 && ob[i * 4 + 2] <= x1 && ob[i * 4 + 1] >= y0 && ob[i * 4 + 3] <= y1) inside.push(i);
        this.#setSelection([...this.sel, ...inside]);
        this.refresh();
      },
      click: (mm, e) => {
        const layer = this.layer();
        if (!layer) return;
        const tool = this.s.tool;
        if (tool === 'select') {
          const hit = v.pickAt(mm[0], mm[1]);
          if (e.shiftKey || e.ctrlKey || e.metaKey) {
            if (hit)
              this.#setSelection(
                this.sel.includes(hit.index) ? this.sel.filter((i) => i !== hit.index) : [...this.sel, hit.index],
              );
          } else this.#setSelection(hit ? [hit.index] : []);
          this.refresh();
          return;
        }
        const p = this.#snapPt(mm);
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
      dblclick: () => {
        if (this.sketch.length) this.#finishSketch();
      },
      hover: (mm) => {
        this.cursor = this.#snapPt(mm);
        if (this.s.tool !== 'select') v.drawOverlay();
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
      v.outlineObjects(ctx, map, layer.id, this.sel, MISC.selection, 0.15, d.dx, d.dy);
    }
    if (d?.kind === 'box') {
      const [ax, ay] = v.toPx(map, ...d.start);
      const [bx, by] = v.toPx(map, ...d.end);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.setLineDash([4 * v.dpr, 4 * v.dpr]);
      ctx.strokeStyle = colour;
      ctx.lineWidth = v.dpr;
      ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      ctx.setLineDash([]);
    }
    const tool = this.s.tool;
    if (tool === 'select') return;
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
