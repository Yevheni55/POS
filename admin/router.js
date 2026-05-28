// admin/router.js
//
// Hash-based router pre admin SPA. Hash format:
//   #dashboard
//   #reporty/tyzden       ← wrapper page s sub-route
//   #sklad-materialy/dodavatelia
//
// Pre wrapper pages router odovzdava sub-route do mod.init(container, sub).
// Ak sa zmeni len sub a top-level pageu ostane rovnaky, volame mod.onSubChange(sub)
// namiesto re-init aby sa nestracal stav.

const routes = {
  // Top-level standalone pages
  dashboard: function () { return import('./pages/dashboard.js'); },
  menu: function () { return import('./pages/menu.js'); },
  tables: function () { return import('./pages/tables.js'); },
  recipes: function () { return import('./pages/recipes.js'); },
  cashflow: function () { return import('./pages/cashflow.js'); },
  'zam-spotreba': function () { return import('./pages/zam-spotreba.js'); },
  storno: function () { return import('./pages/storno.js'); },
  settings: function () { return import('./pages/settings.js'); },

  // Wrapper pages (tab-shell)
  reporty: function () { return import('./pages/reporty.js'); },
  historia: function () { return import('./pages/historia.js'); },
  ludia: function () { return import('./pages/ludia.js'); },
  'sklad-materialy': function () { return import('./pages/sklad-materialy.js'); },
  'sklad-pohyby': function () { return import('./pages/sklad-pohyby.js'); },

  // Sklad — top-level inventory section (sub-items in sidebar)
  'inventory-dashboard': function () { return import('./pages/inventory-dashboard.js'); },
  'purchase-orders': function () { return import('./pages/purchase-orders.js'); },
  assets: function () { return import('./pages/assets.js'); },
  shisha: function () { return import('./pages/shisha.js'); },

  // Standalone legacy routes — still callable, but sidebar links removed.
  // Direct nav (#payments etc.) gets redirected via LEGACY_REDIRECTS below.
  staff: function () { return import('./pages/staff.js'); },
  dochadzka: function () { return import('./pages/dochadzka.js'); },
  reports: function () { return import('./pages/reports.js'); },
  season: function () { return import('./pages/season.js'); },
  weekly: function () { return import('./pages/weekly.js'); },
  payments: function () { return import('./pages/payments.js'); },
  'fiscal-documents': function () { return import('./pages/fiscal-documents.js'); },
  audit: function () { return import('./pages/audit.js'); },
  suppliers: function () { return import('./pages/suppliers.js'); },
  ingredients: function () { return import('./pages/ingredients.js'); },
  supplies: function () { return import('./pages/supplies.js'); },
  'stock-movements': function () { return import('./pages/stock-movements.js'); },
  'inventory-audit': function () { return import('./pages/inventory-audit.js'); },
  'write-offs': function () { return import('./pages/write-offs.js'); },
};

const pageTitles = {
  dashboard: 'Dashboard',
  menu: 'Menu',
  tables: 'Stoly',
  recipes: 'Receptúry',
  reporty: 'Reporty',
  historia: 'História',
  ludia: 'Ľudia',
  cashflow: 'Cashflow',
  'zam-spotreba': 'Zamestnanecká spotreba',
  storno: 'Storno koš',
  'inventory-dashboard': 'Prehľad skladu',
  'sklad-materialy': 'Materiály',
  'sklad-pohyby': 'Pohyby skladu',
  'purchase-orders': 'Objednávky skladu',
  assets: 'Majetok',
  shisha: 'Shisha',
  settings: 'Nastavenia',
  // Legacy titles preserved for direct navigation
  staff: 'Zamestnanci',
  dochadzka: 'Dochádzka',
  reports: 'Reporty',
  season: 'Sezóna',
  weekly: 'Týždeň',
  payments: 'História platieb',
  'fiscal-documents': 'Fiškálne doklady',
  audit: 'História objednávok',
  suppliers: 'Dodávatelia',
  ingredients: 'Suroviny',
  supplies: 'Tovar',
  'stock-movements': 'Pohyby skladu',
  'inventory-audit': 'Inventúra',
  'write-offs': 'Odpisy zásob',
};

