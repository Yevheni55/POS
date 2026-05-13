// admin/pages/ludia.js
//
// Wrapper page — zlucuje Zamestnanci (master data) + Dochadzka
// (cas/hodiny). Logicky: master data zamestnanca ↔ jeho cas.

import { createTabShell } from '../components/tab-shell.js';

let shell = null;

export async function init(container, subRoute) {
  shell = await createTabShell(container, {
    hashPrefix: 'ludia',
    defaultTab: 'zamestnanci',
    initialTab: subRoute || null,
    tabs: [
      { slug: 'zamestnanci', label: 'Zamestnanci', importer: function () { return import('./staff.js'); } },
      { slug: 'dochadzka',   label: 'Dochádzka',   importer: function () { return import('./dochadzka.js'); } },
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
