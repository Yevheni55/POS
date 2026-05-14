# POS Tablet UX Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the POS order panel + product grid for tablet-first speed: compact rows so 5–6 items fit without scroll, equal-weight payment buttons, danger-confirm modal, prominent product-in-order badges, state-aware action buttons, unified SVG product icons.

**Architecture:** All UI sits in `pos-enterprise.html` + `css/pos.css` + `js/pos-render.js`/`js/pos-orders.js`. We refactor the existing single-page POS — no new modules, no framework swap. CSS changes are additive to the current Daylight token system (`tokens.css`, `css/pos.css` `:root` override). Touch targets standardised at 44 px. Payment-action state machine driven by a single `_computeOrderState()` helper read from `getOrder()`.

**Tech Stack:** Vanilla JS, ES2018+, CSS3 custom properties (Daylight tokens), no build step. Slovak `sk-SK` locale, `Europe/Bratislava` timezone. Existing `softDelete`/`mountEmptyState` admin helpers are POS-side equivalents already in `js/pos-payments.js` and inline modals.

---

## Pre-flight: branch, baseline, smoke test

### Task 0: Smoke baseline

**Files:** none modified — only verification

- [ ] **Step 1: Make sure working tree is clean**

Run: `git status`
Expected: `nothing to commit, working tree clean`

- [ ] **Step 2: Boot dev server locally (server already runs on kasa via Tailscale — for local-only changes you can skip)**

Run: `node --check js/pos-render.js && node --check js/pos-orders.js && node --check js/pos-payments.js`
Expected: no output (silent success)

- [ ] **Step 3: Note current pixel measurements for regression check**

Open `pos-enterprise.html` in browser at 1280×800 (tablet landscape). Measure with DevTools:
- `.order-panel` width
- `.order-item-wrap` height (one row in a multi-item order)
- Vertical pixels available for `.order-items` (subtract header + tabs + footer)
- Count how many `.order-item-wrap` rows fit without scroll

Record in a comment block at top of plan if needed. Goal after refactor: at least 5 rows fit without scroll at 1280×800.

---

## Phase 1 — Compact order rows (Spec 1.1, 1.2, 2.1, 2.2)

### Task 1: Slim order-item row layout

**Files:**
- Modify: `css/pos.css` — `.order-item-wrap`, `.order-item-inner`, `.order-item-emoji`, `.order-item-info`, `.order-item-name`, `.order-item-note`, `.order-item-note-placeholder`, `.order-item-qty`, `.qty-btn`, `.qty-val`, `.order-item-total`, `.order-item-move`, `.order-item-swipe-left`
- Modify: `js/pos-render.js:941-948` — `renderOrder()` non-move branch (the order-row HTML template)

- [ ] **Step 1: Read current row CSS to understand baseline**

Run: `grep -n "\.order-item" css/pos.css | head -30`
Expected output shows existing `.order-item-wrap`, `.order-item-inner`, `.order-item-emoji`, etc. with their current rules. Note total stack height (`padding` + `min-height` + gaps).

- [ ] **Step 2: Replace the order-row CSS block with compact 56 px tall layout**

In `css/pos.css`, find the block starting at `.order-item-wrap{` (around line 750-880) and replace ONLY the row-rendering selectors (NOT the move-mode or swipe variants) with:

```css
/* === ORDER ROW — Tablet-compact (Spec 1.1 + 2.1) ============================
   Target row height: 56px (was ~78px). 5 rows visible @ 1280×800 without scroll.
   Layout: [emoji 28] [name+note flex] [note-pencil 32] [- qty +] [price] [×]
   Touch targets ≥ 44px wide on actionable buttons (qty +/-, note, remove).
   ============================================================================ */
.order-item-wrap{position:relative;margin:2px 0;overflow:hidden;border-radius:var(--radius-sm)}
.order-item-inner{
  display:grid;
  grid-template-columns:28px 1fr 36px 132px 64px 36px;
  align-items:center;
  gap:8px;
  padding:6px 8px;
  background:var(--color-bg-elevated);
  border:1px solid var(--color-border);
  border-radius:var(--radius-sm);
  min-height:56px;
}
.order-item-inner.sent{background:rgba(74,122,58,.06);border-color:rgba(74,122,58,.18)}
.order-item-emoji{font-size:20px;line-height:1;text-align:center}
.order-item-info{min-width:0;display:flex;flex-direction:column;justify-content:center;cursor:pointer}
.order-item-name{font-family:var(--font-display);font-size:14px;font-weight:600;color:var(--color-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2}
.order-item-note{font-size:11px;color:var(--color-accent);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.order-item-note-placeholder{font-size:11px;color:var(--color-text-dim);margin-top:2px}
.order-item-note-btn{
  appearance:none;background:transparent;border:1px solid var(--color-border);
  width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;
  color:var(--color-text-sec);cursor:pointer;-webkit-tap-highlight-color:transparent;
  transition:background var(--transition-fast),border-color var(--transition-fast),color var(--transition-fast);
}
.order-item-note-btn:hover{background:var(--color-accent-bg);border-color:var(--color-accent-border);color:var(--color-accent)}
.order-item-note-btn.has-note{background:var(--color-accent-bg-hover);border-color:var(--color-accent);color:var(--color-accent)}
.order-item-qty{display:flex;align-items:center;gap:4px}
.qty-btn{
  appearance:none;background:var(--color-bg-elevated);border:1px solid var(--color-border);
  width:44px;height:44px;border-radius:10px;font-size:20px;font-weight:700;line-height:1;
  color:var(--color-text);cursor:pointer;display:flex;align-items:center;justify-content:center;
  -webkit-tap-highlight-color:transparent;
  transition:background var(--transition-fast),border-color var(--transition-fast),transform var(--transition-fast);
}
.qty-btn:hover{background:var(--color-accent-bg);border-color:var(--color-accent-border);color:var(--color-accent)}
.qty-btn:active{transform:scale(.94)}
.qty-val{
  min-width:32px;text-align:center;font-family:var(--font-mono),'JetBrains Mono Variable',ui-monospace,monospace;
  font-size:16px;font-weight:700;color:var(--color-text);font-feature-settings:'tnum' 1;
}
.order-item-total{
  text-align:right;
  font-family:var(--font-mono),'JetBrains Mono Variable',ui-monospace,monospace;
  font-feature-settings:'tnum' 1;
  font-size:14px;font-weight:700;color:var(--color-text);
  white-space:nowrap;
}
.order-item-remove{
  appearance:none;background:transparent;border:1px solid transparent;
  width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;
  color:var(--color-text-dim);font-size:18px;line-height:1;cursor:pointer;-webkit-tap-highlight-color:transparent;
  transition:background var(--transition-fast),color var(--transition-fast),border-color var(--transition-fast);
}
.order-item-remove:hover{background:var(--color-danger-bg);border-color:var(--color-danger-border);color:var(--color-danger)}
```

