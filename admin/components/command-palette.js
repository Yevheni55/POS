// admin/components/command-palette.js
//
// Cmd+K / Ctrl+K quick switcher — Vercel/Linear-style palette overlay.
//
// Reduces time-to-action from 8s (scan sidebar, click, scan tabs, click) to
// 2s (Cmd+K, type 2-3 chars, Enter). Manazer dosiahne ktorukolvek stranku
// alebo bezne akciu bez clickania v sidebare.
//
// Triggers:
//   - Cmd+K (Mac) / Ctrl+K (Win/Linux)
//   - '/' v non-input contextu
//
// Pattern:
//   1. Open palette
//   2. Type query (fuzzy subsequence match)
//   3. Arrow keys vyber result, Enter potvrď
//   4. Esc zavrieť
//
// Akcie (action commands) co potrebuju kontext stranky pouzivaju
// navigate-then-action pattern: nastavi sessionStorage flag, navigatne na page,
// page module na init() check-ne flag a vykona akciu.

const RECENT_KEY = 'admin_cmd_palette_recent';
const ACTION_FLAG_KEY = 'admin_cmd_palette_action';
const MAX_RECENT = 5;

// ── Commands Registry ─────────────────────────────────────────────────────
// Each command:
//   id       — stable identifier (for recent items)
//   label    — display text
//   group    — 'Navigácia' | 'Reporty' | 'História' | 'Sklad' | 'Akcie'
//   icon     — emoji or SVG glyph (string)
//   hash     — '#path' for nav commands (preferred)
//   action   — function for non-nav commands
//   keywords — extra match terms (synonymá, EN aliases)

