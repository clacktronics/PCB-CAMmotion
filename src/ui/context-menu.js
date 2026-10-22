// A small right-click menu: openMenu(clientX, clientY, items). Items are
// { label, hint?, disabled?, testid?, action } or null for a separator. One menu at a time;
// it closes on a pick, a click elsewhere, Escape, scrolling, resizing or leaving the window.
// ↑/↓ move between items, Enter picks.

import { h } from './dom.js';

let current = null;

export function closeMenu() {
  if (!current) return;
  const c = current;
  current = null;
  c.el.remove();
  for (const [type, fn, opts] of c.listeners) window.removeEventListener(type, fn, opts);
}

export function menuOpen() {
  return !!current;
}

export function openMenu(x, y, items) {
  closeMenu();
  const buttons = [];
  const el = h(
    'div',
    { class: 'ctx-menu', role: 'menu', 'data-testid': 'context-menu' },
    items.map((it) => {
      if (!it) return h('div', { class: 'ctx-sep', role: 'separator' });
      const b = h(
        'button',
        {
          role: 'menuitem',
          disabled: !!it.disabled,
          'data-testid': it.testid,
          onclick: () => {
            closeMenu();
            it.action();
          },
        },
        [h('span', {}, it.label), it.hint ? h('span', { class: 'ctx-hint' }, it.hint) : null],
      );
      if (!it.disabled) buttons.push(b);
      return b;
    }),
  );
  document.body.append(el);
  // keep it on screen
  const r = el.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  const outside = (e) => {
    if (!el.contains(e.target)) closeMenu();
  };
  const key = (e) => {
    if (e.key === 'Escape') closeMenu();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const i = buttons.indexOf(document.activeElement);
      const n = buttons.length;
      if (n) buttons[(i + (e.key === 'ArrowDown' ? 1 : n - 1) + (i < 0 && e.key === 'ArrowUp' ? 1 : 0)) % n].focus();
    } else if (e.key === 'Enter' && buttons.includes(document.activeElement)) return;
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const close = () => closeMenu();
  current = {
    el,
    listeners: [
      ['pointerdown', outside, true],
      ['keydown', key, true],
      ['wheel', close, true],
      ['resize', close, false],
      ['blur', close, false],
    ],
  };
  for (const [type, fn, opts] of current.listeners) window.addEventListener(type, fn, opts);
  return el;
}