Keep the move-mode and swipe selectors below unchanged. Delete the OLD `.order-item-inner`, `.order-item-emoji`, `.order-item-info`, `.order-item-name`, `.order-item-note`, `.order-item-note-placeholder`, `.order-item-qty`, `.qty-btn`, `.qty-val`, `.order-item-total`, `.order-item-move` rules that defined the previous taller layout.

- [ ] **Step 3: Rewrite the order-row HTML template in `renderOrder()`**

In `js/pos-render.js`, locate the block starting around line 941 (non-move branch) and replace the full template with this compact 6-column grid output:

```js
    return `<div class="order-item-wrap" data-item-id="${o.id}"${_companionTitleAttr} ontouchstart="swipeStart(event,this)" ontouchmove="swipeMove(event,this)" ontouchend="swipeEnd(event,this)" onmousedown="swipeStart(event,this)" onmousemove="swipeMove(event,this)" onmouseup="swipeEnd(event,this)">
  <div class="order-item-inner${_isSent?' sent':''}">
    <span class="order-item-emoji" aria-hidden="true">${escHtml(o.emoji)}</span>
    <div class="order-item-info" role="button" tabindex="0" onclick="openNoteModal('${esc}', ${o.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openNoteModal('${esc}', ${o.id});}">
      <div class="order-item-name">${escHtml(o.name)}</div>
      ${o.note?`<div class="order-item-note">&#9998; ${escHtml(o.note)}</div>`:''}
    </div>
    <button type="button" class="order-item-note-btn${o.note?' has-note':''}" onclick="event.stopPropagation();openNoteModal('${esc}', ${o.id})" aria-label="${o.note?'Upravit poznamku':'Pridat poznamku'}" title="${o.note?'Upravit poznamku':'Pridat poznamku'}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
    </button>
    <div class="order-item-qty">
      <button type="button" class="qty-btn" onclick="event.stopPropagation();changeQty('${esc}', -1, ${o.id})" onpointerdown="startQtyHold('${esc}', -1, ${o.id})" aria-label="Znizit pocet">&minus;</button>
      <span class="qty-val">${o.qty}</span>${_companionBadge}
      <button type="button" class="qty-btn" onclick="event.stopPropagation();changeQty('${esc}', 1, ${o.id})" onpointerdown="startQtyHold('${esc}', 1, ${o.id})" aria-label="Zvysit pocet">+</button>
    </div>
    <div class="order-item-total">${fmt(o.price*o.qty)}</div>
    <button type="button" class="order-item-remove" onclick="event.stopPropagation();confirmRemoveItem('${esc}', ${o.id})" aria-label="Odstranit polozku">&times;</button>
  </div>
  <div class="order-item-swipe-left"><button class="swipe-btn swipe-btn-move" onclick="enterMoveMode(${o.id})" aria-label="Presunut polozku">&#8599;</button><button class="swipe-btn swipe-btn-note" onclick="openNoteModal('${esc}', ${o.id})" aria-label="Poznamka">&#9998;</button><button class="swipe-btn swipe-btn-del" onclick="removeItem('${esc}')" aria-label="Odstranit polozku">&#10005;</button></div>
</div>`;
```

Notice: the standalone `.order-item-move` arrow button is REMOVED from the row (move is still accessible via swipe-left and the per-tab move target). The `×` button now calls `confirmRemoveItem` (defined in Task 6) so a fast tap can't wipe out 5× pivo by accident.

- [ ] **Step 4: Add `confirmRemoveItem` shim**

In `js/pos-orders.js`, after the existing `removeItem` function, add:

```js
// Spec 2.1: tap × on order row → friendly inline confirm.
// Single-tap zmaze, ale ak qty > 1 ukaze potvrdenie aby sa nestratilo 5x pivo
// jedinym omylom. Pri qty == 1 maze priamo (rovnaky pocit ako predtym).
function confirmRemoveItem(name, id) {
  var order = getOrder();
  var item = order.find(function (o) { return o.id === id; });
  if (!item) { removeItem(name); return; }
  if (item.qty <= 1) { removeItem(name); return; }
  showConfirm({
    title: 'Odstránit položku',
    message: '„' + item.name + '" × ' + item.qty + ' bude odobrané z účtu.',
    confirmLabel: 'Odstránit',
    cancelLabel: 'Späť',
    danger: true,
    onConfirm: function () { removeItem(name); },
  });
}
window.confirmRemoveItem = confirmRemoveItem;
```

If `showConfirm` does not yet exist in the POS codebase, add a minimal version in `js/pos-orders.js`:

