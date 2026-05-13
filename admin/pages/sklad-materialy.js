// admin/pages/sklad-materialy.js
//
// Wrapper page — zlucuje Suroviny (food ingredients) + Tovar (non-food
// supplies) + Dodavatelia. Vsetko su master-data zoznamy (CO nakupujeme,
// OD koho). Najmenej casto editovane → vhodne do tabov.

import { createTabShell } from '../components/tab-shell.js';

let shell = null;

export async function init(container, subRoute) {
  shell = await createTabShell(container, {
    hashPrefix: 'sklad-materialy',
    defaultTab: 'suroviny',
    initialTab: subRoute || null,
    tabs: [
      { slug: 'suroviny',    label: 'Suroviny',    importer: function () { return import('./ingredients.js'); } },
      { slug: 'tovar',       label: 'Tovar',       importer: function () { return import('./supplies.js'); } },
      { slug: 'dodavatelia', label: 'Dodávatelia', importer: function () { return import('./suppliers.js'); } },
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
