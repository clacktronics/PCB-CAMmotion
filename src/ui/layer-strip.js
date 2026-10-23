// Layer strip on the right of the board (the counterpart of the editor's tool strip on the
// left): All, then one button per copper layer, T, inner 1, 2, … and B. Clicking a layer
// selects it and shows it alone (solo); T and B also turn the board to that side. Shift+click
// adds a layer to the solo or takes it out; All shows the whole board again.

import { h, clear } from './dom.js';
import { copperSheets } from '../model/layer-groups.js';

export class LayerStrip {
  /**
   * @param {{
   *   layers: () => object[],
   *   solo: () => string[],
   *   side: () => 'top'|'bottom',
   *   colour: (layer: object) => number[],
   *   show: (id: string, side: string) => void,
   *   toggleSolo: (id: string) => void,
   *   showAll: () => void,
   * }} host
   */
  constructor(host) {
    this.host = host;
    this.el = h('nav', { class: 'layer-strip hidden', 'data-testid': 'layer-strip', 'aria-label': 'Copper layers' });
  }

  refresh() {
    clear(this.el);
    const layers = this.host.layers();
    const sheets = copperSheets(layers);
    this.el.classList.toggle('hidden', !sheets.length);
    if (!sheets.length) return;
    const solo = this.host.solo();
    const viewSide = this.host.side();
    const all = !solo.length;
    this.el.append(
      h(
        'button',
        {
          class: `all${all ? ' on' : ''}`,
          'data-testid': 'layer-strip-all',
          'aria-pressed': all ? 'true' : 'false',
          title: `Whole board, seen from the ${viewSide}`,
          onclick: () => this.host.showAll(),
        },
        'All',
      ),
    );
    let side = 'all';
    for (const s of sheets) {
      const l = layers.find((x) => x.id === s.id);
      const on = solo.includes(s.id);
      // a rule between All, the outer and the inner layers
      if (side !== s.side) this.el.append(h('span', { class: 'strip-sep', 'aria-hidden': 'true' }));
      side = s.side;
      const turns = s.side === 'top' || s.side === 'bottom';
      this.el.append(
        h(
          'button',
          {
            class: `${on ? 'on' : ''}${s.side === viewSide ? ' facing' : ''}`,
            style: `--layer: ${this.host.colour(l).join(', ')}`,
            'data-testid': `layer-strip-${s.label}`,
            'data-layer': s.id,
            'aria-pressed': on ? 'true' : 'false',
            title: `${s.title}\nClick: show only this layer${turns ? `, seen from the ${s.side}` : ''} · Shift+click: add it to (or take it out of) the layers shown`,
            onclick: (e) => (e.shiftKey ? this.host.toggleSolo(s.id) : this.host.show(s.id, s.side)),
          },
          s.label,
        ),
      );
    }
  }
}
