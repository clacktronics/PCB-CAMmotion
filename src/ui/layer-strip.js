// Layer strip on the right of the board (the counterpart of the editor's tool strip on the
// left): one button per copper layer, T, inner 1, 2, … and B. Click selects that layer (the
// layer the editor edits; with one layer soloed the solo moves to it); shift+click solos it.

import { h, clear } from './dom.js';
import { copperSheets } from '../model/layer-groups.js';

export class LayerStrip {
  /**
   * @param {{
   *   layers: () => object[],
   *   activeId: () => string|null,
   *   solo: () => string[],
   *   colour: (layer: object) => number[],
   *   select: (id: string) => void,
   *   toggleSolo: (id: string) => void,
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
    const active = this.host.activeId();
    const solo = this.host.solo();
    let side = null;
    for (const s of sheets) {
      const l = layers.find((x) => x.id === s.id);
      const on = s.id === active;
      const soloed = solo.includes(s.id);
      // a rule between the outer and the inner layers
      if (side && side !== s.side) this.el.append(h('span', { class: 'strip-sep', 'aria-hidden': 'true' }));
      side = s.side;
      this.el.append(
        h(
          'button',
          {
            class: `${on ? 'on' : ''}${soloed ? ' soloed' : ''}${solo.length && !soloed ? ' muted' : ''}`,
            style: `--layer: ${this.host.colour(l).join(', ')}`,
            'data-testid': `layer-strip-${s.label}`,
            'data-layer': s.id,
            'aria-pressed': on ? 'true' : 'false',
            title: `${s.title}\nClick: select this layer · Shift+click: solo it`,
            onclick: (e) => (e.shiftKey ? this.host.toggleSolo(s.id) : this.host.select(s.id)),
          },
          s.label,
        ),
      );
    }
  }
}