```js
// Spec 1.5 + 2.5: shared confirm modal pre destruktivne akcie.
function showConfirm(opts) {
  var existing = document.getElementById('posConfirmModal');
  if (existing) existing.remove();
  var ov = document.createElement('div');
  ov.id = 'posConfirmModal';
  ov.className = 'u-overlay show';
  ov.innerHTML = '<div class="u-modal u-modal--confirm" role="dialog" aria-modal="true">'
    + '<div class="u-modal-icon" aria-hidden="true">⚠️</div>'
    + '<div class="u-modal-title">' + escHtml(opts.title) + '</div>'
    + '<div class="u-modal-text">' + escHtml(opts.message) + '</div>'
    + '<div class="u-modal-btns">'
    +   '<button type="button" class="u-btn u-btn-ghost" data-act="cancel">' + escHtml(opts.cancelLabel || 'Späť') + '</button>'
    +   '<button type="button" class="u-btn ' + (opts.danger ? 'u-btn-rose' : 'u-btn-mint') + '" data-act="confirm">' + escHtml(opts.confirmLabel || 'Potvrdit') + '</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(ov);
  function close() { ov.classList.remove('show'); setTimeout(function () { ov.remove(); }, 300); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') { close(); } else if (e.key === 'Enter') { close(); if (opts.onConfirm) opts.onConfirm(); } }
  document.addEventListener('keydown', onKey);
  ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
  ov.querySelector('[data-act="cancel"]').onclick = function () { close(); if (opts.onCancel) opts.onCancel(); };
  ov.querySelector('[data-act="confirm"]').onclick = function () { close(); if (opts.onConfirm) opts.onConfirm(); };
  setTimeout(function () { ov.querySelector('[data-act="cancel"]').focus(); }, 0);
}
window.showConfirm = showConfirm;
```

- [ ] **Step 5: Smoke-test in browser**

Reload `pos-enterprise.html`. Open a table, add 6 items. Verify:
1. All 6 rows are visible without scroll at 1280×800
2. Tap `+` increments qty, `−` decrements, no parent-row click side-effect (stopPropagation works)
3. Tap pencil icon opens note modal
4. Tap `×` on a 1× item removes it instantly; on a 3× item shows confirm modal
5. Swipe-left on a row still reveals the swipe action panel (we did NOT touch swipe CSS)

- [ ] **Step 6: Commit**

```bash
git add css/pos.css js/pos-render.js js/pos-orders.js
git commit -m "feat(pos): compact 56px order rows — fit 5+ items without scroll"
```

---

## Phase 2 — Order list fills available height (Spec 1.2, 2.7)

### Task 2: Stretch `.order-items` + fix footer

**Files:**
- Modify: `css/pos.css` — `.order-panel`, `.order-header`, `.order-tabs`, `.order-items`, `.order-footer`, `.sum-total-wrap`

- [ ] **Step 1: Make order panel flex column with footer pinned bottom**

In `css/pos.css`, locate the `.order-panel` rule (search `\.order-panel{`). Replace + neighbouring layout rules with:

```css
/* Spec 1.2 + 2.7 — order panel je flex column: header + tabs auto, items grow, footer sticky bottom.
   On 1280×800 tablet landscape the items area is ~520px tall → 9 rows @ 56px height. */
.order-panel{
  display:flex;flex-direction:column;
  flex:0 0 360px;
  max-width:360px;
  height:100%;
  background:var(--color-bg);
  border-left:1px solid var(--color-border);
}
.order-header{flex:0 0 auto;padding:10px 14px 6px;border-bottom:1px solid var(--color-border)}
.order-tabs{flex:0 0 auto;padding:6px 8px 4px}
.order-tabs.pos-hidden{display:none}
.order-items{flex:1 1 auto;min-height:0;overflow-y:auto;padding:4px 6px;scrollbar-width:thin}
.order-footer{flex:0 0 auto;padding:8px 12px 12px;border-top:1px solid var(--color-border);background:var(--color-bg-elevated)}
```

Delete the OLD `.order-items{flex:1;overflow-y:auto;...}` rule from step earlier — it had `padding:2px 6px;` which is fine but the new rule supersedes it. Use search-and-replace: find any duplicate `.order-items{` and keep only the new one.

- [ ] **Step 2: Verify panel width vs tablet viewport**

Open browser DevTools at 1280×800. Inspect `.order-panel`: width should be 360px. `.order-items` should fill all vertical space between tabs and footer (~480–520 px depending on tabs visible). Count rows fitting without scroll — must be ≥ 5.

- [ ] **Step 3: Commit**

```bash
git add css/pos.css
git commit -m "feat(pos): order panel flex column — items area expands to fill height"
```

---

## Phase 3 — Compact total block + equal-weight payments (Spec 1.3, 1.4, 2.2)

### Task 3: Single-line total + equal H/K payment buttons

**Files:**
- Modify: `css/pos.css` — `.sum-total-wrap`, `.sum-total-label`, `.sum-total-val`, `.actions`, `.pay-row`, `.btn-send`, `.btn-prebill`, `.btn-cash`, `.btn-card`, `.btn-cancel`, `.extra-row`
- Modify: `pos-enterprise.html:118` — order panel summary block

- [ ] **Step 1: Replace summary + actions CSS with compact layout**

In `css/pos.css`, find `.sum-total-wrap{` and the action-row block beneath it. Replace with:

```css
/* Spec 1.3 — total in a single low strip, no oversized hero number. */
.sum-total-wrap{
  display:flex;align-items:baseline;justify-content:space-between;
  padding:6px 10px;margin:0 0 8px;
  background:rgba(184,84,42,.06);border:1px solid rgba(184,84,42,.18);
  border-radius:var(--radius-sm);
}
.sum-total-label{
  font-family:var(--font-body);font-weight:700;font-size:11px;
  letter-spacing:.16em;text-transform:uppercase;color:var(--color-text-sec);
}
.sum-total-val{
  font-family:var(--font-mono),'JetBrains Mono Variable',ui-monospace,monospace;
  font-feature-settings:'tnum' 1;
  font-size:22px;font-weight:800;color:var(--color-accent);
  letter-spacing:-.01em;
}

/* Spec 1.4 — Hotovost + Karta sa rovnaké, rozdiel iba ikona/text. */
.actions{display:flex;flex-direction:column;gap:6px}
.pay-row{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.btn-cash,.btn-card{
  /* equal-weight twin buttons */
  display:flex;align-items:center;justify-content:center;gap:6px;
  background:var(--color-accent);
  color:#fff;border:1px solid var(--color-accent-dim);
  font-family:var(--font-display);font-weight:700;font-size:14px;
  padding:0 var(--space-3);
  min-height:var(--btn-h-md);  /* 44px touch target — Spec 2.2 */
  border-radius:var(--radius-sm);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 2px 6px -1px rgba(184,84,42,.26);
  cursor:pointer;-webkit-tap-highlight-color:transparent;
  transition:transform var(--transition-fast),box-shadow var(--transition-fast),opacity var(--transition-fast);
}
.btn-cash:hover,.btn-card:hover{transform:translateY(-1px);box-shadow:inset 0 1px 0 rgba(255,255,255,.26),0 3px 10px -1px rgba(184,84,42,.32)}
.btn-cash:active,.btn-card:active{transform:translateY(0);box-shadow:inset 0 1px 0 rgba(255,255,255,.16),0 1px 3px rgba(184,84,42,.20)}
.btn-cash:disabled,.btn-card:disabled,.btn-prebill:disabled,.btn-send:disabled{
  opacity:.4;cursor:not-allowed;transform:none;box-shadow:none;
}

/* Send button — amber (Poslat) ostane vyrazne ze ide o non-payment akciu. */
.btn-send{
  background:var(--accent-amber);color:#f5efe3;border:none;
  font-size:14px;font-weight:800;padding:0 var(--space-3);
  min-height:var(--btn-h-md);border-radius:var(--radius-sm);
  letter-spacing:.02em;text-transform:uppercase;
  display:flex;align-items:center;justify-content:center;gap:6px;
  cursor:pointer;-webkit-tap-highlight-color:transparent;
  transition:transform var(--transition-fast),background var(--transition-fast);
  position:relative;overflow:hidden;
}
.btn-send:hover:not(:disabled){background:#c98a22}
.btn-send:active:not(:disabled){transform:translateY(1px)}

/* Predúčet — navy outline, secondary action. */
.btn-prebill{
  background:var(--color-accent-secondary-soft);
  color:var(--color-accent-secondary);
  border:1px solid color-mix(in oklab, var(--color-accent-secondary) 30%, transparent);
  font-weight:600;font-size:13px;
  padding:0 var(--space-3);min-height:var(--btn-h-md);
  border-radius:var(--radius-sm);
  display:flex;align-items:center;justify-content:center;gap:6px;
  cursor:pointer;-webkit-tap-highlight-color:transparent;
  transition:background var(--transition-fast),border-color var(--transition-fast);
}
.btn-prebill:hover:not(:disabled){background:color-mix(in oklab, var(--color-accent-secondary) 12%, transparent);border-color:var(--color-accent-secondary)}

/* Cancel — Spec 1.5: less aggressive, ghost outline + danger color iba pri hover. */
.btn-cancel{
  width:100%;background:transparent;
  color:var(--color-text-sec);border:1px solid var(--color-border);
  font-size:12px;font-weight:600;
  padding:0 var(--space-3);min-height:36px;
  border-radius:var(--radius-sm);
  cursor:pointer;-webkit-tap-highlight-color:transparent;
  transition:background var(--transition-fast),color var(--transition-fast),border-color var(--transition-fast);
}
.btn-cancel:hover:not(:disabled){background:var(--color-danger-bg);color:var(--color-danger);border-color:var(--color-danger-border)}
```

If the file already has `.btn-cash{...}` and `.btn-card{...}` with the old asymmetric styles (e.g. `.btn-cash` filled terra, `.btn-card` outline navy), DELETE those legacy rules — the new equal-weight block above replaces them.

- [ ] **Step 2: Verify HTML markup for summary block matches new selectors**

Open `pos-enterprise.html` around line 113-136. The current markup should be:

```html
<div class="sum-total-wrap"><span class="sum-total-label">Celkom</span><span class="sum-total-val" id="total">0,00 &euro;</span></div>
<div class="actions">
  <button class="btn btn-send" id="btnSend" ...>...Poslat objednavku</button>
  <button class="btn btn-prebill" id="btnPreBill" ...>...Predúčet</button>
  <div class="pay-row">
    <button class="btn btn-cash" onclick="initiatePayment('hotovost')">...Hotovost</button>
    <button class="btn btn-card" onclick="initiatePayment('karta')">...Karta</button>
  </div>
  ...
  <button type="button" class="btn btn-cancel btn-block" onclick="clearOrder()">Zrusit objednavku</button>
</div>
```

If this matches, no HTML change needed. If `Zrusit objednavku` is currently outside `.actions`, leave it there — the CSS targets `.btn-cancel` regardless.

- [ ] **Step 3: Reload and visually verify**

