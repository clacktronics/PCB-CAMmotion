// Analyser dock under the board: aperture table, shape gallery, command inspector and
// step-through playback for the selected layer. Analysis itself lives in src/analyze; this file
// is DOM only. Its state is project data: settings.analyze (src/project/project.js).

import { h, clear } from './dom.js';
import {
  apertureTable,
  imageStats,
  objectsWithAperture,
  apertureImage,
  apertureLines,
  fmtMm,
} from '../analyze/apertures.js';
import { describeCommand, coordinateContext, objectCommand, commandObjectRange } from '../analyze/commands.js';
import { playbackState, nextStep, visibleObjects, clampStep } from '../analyze/playback.js';
import { PLAYBACK_SPEEDS } from '../project/project.js';
import { drawImage } from '../render/draw-image.js';
import { CanvasTarget } from '../render/canvas-target.js';
import { MISC, rgba } from '../model/materials.js';

const ROW_PX = 20; // command list row height (keep in sync with .cmd-row in styles.css)
const THUMB_PX = 64;
const TAB_LABELS = { apertures: 'Apertures', shapes: 'Shapes', commands: 'Commands' };

/**
 * @typedef {object} DockHost
 * @property {() => object} settings     settings.analyze of the project
 * @property {() => object|null} layer   the selected layer
 * @property {() => object[]} layers
 * @property {() => object|null} selection   the selected object ({layerId, index, object})
 * @property {(layerId: string, index: number) => void} select   select an object (inspector)
 * @property {object} viewer
 * @property {() => void} touch          the project changed
 * @property {(text: string) => void} message
 */

export class AnalyserDock {
  /** @param {DockHost} host */
  constructor(host) {
    this.host = host;
    this.playing = false;
    this.selectedCommand = null; // { layerId, ci } chosen in the command list
    this.#build();
  }

  get s() {
    return this.host.settings();
  }

  // ---------------------------------------------------------------- layout