// Bookmark / direct-nav redirects: stare URLs sa transparentne preklopia
// na nove tab-route URLs. Mapuje: stary slug → 'nova-page/sub-slug'.
const LEGACY_REDIRECTS = {
  payments: 'historia/platby',
  'fiscal-documents': 'historia/fiskalne',
  audit: 'historia/audit',
  weekly: 'reporty/tyzden',
  season: 'reporty/sezona',
  reports: 'reporty/denny',
  staff: 'ludia/zamestnanci',
  dochadzka: 'ludia/dochadzka',
  suppliers: 'sklad-materialy/dodavatelia',
  ingredients: 'sklad-materialy/suroviny',
  supplies: 'sklad-materialy/tovar',
  'stock-movements': 'sklad-pohyby/pohyby',
  'inventory-audit': 'sklad-pohyby/inventura',
  'write-offs': 'sklad-pohyby/odpisy',
};

let currentPage = null;
let currentSub = null;
let currentModule = null;
let pendingPage = null;
// intendedPage = autoritativny "kam smeruje aktualna navigacia". Aktualizovany
// na zaciatku KAZDEJ navigate() volania, pred prvym updateSidebarActiveState.
// MutationObserver guard pouziva PRAVE TO ako zdroj pravdy — currentPage je
// stara hodnota az kym sa nedokonci await routes[page]() (čo môže trvať pre
// HTTP load modulu), takze pocas tohto okna by guard omylom odstranil .active
// z noveho page item-u myslejuc si ze patri starej page.
let intendedPage = null;
let navigationSeq = 0;
let venuePortosSynced = false;

async function ensureVenueFromPortosOnce() {
  if (venuePortosSynced) return;
  const u = typeof api !== 'undefined' && api.getUser ? api.getUser() : null;
  if (!u || (u.role !== 'manazer' && u.role !== 'admin')) {
    venuePortosSynced = true;
    return;
  }
  const SYNC_MS = 18000;
  try {
    const profile = await Promise.race([
      api.syncCompanyProfileFromPortos(),
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error('Portos sync timeout'));
        }, SYNC_MS);
      }),
    ]);
    if (profile && typeof api.mergeCompanyProfileIntoPosSettingsCache === 'function') {
      api.mergeCompanyProfileIntoPosSettingsCache(profile);
    }
  } catch (e) {
    console.warn('Portos company profile sync:', e);
  } finally {
    venuePortosSynced = true;
  }
}

function parseHash() {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return { page: 'dashboard', sub: null };
  // Resolve legacy redirect (transparent for bookmarks)
  const legacy = LEGACY_REDIRECTS[raw];
  const effective = legacy || raw;
  const parts = effective.split('/');
  return { page: parts[0] || 'dashboard', sub: parts.slice(1).join('/') || null };
}

/**
 * Sidebar active-state update — POVINNE volat z kazdej navigate() vetvy
 * + z hashchange listener priamo. Defensive: vzdy iteruje VSETKY nav-items,
 * najprv EXPLICITNE odstrani `.active` zo VSETKYCH, potom ho prida LEN na
 * tych co matchnu (matchesPage || matchesAlias).
 *
 * Bug history: user reportoval ze na #recipes mali aktivne aj dashboard,
 * menu, recipes, tables (prve 4 items). Diagnostika potvrdila ze 4 items
 * naozaj mali .active classlist. Hard-reload nepomohlo.
 *
 * Predtym sa pouzival `classList.toggle('active', active)` co MA odstranit
 * triedu ked je 2. argument falsy. V niektorych edge-case (race s page
 * modulom co re-renderuje sidebar, Sklad collapse toggle co manipuluje
 * subset items) sa moglo stat ze toggle bezal pred re-renderom alebo na
 * subset prvkov. Explicit remove-then-add je idempotentne a robi sa nad
 * KONKRETNYM zoznamom prvkov v jednom synchronnom prechode.
 */
