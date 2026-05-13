// admin/pages/reporty.js
//
// Wrapper page — zlucuje Reporty (denne KPI) + Tyzden (hodinova
// statistika) + Sezona (od otvorenia). Vsetky tri su time-series
// agregacie, lisia sa len periodou. Tab-shell ich hostuje pod
// jednym #reporty/{denny,tyzden,sezona} hashom.
//
// Existujuce moduly (reports.js, weekly.js, season.js) sa nemenia.

import { createTabShell } from '../components/tab-shell.js';

let shell = null;

export async function init(container, subRoute) {
  shell = await createTabShell(container, {
    hashPrefix: 'reporty',
    defaultTab: 'denny',
    initialTab: subRoute || null,
    tabs: [
      { slug: 'denny',  label: 'Denné',  importer: function () { return import('./reports.js'); } },
      { slug: 'tyzden', label: 'Týždeň', importer: function () { return import('./weekly.js'); } },
      { slug: 'sezona', label: 'Sezóna', importer: function () { return import('./season.js'); } },
    ],
  });
  return shell;
}

export function destroy() {
  if (shell && typeof shell.destroy === 'function') shell.destroy();
  shell = null;
}

// Router will call this if user clicks the same top-level page with different
// sub-route (e.g. switching #reporty/denny → #reporty/sezona via address bar).
export function onSubChange(subRoute) {
  if (shell && typeof shell.switchTo === 'function' && subRoute) {
    shell.switchTo(subRoute);
  }
}
