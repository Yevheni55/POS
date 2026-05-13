// admin/pages/sklad-pohyby.js
//
// Wrapper page — zlucuje Pohyby (stock movement log) + Inventura
// (counted stock audit) + Odpisy (write-offs/wastage). Vsetko su
// stock-changing eventy.

import { createTabShell } from '../components/tab-shell.js';

let shell = null;

export async function init(container, subRoute) {
  shell = await createTabShell(container, {
    hashPrefix: 'sklad-pohyby',
    defaultTab: 'pohyby',
    initialTab: subRoute || null,
    tabs: [
      { slug: 'pohyby',    label: 'Pohyby',    importer: function () { return import('./stock-movements.js'); } },
      { slug: 'inventura', label: 'Inventúra', importer: function () { return import('./inventory-audit.js'); } },
      { slug: 'odpisy',    label: 'Odpisy',    importer: function () { return import('./write-offs.js'); } },
    ],
  });
  return shell;
}

export function destroy() {
  if (shell && typeof shell.destroy === 'function') shell.destroy();
  shell = null;
}

export function onSubChange(subRoute) {
  if (shell && typeof shell.switchTo === 'function' && subRoute) {
    shell.switchTo(subRoute);
  }
}