function updateSidebarActiveState(page) {
  const items = document.querySelectorAll('#sidebarNav .nav-item');
  // Phase 1: EXPLICITNE odstran .active a aria-current zo VSETKYCH items.
  // Bez ohladu na predchadzajuci stav. classList.remove na chybajucu triedu
  // je no-op (zadarmo), takze cena tohto purge je minimalna.
  items.forEach(function (a) {
    a.classList.remove('active');
    a.removeAttribute('aria-current');
  });
  // Phase 2: Najdi VSETKY items co maju matchnut (zvycajne 1, ale data-active-for
  // moze matchnut aj wrapper page) a oznac ich ako aktivne.
  let activeEl = null;
  items.forEach(function (a) {
    const matchesPage = a.dataset.page === page;
    const matchesAlias = a.dataset.activeFor && a.dataset.activeFor.split(',').indexOf(page) >= 0;
    if (matchesPage || matchesAlias) {
      a.classList.add('active');
      a.setAttribute('aria-current', 'page');
      if (!activeEl) activeEl = a;
    }
  });
  // Mobile UX: scroll horizontal nav bar tak aby aktivny chip bol vidno.
  // Bez toho po loadnuti `#reporty/denny` user vidi iba Dashboard..Stoly,
  // a active terra chip je off-screen vpravo. scrollIntoView so smooth +
  // inline:center umiestni aktivny v strede viewportu.
  if (activeEl && typeof activeEl.scrollIntoView === 'function') {
    // requestAnimationFrame: dovoli sidebar layoutu (po toggle .active class)
    // ustalit sa pred scroll prepocitanim → zabranujeme ze v 1 frame scroll
    // pouzije stary measurement.
    requestAnimationFrame(function () {
      try {
        activeEl.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
      } catch (_) { /* IE11 / legacy → polyfill noop */ }
    });
  }
}

/**
 * Sidebar active-state guard — MutationObserver ktora chrani sidebar pred
 * tym aby trojejka kod (page modul / cmd-palette / nahodny script) pridala
 * `.active` na items co by maly byt inactive. Ked nieco prida `.active`
 * v rozpore s currentPage, observer to okamzite odstrani.
 *
 * Toto je belt-and-suspenders fix — updateSidebarActiveState by mala stacit,
 * ale ked sa bug objavi znova v inom flow, observer ho zachyti za <1 ms.
 * Bez observer-a by user musel cakat na dalsiu navigaciu kym sa cislo
 * .active items znormalizuje.
 */
function installSidebarActiveGuard() {
  const navEl = document.getElementById('sidebarNav');
  if (!navEl || typeof MutationObserver === 'undefined') return;
  const observer = new MutationObserver(function (mutations) {
    for (const m of mutations) {
      if (m.type !== 'attributes' || m.attributeName !== 'class') continue;
      const el = m.target;
      if (!el.matches || !el.matches('.nav-item')) continue;
      if (!el.classList.contains('active')) continue;
      // Tento item ma .active. Skontroluj ci by ho mal mat podla intendedPage.
      // intendedPage je aktualizovany ESTE PRED tym ako navigate() prida .active
      // na novy page item, takze guard nikdy nevidi "stary" page-context.
      const expectedPage = intendedPage;
      if (!expectedPage) continue; // este nepoznal page, neriesime
      const matchesPage = el.dataset.page === expectedPage;
      const matchesAlias = el.dataset.activeFor && el.dataset.activeFor.split(',').indexOf(expectedPage) >= 0;
      if (!matchesPage && !matchesAlias) {
        // Nemal by byt active — niekto ho omylom oznacil. Odstran.
        el.classList.remove('active');
        el.removeAttribute('aria-current');
      }
    }
  });
  observer.observe(navEl, { attributes: true, attributeFilter: ['class'], subtree: true });
}

