// admin/components/tab-shell.js
//
// Reusable tab-shell pre wrapper pages (reporty, historia, ludia,
// sklad-materialy, sklad-pohyby). Hostuje N existujucich page modulov
// pod jednym hash-prefixom — napr. #reporty/tyzden, #historia/audit.
//
// Architekturalny princip:
//   - Wrapper page nemeni existujuce page moduly (reports.js, weekly.js, ...)
//   - Iba ich lazy-imports a mountuje do `.panel-tabs-body`
//   - Pri tab clicku: destroy() byvalu, import() novej, init(body)
//   - URL hash sa updatne SILENT (history.replaceState) aby router
//     nere-init-oval cely wrapper iba kvoli sub-route zmene
//
// Usage:
//   import { createTabShell } from '../components/tab-shell.js';
//   const shell = await createTabShell(container, {
//     hashPrefix: 'reporty',
//     defaultTab: 'denny',
//     initialTab: subFromHash, // optional, fallback na defaultTab
//     tabs: [
//       { slug: 'denny',  label: 'Denné',  importer: () => import('../pages/reports.js') },
//       { slug: 'tyzden', label: 'Týždeň', importer: () => import('../pages/weekly.js') },
//       { slug: 'sezona', label: 'Sezóna', importer: () => import('../pages/season.js') },
//     ],
//   });
//   // shell.destroy() — called by router when navigating away
//   // shell.switchTo(slug) — programatic switch (used by onSubChange)

export async function createTabShell(container, config) {
  const { hashPrefix, defaultTab, initialTab, tabs } = config;

  if (!Array.isArray(tabs) || !tabs.length) {
    throw new Error('createTabShell: tabs array required');
  }

  // Build shell DOM
  container.innerHTML = ''
    + '<nav class="panel-tabs" role="tablist" aria-label="Pod-stránky">'
    +   tabs.map(function (t, i) {
          return '<button type="button" class="panel-tab" role="tab" '
            + 'data-slug="' + escapeAttr(t.slug) + '" '
            + 'id="tab-' + escapeAttr(hashPrefix) + '-' + escapeAttr(t.slug) + '" '
            + 'aria-selected="false" tabindex="' + (i === 0 ? '0' : '-1') + '">'
            + escapeText(t.label) + '</button>';
        }).join('')
    + '</nav>'
    + '<div class="panel-tabs-body" role="tabpanel" tabindex="0"></div>';

  const tabBar = container.querySelector('.panel-tabs');
  const body = container.querySelector('.panel-tabs-body');

  let currentSlug = null;
  let currentModule = null;
  let switching = false; // race-condition guard pri rychlych clickoch

  async function switchTo(slug) {
    if (switching) return;
    const tab = tabs.find(function (t) { return t.slug === slug; }) || tabs[0];
    if (currentSlug === tab.slug) return;

    switching = true;
    try {
      // Destroy current tab module
      if (currentModule && typeof currentModule.destroy === 'function') {
        try { currentModule.destroy(); } catch (e) { console.warn('tab destroy:', e); }
      }
      currentModule = null;

      // Update active button visuals + ARIA
      tabBar.querySelectorAll('.panel-tab').forEach(function (btn) {
        const active = btn.dataset.slug === tab.slug;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', String(active));
        btn.setAttribute('tabindex', active ? '0' : '-1');
      });

      // Update URL hash silently — netriggruj router re-navigaciu
      const newHash = '#' + hashPrefix + '/' + tab.slug;
      if (window.location.hash !== newHash) {
        try {
          history.replaceState(null, '', newHash);
        } catch (_) {
          // Fallback for environments where replaceState fails (rare)
          window.location.hash = newHash;
        }
      }

      // Mount new tab module into body
      body.innerHTML = '';
      // Reset className on body so page modules co maju .admin-page-fill nezasahuju
      body.className = 'panel-tabs-body';

      const mod = await tab.importer();
      const initResult = mod.init(body);
      if (initResult && typeof initResult.then === 'function') {
        await initResult;
      }
      currentModule = mod;
      currentSlug = tab.slug;
    } catch (err) {
      console.error('Tab load failed:', slug, err);
      body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--color-text-dim)">Chyba pri načítaní tabu — skúste znovu.</div>';
    } finally {
      switching = false;
    }
  }

  // Click handler (event delegation)
  function onTabClick(e) {
    const btn = e.target.closest('.panel-tab');
    if (!btn || !tabBar.contains(btn)) return;
    switchTo(btn.dataset.slug);
  }

  // Keyboard navigation: arrow keys cycle tabs (WAI-ARIA pattern)
  function onTabKeydown(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    const btns = Array.from(tabBar.querySelectorAll('.panel-tab'));
    const currentIdx = btns.findIndex(function (b) { return b.dataset.slug === currentSlug; });
    if (currentIdx < 0) return;
    let nextIdx;
    if (e.key === 'ArrowLeft') nextIdx = (currentIdx - 1 + btns.length) % btns.length;
    else if (e.key === 'ArrowRight') nextIdx = (currentIdx + 1) % btns.length;
    else if (e.key === 'Home') nextIdx = 0;
    else nextIdx = btns.length - 1;
    e.preventDefault();
    btns[nextIdx].focus();
    switchTo(btns[nextIdx].dataset.slug);
  }

  tabBar.addEventListener('click', onTabClick);
  tabBar.addEventListener('keydown', onTabKeydown);

  // Initial mount
  await switchTo(initialTab || defaultTab);

  return {
    switchTo: switchTo,
    destroy: function () {
      tabBar.removeEventListener('click', onTabClick);
      tabBar.removeEventListener('keydown', onTabKeydown);
      if (currentModule && typeof currentModule.destroy === 'function') {
        try { currentModule.destroy(); } catch (_) {}
      }
      currentModule = null;
      currentSlug = null;
    },
  };
}

// Local escapers (admin sometimes loads escHtml.js, sometimes not).
function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}
function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