const COMMANDS = [
  // Top-level navigation
  { id: 'nav-dashboard', label: 'Dashboard',       group: 'Navigácia', icon: '📊', hash: '#dashboard',  keywords: ['prehlad', 'home', 'uvod'] },
  { id: 'nav-menu',      label: 'Menu',            group: 'Navigácia', icon: '🍔', hash: '#menu',       keywords: ['produkty', 'jedlo', 'kategorie'] },
  { id: 'nav-recipes',   label: 'Receptúry',       group: 'Navigácia', icon: '🍳', hash: '#recipes',    keywords: ['recipes', 'recepty', 'spotreba'] },
  { id: 'nav-tables',    label: 'Stoly',           group: 'Navigácia', icon: '🪑', hash: '#tables',     keywords: ['tables', 'zona', 'plan'] },
  { id: 'nav-cashflow',  label: 'Cashflow',        group: 'Navigácia', icon: '💰', hash: '#cashflow',   keywords: ['vklad', 'vyber', 'hotovost'] },
  { id: 'nav-settings',  label: 'Nastavenia',      group: 'Navigácia', icon: '⚙️', hash: '#settings',   keywords: ['settings', 'config', 'firma'] },

  // Reporty sub-routes
  { id: 'rep-denny',  label: 'Reporty · Denné',  group: 'Reporty', icon: '📈', hash: '#reporty/denny',  keywords: ['daily', 'reports', 'dnes'] },
  { id: 'rep-tyzden', label: 'Reporty · Týždeň', group: 'Reporty', icon: '📅', hash: '#reporty/tyzden', keywords: ['weekly', 'week', 'hodina'] },
  { id: 'rep-sezona', label: 'Reporty · Sezóna', group: 'Reporty', icon: '🌊', hash: '#reporty/sezona', keywords: ['season', 'leto', 'otvorenie'] },

  // História sub-routes
  { id: 'his-platby',   label: 'História · Platby',          group: 'História', icon: '💳', hash: '#historia/platby',   keywords: ['payments', 'platby', 'history'] },
  { id: 'his-fiskalne', label: 'História · Fiškálne doklady', group: 'História', icon: '📄', hash: '#historia/fiskalne', keywords: ['fiscal', 'portos', 'ekasa'] },
  { id: 'his-audit',    label: 'História · Audit objednávok', group: 'História', icon: '🕒', hash: '#historia/audit',    keywords: ['audit', 'log', 'events'] },

  // Ľudia sub-routes
  { id: 'lud-zam',  label: 'Ľudia · Zamestnanci', group: 'Ľudia', icon: '👥', hash: '#ludia/zamestnanci', keywords: ['staff', 'cisnik', 'manazer'] },
  { id: 'lud-doch', label: 'Ľudia · Dochádzka',   group: 'Ľudia', icon: '⏰', hash: '#ludia/dochadzka',   keywords: ['attendance', 'cas', 'prichod'] },

  // Sklad
  { id: 'skl-prehlad',     label: 'Sklad · Prehľad',      group: 'Sklad', icon: '📦', hash: '#inventory-dashboard',          keywords: ['warehouse', 'stav', 'kpi'] },
  { id: 'skl-suroviny',    label: 'Sklad · Suroviny',     group: 'Sklad', icon: '🧂', hash: '#sklad-materialy/suroviny',     keywords: ['ingredients', 'surovina', 'food'] },
  { id: 'skl-tovar',       label: 'Sklad · Tovar',        group: 'Sklad', icon: '🧴', hash: '#sklad-materialy/tovar',        keywords: ['supplies', 'tovar', 'hygiena'] },
  { id: 'skl-dodavatelia', label: 'Sklad · Dodávatelia',  group: 'Sklad', icon: '🚚', hash: '#sklad-materialy/dodavatelia',  keywords: ['suppliers', 'firma', 'kontakt'] },
  { id: 'skl-pohyby',      label: 'Sklad · Pohyby',       group: 'Sklad', icon: '↕️', hash: '#sklad-pohyby/pohyby',          keywords: ['movements', 'log', 'in', 'out'] },
  { id: 'skl-inventura',   label: 'Sklad · Inventúra',    group: 'Sklad', icon: '📋', hash: '#sklad-pohyby/inventura',       keywords: ['audit', 'pocet'] },
  { id: 'skl-odpisy',      label: 'Sklad · Odpisy',       group: 'Sklad', icon: '🗑️', hash: '#sklad-pohyby/odpisy',          keywords: ['writeoff', 'wastage', 'strata'] },
  { id: 'skl-objednavky',  label: 'Sklad · Objednávky',   group: 'Sklad', icon: '📥', hash: '#purchase-orders',              keywords: ['purchase', 'orders', 'nakup'] },
  { id: 'skl-majetok',     label: 'Sklad · Majetok',      group: 'Sklad', icon: '💼', hash: '#assets',                       keywords: ['assets', 'equipment', 'odpis'] },
  { id: 'skl-shisha',      label: 'Sklad · Shisha',       group: 'Sklad', icon: '💨', hash: '#shisha',                       keywords: ['shisha', 'hookah'] },

  // Akcie — navigate-then-trigger pattern
  { id: 'act-new-ingredient', label: 'Pridať surovinu',     group: 'Akcie', icon: '＋', hash: '#sklad-materialy/suroviny',    actionFlag: 'new-ingredient', keywords: ['new', 'add', 'surovina'] },
  { id: 'act-new-supply',     label: 'Pridať tovar',        group: 'Akcie', icon: '＋', hash: '#sklad-materialy/tovar',       actionFlag: 'new-supply',     keywords: ['new', 'add', 'tovar'] },
  { id: 'act-new-supplier',   label: 'Pridať dodávateľa',   group: 'Akcie', icon: '＋', hash: '#sklad-materialy/dodavatelia', actionFlag: 'new-supplier',   keywords: ['new', 'add'] },
  { id: 'act-new-asset',      label: 'Pridať zariadenie',   group: 'Akcie', icon: '＋', hash: '#assets',                       actionFlag: 'new-asset',      keywords: ['new', 'add'] },
  { id: 'act-new-staff',      label: 'Pridať zamestnanca',  group: 'Akcie', icon: '＋', hash: '#ludia/zamestnanci',            actionFlag: 'new-staff',      keywords: ['new', 'add'] },
  { id: 'act-new-audit',      label: 'Nová inventúra',      group: 'Akcie', icon: '📋', hash: '#sklad-pohyby/inventura',       actionFlag: 'new-audit',      keywords: ['new', 'pocet'] },
  { id: 'act-new-writeoff',   label: 'Nový odpis',          group: 'Akcie', icon: '🗑️', hash: '#sklad-pohyby/odpisy',          actionFlag: 'new-writeoff',   keywords: ['new', 'wastage'] },
  { id: 'act-new-po',         label: 'Nová objednávka skladu', group: 'Akcie', icon: '📥', hash: '#purchase-orders',           actionFlag: 'new-po',         keywords: ['new', 'nakup', 'order'] },

  // Univerzálne akcie
  { id: 'act-back-pos', label: 'Späť na POS', group: 'Akcie', icon: '←', action: function () {
    if (typeof window.goBackToPOS === 'function') window.goBackToPOS();
    else window.location.href = '/pos-enterprise.html';
  }, keywords: ['back', 'kasa', 'exit'] },
];