async function navigate(page, sub) {
  if (!routes[page]) page = 'dashboard';

  // KRITICKE: intendedPage musi byt nastaveny PRED prvym updateSidebarActiveState
  // pretoze MutationObserver guard ho pouziva ako zdroj pravdy. Bez toho by guard
  // pouzil stary currentPage a omylom odstranil .active z noveho page item-u.
  intendedPage = page;

  // DEFENSIVE: vzdy refresh sidebar + title PRED early-returnom — sluzi
  // ako safety net ak by sa medzitym .active class niekde rozsipala.
  updateSidebarActiveState(page);
  const titleEl0 = document.getElementById('pageTitle');
  if (titleEl0) titleEl0.textContent = pageTitles[page] || page;

  // Same top-level page + sub change → call onSubChange instead of re-init.
  if (page === currentPage && pendingPage === null) {
    if (sub !== currentSub && currentModule && typeof currentModule.onSubChange === 'function') {
      currentSub = sub;
      try { currentModule.onSubChange(sub); } catch (e) { console.warn('onSubChange:', e); }
    }
    return;
  }

  pendingPage = page;
  const seq = ++navigationSeq;

  const container = document.getElementById('pageContent');
  const titleEl = document.getElementById('pageTitle');

  // Destroy current page module
  if (currentModule && typeof currentModule.destroy === 'function') {
    try { currentModule.destroy(); } catch (e) { console.warn('destroy:', e); }
  }
  currentModule = null;

  // Sidebar + title uz boli aktualizovane na vrchu funkcie — refresh-neme
  // este raz pre istotu (race-safe).
  updateSidebarActiveState(page);
  titleEl.textContent = pageTitles[page] || page;

  // Load + init module
  try {
    await ensureVenueFromPortosOnce();
    const mod = await routes[page]();
    if (seq !== navigationSeq) return;
    pendingPage = null;
    currentPage = page;
    currentSub = sub;
    currentModule = mod;
    container.innerHTML = '';
    container.className = 'content';
    container.removeAttribute('style');
    const initResult = mod.init(container, sub);
    if (initResult && typeof initResult.then === 'function') await initResult;
  } catch (err) {
    if (seq !== navigationSeq) return;
    pendingPage = null;
    console.error('Failed to load page:', page, err);
    container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--color-text-dim)">Chyba pri načítaní stránky</div>';
    container.className = 'content';
    container.removeAttribute('style');
  }
}

// Hash change → parse + navigate. parseHash() resolves legacy redirects too.
window.addEventListener('hashchange', function () {
  const parsed = parseHash();
  // If legacy redirect was applied, normalize URL silently so user sees the new hash.
  const raw = window.location.hash.replace(/^#/, '');
  if (LEGACY_REDIRECTS[raw]) {
    try { history.replaceState(null, '', '#' + LEGACY_REDIRECTS[raw]); } catch (_) {}
  }
  navigate(parsed.page, parsed.sub);
});

// Initial navigation + sidebar guard install
(function () {
  // Install sidebar active-class guard PRED prvou navigaciou. Guard pouziva
  // currentPage z module scope-u, takze potrebuje byt aktivny pred tym ako
  // navigate() ho nastavi (inak by mohol odstranit aj korektne pridane
  // .active na samom prvom navigate call).
  installSidebarActiveGuard();
  const parsed = parseHash();
  const raw = window.location.hash.replace(/^#/, '');
  if (LEGACY_REDIRECTS[raw]) {
    try { history.replaceState(null, '', '#' + LEGACY_REDIRECTS[raw]); } catch (_) {}
  }
  navigate(parsed.page, parsed.sub);
})();
