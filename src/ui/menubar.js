// Drop-down menus for the top bar: new MenuBar(menus) with menus = [{ key, label, items, onOpen? }];
// onOpen runs before a menu shows (e.g. to enable its items for the current state).
// Items are DOM nodes (buttons, rows, inputs) or null for a separator. One menu is open at a
// time; it closes on a button press inside it, a click elsewhere or Escape. While one menu is
// open, hovering another menu's title opens that one instead.

import { h } from './dom.js';

export class MenuBar {
  constructor(menus) {
    this.menus = menus.map((m) => {
      const button = h(
        'button',
        {
          class: 'menu-title',
          'data-testid': `menu-${m.key}`,
          'aria-haspopup': 'true',
          'aria-expanded': 'false',
          onclick: () => this.toggle(m.key),
          onmouseenter: () => this.open && this.open !== m.key && this.show(m.key),
        },
        m.label,
      );
      const panel = h(
        'div',
        { class: 'menu-panel hidden', role: 'menu', 'data-menu': m.key, 'data-testid': `menu-${m.key}-panel` },
        m.items.map((it) => it || h('div', { class: 'ctx-sep', role: 'separator' })),
      );
      // a pressed button inside the menu is a pick: close (inputs and labels keep it open)
      panel.addEventListener('click', (e) => {
        if (e.target.closest('button')) this.close();
      });
      return { key: m.key, onOpen: m.onOpen, button, panel, el: h('div', { class: 'menu' }, [button, panel]) };
    });
    this.open = null;
    this.el = h(
      'nav',
      { class: 'menubar' },
      this.menus.map((m) => m.el),
    );
    window.addEventListener('pointerdown', (e) => {
      if (this.open && !this.el.contains(e.target)) this.close();
    });
    window.addEventListener(
      'keydown',
      (e) => {
        if (this.open && e.key === 'Escape') {
          e.stopPropagation();
          const m = this.byKey(this.open);
          this.close();
          m.button.focus();
        }
      },
      true,
    );
  }

  byKey(key) {
    return this.menus.find((m) => m.key === key);
  }

  /** The title button of a menu, e.g. to mark it when something inside needs attention. */
  title(key) {
    return this.byKey(key).button;
  }

  toggle(key) {
    if (this.open === key) this.close();
    else this.show(key);
  }

  show(key) {
    this.byKey(key).onOpen?.();
    this.open = key;
    for (const m of this.menus) {
      m.panel.classList.toggle('hidden', m.key !== key);
      m.button.classList.toggle('open', m.key === key);
      m.button.setAttribute('aria-expanded', m.key === key ? 'true' : 'false');
    }
  }

  close() {
    this.open = null;
    for (const m of this.menus) {
      m.panel.classList.add('hidden');
      m.button.classList.remove('open');
      m.button.setAttribute('aria-expanded', 'false');
    }
  }
}