// ── Fuzzy Match ───────────────────────────────────────────────────────────
//
// Subsequence match: chars of query must appear in target in order.
// Score:
//   +10 per character match
//   -2 per gap between matches
//   +20 if first match is at word start
//   +5 if match starts the string
//
// Returns null if no match.
function fuzzyScore(query, target) {
  if (!query) return { score: 0, matches: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let lastMatch = -1;
  const matches = [];
  let score = 0;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      matches.push(ti);
      score += 10;
      if (lastMatch >= 0) score -= (ti - lastMatch - 1) * 2;
      // Word-start boost
      if (ti === 0 || /[\s·\-_/.]/.test(t[ti - 1])) score += 8;
      lastMatch = ti;
      qi++;
    }
  }

  if (qi < q.length) return null;
  if (matches.length && matches[0] === 0) score += 5;
  return { score: score, matches: matches };
}

function rankCommands(query, recentIds) {
  if (!query) {
    // No query — show recent first, then all (without duplicates)
    const recentSet = new Set(recentIds);
    const recents = recentIds
      .map(function (id) { return COMMANDS.find(function (c) { return c.id === id; }); })
      .filter(Boolean);
    const rest = COMMANDS.filter(function (c) { return !recentSet.has(c.id); });
    return recents.concat(rest).map(function (c) { return { cmd: c, matches: [] }; });
  }
  const scored = [];
  for (const c of COMMANDS) {
    // Match against label OR any keyword (take the best)
    const candidates = [c.label].concat(c.keywords || []);
    let best = null;
    for (const cand of candidates) {
      const res = fuzzyScore(query, cand);
      if (res && (!best || res.score > best.score)) {
        best = res;
        best._matchedField = cand === c.label ? 'label' : 'keyword';
      }
    }
    if (best) scored.push({ cmd: c, matches: best._matchedField === 'label' ? best.matches : [], score: best.score });
  }
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored;
}

// ── State ─────────────────────────────────────────────────────────────────
let _overlay = null;
let _input = null;
let _list = null;
let _activeIdx = 0;
let _filtered = [];

function loadRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(0, MAX_RECENT) : [];
  } catch (_) { return []; }
}

function pushRecent(commandId) {
  try {
    let recents = loadRecent().filter(function (id) { return id !== commandId; });
    recents.unshift(commandId);
    recents = recents.slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
  } catch (_) {}
}