  #build() {
    this.tabs = Object.fromEntries(
      Object.entries(TAB_LABELS).map(([k, label]) => [
        k,
        h('button', { 'data-testid': `tab-${k}`, onclick: () => this.setTab(k) }, label),
      ]),
    );
    const btn = (label, title, testid, onclick) => h('button', { title, 'data-testid': testid, onclick }, label);
    this.btnPlay = btn('▶', 'Play the layer as a photoplotter would draw it', 'pb-play', () => this.togglePlay());
    this.slider = h('input', {
      type: 'range',
      min: 0,
      max: 0,
      step: 1,
      value: 0,
      class: 'pb-slider',
      'data-testid': 'pb-slider',
      title: 'Playback position (commands run)',
      oninput: (e) => this.#setStep(Number(e.target.value), { start: true }),
    });
    this.bySel = h(
      'select',
      {
        title: 'Step by command, or skip to the next command that draws something',
        'data-testid': 'pb-by',
        onchange: (e) => {
          this.s.playback.by = e.target.value;
          this.host.touch();
        },
      },
      [h('option', { value: 'command' }, 'by command'), h('option', { value: 'object' }, 'by object')],
    );
    this.speedSel = h(
      'select',
      {
        title: 'Playback speed (commands per second)',
        'data-testid': 'pb-speed',
        onchange: (e) => {
          this.s.playback.speed = Number(e.target.value);
          this.host.touch();
        },
      },
      PLAYBACK_SPEEDS.map((v) => h('option', { value: v }, `${v.toLocaleString('en')}/s`)),
    );
    this.pos = h('span', { class: 'pb-pos', 'data-testid': 'pb-pos' }, '');
    this.btnOpen = h(
      'button',
      {
        class: 'dock-toggle',
        'data-testid': 'dock-toggle',
        title: 'Hide the analyser (A)',
        onclick: () => this.setOpen(false),
      },
      '✕',
    );
    // the toolbar's on/off button for the whole dock (placed by the app shell)
    this.toolbarButton = h(
      'button',
      {
        'data-testid': 'analyser-toggle',
        title: 'Show or hide the analyser: apertures, shapes, commands and playback (A)',
        onclick: () => this.setOpen(!this.s.open),
      },
      'Analyser',
    );
    this.head = h('div', { class: 'dock-head' }, [
      this.btnOpen,
      h('span', { class: 'seg' }, Object.values(this.tabs)),
      h('span', { class: 'playback' }, [
        btn('⏮', 'Rewind: start playback from an empty layer', 'pb-rewind', () => this.rewind()),
        btn('◀', 'Step back (,)', 'pb-back', () => this.step(-1)),
        this.btnPlay,
        btn('▶|', 'Step forward (.)', 'pb-forward', () => this.step(1)),
        btn('⏭', 'End playback: show the whole layer', 'pb-end', () => this.stop()),
        this.slider,
        this.bySel,
        this.speedSel,
      ]),
      this.pos,
    ]);
    this.body = h('div', { class: 'dock-body', 'data-testid': 'analyser' });
    this.el = h('section', { class: 'analyser' }, [this.head, this.body]);
  }

  /**
   * Show or hide the dock. Hiding also ends playback and clears the highlight, so the board
   * never stays half-drawn or marked with no controls in sight.
   */
  setOpen(open) {
    this.s.open = open;
    if (!open) {
      this.#pause();
      Object.assign(this.s.playback, { layer: null, step: null });
      this.s.highlight = null;
      this.#applyPlayback();
      this.#applyHighlight();
    }
    this.host.touch();
    this.refresh();
  }

  setTab(tab) {
    this.s.tab = tab;
    if (!this.s.open) this.s.open = true;
    this.host.touch();
    this.refresh();
  }

  // ---------------------------------------------------------------- analysis cache

  /** Per-layer analysis, computed once (layers are rebuilt when the project changes). */
  #analysis(layer) {
    if (!layer._analysis) {
      layer._analysis = {
        table: apertureTable(layer.image, layer.commands),
        stats: imageStats(layer.image),
        ctx: layer.kind === 'gerber' ? coordinateContext(layer.commands) : null,
      };
    }
    return layer._analysis;
  }

  // ---------------------------------------------------------------- refresh

  /** The layers were rebuilt: re-apply highlight and playback from the settings. */
  layersChanged() {
    this.#pause();
    this.selectedCommand = null;
    const pb = this.s.playback;
    if (pb.layer && !this.#layer(pb.layer)) Object.assign(pb, { layer: null, step: null });
    const hl = this.s.highlight;
    if (hl && !this.#layer(hl.layer)) this.s.highlight = null;
    this.#applyHighlight();
    this.#applyPlayback();
    this.refresh();
  }

  #layer(id) {
    return this.host.layers().find((l) => l.id === id) || null;
  }

  refresh() {
    const s = this.s;
    this.el.classList.toggle('closed', !s.open);
    this.toolbarButton.classList.toggle('on', s.open);
    this.toolbarButton.setAttribute('aria-pressed', s.open ? 'true' : 'false');
    for (const [k, b] of Object.entries(this.tabs)) b.classList.toggle('on', s.open && s.tab === k);
    this.bySel.value = s.playback.by;
    this.speedSel.value = String(s.playback.speed);
    this.#refreshPlaybackBar();
    clear(this.body);
    this.cmdList = null;
    if (!s.open) return;
    const layer = this.host.layer();
    if (!layer) {
      this.body.append(h('p', { class: 'muted' }, 'Load Gerber or drill files and select a layer to analyse it.'));
      return;
    }
    if (s.tab === 'apertures') this.#renderApertures(layer);
    else if (s.tab === 'shapes') this.#renderShapes(layer);
    else this.#renderCommands(layer);
  }

  /** The selection changed (viewer click, inspector, command list). */
  onSelection() {
    if (!this.s.open) return;
    if (this.s.tab === 'commands' && this.cmdList) {
      const hit = this.host.selection();
      if (hit && hit.layerId === this.cmdList.layer.id) {
        const ci = objectCommand(this.cmdList.layer.image, hit.index);
        if (ci >= 0) this.#scrollTo(ci);
      }
      this.#renderRows();
    } else if (this.s.tab === 'apertures') this.refresh();
  }

  /** Open the command list at the command that produced an object. */
  showCommand(layerId, index) {
    const layer = this.#layer(layerId);
    if (!layer) return;
    this.s.tab = 'commands';
    this.s.open = true;
    this.refresh();
    const ci = objectCommand(layer.image, index);
    if (ci >= 0) {
      this.selectedCommand = { layerId, ci };
      this.#scrollTo(ci, true);
      this.#renderRows();
    }
  }

  // ---------------------------------------------------------------- highlight

  /** Mark every use of aperture `code` (null = regions) on a layer; same again clears it. */
  toggleHighlight(layer, code) {
    const hl = this.s.highlight;
    const same = hl && hl.layer === layer.id && hl.code === code;
    this.s.highlight = same ? null : { layer: layer.id, code };
    this.#applyHighlight();
    this.host.touch();
    if (!same) {
      const n = this.host.viewer.highlight?.indices.length ?? 0;
      const what = code === null ? 'regions' : `${layer.kind === 'excellon' ? 'T' : 'D'}${code}`;
      this.host.message(`${what}: ${n.toLocaleString('en')} use${n === 1 ? '' : 's'} highlighted on ${layer.name}`);
    }
    this.refresh();
  }

  #applyHighlight() {
    const hl = this.s.highlight;
    const layer = hl && this.#layer(hl.layer);
    this.host.viewer.setHighlight(
      layer ? { layerId: layer.id, indices: objectsWithAperture(layer.image, hl.code) } : null,
    );
  }

  // ---------------------------------------------------------------- apertures

  #renderApertures(layer) {
    const { table, stats } = this.#analysis(layer);
    const drill = layer.kind === 'excellon';
    const hl = this.s.highlight;
    const sel = this.host.selection();
    const selCode = sel && sel.layerId === layer.id ? (sel.object.ap?.code ?? null) : undefined;
    const cols = [
      ['label', drill ? 'Tool' : 'D-code', (r) => r.label, 'code'],
      ['shape', 'Shape', (r) => r.description],
      ['size', 'Size (mm)', (r) => `${fmtMm(r.widthMm)} × ${fmtMm(r.heightMm)}`, 'widthMm'],
      ['area', 'Area (mm²)', (r) => (r.areaExact ? '' : '≈') + fmtMm(r.areaMm2), 'areaMm2'],
      ['flashes', drill ? 'Holes' : 'Flashes', (r) => count(r.flashes), 'flashes'],
      ['draws', drill ? 'Slots' : 'Draws', (r) => count(r.draws), 'draws'],
      ['arcs', 'Arcs', (r) => count(r.arcs), 'arcs'],
      ['length', drill ? 'Routed (mm)' : 'Length (mm)', (r) => (r.lengthMm ? fmtMm(r.lengthMm) : ''), 'lengthMm'],
      ['function', 'Function', (r) => r.function],
      ['line', 'Line', (r) => String(r.line), 'line'],
    ];
    const sort = this.s.sort && cols.some((c) => c[3] === this.s.sort.key) ? this.s.sort : { key: 'code', desc: false };
    const rows = table.slice().sort((a, b) => {
      const va = a[sort.key];
      const vb = b[sort.key];
      return (va < vb ? -1 : va > vb ? 1 : a.code - b.code) * (sort.desc ? -1 : 1);
    });
    const thead = h(
      'tr',
      {},
      cols.map(([k, label, , key]) =>
        h(
          'th',
          {
            class: `c-${k}${key ? ' sortable' : ''}`,
            title: key ? 'Sort' : undefined,
            onclick: key
              ? () => {
                  this.s.sort = { key, desc: sort.key === key ? !sort.desc : false };
                  this.host.touch();
                  this.refresh();
                }
              : undefined,
          },
          label + (sort.key === key ? (sort.desc ? ' ▾' : ' ▴') : ''),
        ),
      ),
    );
    const body = rows.map((r) =>
      h(
        'tr',
        {
          class: `${r.uses ? '' : 'unused'}${hl && hl.layer === layer.id && hl.code === r.code ? ' on' : ''}${selCode === r.code ? ' sel' : ''}`,
          'data-testid': 'aperture-row',
          'data-code': r.code,
          title: r.uses ? 'Click: highlight every use on the board' : 'Not used',
          onclick: () => this.toggleHighlight(layer, r.code),
        },
        cols.map(([k, , f]) => h('td', { class: `c-${k}` }, f(r))),
      ),
    );
    if (stats.regions) {
      const on = hl && hl.layer === layer.id && hl.code === null;
      body.push(
        h(
          'tr',
          {
            class: `regions${on ? ' on' : ''}${selCode === null ? ' sel' : ''}`,
            'data-testid': 'aperture-row',
            'data-code': 'regions',
            title: 'Click: highlight every region on the board',
            onclick: () => this.toggleHighlight(layer, null),
          },
          [
            h('td', { class: 'c-label' }, 'G36'),
            h('td', { class: 'c-shape' }, `regions (${count(stats.regionVertices)} vertices)`),
            h('td', {}, ''),
            h('td', { class: 'c-area' }, fmtMm(stats.regionAreaMm2)),
            h('td', { class: 'c-flashes' }, count(stats.regions)),
            h('td', { colspan: 5 }, ''),
          ],
        ),
      );
    }
    const unused = table.filter((r) => !r.uses).length;
    this.body.append(
      h('div', { class: 'dock-note muted' }, [
        `${layer.name}: ${table.length} ${drill ? 'tool' : 'aperture'}${table.length === 1 ? '' : 's'}`,
        unused ? `, ${unused} unused` : '',
        ' · click a row to highlight its uses',
      ]),
      h('table', { class: 'apt', 'data-testid': 'aperture-table' }, [h('thead', {}, thead), h('tbody', {}, body)]),
    );
  }

  // ---------------------------------------------------------------- shapes

  #renderShapes(layer) {
    const { table, stats } = this.#analysis(layer);
    const drill = layer.kind === 'excellon';
    const b = stats.bounds;
    const facts = [
      ['Objects', count(stats.objects)],
      [drill ? 'Holes' : 'Flashes', count(stats.flashes)],
      [drill ? 'Slots / routes' : 'Draws', count(stats.draws)],
      ['Arcs', count(stats.arcs)],
      drill ? null : ['Regions', `${count(stats.regions)} (${count(stats.regionVertices)} vertices)`],
      drill ? null : ['Polarity', `${count(stats.dark)} dark · ${count(stats.clear)} clear`],
      ['Drawn length', `${fmtMm(stats.drawLengthMm)} mm`],
      [
        drill ? 'Narrowest slot' : 'Narrowest draw',
        stats.minDrawWidthMm === null ? '—' : `${fmtMm(stats.minDrawWidthMm)} mm`,
      ],
      [drill ? 'Smallest hole' : 'Smallest flash', stats.minFlashMm === null ? '—' : `${fmtMm(stats.minFlashMm)} mm`],
      [drill ? 'Largest hole' : 'Largest flash', stats.maxFlashMm === null ? '—' : `${fmtMm(stats.maxFlashMm)} mm`],
      [drill ? 'Tools used' : 'Apertures used', `${stats.aperturesUsed} of ${stats.aperturesDefined}`],
      ['Extent', b ? `${fmtMm(b[2] - b[0])} × ${fmtMm(b[3] - b[1])} mm` : '—'],
    ].filter(Boolean);
    const hl = this.s.highlight;
    // lines: short description (what, size); full: the whole description for the tooltip
    const card = (key, title, lines, full, uses, image, code) =>
      h(
        'button',
        {
          class: `shape-card${uses ? '' : ' unused'}${hl && hl.layer === layer.id && hl.code === code ? ' hl' : ''}`,
          'data-testid': 'shape-card',
          'data-code': key,
          title: `${title}: ${full}${uses ? ' · click to highlight every use' : ' · not used'}`,
          onclick: () => this.toggleHighlight(layer, code),
        },
        [
          thumbnail(image),
          h('span', { class: 'shape-title' }, title),
          ...lines.map((t) => h('span', { class: 'shape-sub' }, t)),
          h('span', { class: 'shape-uses' }, `×${count(uses)}`),
        ],
      );
    const cards = table.map((r) => {
      const ap = layer.image.apertures.get(r.code);
      return card(r.code, r.label, apertureLines(ap), r.description, r.uses, apertureImage(ap), r.code);
    });
    if (stats.regions) {
      const first = layer.image.objects.find((o) => o.k === 'R');
      const bb = [Infinity, Infinity, -Infinity, -Infinity];
      for (const c of first.contours)
        for (let i = 0; i < c.length; i += 2) {
          bb[0] = Math.min(bb[0], c[i]);
          bb[1] = Math.min(bb[1], c[i + 1]);
          bb[2] = Math.max(bb[2], c[i]);
          bb[3] = Math.max(bb[3], c[i + 1]);
        }
      cards.push(
        card(
          'regions',
          'Regions',
          ['G36/G37', `${count(stats.regionVertices)} vertices`],
          'G36/G37 filled contours',
          stats.regions,
          { objects: [first], bounds: bb },
          null,
        ),
      );
    }
    this.body.append(
      h('div', { class: 'shapes' }, [
        h(
          'dl',
          { class: 'kv shape-stats', 'data-testid': 'shape-stats' },
          facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]),
        ),
        h('div', { class: 'gallery', 'data-testid': 'gallery' }, cards),
      ]),
    );
  }

  // ---------------------------------------------------------------- commands

  #renderCommands(layer) {
    const n = layer.commands?.length ?? 0;
    const scroller = h('div', {
      class: 'cmds',
      'data-testid': 'command-list',
      onscroll: () => this.#renderRows(),
    });
    const spacer = h('div', { class: 'cmds-spacer', style: `height: ${n * ROW_PX}px` });
    const rows = h('div', { class: 'cmds-rows' });
    spacer.append(rows);
    scroller.append(spacer);
    this.body.append(
      h('div', { class: 'dock-note muted' }, [
        `${layer.name}: ${count(n)} commands · click a command to select what it drew`,
        this.s.playback.layer === layer.id && this.s.playback.step !== null ? ' (or to play up to it)' : '',
      ]),
      scroller,
    );
    this.cmdList = { layer, scroller, rows, first: -1, last: -1 };
    const pb = this.s.playback;
    const sel = this.host.selection();
    let at = -1;
    if (this.selectedCommand?.layerId === layer.id) at = this.selectedCommand.ci;
    else if (pb.layer === layer.id && pb.step !== null) at = pb.step - 1;
    else if (sel?.layerId === layer.id) at = objectCommand(layer.image, sel.index);
    // the scroller has its size once it is in the document
    requestAnimationFrame(() => {
      if (this.cmdList?.scroller !== scroller) return;
      if (at >= 0) this.#scrollTo(at, true);
      this.#renderRows();
    });
  }

  #scrollTo(ci, centre = false) {
    const list = this.cmdList;
    if (!list) return;
    const sc = list.scroller;
    const y = ci * ROW_PX;
    if (centre || y < sc.scrollTop || y + ROW_PX > sc.scrollTop + sc.clientHeight) {
      sc.scrollTop = Math.max(0, y - (centre ? sc.clientHeight / 2 : sc.clientHeight / 3));
    }
  }

  /** Render only the rows in view (files can have millions of commands). */
  #renderRows() {
    const list = this.cmdList;
    if (!list) return;
    const { layer, scroller, rows } = list;
    const n = layer.commands.length;
    const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_PX) - 5);
    const last = Math.min(n, Math.ceil((scroller.scrollTop + scroller.clientHeight) / ROW_PX) + 5);
    const an = this.#analysis(layer);
    const pb = this.s.playback;
    const playing = pb.layer === layer.id && pb.step !== null;
    const sel = this.host.selection();
    const selCi = sel?.layerId === layer.id ? objectCommand(layer.image, sel.index) : -1;
    const chosen = this.selectedCommand?.layerId === layer.id ? this.selectedCommand.ci : -1;
    clear(rows);
    rows.style.transform = `translateY(${first * ROW_PX}px)`;
    for (let ci = first; ci < last; ci++) {
      const c = layer.commands[ci];
      const d = describeCommand(layer, ci, an.ctx);
      const cls = ['cmd-row'];
      if (playing && ci === pb.step - 1) cls.push('cur');
      if (playing && ci >= pb.step) cls.push('future');
      if (ci === selCi || ci === chosen) cls.push('sel');
      if (d.objects) cls.push('draws');
      rows.append(
        h(
          'div',
          {
            class: cls.join(' '),
            'data-testid': 'command-row',
            'data-index': ci,
            'data-line': c.line,
            title: `Command ${ci + 1}, source line ${c.line}`,
            onclick: () => this.#clickCommand(layer, ci),
          },
          [
            h('span', { class: 'ci' }, String(ci + 1)),
            h('span', { class: 'ln' }, String(c.line)),
            h('span', { class: 'cmd-code' }, d.code),
            h('span', { class: 'text' }, d.text),
          ],
        ),
      );
    }
    list.first = first;
    list.last = last;
  }

  #clickCommand(layer, ci) {
    const pb = this.s.playback;
    this.selectedCommand = { layerId: layer.id, ci };
    if (pb.layer === layer.id && pb.step !== null) {
      this.#setStep(ci + 1);
      return;
    }
    const [a, b] = commandObjectRange(layer.image, ci);
    if (b > a) this.host.select(layer.id, a);
    this.#renderRows();
  }

  // ---------------------------------------------------------------- playback

  /** Start (or continue) playback on the selected layer. */
  #ensurePlayback(atStart) {
    const layer = this.host.layer();
    if (!layer) return null;
    const pb = this.s.playback;
    if (pb.layer !== layer.id || pb.step === null) {
      pb.layer = layer.id;
      pb.step = atStart ? 0 : layer.commands.length;
    }
    return layer;
  }

  rewind() {
    this.#pause();
    if (this.#ensurePlayback(true)) this.#setStep(0);
  }

  step(dir) {
    this.#pause();
    const layer = this.#ensurePlayback(dir > 0);
    if (!layer) return;
    const pb = this.s.playback;
    this.#setStep(nextStep(layer.image, pb.step, dir, pb.by));
  }

  stop() {
    this.#pause();
    Object.assign(this.s.playback, { layer: null, step: null });
    this.#applyPlayback();
    this.host.touch();
    this.#afterStep();
  }

  togglePlay() {
    if (this.playing) {
      this.#pause();
      this.host.touch();
      this.#refreshPlaybackBar();
      return;
    }
    const layer = this.#ensurePlayback(true);
    if (!layer) return;
    const pb = this.s.playback;
    if (pb.step >= layer.commands.length) pb.step = 0;
    this.playing = true;
    let last = performance.now();
    let carry = 0;
    const tick = (now) => {
      if (!this.playing) return;
      carry += ((now - last) / 1000) * pb.speed;
      last = now;
      let k = Math.floor(carry);
      carry -= k;
      let s = pb.step;
      while (k-- > 0 && s < layer.commands.length) s = nextStep(layer.image, s, 1, pb.by);
      if (s !== pb.step) this.#setStep(s, { quiet: true });
      if (s >= layer.commands.length) {
        this.#pause();
        this.host.touch();
        this.#refreshPlaybackBar();
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.#refreshPlaybackBar();
  }

  #pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
  }

  /** Move playback to `step` (commands run). quiet: no autosave touch (while playing). */
  #setStep(step, { quiet = false, start = false } = {}) {
    if (start) this.#ensurePlayback(true);
    const pb = this.s.playback;
    const layer = pb.layer && this.#layer(pb.layer);
    if (!layer) return;
    pb.step = clampStep(step, layer.commands.length);
    this.#applyPlayback();
    if (!quiet) this.host.touch();
    this.#afterStep();
  }

  #afterStep() {
    this.#refreshPlaybackBar();
    const pb = this.s.playback;
    if (this.cmdList) {
      if (pb.layer === this.cmdList.layer.id && pb.step > 0) this.#scrollTo(pb.step - 1);
      this.#renderRows();
    }
  }

  /** Draw the playback layer up to the current step, and show the plotter head. */
  #applyPlayback() {
    const pb = this.s.playback;
    let changed = false;
    for (const l of this.host.layers()) {
      const want = pb.layer === l.id && pb.step !== null ? visibleObjects(l.image, pb.step) : undefined;
      if (l.limit !== want) {
        l.limit = want;
        changed = true;
      }
    }
    const layer = pb.layer && this.#layer(pb.layer);
    if (layer && pb.step !== null) {
      const st = playbackState(layer.image, pb.step);
      this.host.viewer.setPlayhead({ layerId: layer.id, current: st.current, head: st.head });
    } else this.host.viewer.setPlayhead(null);
    if (changed) this.host.viewer.layersChanged();
  }

  #refreshPlaybackBar() {
    const pb = this.s.playback;
    const layer = pb.layer && this.#layer(pb.layer);
    const active = this.host.layer();
    this.btnPlay.textContent = this.playing ? '⏸' : '▶';
    this.btnPlay.classList.toggle('on', this.playing);
    this.el.classList.toggle('playing', !!layer);
    if (!layer) {
      this.slider.max = String(active?.commands?.length ?? 0);
      this.slider.value = this.slider.max;
      this.pos.textContent = active ? 'Playback off: whole layer shown' : '';
      return;
    }
    const st = playbackState(layer.image, pb.step);
    this.slider.max = String(st.total);
    this.slider.value = String(st.step);
    let text = `${layer.name} · step ${count(st.step)} / ${count(st.total)} · ${count(st.objects)} object${st.objects === 1 ? '' : 's'}`;
    if (st.command >= 0) {
      const c = layer.commands[st.command];
      const d = describeCommand(layer, st.command, this.#analysis(layer).ctx);
      text += ` · line ${c.line}: ${d.text}`;
    }
    this.pos.textContent = text;
    this.pos.title = text;
  }
}

function count(n) {
  return n.toLocaleString('en');
}

/** A small canvas showing an aperture (or region) image, scaled to fit. */
function thumbnail(image) {
  const dpr = globalThis.devicePixelRatio || 1;
  const size = Math.round(THUMB_PX * dpr);
  const c = h('canvas', { class: 'thumb', width: size, height: size });
  const b = image.bounds;
  if (!b || !(b[2] > b[0] || b[3] > b[1])) return c;
  const w = Math.max(b[2] - b[0], 1e-6);
  const hh = Math.max(b[3] - b[1], 1e-6);
  const s = (size * 0.8) / Math.max(w, hh);
  const map = { s, mirror: false, ox: size / 2 - (s * (b[0] + b[2])) / 2, oy: size / 2 + (s * (b[1] + b[3])) / 2 };
  const ctx = c.getContext('2d');
  drawImage(image, new CanvasTarget(ctx, map));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = rgba(MISC.thumbnail, 1);
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';
  return c;
}
