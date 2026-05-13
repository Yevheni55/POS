// admin/pages/historia.js
//
// Wrapper page — zlucuje Platby (POS transaction list) + Fiskalne
// doklady (Portos audit trail) + Audit (order_events log). Vsetky
// su transactional history — manazer cez ne hladaju "co sa stalo s
// objednavkou #123" pri reklamaciach. Tab-shell pod #historia/{...}.

import { createTabShell } from '../components/tab-shell.js';

let shell = null;

export async function init(container, subRoute) {
  shell = await createTabShell(container, {
    hashPrefix: 'historia',
    defaultTab: 'platby',
    initialTab: subRoute || null,
    tabs: [
      { slug: 'platby',   label: 'Platby',          importer: function () { return import('./payments.js'); } },
      { slug: 'fiskalne', label: 'Fiškálne doklady', importer: function () { return import('./fiscal-documents.js'); } },
      { slug: 'audit',    label: 'Audit objednávok', importer: function () { return import('./audit.js'); } },
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