// ── DOM Build ─────────────────────────────────────────────────────────────
function buildOverlay() {
  const ov = document.createElement('div');
  ov.className = 'cmdk-overlay';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', 'Quick switcher');
  ov.innerHTML = ''
    + '<div class="cmdk-modal">'
    +   '<div class="cmdk-input-wrap">'
    +     '<svg class="cmdk-input-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>'
    +     '<input type="text" class="cmdk-input" placeholder="Hľadať stránku alebo akciu…" autocomplete="off" spellcheck="false" aria-label="Hľadať">'
    +     '<button type="button" class="cmdk-input-kbd" aria-label="Zavrieť"><kbd>Esc</kbd></button>'
    +   '</div>'
    +   '<div class="cmdk-list" role="listbox"></div>'
    +   '<footer class="cmdk-footer">'
    +     '<span class="cmdk-hint"><kbd>↑</kbd><kbd>↓</kbd> navigovať</span>'
    +     '<span class="cmdk-hint"><kbd>↵</kbd> otvoriť</span>'
    +     '<span class="cmdk-hint"><kbd>Esc</kbd> zavrieť</span>'
    +   '</footer>'
    + '</div>';

  document.body.appendChild(ov);
  return ov;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function highlightMatches(label, matchIndices) {
  if (!matchIndices || !matchIndices.length) return escapeHtml(label);
  // Sort + dedupe just in case
  const ms = matchIndices.slice().sort(function (a, b) { return a - b; });
  let out = '';
  let i = 0;
  for (let p = 0; p < label.length; p++) {
    if (i < ms.length && ms[i] === p) {
      out += '<mark class="cmdk-match">' + escapeHtml(label[p]) + '</mark>';
      i++;
    } else {
      out += escapeHtml(label[p]);
    }
  }
  return out;
}

function renderList(query) {
  const recentIds = !query ? loadRecent() : [];
  _filtered = rankCommands(query, recentIds);
  _activeIdx = 0;

  if (!_filtered.length) {
    _list.innerHTML = '<div class="cmdk-empty">Žiadne výsledky pre „<strong>' + escapeHtml(query) + '</strong>".<br><small>Skús: surovina, reporty, predúčet…</small></div>';
    return;
  }

  // Group by group key (preserve sort order)
  const groups = [];
  const groupMap = new Map();
  const showRecent = !query && recentIds.length > 0;
  for (let i = 0; i < _filtered.length; i++) {
    const item = _filtered[i];
    let g;
    if (showRecent && recentIds.indexOf(item.cmd.id) >= 0) {
      g = 'Naposledy';
    } else {
      g = item.cmd.group || 'Iné';
    }
    if (!groupMap.has(g)) {
      groupMap.set(g, groups.length);
      groups.push({ name: g, items: [] });
    }
    groups[groupMap.get(g)].items.push({ globalIdx: i, item: item });
  }

  let html = '';
  for (const g of groups) {
    html += '<div class="cmdk-group-label">' + escapeHtml(g.name) + '</div>';
    for (const entry of g.items) {
      const c = entry.item.cmd;
      const labelHtml = highlightMatches(c.label, entry.item.matches);
      const activeAttr = entry.globalIdx === _activeIdx ? ' aria-selected="true"' : '';
      const activeCls = entry.globalIdx === _activeIdx ? ' active' : '';
      html += '<button type="button" class="cmdk-row' + activeCls + '" role="option"' + activeAttr + ' data-idx="' + entry.globalIdx + '">'
        + '<span class="cmdk-row-icon" aria-hidden="true">' + escapeHtml(c.icon || '·') + '</span>'
        + '<span class="cmdk-row-label">' + labelHtml + '</span>'
        + '<span class="cmdk-row-arrow" aria-hidden="true">→</span>'
        + '</button>';
    }
  }
  _list.innerHTML = html;
}

function setActive(idx) {
  if (!_filtered.length) return;
  if (idx < 0) idx = _filtered.length - 1;
  if (idx >= _filtered.length) idx = 0;
  _activeIdx = idx;
  const rows = _list.querySelectorAll('.cmdk-row');
  rows.forEach(function (r) {
    const rIdx = parseInt(r.dataset.idx, 10);
    const active = rIdx === idx;
    r.classList.toggle('active', active);
    r.setAttribute('aria-selected', String(active));
    if (active) r.scrollIntoView({ block: 'nearest' });
  });
}

function executeActive() {
  if (!_filtered.length) return;
  const entry = _filtered[_activeIdx];
  if (!entry) return;
  const cmd = entry.cmd;
  pushRecent(cmd.id);
  closePalette();

  // Action with navigation flag — set sessionStorage so page module triggers on init
  if (cmd.actionFlag && cmd.hash) {
    try { sessionStorage.setItem(ACTION_FLAG_KEY, cmd.actionFlag); } catch (_) {}
    if (window.location.hash === cmd.hash) {
      // Already on the right page — fire a custom event for page module to react
      window.dispatchEvent(new CustomEvent('cmd-palette-action', { detail: { flag: cmd.actionFlag } }));
    } else {
      window.location.hash = cmd.hash;
    }
    return;
  }

  if (cmd.hash) {
    if (window.location.hash !== cmd.hash) window.location.hash = cmd.hash;
    return;
  }
  if (typeof cmd.action === 'function') {
    try { cmd.action(); } catch (e) { console.error('cmd action failed:', e); }
  }
}

// ── Open / Close ──────────────────────────────────────────────────────────
function openPalette() {
  if (!_overlay) _overlay = buildOverlay();
  if (!_input) _input = _overlay.querySelector('.cmdk-input');
  if (!_list) _list = _overlay.querySelector('.cmdk-list');

  _input.value = '';
  renderList('');
  _overlay.classList.add('show');
  // Focus after paint so transform animation runs cleanly
  requestAnimationFrame(function () { _input.focus(); });
  document.addEventListener('keydown', onGlobalKeydown, true);
}

function closePalette() {
  if (!_overlay) return;
  _overlay.classList.remove('show');
  document.removeEventListener('keydown', onGlobalKeydown, true);
}

function onGlobalKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closePalette();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setActive(_activeIdx + 1);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    setActive(_activeIdx - 1);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    executeActive();
    return;
  }
}