Open POS in browser, add 2 items to an order. Verify:
- "CELKOM" label is small + uppercase tracked
- Total value is on the SAME row as the label, right-aligned, 22 px mono
- Hotovosť and Karta sit side-by-side at equal width and identical color (both terra-filled)
- Poslať objednávka is amber (kept distinct because it's not a payment action)
- Predúčet is navy outline (secondary)
- Zrušiť objednávku is a quiet ghost button — danger styling only on hover

- [ ] **Step 4: Commit**

```bash
git add css/pos.css pos-enterprise.html
git commit -m "feat(pos): compact total + equal-weight Hotovost/Karta buttons"
```

---

## Phase 4 — Cancel-order confirmation modal (Spec 1.5, 2.5)

### Task 4: Replace `clearOrder()` direct call with confirm modal

**Files:**
- Modify: `pos-enterprise.html` — inline `onclick="clearOrder()"` on both desktop + mobile cancel buttons
- Modify: `js/pos-orders.js` — rename current behaviour to `_clearOrderImmediate()`, add new `clearOrder()` that opens confirm modal first

- [ ] **Step 1: Find current `clearOrder` implementation**

Run: `grep -n "function clearOrder" js/pos-orders.js`
Expected: one line with the function definition. Note current body — that's what we wrap.

- [ ] **Step 2: Rename existing function + add confirm-wrapper**

In `js/pos-orders.js`, replace the existing `function clearOrder(...) { ... }` block with:

```js
// Spec 1.5 + 2.5 — clearOrder uz nevykonava destruktivnu akciu priamo.
// Otvori confirm modal; potvrdenie vola _clearOrderImmediate.
function clearOrder() {
  var order = getOrder();
  if (!order.length) return;  // empty order — silent no-op
  // If everything is already sent and there's nothing pending, treat as
  // "release table" — still confirm because it abandons unpaid items.
  var pendingCount = order.filter(function (o) { return !o.sent; }).length;
  var sentCount = order.length - pendingCount;
  var summary;
  if (pendingCount && sentCount) {
    summary = pendingCount + ' nové + ' + sentCount + ' odoslaných položiek bude zrušených.';
  } else if (pendingCount) {
    summary = pendingCount + ' nových položiek bude zrušených.';
  } else {
    summary = sentCount + ' odoslaných položiek bude zrušených (zatiaľ nezaplatených).';
  }
  showConfirm({
    title: 'Zrušiť objednávku?',
    message: summary,
    confirmLabel: 'Áno, zrušiť',
    cancelLabel: 'Nie, späť',
    danger: true,
    onConfirm: _clearOrderImmediate,
  });
}

function _clearOrderImmediate() {
  // <PASTE the original clearOrder body verbatim here>
}
window.clearOrder = clearOrder;
```

Where `<PASTE the original clearOrder body verbatim here>` literally means: copy the lines that were INSIDE the previous `function clearOrder() { ... }`, paste them into `_clearOrderImmediate`. No edits. The wrapper is the only new logic.

- [ ] **Step 3: Verify mobile cancel button also routes through wrapper**

Run: `grep -n "clearOrder" pos-enterprise.html`
Expected: 3 occurrences — desktop `.btn-cancel` (line ~136), mobile `.mob-btn-cancel` (line ~223), and any drawer. All call `clearOrder()` — the wrapper will intercept. No HTML change needed.

- [ ] **Step 4: Smoke test**

Add 2 items to an order. Click "Zrušiť objednávku". Verify:
1. Confirm modal opens with title "Zrušiť objednávku?" and danger-styled "Áno, zrušiť" button
2. Click "Nie, späť" — order stays intact
3. Click "Áno, zrušiť" — order is cleared (same as before)
4. With an empty order, "Zrušiť objednávku" is a no-op (no modal flash)

- [ ] **Step 5: Commit**

```bash
git add js/pos-orders.js
git commit -m "feat(pos): cancel-order confirm modal — no more single-tap wipes"
```

---

## Phase 5 — Product-in-order visual badge (Spec 1.6, 2.6)

### Task 5: Stronger in-cart indicator on `.product-card`

**Files:**
- Modify: `css/pos.css` — `.product-card`, `.product-card.in-cart`, `.product-card .qty-badge`
- Modify: `js/pos-render.js` — `updateQtyBadges()` (find via `grep -n "updateQtyBadges" js/pos-render.js`)

- [ ] **Step 1: Read current product-card + badge CSS**

Run: `grep -n "\.product-card\|qty-badge" css/pos.css | head -20`
Note current styles for `.product-card` base, hover, and `.qty-badge` (small numerical chip in corner).

- [ ] **Step 2: Add `.in-cart` modifier with terra border + tinted bg**

In `css/pos.css`, find the `.product-card{...}` block and ADD beneath it:

```css
/* Spec 1.6 + 2.6 — produkty uz v objednavke maju vyrazne oznacenie:
   1px terra border + 6 % terra tint pozadie + vacsi badge s qty.
   Cashier hned vidi co je nablokovane. */
.product-card.in-cart{
  border-color:var(--color-accent) !important;
  background:rgba(184,84,42,.06);
  box-shadow:0 0 0 1px rgba(184,84,42,.16),0 2px 6px -1px rgba(184,84,42,.14);
}
.product-card.in-cart:hover{
  background:rgba(184,84,42,.10);
}
.product-card .qty-badge{
  position:absolute;top:6px;right:6px;
  min-width:24px;height:24px;padding:0 6px;
  border-radius:12px;
  background:var(--color-accent);color:#fff;
  font-family:var(--font-mono),'JetBrains Mono Variable',ui-monospace,monospace;
  font-feature-settings:'tnum' 1;
  font-size:12px;font-weight:800;
  display:none;align-items:center;justify-content:center;line-height:1;
  box-shadow:0 1px 4px rgba(184,84,42,.36);
  z-index:1;
}
.product-card.in-cart .qty-badge{display:flex}
```

If `.qty-badge` already exists, REPLACE its rule with this version (the bigger pill shape) and delete the old one.

- [ ] **Step 3: Wire `.in-cart` class in `updateQtyBadges()`**

In `js/pos-render.js`, find `function updateQtyBadges` (or `updateQtyBadges =`). Replace its body with:

```js
function updateQtyBadges() {
  var order = getOrder();
  // Aggregate qty per product name (companion/sauce rows kept separate;
  // their badges aren't shown).
  var totals = {};
  order.forEach(function (o) {
    if (o._companionOf) return;        // skip auto-mirror rows
    var k = String(o.name);
    totals[k] = (totals[k] || 0) + o.qty;
  });
  // For every product card in the menu, toggle .in-cart + write qty.
  document.querySelectorAll('.product-card[data-name]').forEach(function (card) {
    var name = card.dataset.name;
    var q = totals[name] || 0;
    var badge = card.querySelector('.qty-badge');
    if (q > 0) {
      card.classList.add('in-cart');
      if (badge) badge.textContent = '×' + q;
    } else {
      card.classList.remove('in-cart');
      if (badge) badge.textContent = '';
    }
  });
}
window.updateQtyBadges = updateQtyBadges;
```

- [ ] **Step 4: Make sure product-card HTML has both `data-name` and a child `.qty-badge` placeholder**

In `js/pos-render.js`, find the function that renders a product card (search for `class="product-card"`). Inside the template, ensure the wrapper looks like:

```js
'<div class="product-card" data-name="' + escAttr(p.name) + '" onclick="addToOrder(...)">'
+ '<span class="qty-badge" aria-hidden="true"></span>'
+ '... rest of the card markup ...'
+ '</div>'
```

If `data-name` or `<span class="qty-badge">` are missing, add them. The CSS rule hides the badge by default (`display:none`) and only shows it when `.in-cart` is set, so adding the empty span to every card is safe.

- [ ] **Step 5: Smoke test**

Add Urpiner 10° to an order. Verify in the product grid:
1. The Urpiner 10° card has a terra border + warm cream tint
2. A "×1" badge sits in the top-right of the card
3. Adding another → badge becomes "×2"
4. Removing all from the order → border + badge disappear

- [ ] **Step 6: Commit**

```bash
git add css/pos.css js/pos-render.js
git commit -m "feat(pos): in-cart product cards get terra border + qty pill badge"
```

---

## Phase 6 — Order-state-aware action buttons (Spec 2.3, 2.4)

### Task 6: Disable & re-prioritise action buttons per state

**Files:**
- Modify: `js/pos-render.js` — `renderOrder()` and/or `updateTotals()` (whichever runs after order changes)
- Modify: `css/pos.css` — add `.pos-action-primary` / `.pos-action-secondary` helper classes (if not using existing ones)

- [ ] **Step 1: Add `_computeOrderState()` helper to `js/pos-render.js`**

Add near the top of `js/pos-render.js` (after the existing `function fmt(...)` or similar helpers):

```js
// Spec 2.3 — single source of truth pre buttons disabled/visible state.
// Vracia jeden zo stringov: 'empty' | 'new' | 'partial' | 'sent' | 'paid'.
//   empty   = no items
//   new     = at least one item, NONE sent yet
//   partial = some sent, some pending — send button still shines
//   sent    = all sent, nothing paid yet — payments + predúčet are primary
//   paid    = order has been paid (rare in this UI since paid orders close)
function _computeOrderState() {
  var order = (typeof getOrder === 'function') ? getOrder() : [];
  if (!order.length) return 'empty';
  var hasPending = order.some(function (o) { return !o.sent; });
  var hasSent = order.some(function (o) { return o.sent; });
  if (hasPending && hasSent) return 'partial';
  if (hasPending) return 'new';
  if (hasSent) return 'sent';
  return 'empty';
}
window._computeOrderState = _computeOrderState;
```

- [ ] **Step 2: Centralise button enable/disable in a helper**

Add right after `_computeOrderState`:

```js
function _applyActionButtonState() {
  var state = _computeOrderState();
  var btnSend    = document.getElementById('btnSend');
  var btnPreBill = document.getElementById('btnPreBill');
  var btnCash    = document.querySelector('.btn-cash');
  var btnCard    = document.querySelector('.btn-card');
  var btnCancel  = document.querySelector('.actions .btn-cancel');

  // Disabled in 'empty' state (Spec 2.4)
  if (btnSend)    btnSend.disabled    = (state === 'empty' || state === 'sent');
  if (btnPreBill) btnPreBill.disabled = (state === 'empty');
  if (btnCash)    btnCash.disabled    = (state === 'empty');
  if (btnCard)    btnCard.disabled    = (state === 'empty');
  if (btnCancel) {
    btnCancel.disabled = (state === 'empty');
    btnCancel.classList.toggle('pos-hidden', state === 'empty');
  }

  // Primary emphasis swaps per state.
  // 'new' / 'partial' → Poslat je hlavna akcia.
  // 'sent'            → Hotovost/Karta a Preducet su hlavne; Poslat disabled.
  if (btnSend)    btnSend.classList.toggle('is-primary',    state === 'new' || state === 'partial');
  if (btnCash)    btnCash.classList.toggle('is-primary',    state === 'sent' || state === 'partial');
  if (btnCard)    btnCard.classList.toggle('is-primary',    state === 'sent' || state === 'partial');
  if (btnPreBill) btnPreBill.classList.toggle('is-primary', state === 'sent');
}
window._applyActionButtonState = _applyActionButtonState;
```

- [ ] **Step 3: Call `_applyActionButtonState()` at the end of `renderOrder()` and `updateTotals()`**

In `js/pos-render.js`, locate `function renderOrder()` — at the last line before its closing `}`, after `updateTotals();`, add:

```js
  _applyActionButtonState();
```

In `function updateTotals()`, before its closing `}`, also add:

```js
  _applyActionButtonState();
```

(Yes — both. `updateTotals` is sometimes called without `renderOrder` for fast-paths, and we need button state to stay consistent.)

- [ ] **Step 4: Add `.is-primary` emphasis CSS**

In `css/pos.css`, after the new `.btn-cash, .btn-card { ... }` block from Task 3, add:

```css
/* Spec 2.3 — primary akcia podla stavu objednavky.
   Visual cue: subtle outer glow + scale on hover. */
.btn-send.is-primary,
.btn-cash.is-primary,
.btn-card.is-primary,
.btn-prebill.is-primary{
  box-shadow:inset 0 1px 0 rgba(255,255,255,.26),0 4px 14px -2px rgba(184,84,42,.30),0 8px 22px -4px rgba(184,84,42,.22);
}
.btn-send.is-primary{
  box-shadow:inset 0 1px 0 rgba(255,255,255,.26),0 4px 14px -2px rgba(184,124,26,.36),0 8px 22px -4px rgba(184,124,26,.22);
}
.btn-prebill.is-primary{
  /* Predúčet primary = bolder navy fill instead of just outline. */
  background:var(--color-accent-secondary);color:#fff;border-color:var(--color-accent-secondary);
}
```

- [ ] **Step 5: Smoke test the state machine**

In POS, open a table. Verify:
1. Empty order: Hotovosť, Karta, Predúčet, Poslať are all disabled / muted; Zrušiť is hidden
2. Add 1 item: Poslať becomes primary (amber glow); Hotovosť/Karta still clickable but visually secondary; Predúčet enabled but plain; Zrušiť visible
3. Press Poslať → kitchen ticket fires → state becomes "sent"; Poslať disables; Hotovosť/Karta/Predúčet all become primary
4. Cancel order (confirm dialog from Task 4) → state back to "empty"; buttons disabled again

- [ ] **Step 6: Commit**

```bash
git add js/pos-render.js css/pos.css
git commit -m "feat(pos): action buttons disable/promote per order state machine"
```

---

## Phase 7 — Category rail polish (Spec 1.7)

### Task 7: Tablet-friendly category buttons

**Files:**
- Modify: `css/pos.css` — `.cat-list`, `.cat-btn`, `.cat-btn.active`

- [ ] **Step 1: Locate current category styles**

Run: `grep -n "\.cat-btn\|\.cat-list" css/pos.css | head -10`
Expected: rules for `.cat-list` (sidebar container) and `.cat-btn` (individual button) with their current width/padding/font.

- [ ] **Step 2: Apply 48 px tap target, larger label, refined active state**

In `css/pos.css`, replace the existing `.cat-btn{...}` block with:

```css
/* Spec 1.7 — category rail: 48px tap target, 14px label, terra accent on active. */
.cat-list{
  display:flex;flex-direction:column;gap:4px;
  padding:8px 6px;
  overflow-y:auto;-webkit-overflow-scrolling:touch;
  scrollbar-width:thin;scrollbar-color:rgba(122,100,80,.18) transparent;
}
.cat-list::-webkit-scrollbar{width:4px}
.cat-list::-webkit-scrollbar-thumb{background:rgba(122,100,80,.18);border-radius:6px}
.cat-btn{
  appearance:none;background:transparent;border:none;
  display:flex;align-items:center;gap:10px;
  width:100%;min-height:48px;padding:8px 12px;
  border-radius:10px;
  font-family:var(--font-body);font-weight:600;font-size:14px;
  color:var(--color-text);text-align:left;cursor:pointer;
  -webkit-tap-highlight-color:transparent;
  border-left:3px solid transparent;
  transition:background var(--transition-fast),border-color var(--transition-fast),color var(--transition-fast);
}
.cat-btn:hover{background:rgba(30,24,18,.04)}
.cat-btn.active{
  background:rgba(184,84,42,.10);
  color:var(--color-accent);
  font-weight:800;
  border-left-color:var(--color-accent);
  box-shadow:inset 3px 0 0 var(--color-accent);
}
.cat-btn .cat-emoji{font-size:18px;line-height:1;flex-shrink:0;width:22px;text-align:center}
.cat-btn .cat-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
```

- [ ] **Step 3: Smoke test scroll + tap target**

Open POS at 1280×800 tablet width. On the left category rail:
1. Tap a category — active state shows: terra inset bar + bold terra label + soft cream-terra tint
2. Each category button is at least 48 × full-width (no need to aim with the stylus)
3. If there are many categories, the rail scrolls smoothly with finger flick
4. Hovering a non-active item shows a soft dark tint (no surprise color shift)

- [ ] **Step 4: Commit**

```bash
git add css/pos.css
git commit -m "feat(pos): category rail — 48px taps + clearer active marker"
```

---

## Phase 8 — Unified SVG product icons (Spec 1.8)

### Task 8: Replace emoji with a tiny SVG icon sprite

**Files:**
- Create: `js/pos-product-icons.js`
- Modify: `js/pos-render.js` — order row + product card emoji emit; route through new helper
- Modify: `pos-enterprise.html` — load the icon module

- [ ] **Step 1: Create `js/pos-product-icons.js` with SVG mapping**

```js
// js/pos-product-icons.js — jednotny SVG icon set pre produkty.
// Mapping: category slug → SVG markup. Fallback je generic "dot" glyph.
// Volane z renderProductCard a renderOrder row.

'use strict';

var _SVG_BY_CATEGORY = {
  // Drinks
  pivo: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8h11v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8z"/><path d="M17 11h2a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2"/><path d="M9 12v4M12 12v4"/></svg>',
  nealko: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4h12l-2 16a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2L6 4z"/><path d="M8 10h8"/></svg>',
  limonady: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 7h12M7 7l1.5 13a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2L17 7"/><path d="M9 11h6M9 15h6"/><path d="M11 3l1 2 1-2"/></svg>',
  smoothies: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 8h8l-1 12a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2L8 8z"/><path d="M10 4h4l-1 4h-2z"/><path d="M14 3v2"/></svg>',
  kava: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h13v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-6z"/><path d="M17 12h2a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-2"/><path d="M7 7c0-1 1-1 1-2s-1-1-1-2M11 7c0-1 1-1 1-2s-1-1-1-2"/></svg>',
  alkohol: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3h8v4l-2 6v6h-4v-6L8 7z"/><path d="M9 13h6"/></svg>',

  // Food
  jedlo: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11h18a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"/><path d="M3 11c0-4 4-7 9-7s9 3 9 7"/><path d="M7 8h0M11 7h0M15 8h0"/><path d="M2 17h20"/></svg>',
  burger: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11h18a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"/><path d="M3 11c0-4 4-7 9-7s9 3 9 7"/><path d="M2 17h20"/></svg>',
  doplnky: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="9"/></svg>',
};

// Fallback heuristic: ak nevieme presnu kategoriu, pozri na meno produktu.
function _guessCategorySlug(productName, categorySlug) {
  if (categorySlug && _SVG_BY_CATEGORY[categorySlug]) return categorySlug;
  var s = String(productName || '').toLowerCase();
  if (/pivo|urpin|tatran|čapovan|capovan/.test(s)) return 'pivo';
  if (/kofol|kola|cola|sprit|tonik|tonic|fanta|pepsi/.test(s)) return 'nealko';
  if (/limonad|limo|citrus|home.?made/.test(s)) return 'limonady';
  if (/smoothie|shake|fresh|džús|dzus/.test(s)) return 'smoothies';
  if (/kafe|kava|kava|espreso|cappuc|lat[eé]/.test(s)) return 'kava';
  if (/burger|hot.?dog|wrap|sendvič|sendvic|panini/.test(s)) return 'burger';
  if (/whisk|rum|vodka|gin|tequil|brandy|liker|bork/.test(s)) return 'alkohol';
  if (/omáč|omac|hranolk|chips|prílo|prilo|extra/.test(s)) return 'doplnky';
  return null;
}

window.productIconSVG = function (productName, categorySlug) {
  var slug = _guessCategorySlug(productName, categorySlug);
  if (slug && _SVG_BY_CATEGORY[slug]) return _SVG_BY_CATEGORY[slug];
  // Fallback: small dot glyph so layout doesn't break for unknown items.
  return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/></svg>';
};
```

- [ ] **Step 2: Load icon module before pos-render.js**

In `pos-enterprise.html`, find the `<script src="/js/pos-render.js">` line. Add immediately BEFORE it:

```html
<script src="/js/pos-product-icons.js"></script>
```

- [ ] **Step 3: Use `productIconSVG()` in order rows**

In `js/pos-render.js`, find the line `<span class="order-item-emoji" aria-hidden="true">${escHtml(o.emoji)}</span>` (Task 1 left this — escHtml on the emoji string). Replace with:

```js
<span class="order-item-emoji" aria-hidden="true">${(typeof productIconSVG==='function'?productIconSVG(o.name,o.categorySlug):escHtml(o.emoji||''))}</span>
```

The fallback keeps emoji rendering if the icon module fails to load — defensive against caching bugs.

- [ ] **Step 4: Use `productIconSVG()` in product cards**

In `js/pos-render.js`, locate the function that emits `.product-card` HTML (search `class="product-card"`). Find where the emoji glyph is currently emitted (likely `${p.emoji}` or `escHtml(p.emoji)`). Replace it with:

```js
(typeof productIconSVG==='function'?productIconSVG(p.name,p.categorySlug):escHtml(p.emoji||''))
```

The SVG is `currentColor` based — colour comes from the surrounding `.product-card` text color, so it adapts to terra on `.in-cart` cards.

- [ ] **Step 5: Smoke test icon consistency**

Open POS. Scroll across all categories. Verify:
1. Every product card shows a consistent SVG glyph (no random emojis)
2. Beer items in any category share the beer glyph; sodas share the bottle glyph; etc.
3. In the order panel, the row icon matches the card icon for the same product
4. Unknown product (e.g. shisha) gets the fallback dot — readable, not garbage

- [ ] **Step 6: Commit**

```bash
git add js/pos-product-icons.js js/pos-render.js pos-enterprise.html
git commit -m "feat(pos): unified SVG product icons replacing inconsistent emojis"
```

---

## Phase 9 — Final tablet QA + deploy

### Task 9: Acceptance checklist + deploy

**Files:** none modified — purely validation.

- [ ] **Step 1: Local syntax check**

Run: `node --check js/pos-render.js && node --check js/pos-orders.js && node --check js/pos-payments.js && node --check js/pos-product-icons.js`
Expected: no output (all OK).

- [ ] **Step 2: Validate every acceptance criterion (Spec § 3)**

Open POS at tablet viewport 1280×800 in browser. Verify each:

| # | Criterion | Pass? |
|---|-----------|-------|
| 1 | 5+ order items visible without scroll | □ |
| 2 | `+` / `−` qty buttons comfortable to tap (≥44 px) | □ |
| 3 | Product card with items in order shows terra border + qty pill | □ |
| 4 | Hotovosť + Karta look identical in weight (only icon/text differs) | □ |
| 5 | Empty order: all payment + send + predúčet + cancel disabled | □ |
| 6 | Cancel always triggers confirm modal | □ |
| 7 | Total visible but compact (single row, ≤ 28 px tall block) | □ |
| 8 | Order panel still usable with 10–12 items (scroll smoothly) | □ |
| 9 | Categories: easy to tap, active state obvious | □ |
| 10 | Whole UI navigable by finger (no precision misses) | □ |

If any row fails, return to its origin task and iterate. Do not deploy a half-pass list.

- [ ] **Step 3: Bump CSS cache-bust**

Run: `grep -n "pos.css?v=" pos-enterprise.html | head -3`
Expected: one `<link>` with `pos.css?v=NN`. Increment NN by 1. Example:

```bash
sed -i 's|pos.css?v=[0-9]\+|pos.css?v=42|g' pos-enterprise.html
```

(Replace `42` with `previous+1`. Verify with another grep.)

- [ ] **Step 4: Deploy to kasa**

Run: `DEPLOY_HOST="surfs@100.95.64.38" sh scripts/deploy-tailscale-pos.sh`
Expected last lines: `Container pos-app-1 Started\n=== Deploy complete ===`

- [ ] **Step 5: Live tablet sanity check**

On the kasa tablet over Tailscale: hard-reload (`Ctrl+Shift+R`). Repeat the 10-row acceptance table from Step 2. Each criterion must still hold on actual hardware (touch latency, font rendering, viewport quirks all live).

- [ ] **Step 6: Final commit (deploy bumper)**

```bash
git add pos-enterprise.html
git commit -m "chore(pos): cache-bust pos.css for tablet UX refresh"
git push origin HEAD:main
```

---

## Out-of-scope (NOT in this plan)

These were mentioned around the spec but are intentionally **not** addressed here — track separately if needed:

- Replacing inline modals (`showConfirm`) with the admin `softDelete` Gmail-undo pattern — different UX trade-off.
- Adding a Cmd+K command palette to POS — admin already has it; POS is single-context, low value.
- Bulk select / bulk delete of order items — not mentioned in spec.
- Mobile-phone-portrait layout — spec only requests tablet landscape.
- New fonts or palette overhaul — Daylight stays as-is.

---

## Risks + open questions

- **`.order-item-move` removal** (Task 1): we drop the standalone arrow button because it duplicated swipe-left move. If any code path (move-mode flow, drag-drop between tabs) depends on `.order-item-move` selector, it'll break. Mitigation: keep move-mode CSS untouched; arrow access remains via swipe-left + per-tab "Presunut" button.
- **`_clearOrderImmediate` body copy** (Task 4): the plan tells the engineer to paste the previous body verbatim. If the existing `clearOrder` has side-effects we miss (e.g. specific event dispatches), the wrapper will silently break them. Mitigation: side-by-side diff before/after; smoke-test the cancel flow explicitly.
- **Product icon module load order** (Task 8): `productIconSVG` must exist before `renderOrder()` first call. We add the `<script>` BEFORE `pos-render.js` so the global is set in time. If a service worker caches old `pos-enterprise.html`, the new script tag won't load — Phase 9 cache-bust takes care of this for the HTML, but `pos-product-icons.js` itself has no `?v=` query. Add one if cache shows stale icons.
- **`categorySlug` field** (Task 8): we read `o.categorySlug` / `p.categorySlug`. If product objects don't expose this property in current API responses, the `_guessCategorySlug` heuristic on the product NAME is the safety net. Tested by Phase 8 Step 5 — every product must show A icon, even if not the perfect one.
