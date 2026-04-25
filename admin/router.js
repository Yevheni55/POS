const routes = {
  dashboard: () => import('./pages/dashboard.js'),
  menu: () => import('./pages/menu.js'),
  tables: () => import('./pages/tables.js'),
  staff: () => import('./pages/staff.js'),
  reports: () => import('./pages/reports.js'),
  payments: () => import('./pages/payments.js'),
  'fiscal-documents': () => import('./pages/fiscal-documents.js'),
  settings: () => import('./pages/settings.js'),
  recipes: () => import('./pages/recipes.js'),
  'inventory-dashboard': () => import('./pages/inventory-dashboard.js'),
  suppliers: () => import('./pages/suppliers.js'),
  ingredients: () => import('./pages/ingredients.js'),
  'purchase-orders': () => import('./pages/purchase-orders.js'),
  'supplies': () => import('./pages/supplies.js'),
  'stock-movements': () => import('./pages/stock-movements.js'),
  'inventory-audit': () => import('./pages/inventory-audit.js'),
  assets: () => import('./pages/assets.js'),
  'write-offs': () => import('./pages/write-offs.js'),
  shisha: () => import('./pages/shisha.js'),
};

const pageTitles = {
  dashboard: 'Dashboard',
  menu: 'Menu',
  tables: 'Stoly',
  staff: 'Zamestnanci',
  reports: 'Reporty',
  payments: 'História platieb',
  'fiscal-documents': 'Fiškálne doklady',
  settings: 'Nastavenia',
  recipes: 'Receptúry',
  'inventory-dashboard': 'Prehľad skladu',
  suppliers: 'Dodávatelia',
  ingredients: 'Suroviny',
  'purchase-orders': 'Objednávky skladu',
  'supplies': 'Tovar',
  'stock-movements': 'Pohyby skladu',
  'inventory-audit': 'Inventúra',
  assets: 'Majetok',
  'write-offs': 'Odpisy zásob',
  shisha: 'Shisha',
};

let currentPage = null;
let currentModule = null;
/** Target of the in-flight navigate; null when the last navigation finished. */
let pendingPage = null;
/** Monotonic id so only the latest in-flight navigation may paint (avoids race when imports finish out of order). */
let navigationSeq = 0;

let venuePortosSynced = false;

/** Jednorazovo: aktuálna identita z Portos → DB + pos_settings (po zmene firmy / eKasa). */
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
      new Promise(function(_, reject) {
        setTimeout(function() {
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

async function navigate(page) {
  if (!routes[page]) page = 'dashboard';
  // Skip redundant clicks only when this page is already shown and nothing else is loading.
  // If currentPage still reflects the old route while another import is in flight, pendingPage is set — do not skip.
  if (page === currentPage && pendingPage === null) return;

  pendingPage = page;
  const seq = ++navigationSeq;

  const container = document.getElementById('pageContent');
  const titleEl = document.getElementById('pageTitle');

  // Destroy current page
  if (currentModule && currentModule.destroy) {
    currentModule.destroy();
  }

  // Update sidebar active state + aria-current
  document.querySelectorAll('#sidebarNav .nav-item').forEach(function(a) {
    var active = a.dataset.page === page;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  // Update header title
  titleEl.textContent = pageTitles[page] || page;

  // Load new page module
  try {
    await ensureVenueFromPortosOnce();
    const mod = await routes[page]();
    if (seq !== navigationSeq) return;
    pendingPage = null;
    currentPage = page;
    currentModule = mod;
    container.innerHTML = '';
    container.className = 'content';
    container.removeAttribute('style');
    const initResult = mod.init(container);
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

function getPageFromHash() {
  const hash = window.location.hash.replace('#', '');
  return hash || 'dashboard';
}

// Listen for hash changes
window.addEventListener('hashchange', function() {
  navigate(getPageFromHash());
});

// Initial navigation
navigate(getPageFromHash());