// ── Init (export) ─────────────────────────────────────────────────────────
export function initCommandPalette() {
  // Global trigger — Cmd+K / Ctrl+K
  document.addEventListener('keydown', function (e) {
    // Cmd/Ctrl + K
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (_overlay && _overlay.classList.contains('show')) closePalette();
      else openPalette();
      return;
    }
    // '/' v non-input contextu
    if (e.key === '/' && !isTypingTarget(e.target)) {
      e.preventDefault();
      openPalette();
      return;
    }
  });

  // Input listener (registered lazily on first build via delegation)
  document.addEventListener('input', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('cmdk-input')) {
      renderList(e.target.value);
    }
  });

  // Click on row
  document.addEventListener('click', function (e) {
    const row = e.target.closest && e.target.closest('.cmdk-row');
    if (row) {
      const idx = parseInt(row.dataset.idx, 10);
      _activeIdx = idx;
      executeActive();
      return;
    }
    // Click outside modal → close
    if (_overlay && _overlay.classList.contains('show') && e.target === _overlay) {
      closePalette();
    }
    // Esc button in input
    if (e.target.closest && e.target.closest('.cmdk-input-kbd')) {
      closePalette();
    }
  });

  // Hover row to update active (mouse-driven)
  document.addEventListener('mousemove', function (e) {
    if (!_overlay || !_overlay.classList.contains('show')) return;
    const row = e.target.closest && e.target.closest('.cmdk-row');
    if (row) {
      const idx = parseInt(row.dataset.idx, 10);
      if (idx !== _activeIdx) setActive(idx);
    }
  });

  // Expose programmatic API
  window.cmdPalette = {
    open: openPalette,
    close: closePalette,
    /** Page modules call consumeActionFlag() in init() to check if cmd-palette
     *  triggered an action. Returns flag string or null. Clears the flag. */
    consumeActionFlag: function () {
      try {
        const flag = sessionStorage.getItem(ACTION_FLAG_KEY);
        if (flag) sessionStorage.removeItem(ACTION_FLAG_KEY);
        return flag;
      } catch (_) { return null; }
    },
  };
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}
