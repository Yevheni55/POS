# Web POS — plán zlepšení (syntéza 186 nálezov, 10 dimenzií)

Merge: 186 nálezov → **48 položiek**. Zlúčené sú tie, kde rôzni auditori našli **ten istý koreň** z iného uhla (napr. „dvojitý doklad" našli pos-ux aj backend-api; TZ chybu 6 dimenzií naraz).

---

## ⭐ TOP 5 — čo urobiť ako prvé

| # | Zmena | Prečo práve toto |
|---|---|---|
| **1** | **Deploy prestať baliť working tree; scommitovať 5 untracked súborov + 43 „M"** (`scripts/deploy-tailscale-pos.sh:23,37`) | Kasa dnes beží kód, ktorý **neexistuje v žiadnom commite** — obnova z gitu po havárii PC nezbootuje (`server/routes/payments.js:22` importuje untracked `lib/payments/qr.js`). Všetko ostatné v tomto pláne je bezcenné, kým je toto pravda. |
| **2** | **Re-entrancy guard na `confirmPayment` + Enter** (`js/pos-payments.js:1266`, `js/pos-ui.js:608`) | 10 riadkov kódu zabráni **dvom eKasa dokladom na jednu tržbu**, ktoré sa už nedajú vziať späť bez ručného storna v Portose. |
| **3** | **1-riadkový hotfix `loadAllOrders`** (`js/pos-state.js:286` — preskočiť zápis keď `t.id === selectedTableId`) | Dnes sa po tichom 30 s polle na stole s 2 účtami **prilepia položky cudzieho účtu do platby** a server nadhodnotenú sumu prepustí (`create.js:54` kontroluje len podtečenie). Hosť zaplatí cudzí účet. |
| **4** | **Z-report: Portos výber presunúť ZA idempotenčný guard + confirm** (`server/lib/print/z-report.js:81` vs `:103`, `admin/pages/dashboard.js:158`) | Jeden omylný tap na tablete = **reálny fiškálny paragón výberu hotovosti**; druhý tap = druhý paragón, kým cashflow má len jeden zápis. Papier a zásuvka si prestanú sedieť. |
| **5** | **Offline fronta: flush v `_setOnline()` + null-check `newOrder`** (`api.js:45`, `js/pos-orders.js:515`) | Po `docker compose up -d --build` (váš vlastný deploy flow) sa NIC event nevystrelí → **zaradené objednávky visia navždy**, kuchyňa nedostane bon a účet sa dá zaplatiť bez nich. |

---

## 🔴 NOW — tento týždeň (takmer všetko S, najvyšší payoff)

### N1. Git/deploy hygiena — prod beží na neverzovanom kóde
`scripts/deploy-tailscale-pos.sh:23,37` · **critical / S** · *(tests-tooling)*
- Untracked, ale bežiace na kase: `server/lib/payments/qr.js` (239 r.), `server/lib/sheets-export.js` (229 r.), `admin/pages/odpisy.js` (178 r.), `scripts/migrations/2026-06-16-order-items-discount.sql`, `server/test/routes/payments.qr.test.js` (320 r.).
- `git show HEAD:server/routes/payments.js | grep qr` → 0 zásahov ⇒ `git clone` + build **spadne na chýbajúcom module**.
- Fix: `git add` tých 5 + commit 43 „M" súborov; do deploy skriptu pred r. 23 vložiť `git diff --quiet && git diff --cached --quiet || exit 1`; `tar` nahradiť za `git archive HEAD`; do balíčka `git rev-parse HEAD > DEPLOYED_SHA`.

### N2. Dvojitý eKasa doklad na jednu platbu
`js/pos-payments.js:1266,1290,1377` · `js/pos-ui.js:608` · `server/lib/payments/create.js:37,42,126,139` · `server/lib/payments/context.js:24` · `api.js:374`
**critical / S (klient) + M (server)** · *(zlúčené: pos-ux + backend-api)*
- Klient: `btnLoading()` disabluje len tlačidlo, Enter volá `confirmPayment()` priamo. `api.post` generuje **nový idempotency kľúč** pri každom volaní.
- Server: `order.status='open'` sa kontroluje **mimo transakcie** a flipne sa až po Portos roundtripe → dva requesty = dva `externalId` = dva doklady. Lokálne vznikne len JEDNA platba (`payments_order_id_uidx`), takže druhý doklad **nemá v DB stopu a nedá sa stornovať**.
- **NOW (S):** modulový `_confirmingPayment` flag v `confirmPayment` + reset vo `finally` (r. 1377); v `pos-ui.js:609` `if (b && !b.disabled)`. Ten istý vzor pre `initiateQrPayment` (r. 1409) a `closeAsOdpis` (r. 1130).
- **NEXT (M):** `SELECT pg_advisory_xact_lock(hashtext('order-pay'), $orderId)` pred `create.js:126`, alebo atomické `UPDATE orders SET status='paying' WHERE status='open' RETURNING *`.

### N3. Cudzie položky v účte → hosť zaplatí viac
`js/pos-state.js:286-315,404-410,567` · `js/pos-init.js:210-252` · `js/pos-render.js:1138` · `server/lib/payments/create.js:54`
**critical / S (hotfix) + M (poriadok)** · *(architecture)*
- Dvaja pisatelia do `tableOrders[selectedTableId]`: `loadAllOrders()` píše **súčet všetkých účtov stola** (r. 306), `loadTableOrder()` píše **len aktuálny účet** (r. 408). 30 s poll korekciu robí len vnútri `if (_lastOrdersCacheJSON !== oldJSON)`.
- **Hotfix (1 riadok):** v `pos-state.js:286` preskočiť `t.id === selectedTableId`.
- **Poriadok (M):** `loadAllOrders()` píše výhradne do `allOrdersCache` + `TABLES[].status`; duplikovaný blok `pos-init.js:223-246` / `pos-state.js:404-426` vyňať do `syncCurrentOrderFromCache(tableId)` a volať bezpodmienečne.

### N4. Uzávierka vystaví druhý fiškálny výber hotovosti
`server/lib/print/z-report.js:81 vs :103-110` · `server/lib/portos.js:368` · `admin/pages/dashboard.js:156-171` · `admin/pages/reports.js:883`
**high / S** · *(zlúčené: admin-ux + backend-api)*
- Portos `registerCashWithdrawal()` beží **pred** idempotenčným SELECTom nad `cashflow_entries`, a request nenesie `externalId` ⇒ ani Portos nededuplikuje.
- Fix: SELECT presunúť pred blok 76-98 a pri existujúcom `withdrawal_uzavierka` Portos preskočiť; do `registerCashWithdrawal` doplniť deterministický `externalId = withdraw-${date}-${cashRegisterCode}`.
- UI: `showConfirm` na `dashboard.js:158` aj `reports.js:883` s textom „Vystaví sa fiškálny paragón výberu — nedá sa vrátiť".

### N5. Offline fronta + robustnosť `syncOrderToServer`
`api.js:6,36,45,71,79,81,104,111,194,208,444` · `js/pos-orders.js:508-517,551` · `js/pos-payments.js:66,1365`
**critical / S** · *(zlúčené: resilience ×4 + frontend-perf + frontend-security)*
Päť nezávislých defektov jednej cesty:
1. **Queue sa flushne LEN na `window 'online'`** (`api.js:444`). Reštart servera / rebuild kontajnera NIC event nevystrelí → objednávky visia navždy. → V `_setOnline()` (r. 45) spustiť flush s reentrancy guardom + 10 s heartbeat na `/api/health` kým `_offline`.
2. **Detekcia offline cez `err.message.includes('fetch')`** (`api.js:194`, `pos-payments.js:66,1365`) — Safari/iOS hlási `Load failed` ⇒ na iPhone sa POST **nezaradí do queue** a padne ako `showToast('Chyba sync: Load failed')`. → `_isTransportError(err)` = `TypeError || AbortError || !navigator.onLine`.
3. **`newOrder.id` bez null-checku** (`pos-orders.js:515`) — offline `request()` vracia `null` → TypeError, a **každý ďalší pokus zaradí ďalší POST /orders** s novým kľúčom ⇒ N duplicitných účtov po obnove. → null-check + stabilný idempotency kľúč uložený vedľa lokálnej objednávky.
4. **`syncQueue` hlási falošný úspech** (`api.js:104` + toast `:449`) — `request()` pri chybe vráti `null` a operáciu si sám vráti do queue, ale počíta sa ako `synced++`.
5. **Bez capu/TTL a bez try/catch okolo `setItem`** (`api.js:36,208`) — dni staré POSTy sa naraz prehrajú a založia účty, ktoré nikto nezakladal. → filter `> 6 h` v `_loadQueue`, cap 200, try/catch.

### N6. Časové zóny — jeden sweep, 6 súborov
**high / S** · *(zlúčené: admin-ux + architecture + backend-api + tests-tooling ×3)*
| Miesto | Chyba | Fix |
|---|---|---|
| `admin/pages/reports.js:37-50` | `monthStartStr()` vracia **posledný deň predošlého mesiaca** celý letný čas | `bratislavaDayIso()` (`api.js:22`) + `iso.slice(0,8)+'01'` |
| `admin/pages/weekly.js:38-50`, `season.js:27` | to isté | dtto |
| `server/lib/reports/z-report.js:10-11` | okno 02:00–01:59; po polnoci **takmer prázdny report** | `AT TIME ZONE 'Europe/Bratislava'` ako v `summary.js:22` |
| `server/lib/reports/staff.js:12-13` | to isté | dtto |
| `server/lib/reports/export.js:15-16,92-93` | CSV pre účtovníčku: okno + `toLocaleDateString` bez `timeZone` | dtto + `localDateTime` z `print/format.js:23` |
| `server/lib/print/tickets.js:441-442` | **vytlačený čas uzávierky je UTC** (o 2 h vedľa); `localTimeHHMM` z `format.js:14` sa neimportuje | doplniť import, nahradiť `getHours()` |
| `server/lib/reports/weekly.js:169,390` | `offsetMs` je zlý → hodinové bucketovanie dáva **iné a obe nesprávne** čísla v UTC vs Bratislava | prepočet cez `Intl.DateTimeFormat.formatToParts` |
- Do deploy checklistu grep guard `toISOString().split('T')`.

### N7. printers.js — čašník píše HTML do admin session + skenuje sieť
`server/routes/printers.js:59,80,107,125` · `server/app.js:211` · `admin/pages/settings.js:601,602,610,717`
**critical / S** · *(zlúčené: frontend-security ×2 + backend-api)*
- Súbor **neimportuje `requireRole`** ⇒ POST/PUT/DELETE/test sú za holým `auth`. Je to **jediná cisnik→admin eskalačná cesta** v celom audite (menu/ingredients/tables sú manazer+).
- `settings.js:601` reťazí `p.name` do `innerHTML` bez escapu, hoci `escapeHtml()` je v tom istom súbore na r. 717.
- `/:id/test` volá `net.connect(port, ip)` s odlišnou hláškou pri refused vs timeout = blind port-scan oracle na tailnete.
- Fix: `const mgr = requireRole('manazer','admin')` na r. 59/80/107/125 (GET nechať otvorený); `escapeHtml()` na r. 601-604 a 610; validácia `ip` cez `isPrivateLanHostname()` (`server/lib/cors-origin.js`) a `port` ako int 1–65535.

### N8. Postgres 5432 publikovaný s heslom `pos/pos`
`docker-compose.yml:6,7,11,12` · `server/db/schema.js:18` · **high / S**
- Bind na 0.0.0.0, app pristupuje interne cez `db:5432` ⇒ mapovanie je zbytočné. `psql -h 100.95.64.38 -U pos` obchádza **každý `requireRole` v repe** a číta `pin_visible` v plaintexte.
- Fix: zmazať `"5432:5432"` (alebo `127.0.0.1:5432:5432`), heslo do root `.env`, prerotovať.

### N9. Odstránenie položky podľa MENA → zmaže sa iný riadok
`js/pos-orders.js:900,917,985` · `js/pos-render.js:1262` · `js/pos-mobile.js:354` · `js/pos-orders.js:558`
**high / S** · *(zlúčené: pos-ux ×2 + architecture)*
- `confirmRemoveItem(name, id)` si nájde správnu položku pre TEXT potvrdenia podľa `id`, ale potom volá `removeItem(name)` → `order.find(o => o.name === name)` = prvý zhodný riadok. Duplicitné mená sú bežné (note, `_noMerge` combá, sent+unsent twin).
- Dôsledok: STORNO bon do kuchyne na **nesprávnu položku**, a tá správna ide do fiškálu.
- Fix: použiť existujúci `_findOrderItemForQtyChange(order, name, itemId)` (r. 558). Pri tom: `pos-mobile.js:354` `removeItem` → `confirmRemoveItem(esc, o.id)` (mobil dnes maže 5× pivo bez potvrdenia) a `pos-mobile.js:320` doplniť chýbajúci `escAttr()`.

### N10. Serverový guard sweep — 6 dier, jeden PR
**high / S** · *(zlúčené: backend-api ×6 + frontend-security ×2)*
| Route | Diera | Fix |
|---|---|---|
| `orders.js:1376` DELETE `/:id` | manažér natvrdo zmaže `payments` + `fiscal_documents` (r. 1397,1400) — **eKasa doklad ostane, lokálne nič**; audit event sa zmaže kaskádou (`schema.js:228`) | odmietnuť pri existujúcom SUCCESS doklade; audit do `events`, nie `order_events`; `requireRole('manazer','admin')` |
| `orders.js:300` POST `/:id/close` | ľubovoľný JWT zavrie účet **bez platby a bez fiškálu**, `closure_type='paid'` | odstrániť (web to nevolá) alebo mgr + `status='open'` + kontrola payment |
| `orders.js:273,279,283` `/batch` | `where(eq(orderItems.id, op.itemId))` **bez `orderId`** = cross-order IDOR | pridať `and(eq(orderItems.orderId, orderId))` ako na r. 208/215 |
| `orders.js:197,234` PUT/DELETE items | manager-PIN gate na storno **odoslanej** položky je len klientsky (`pos-orders.js:906`, `sessionStorage`) — priama cesta ku krádeži | ak `sent && req.user.role==='cisnik'` → 403 (elevation token z `auth.js:161` je dnes mŕtvy kód) |
| `payments.js:46` receipt-copy | jediná platobná routa bez guardu — kópia ľubovoľného historického dokladu | `staff` guard + obmedziť na dnešný deň + audit event |
| `invoice-scan.js:15` | čašník ťahá **gpt-4o** na účet prevádzky, 20 MB body | `requireRole('manazer','admin')` + `express.json({limit:'6mb'})` |
| `staff.js:33,52` | `hourlyRate` všetkých kolegov ľubovoľnému JWT (komentár „needed for POS UI" je zastaraný — `grep` v `js/` = 0 volaní) | hourlyRate len pre mgr+ |

### N11. Zatvorené modály ostávajú v tab-poradí
`css/pos.css:1608,1621,1113,1192` · `admin/admin.css:389,2436` · `pos-enterprise.html:286` · **high / S** · *(a11y)*
- `.u-overlay{opacity:0;pointer-events:none}` bez `display/visibility/inert` (`grep inert` = 0 v celom scope). 10 statických overlayov ⇒ **~30 neviditeľných tab-zastávok** medzi mriežkou produktov a panelom účtu. Projekt pritom klávesnicu zámerne podporuje (F2, `/`, Enter=platba).
- Fix: `visibility:hidden` / `visible` + `transition ... visibility 0s linear var(--t-paper)`; ideálne `overlay.inert = !shown`.

### N12. Štyri CSS premenné neexistujú — manažérsky PIN kontext je neviditeľný
`js/pos-ui.js:409` · `js/pos-payments.js:540,657` · `css/pos.css:619,640` · `admin/pages/assets.js:233,383,511` · **high / S** · *(design-system)*
- `.manager-pin-context` má `color: var(--color-text-muted, rgba(255,255,255,.7))`; premenná **neexistuje** (správna je `--text-muted`) ⇒ vyhrá **biely fallback na krémovom `#ece4d2`** ≈ 1,1:1.
- Je to jediné miesto, kde je napísané, **čo manažér PIN-om schvaľuje** (5 volajúcich: `pos-orders.js:796,911,1040`, `pos-payments.js:366,1075`), titulok modálu je generický „Manazersky PIN" ⇒ **porazená protipodvodová kontrola**, manažér schvaľuje na slovo čašníka.
- Fix: `.manager-pin-context` do `css/pos.css` s `var(--color-text-sec)`; premenovať `--color-text-muted`→`--color-text-sec` (22×), `--color-surface-raised`→`--surface-raised`, `--text-dim`→`--color-text-dim`, `--color-info`→`--color-accent-secondary`; `--color-warning*` promovať z `admin/admin.css:52-54` do `tokens.css`.

### N13. Boot POS: odstrániť blokujúce externé závislosti
`js/pos-init.js:134-143` · `pos-enterprise.html:13-18` · `login.html:13-18` · `dochadzka.html:7-10` · `sw.js:10-36` · **high / S** · *(zlúčené: frontend-perf ×2 + design-system)*
- `await Promise.race([api.getCompanyProfile({refresh:true}), 12s])` stojí **pred prvým renderom**; server v ňom robí Portos sync s 8 s stropom (`company-profile.js:99`). Čaká sa na názov prevádzky do hlavičky. → fire-and-forget po `renderProducts()`. To isté `admin/router.js:292` (18 s strop).
- 2× `fonts.googleapis.com` stylesheet **pred** `tokens.css` na 3 povrchoch; `fonts/fonts.css` deklaruje len Sora+Manrope (nepoužité), admin/kitchen preto bežia na `system-ui`. → self-host Outfit + JetBrains Mono, zmazať 6 link tagov, pridať do `sw.js STATIC_ASSETS`, odstrániť z CSP (`server/app.js:83,86`).
- `socket.io.js` 156 kB → `socket.io.min.js` 47 kB (`pos-enterprise.html:436`, `kitchen.html:39`).

### N14. Deploy brána: `node --check` + `npm test`
`scripts/deploy-tailscale-pos.sh:37` · `package.json:7` · `server/package.json:16` · **high / S** · *(tests-tooling)*
- `.github` neexistuje, `.husky` neexistuje, `.git/hooks` = samé `.sample`, žiadny eslint/prettier. Deploy ide `ssh ... docker compose up -d --build` bez akejkoľvek brány.
- POS načítava `js/pos-*.js` ako **klasické skripty** ⇒ syntax error v jednom súbore ticho zabije všetky jeho globálne funkcie (čašník klikne a nestane sa nič, bez hlášky).
- Fix: pred r. 23 `for f in js/*.js api.js components/*.js admin/pages/*.js sw.js; do node --check "$f" || exit 1; done` + `(cd server && npm test)`. Root `package.json`: `"test": "npm --prefix server test"`.

---

## 🟠 NEXT — tento mesiac

### QR platba a paragóny (fiškálna integrita)
**Q1. QR platba žije iba v pamäti tabu** — `js/pos-payments.js:440,452,508,514,565` · `server/lib/payments/qr.js:47` · **critical / M**
`_qrPayments = []` in-memory; kľúč `qrTx:` sa **zapisuje a nikdy nečíta**; server transakciu neperzistuje vôbec. Reload → hosť zaplatil, doklad nevznikol. Navyše `method:'prevod'` sa **nedá vybrať v bežnom modáli** (jediný POST je r. 565) ⇒ recovery vedie k dokladu so zlým spôsobom platby. Fix: restore z `localStorage` pri boote (S) + tabuľka `qr_payments` a worker podľa vzoru `server/jobs/paragon-sync.js` (M). Sem patrí aj `_qrFinalize` (r. 552-603), ktorý po zlyhaní fiškálu **už nikdy nereštartuje pooling**.

**Q2. Paragón fallback zlyhá presne pri výpadku — a neskôr sa prehrá ako druhý doklad** — `api.js:6` · `js/pos-payments.js:1216,1225,1364` · `server/routes/paragons.js:67` · **critical / M**
`/paragons` nie je v `OFFLINE_NO_QUEUE_PREFIXES` ⇒ offline vráti `null` → „Paragón sa nepodarilo vystaviť". Zostane v queue, po obnove sa prehrá a `POST /paragons` **nekontroluje, či účet už nie je zaplatený** ⇒ dva doklady v eKase. Fix: prefix do zoznamu + server-side 409 pri `order.status !== 'open'` alebo existujúcej platbe.

### Peniaze / reporty
**Q3. Zrušenie celého účtu nezapíše žiadne storno** — `js/pos-orders.js:1049-1098` · `server/routes/orders.js:864,1376` · **high / M**. Storno 1 piva = zápis do koša + korekcia skladu; storno 8-položkového účtu = **nič** (sklad zostáva odpísaný ako predaj, strata neviditeľná v P&L).
**Q4. Cashflow karta „Čistý zisk" odpočítava aj automatické výbery hotovosti** — `admin/pages/cashflow.js:127` · `server/routes/cashflow.js:140-146,197` · `server/lib/print/z-report.js:114`. Hotovostná tržba sa v čísle prakticky vyruší ⇒ arytmeticky nezmyselné číslo vedľa iného čísla v Reportoch. Fix: vylúčiť `withdrawal_uzavierka`, premenovať na „Čistý tok hotovosti".
**Q5. História platieb: q-filter a scope bežia až PO SQL limite** — `server/lib/payments/history.js:29-56` · `admin/pages/payments.js:236,449`. Platba staršia než posledných 200 sa nedá nájsť ⇒ ani stornovať, refiskalizovať či vytlačiť kópiu. Fix: filtre do WHERE, `from`/`to` do UI, `truncated` flag, oprava `destroy()` (stráca `scope`).
**Q6. `SUM(DISTINCT payments.amount)` zlúči rovnaké sumy** — `server/lib/reports/staff.js:23,36`. V bare, kde je väčšina účtov cenníková suma, je hodnotenie personálu **systematicky podhodnotené**; headline navyše obsahuje stornované platby (`notStornoedSql` je len v breakdowne, r. 51).
**Q7. `payments.amount` sa berie od klienta** — `server/lib/payments/context.js:128` · `schemas/payments.js:10` · `fiscal-payment.js:382`. Doklad ide na serverový `expectedTotal`, DB dostane klientskú hodnotu ⇒ pri zastaranom stave klienta systém a súčet dokladov nesedia. Fix: ukladať `expectedTotal`, klientský amount len ako sanity check → 409.
**Q8. CSV export deduplikuje položky podľa MENA** — `server/lib/reports/export.js:78`. Dva legitímne riadky s tým istým názvom (napr. Kofola s poznámkou a bez) ⇒ Zaklad ≠ Celkom. Kľúč `row.orderItemId` je už načítaný na r. 68.
**Q9. Vymazanie PRIJATEJ objednávky skladu bez confirmu a bez reverzu** — `admin/pages/purchase-orders.js:145,198` · `server/routes/inventory.js:624`. `stock_movements` ostanú visieť na neexistujúce `purchase_order id`. `cancel`/`reopen` pritom `reversePurchaseOrderStock()` volajú.
**Q10. move-items nekontroluje stav zdrojovej objednávky** — `server/routes/orders.js:1081` + `splitSchema`/`moveItemsSchema` bez `version` (`schemas/orders.js:46,51`). Dá sa stiahnuť položky zo **zaplatenej** objednávky; split navyše maže audit históriu kaskádou.

### Bezpečnosť
**Q11. `pin_visible` plaintext + manažér číta admin PIN** — `server/routes/staff.js:64,67,118` · `schema.js:18`. Potvrdená manazer→admin eskalácia; nočný `pg_dump` nesie plaintext PIN-y. Krátkodobo: `requireRole('admin')` + filter na cudzie admin riadky; správne: zahodiť stĺpce, „Resetovať PIN" ukáže PIN raz.
**Q12. escapeHtml — 22 kópií, 4 správania** — `admin/index.html:319` · `supplies.js:10,61,84` · `recipes.js:293` · `command-palette.js:204` · `staff.js:268` · `js/pos-escape.js:24,44` · plus neescapované sinky v `reports.js:722,798,806,867,873`, `menu.js:142,564,568,669`, `tables.js:170`, `dashboard.js:348,495`, `ingredients.js:83`, `inventory-dashboard.js:113`, `shisha.js:80`.
Prioritne: 3 DOM-based varianty (neescapujú `"` ani `'`) použité **v atribútoch**; potom `<script src="/js/pos-escape.js">` do `admin/index.html:167` a zmazanie lokálnych kópií.
**Q13. bcrypt DoS pred rate-limitom** — `server/routes/auth.js:81-87,137-141` · `server/routes/attendance.js:83,105` · `server/app.js:190`. `bcryptjs` (pure JS, cost 10) × všetky aktívne účty **synchronne**, lockout až potom, a `/attendance/identify` je **verejná**. Ktokoľvek na tailnete zmrazí kasu. Fix: lockout pred compare, `await bcrypt.compare`, staffId z klienta, `express-rate-limit`.
**Q14. Offline queue sa prehrá pod tokenom ĎALŠIEHO používateľa** — `api.js:79,99,135,208`. Zdieľaný tablet: A zaradí, odhlási sa, B sa prihlási → zápisy sa pripíšu B (`staffId: req.user.id`) ⇒ zlá atribúcia tržieb a auditu, ktorá ide do mzdových reportov. Fix: `staffId` do queue položky + skip cudzích.
**Q15. Mobilný admin handoff + logout hygiena** — `js/pos-mobile.js:487-489` · `admin/index.html:202-215` · `api.js:135`. TTL 30 s vynucuje len konzument; ak sa cieľ nikdy nenačíta, JWT ostane v `localStorage`. + `sessionStorage.removeItem('pos_shift_started_at')`.

### Výkon
**Q16. Socket event storm** — `js/pos-init.js:271,283,292,304,324,333,345` · `server/lib/emit.js:22` · `js/pos-state.js:268,316`. 7 z 10 handlerov robí plný `loadAllOrders()`, broadcast ide aj pisateľovi, `syncOrderToServer` pošle N zápisov → N refetchov **presne pri potvrdzovaní platby**. Fix: originId + ignore vlastného echa, 150 ms coalescing, inkrementálny update z `data.tableId`.
**Q17. Batch endpoint pre item writes** — `js/pos-orders.js:480,525,546`. Sekvenčné DELETE/PUT po jednom (PUT reťazí `orderVersion`, nedá sa paralelizovať) ⇒ `PATCH /orders/:id/items` s `{version, deletes[], updates[]}` v jednej transakcii + jeden emit + vrátený čerstvý účet (odpadne aj `loadTableOrder` na r. 546).
**Q18. Dashboard 8× `/reports/summary`** — `admin/pages/dashboard.js:295-307,209` · `server/lib/reports/summary.js` (21 sekvenčných dotazov). ~168 SQL na jeden refresh, na tej istej DB ako kasa. Fix: `GET /reports/daily-revenue` + `?light=1` (použije aj `season.js:46`, ktorý ťahá 3-mesačný `productsByDay` a nepoužije ho).
**Q19. Mobil: `updateQtyBadges` monkeypatch prerenderuje celé menu** — `js/pos-mobile.js:518-523,112,171`. Každé +/- zbúra 40-80 tlačidiel a stratí scroll. Desktop má guard `_lastProductsRenderKey` (`pos-render.js:796`).
**Q20. Non-passive `touchstart/touchmove` na `document`** — `js/pos-ui.js:542,558`. Registrované bezpodmienečne pri načítaní ⇒ vypnutý async scrolling pre celú stránku. Fix: registrovať len počas edit módu (vzor `_startTableResize`, r. 471).

### Odolnosť / prevádzka
**Q21. Zálohy len na tom istom disku, bez alertu** — `server/lib/backup.js:20` · `docker-compose.yml:50` · `server/server.js:216`. Zlyhanie disku = živá DB **aj 14 dní záloh** naraz. Fix: kópia cez Tailscale na druhý peer + `lastBackup` v `/api/health` + na dashboarde.
**Q22. sw.js precache je pre POS mŕtvy** — `sw.js:10-36,86` vs `pos-enterprise.html:23,438-443`. Precache nemá `?v=`, `caches.match` je bez `ignoreSearch` ⇒ offline chýba **5 z 8 POS skriptov aj `/css/pos.css`**. + chýbajú `pos-escape.js`, `pos-product-icons.js`, `escHtml.js`, `icons.js`, `pos-dark.css`. + `BUILD_VERSION` sa nikde nenastavuje (`server/app.js:127`) ⇒ každý reštart zahodí cache.
**Q23. Auto-close dochádzky sa pri nočnom reštarte preskočí** — `server/server.js:189,229,173`. `msUntilNext0400Local()` vracia vždy **zajtrajšie** 04:00 a 36 h recovery okno vynechaný beh nedobehne (treba ≥52 h) ⇒ zabudnutý „Odchod" ostane otvorený navždy + deň bez zálohy.
**Q24. Klientská telemetria chýb = 0** — `grep window.onerror|unhandledrejection` → 0. Tablet je fullscreen PWA bez DevTools ⇒ „kasa nešla" sa nedá dohľadať. Fix: `sendBeacon('/api/client-errors')` v `api.js`.
**Q25. Socket bez `connect_error` a bez resync** — `js/pos-init.js:263,266` (KDS to má správne: `kitchen.js:461,467`). 12 h JWT vyprší cez noc → realtime ticho zomrie, kasa jazdí na 30 s polle.
**Q26. Žiadny update prompt pre PWA** — `pos-enterprise.html:567`, `login.html:679` holá registrácia + `skipWaiting()` ⇒ starý JS beží proti novej API schéme dni. Banner áno, **auto-reload nikdy** (zabil by rozrobenú QR platbu).
**Q27. `events` a `print_queue` sa nikdy nečistia** — `server/lib/emit.js:13`, `print/queue.js:90`. Prune do 04:00 hooku (`server.js:198`).
**Q28. crash.log a `uploads/` v efemérnom FS** — `server/server.js:83`, `menu.js:21`, `docker-compose.yml:45`. Rebuild (typicky ten, ktorým fixuješ pád) zmaže log príčiny.

### UX / a11y (medium, S)
**Q29. Zlyhaný sync zamkne čašníka na stole** — `js/pos-render.js:125,154,673` · `js/pos-mobile.js:19,77`. Pri 409/5xx tap na „Stoly", na iný stôl aj mobilná záložka nespravia nič okrem dvoch surových toastov. Fix: `showConfirm('Nepodarilo sa odoslať — odísť aj tak?')`.
**Q30. Zavretie storno-modalu ticho zahodí zápis storna** — `js/pos-orders.js:631` · `js/pos-ui.js:182,206`. Modal sa otvára **po** DELETE a vytlačení STORNO bonu; klik na pozadie ⇒ v Storno koši nič, sklad sa neopraví. Fix: `dismissible:false` + fallback zápis `reason:'other'`.
**Q31. Po „Platba zablokovaná/nejasná" ostáva Potvrdiť aktívne** — `js/pos-payments.js:1336-1345,1377`. Najkritickejší stav systému končí obrazovkou s pripraveným zeleným tlačidlom.
**Q32. Split/move vytvárajú účet PRED presunom** — `js/pos-orders.js:1506,1537,1832` · `orders.js:1412`. Pri chybe zostane prázdny účet držiaci stôl obsadený, ktorý sa z POS nedá zmazať (`clearOrder` r. 1002 tichý no-op).
**Q33. Fokus sa neprenáša do statických modálov** — `js/pos-payments.js:426`, `pos-orders.js:1151,1329`, `pos-init.js:455,539`, `pos-render.js:1323,1425`; `captureModalTrigger()` sa volá len v dynamických. Focus trap (`pos-ui.js:670`) sa preto nikdy nechytí + berie **prvý** overlay v DOM, nie vrchný (r. 676).
**Q34. `.btn-odpis[hidden]` override chýba** — `css/pos.css:1484` (pre `.btn-qr` r. 1400 a `.btn-staff-meal` r. 1437 existuje). Každý čašník vidí červené „Odpis (mimo fiškál)". Radšej rovno `.btn[hidden]{display:none!important}` za r. 1373.
**Q35. Kontrast Daylight** — `--color-text-dim` 3,53:1 (`css/pos.css:54`) nesie prečiarknutú pôvodnú cenu pri zľave (`:3150`, `:2848`) a `.item-dest` 9px; `--accent-amber` 3,09:1 (`:60`) nesie **čas obsadenia stola** (`:597`, na tablete 14px bold) a čistú cenu po zľave (`:3154`); `#tableStatusBadge` hardkóduje 3 retired dark hexy (`js/pos-render.js:1063-1078`) ≈ 1,5–2,4:1. Tmavá téma je OK — týka sa len dennej zmeny.
**Q36. `a11y.css` sa v admine nenačítava** — `admin/index.html:9-12`. Chýba spinner (`components/loading.js:10` sa naň priamo odvoláva), červená validácia (`.field-error`), skip-link, globálny focus ring, blanket reduced-motion. **Jednoriadkový fix** + zapne aj `.is-offline` indikátor, ktorý `api.js:63` už nastavuje.
**Q37. `validateForm` nepresúva fókus na chybné pole** — `components/validate.js:23,81` · 13 volajúcich · `admin/admin.css:407`. Na dlhom formulári produktu klik na „Uložiť" nič neurobí a hláška je odrolovaná mimo modálu ⇒ „tlačidlo nefunguje". Postihuje aj vidiaceho používateľa.

### Testy — minimálna sada, ktorá by chytila reálne chyby
`server/test/routes/role-gates.test.js:51` je dnes JEDINÉ miesto, kde sa reporty volajú, a asertuje len status 200.
- **T1** `reports.summary.test.js` + `shifts.test.js` — fixture s fiškálne stornovanou platbou, `closure_type='odpis'`, `staff_meal`; regres na `notStornoedSql` (chyba z 7113712 žila 3 mesiace).
- **T2** `orders.odpis.test.js` — `close-as-odpis`, role gates, `convert-odpis-to-fiscal` a hlavne **rollback s 3 vetvami** (`orders.js:796-810`).
- **T3** `payments.change-method.test.js` / `.refiscalize.test.js` — storno OK + nový doklad zlyhá; mock infra už existuje v `payments.portos.test.js` (525 r.).
- **T4** `storno-basket.test.js` (`wasPrepared` vetvy = sklad vs write-off) a `paragons.test.js` (opakovaný `/sync` nesmie duplikovať).
- **T5** `TZ: process.env.TZ || 'UTC'` do `server/scripts/run-tests.mjs:41` a `tests/e2e/_setup/global-setup.mjs:184` + `print-tickets.test.js` na čas uzávierky.
- **T6** `pos_test` guard presunúť do `server/test/helpers/setup.js:11` (dnes chýba v 9 z 23 súborov, fallback regex `/\/pos$/` prepustí URL s query stringom do `TRUNCATE` nad 32 tabuľkami).
- **T7** e2e seed: doplniť kategóriu `Prílohy` + `Kuracie hranolky` (`global-setup.mjs:132,147`) — `combo-sauce-modal.spec.mjs:88` je dnes **garantovane červený**, takže suitu nikto nespúšťa. Potom `food-number-gate.spec.mjs` na povinné číslo pípadla (`js/pos-orders.js:265,284`) a `admin-smoke.spec.mjs` (prejsť kľúče z `admin/router.js:12`, kontrolovať `pageerror` + neprázdny `#page`).
- **T8** CI: `.github/workflows/ci.yml` s postgres service, `npm test` + `npm run e2e`.

---

## 🔵 LATER — štrukturálne

- **L1. DESIGN-CODE.md je zastaraný kontrakt** (`DESIGN-CODE.md:36-52,93-98,620`) — dokumentuje retired fialovú/Sora paletu, kým všetkých 5 povrchov beží Daylight terra/Outfit (`css/pos.css:34,77`; `admin/admin.css:30,73`; `dochadzka.css:19,36`; `login.html:40,83`). CLAUDE.md ho robí povinným čítaním ⇒ **každý ďalší agent/človek vyrobí fialový kód**. Dočasne 3-riadkový banner s live hodnotami, potom prepis + presun Daylight bloku do `tokens.css`.
- **L2. Paleta duplikovaná v 4 `:root` blokoch + dark v 2** (`pos.css:18-108`, `admin.css:20-99`, `dochadzka.css:8-41`, `login.html:26-88`, `pos-dark.css:20-106`, `admin-dark.css:9-98`). Sémantické tokeny už driftli (`--color-warning*` existuje len v admine).
- **L3. Dark mode nedosiahne `admin/pages/*.js`** — 807 inline `style=`, 6 `<style>` blokov, 23 `rgba(255,255,255,.0x)` výplní. `weekly.js:756-759` mieša fialovú a terra v jednej heatmap rampe ⇒ nečitateľná škála.
- **L4. Päť god-modulov = 30 % web JS** (`pos-orders.js` 1958, `pos-payments.js` 1673, `admin/pages/reports.js` 1692, `pos-render.js` 1511, `dochadzka.js` 1541). Ak sa do toho ide, tak mechanicky a po jednom — **pozor na top-level `let`** (`_splitMode:1316`, `moveMode:1552`): rozdelenie bez ich presunu = `SyntaxError` a mŕtva kasa.
- **L5. Paralelné desktop/mobile renderery** (`pos-render.js:1207` vs `pos-mobile.js:320`) — každý feature sa píše 2×. Vyňať `orderRowModel(o)`.
- **L6. Rozhodnúť o KDS** — `js/kitchen.js:114` číta `localStorage['pos_orders']`, ktorý **nikto iný nezapisuje** (POS píše `pos_tableOrders`). Obrazovka je mŕtva, ale je v `sw.js:14` precache. Buď napojiť na `api.get('/orders')`, alebo odstrániť. To isté pre `css/kitchen.css:3-5`, ktorá **globálne predefinuje `--radius-xs`**.
- **L7. Nastavenia zapisujú do localStorage, ktorý nikto nečíta** (`admin/pages/settings.js:463-503`) — sVat, sReceiptFooter, sAutoPrint, hours, sPrimaryColor… `grep` v `js/`/`server/` = 0 konzumentov (čítané sú len `sName` a `sQrPaymentEnabled`). Manažér dostane „Nastavenia uložené" a nestane sa nič. Mŕtve sekcie zmazať; QR toggle presunúť na server, ak sa má riadiť centrálne.
- **L8. Zdieľané moduly:** `roundMoney` ×3 (`fiscal-payment.js:56`, `payments/shared.js:13`, `reports/shared.js:7`) bez jediného testu; `escHtml`/`escAttr`; `LOCAL_ITEM_ID_MIN` — magická `1000000000` opísaná **12× v 5 súboroch** (`pos-state.js:302,311,386,416`, `pos-orders.js:188,469,498,513`, …), pričom rozhoduje o tom, či sa lokálna položka pri refreshi zachová alebo zahodí.
- **L9. Inline `onclick` s reťazeným menom položky** (`js/pos-orders.js:406,420,422`) — meno s backslashom rozbije +/−, poznámku a zmazanie riadku mid-service; drží to `'unsafe-inline'` v CSP (`server/app.js:80`). Prejsť na delegáciu cez `data-item-id` (už sa emituje na r. 417).
- **L10. Logout je čisto klientsky** (`api.js:135`, `middleware/auth.js:15`) — 12 h JWT bez `jti`/denylistu. Defense-in-depth po N7/Q11/Q14, nie predtým.
- **L11. Filtre a dátumy nie sú v URL** (`tab-shell.js:56-98`, `reports.js:1676,1684`) — nič sa nedá bookmarknúť; reset je naprieč modulmi nekonzistentný.
- **L12. UI testy netestujú DOM** (`server/test/ui/pos-render.test.js:11,33,74` — stub s prázdnym `innerHTML`, `querySelector()` vracia `null`, **a stubnutý `escHtml` = escapovanie vypnuté**). Zaviesť `linkedom` sandbox; prvý test: `note = <img src=x onerror=…>` → `querySelectorAll('img').length === 0`.
- **L13. Migračný runner** — `scripts/migrations/*.sql` nespúšťa nič automatické, v DB nie je záznam, čo je na kase aplikované.
- **L14.** Drobnosti bez rizika, keď bude čas: `/` skratka otvára skok na stôl namiesto hľadania (`pos-ui.js:627` vs `pos-init.js:664`, pritom `pos-enterprise.html:554` sľubuje opak); tlačidlo „Zľava" viditeľné čašníkovi, ktorý vždy dostane odmietnutie (`pos-enterprise.html:161`); „Zmena: Xh Ym" počíta od otvorenia tabu a prežije odhlásenie (`pos-render.js:81`); mŕtvy long-press handler zaplavuje konzolu TypeErrormi (`pos-ui.js:696-806`); command palette nepozná 4 stránky a nematchuje „dochadzka" (`command-palette.js:37-88`); 32 mŕtvych tried v `pos.css` + 6 nepoužitých woff2; raw z-index literály; `SALES_RANK`/`serveItem` mŕtvy kód.

---

## ✅ Čo je DOBRÉ — nedotýkať sa

Toto sú miesta, kde kód robí správnu vec a auditori to opakovane potvrdili. Refaktor v okolí ich nesmie zhodiť:

- **`OFFLINE_NO_QUEUE_PREFIXES = ['/payments','/fiscal-documents']`** (`api.js:6`) — vynucované pri zaradení (r. 200) aj pri replayi (r. 90). Presne správne rozhodnutie: fiškálne cesty sa nikdy neprehrávajú naslepo.
- **`payments_order_id_uidx`** (`schema.js:250`) + transakčný `finalizeLocalPayment` (`context.js:88-129`) — vďaka nim duplicitný request nevytvorí druhú platbu ani nezavrie účet dvakrát. Chýba už len Portos strana (N2).
- **Optimistic concurrency `bumpVersion`** so scope-om `and(eq(orderItems.id), eq(orderItems.orderId))` (`orders.js:32,208,215,243`) — toto je dôvod, prečo cross-order zápis z klienta nespôsobí poškodenie dát.
- **`server/lib/reports/shared.js:17 notStornoedSql`** — už opravené v 7113712, funguje. Rovnako `summary.js:22-23` `AT TIME ZONE 'Europe/Bratislava'` je **referenčná** implementácia pre N6.
- **Per-staff lockout** (`auth.js:31-58`) — správne kľúčovaný, znalosť mien z `/staff-list` mu neublíži.
- **`api.get()` in-flight dedupe** (`api.js:224-232`) — pri burste socket eventov kolabuje N requestov na jeden. Nechať; len `loadTableOrder(force)` potrebuje bypass (`getFresh`).
- **`renderProducts` cache guard `_lastProductsRenderKey`** (`pos-render.js:788-796`) a targetovaný `applyToCard` (r. 881) — správny vzor, mobil ho má len skopírovať.
- **`admin/pages/audit.js`** (`:143` hláška o orezaní, `:184-206` Od/Do + presety, `:19-27` `bratislavaDayIso`) a **`cashflow.js:26` ISO-date guard** — toto je vzor, ktorý majú prevziať odpisy, write-offs a payments.
- **`components/confirm.js:238-265`** (focus trap) a **`a11y.css:102-112`** (blanket reduced-motion, na ktorý sa spolieha aj KDS) — funkčné, nekopírovať vedľa nich tretiu implementáciu.
- **Zámerné produktové rozhodnutia — nie sú to chyby:** odpis na jeden tap bez confirmu (`pos-payments.js:1118`, komentár „per poziadavka prevadzky"); tlačidlo Poznámka 32×32 mimo 44px floor (`pos.css:3079-3081`, „justified spec exception"); orezanie predpoveďového pásma na ±100 € (`forecasts.js:50-52`); auto-send pri odchode zo stola (`pos-render.js:153`); progress bar škálovaný na `maxRev`, nie na súčet (`reports.js:420-421`); no-bundler klasické skripty (`pos-enterprise.html:25-29` — pridanie `defer` by rozbilo monkey-patch `showToast` na `pos-payments.js:1382`).
- **`server/lib/payments/create.js:54`** — guard proti podtečeniu sumy. Drží aj proti podvrhnutej nižšej sume z devtools; treba doplniť len druhý smer (Q7).
- Väčšina `server/routes/*` **má** `requireRole` správne (`orders.js:1187,1253,1290,1346,1439`; `payments.js:44-49`) — N10 rieši výnimky, nie systém.

---

## ⚠️ Čo audit NEPOKRYL (a treba to vedieť pri rozhodovaní)

1. **Nič sa nespúšťalo.** Celý audit je statická analýza + čítanie kódu. Testy sa nespustili (`combo-sauce-modal.spec.mjs` je aj tak červený), server sa neštartoval, DB sa nedotýkala.
2. **Žiadne meranie na reálnom HW.** Perf čísla sú veľkosti súborov a počty dotazov, nie profil z tabletu. Odhady typu „80-150 ms" boli v druhom kole opakovane korigované nadol — ber ich ako smer, nie ako rozpočet.
3. **Portos/eKasa ako externá služba.** Nikto neoveril, ako sa Portos naozaj správa pri súbežných `externalId`, pri duplicitnom `registerCashWithdrawal` alebo pri storne. Závery o „dvoch dokladoch" sú odvodené z kódu — pred fixom sa oplatí jeden test v Portos sandboxe.
4. **Reálny stav kasy.** Nevie sa, ktoré `scripts/migrations/*.sql` sú na produkčnej DB aplikované (nie je migračná tabuľka), ani čo presne tam beží (43 „M" súborov + 5 untracked). **Rozdiel medzi repom a kasou je neznámy.**
5. **`uploads/menu/` v repe neexistuje** ⇒ nepotvrdené, či sa fotky produktov reálne používajú; nález o 4 MB fotkách je latentný, nie zmeraný.
6. **Nepotvrdená prevádzková realita:** či sa `kitchen.html` reálne používa (kód hovorí, že nemôže fungovať), ako často sa reálne robí QR platba, koľko účtov na stôl je bežné. Priorita Q1/L6 sa tým môže posunúť.
7. **Mimo scope zámerne:** `android-tablet/`, `windows-app/`, `web/` (marketing), `node_modules/`, `tmp/`. Pozor: **per-item zľava, odpis, order naming a QR nemajú paritu vo Windows appke** (podľa memory), takže niektoré serverové fixy tu môžu rozbiť predpoklady tam.
8. **Infra len okrajovo.** `docker-compose.yml` nie je v scope; expozícia 5432 (N8) je reportovaná len preto, že obchádza celú autorizáciu. Sieťová topológia tailnetu, kto všetko je na LAN podniku, a fyzická bezpečnosť kasy neboli posudzované.
9. **Súbežnosť dvoch terminálov naživo** — všetky závery o 409/version conflict/last-write-wins sú z kódu, nikto nespustil dva klienty proti jednému účtu.