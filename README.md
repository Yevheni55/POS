# POS — Restaurant POS + Admin s fiškálnou integráciou Portos eKasa

Full-stack pokladničný systém pre bar/reštauráciu: **čašnícke POS-rozhranie** (tablet/kiosk), **admin dashboard** (menu, sklad, reporty, fiškálne doklady, história platieb) a **Node.js backend** s PostgreSQL.

Fiškalizácia sa realizuje cez **Portos/NineDigit eKasa** (SR). POS platby sa registrujú cez `POST /api/v1/requests/receipts/cash_register` a papierové bločky tlačí CHDU cez Portos. Storná sa robia priamo z administrátorskej **histórie platieb** alebo zo stránky **Fiškálne doklady**.

Repo: **https://github.com/Yevheni55/POS**

---

## 1. Stručná architektúra

```
┌────────────────────────┐        HTTP / WebSocket          ┌─────────────────────┐
│  POS (browser, tablet) │  ───────────────────────────►   │                     │
│  /pos-enterprise.html  │        (JWT auth)                │   Node.js backend   │
│  js/pos-*.js           │  ◄───────────────────────────   │   server/*.js       │
└────────────────────────┘                                  │                     │
                                                            │  ├── auth / JWT     │
┌────────────────────────┐                                  │  ├── REST API       │
│  Admin (browser)       │  ───────────────────────────►   │  ├── Socket.IO      │
│  /admin/               │                                  │  └── cron / queues  │
│  admin/pages/*.js      │  ◄───────────────────────────   └──────┬──────┬───────┘
└────────────────────────┘                                         │      │
                                                                   │      │ HTTP
                                                    ┌──────────────▼──┐   ▼
                                                    │  PostgreSQL 16  │   ┌────────────────────────────┐
                                                    │  (Docker db)    │   │ Portos eKasa (NineDigit)    │
                                                    │  Drizzle ORM    │   │ http://host:3010/api/v1/... │
                                                    └─────────────────┘   │ → CHDU + fiškálna tlačiareň │
                                                                          └────────────────────────────┘
```

- **POS** (`pos-enterprise.html`, `/js/pos-*.js`) — tablet/kiosk view: stoly, menu, objednávky, platby, storno, posielanie do kuchyne/baru.
- **Admin** (`/admin/`, `admin/pages/*.js`) — manažérsky panel: Dashboard, Menu, Stoly, Reporty, **Platby**, **Fiškálne doklady**, Nastavenia, Sklad.
- **Backend** — Node.js + Express + Drizzle + Socket.IO. Zdrojový kód v `server/`.
- **DB** — PostgreSQL 16 v Dockeri, schéma v `server/db/schema.js`, migrácie cez `drizzle-kit push`.
- **Portos eKasa** — externý lokálny HTTP servis NineDigit, beží na **hostiteľovi kasy** (Windows). POS ho volá cez `PORTOS_BASE_URL` (v Dockeri `http://host.docker.internal:3010`).

---

## 2. Hlavné priečinky

| Cesta | Obsah |
| --- | --- |
| `pos-enterprise.html`, `login.html` | POS a login HTML |
| `js/` | POS JS moduly (init, state, render, orders, payments, mobile, UI) |
| `css/` | štýly POS (`pos.css`, tokens) |
| `admin/` | Admin SPA — `index.html`, `router.js`, `pages/*.js`, `admin.css` |
| `api.js`, `components/` | Zdieľaný API klient a UI helpery (`loading`, `validate`, `toast`) |
| `server/` | Backend — `server.js` + `app.js` |
| `server/routes/` | REST endpointy (auth, menu, orders, **payments**, **company-profile**, **fiscal-documents**, print, inventory, reports, …) |
| `server/lib/` | Biznis knižnice — **Portos client**, **Portos sync job**, fiskálna platba, aktívny kód kasy, audit, emit, CORS |
| `server/db/` | Drizzle schema (`schema.js`), connection (`index.js`), seed skript |
| `server/schemas/` | Zod schémy pre REST body |
| `server/test/` | `node:test` integračné a unit testy (`npm test`) |
| `server/scripts/` | Portos diagnostika a pilotné skripty (readiness, printer test, fiscal test, baud-scan, VAT sync, …) |
| `scripts/` | Deploy + Windows / Docker helpery (Tailscale deploy, firewall, autologon, credential helpers) |
| `docs/` | Runbooky a agent-metodiky (Portos, Tailscale, kasa SSH access) |
| `docker-compose.yml`, `Dockerfile`, `.dockerignore` | Kontajnerový setup |

---

## 3. Kľúčové toky

### 3.1 Objednávka → platba → fiškalizácia
1. POS odošle položky objednávky do `/api/orders` a prípadne do kuchyne / baru (`/send-and-print`).
2. Pri platbe čašník zvolí spôsob (hotovosť / karta) → `POST /api/payments` (`server/routes/payments.js`).
3. Server zvaliduje DPH sadzby (podľa `menu_items.vat_rate`) — ak je firma **neplatiteľ DPH** (prázdne IČ DPH), všetky položky sa automaticky prepíšu na `vatRate: 0` (`server/lib/fiscal-payment.js` + `server/lib/vat-registration.js`).
4. Server zostaví Portos payload (`buildCashRegisterRequestContext`) s **aktuálnym kódom kasy** z DB (`getActiveCashRegisterCode`) a pošle do Portos.
5. Odpoveď normalizuje (`normalizeRegisterResult`) a ukladá do `fiscal_documents` (unikátny `external_id = order-<id>-payment`).
6. Ambiguity po sieťových chybách rieši `resolveFiscalAttempt` (lookup cez `findReceiptByExternalIdWithRetry`, prípadná tlač kópie).

### 3.2 STORNO
- **Admin → Platby → STORNO** (novinka, `admin/pages/payments.js`) — inline tlačidlo vedľa každej úspešnej platby.
- **Admin → Fiškálne doklady** — hľadanie podľa `receiptId`, `externalId` alebo `kód pokladne + rok + mesiac + č. dokladu`, potom „Odoslať STORNO“.
- Backend: `POST /api/payments/:id/fiscal-storno` alebo `POST /api/fiscal-documents/:id/storno`.
- `buildStornoCashRegisterRequestContext` vezme položky z pôvodného dokladu, otočí znaky, pridá `referenceReceiptId` (id alebo OKP) a pošle do Portos (`external_id = order-<id>-payment-storno`).

### 3.3 Synchronizácia identity firmy z Portos
- **Background job** (`server/lib/portos-sync-job.js`): pri štarte a každých **5 minút** sťahuje `/api/v1/identities` z Portos a zapíše do `company_profiles` v DB. Po zmene firmy v Portos je nový názov, IČO, DIČ, adresa a **kód pokladne** v DB bez zásahu človeka.
- **Endpoint** `GET /api/company-profile` s `?refresh=1` — každá rola vie vynútiť synchronizáciu (POS to robí pri štarte, admin pri otvorení Nastavení).
- Prioritizácia kódu kasy v `getActiveCashRegisterCode()`: **DB (z Portos) > .env** — ak sa v Portos zmení firma a `.env` ostane starý, nové platby aj tak používajú správny alias certifikátu.

### 3.4 DPH režim
- Ak `company_profiles.ic_dph` je prázdne ⇒ firma je **neplatiteľ DPH** ⇒ všetky fiškálne riadky idú s `vatRate = 0`.
- Ak IČ DPH existuje ⇒ použijú sa sadzby z menu (5 %, 19 %, 23 %).
- Na štarte v logu `[Portos] VAT mode = registered|NON-REGISTERED …`.

### 3.5 História platieb (admin → *Platby*)
- `GET /api/payments/history` (`server/routes/payments.js`):
  - Join `payments` ↔ `orders` ↔ `tables` ↔ `fiscal_documents`.
  - Parametre: `method=hotovost|karta`, `q=<text>`, `scope=current|all`, `limit`.
  - `scope=current` (default) **skrýva platby starej eKasy** (iný `cash_register_code` než aktuálny).
  - Vracia flag `stornoEligible`, `copyAvailable`, existujúce STORNO doklady.
- UI: `admin/pages/payments.js` — tabuľka s inline **STORNO** a **Kópia dokladu**.

---

## 4. Deploy na kasu (shop PC, Windows)

### 4.1 Predpoklady na kase
- Windows 10/11 s **Docker Desktop** (Linux engine).
- **Tailscale** (alebo priama LAN) — odporúčané pre bezpečný remote deploy.
- **Portos eKasa (NineDigit)** nainštalovaný, bežiaci a zaregistrovaný. Verifikácia: `http://localhost:3010/api/v1/product/info` vráti JSON.
- **CHDU** pripojené (COM port v Portos nastaveniach).
- Firewall: otvorený port `3080` (POS) a `3443` (HTTPS). Skript `scripts/open-bar-pc-firewall.ps1` to nastaví (vrátane pravidla pre Portos 3010 z Dockera).
- Projekt naklonovaný do `C:\POS`:
  ```powershell
  git clone https://github.com/Yevheni55/POS.git C:\POS
  ```

### 4.2 `.env` na kase
Vytvor `C:\POS\server\.env` (príklad):

```env
DATABASE_URL=postgresql://pos:pos@db:5432/pos       # v Dockeri to prepisuje compose
JWT_SECRET=<silné-heslo>
PORT=3080
CORS_ALLOW_LAN=true
PRINTER_IP=192.168.0.107
PRINTER_PORT=9100
PORTOS_ENABLED=true
PORTOS_BASE_URL=http://host.docker.internal:3010
PORTOS_CASH_REGISTER_CODE=<kód_z_Portos>            # DB > .env, ale drž aktuálne kvôli diagnostike
PORTOS_PRINTER_NAME=pos
PORTOS_TIMEOUT_MS=10000
```

> **Poznámka k `PORTOS_CASH_REGISTER_CODE`**: od commitu `0f50576` sa **efektívny kód ťahá z DB** (synchronizovaný z Portos). `.env` je iba fallback a pre diagnostický log. Pri zmene firmy v Portos POS sám prejde na nový kód — stačí reštart alebo počkať na 5-min sync.

### 4.3 Prvý štart (na kase priamo alebo cez RDP)

```powershell
cd C:\POS
docker compose up -d --build
docker compose exec -T app sh -c "cd /app/server && npm run db:push"
docker compose exec -T app sh -c "cd /app/server && npm run db:seed"     # iba prvýkrát
```

Ak je `PORTOS_ENABLED=true`, v logu uvidíš:

```
[Portos] Fiscal integration ENABLED | PORTOS_BASE_URL=http://host.docker.internal:3010 | cashRegister=<…>
[Portos] Company profile sync OK … businessName="…" cashRegister="…"
[Portos] Active cash register = … | .env = … (match|MISMATCH)
[Portos] VAT mode = registered|NON-REGISTERED …
```

POS dostupný:
- `http://localhost:3080/login.html` (lokálne)
- `http://<LAN-IP>:3080` (z tabletu/telefónu v rovnakej WiFi — `CORS_ALLOW_LAN=true`)
- `https://<LAN-IP>:3443` (ak sú v `server/certs/` `key.pem` + `cert.pem`)

### 4.4 Automatizovaný deploy z vývojárskeho PC cez Tailscale + SSH

V tomto repozitári `scripts/deploy-tailscale-pos.sh`:

1. `tar` cely projekt (bez `.git`, `node_modules`, `server/.env`, `*.tgz`).
2. `scp` na kasu do `C:\POS\_pos-update.tgz`.
3. SSH spustí `tar -xf`, následne `docker compose up -d --build app`.

Potrebné v `~/.ssh/config`:

```
Host pos-kasa-tscale
    HostName 100.95.64.38            # Tailscale IP kasy
    User surfs                       # Windows používateľ (whoami)
    IdentityFile ~/.ssh/id_ed25519_pos
    StrictHostKeyChecking accept-new
```

Použitie:

```bash
# z vývojárskeho PC (Git Bash / WSL / Linux / macOS)
bash scripts/deploy-tailscale-pos.sh
```

Pri zmene DB schémy ešte `docker compose exec -T app sh -c "cd /app/server && npm run db:push"`.

### 4.5 Ručný deploy bez skriptu

```powershell
# na kase
cd C:\POS
git pull
docker compose up -d --build app
docker compose exec -T app sh -c "cd /app/server && npm run db:push"
```

### 4.6 Rollback

Každý commit v `main` je funkčný; rollback = checkout staršieho commitu na kase + `docker compose up -d --build`. Alternatíva: vrátiť `_pos-update.tgz` z predchádzajúceho uploadu (je v `C:\POS`).

---

## 5. Užitočné skripty

| Skript | Na čo |
| --- | --- |
| `scripts/deploy-tailscale-pos.sh` | bundle + scp + remote docker build (pozri vyššie) |
| `scripts/setup-new-windows-host.ps1` | inicializácia novej kasy (Docker, firewall, clone) |
| `scripts/open-bar-pc-firewall.ps1` | pravidlá firewallu (3080, 3443, 3010) |
| `scripts/configure-bar-pc-startup.ps1` | Docker Desktop autostart + POS autologon |
| `scripts/set-windows-autologon.ps1` | Windows auto-login (tablet kiosk) |
| `scripts/run-portos-readiness-docker.ps1` | spustí `portos-readiness.mjs` v kontajneri |
| `server/scripts/portos-readiness.mjs` | overí Portos stav, CHDU, tlačiareň, certifikát |
| `server/scripts/portos-printer-test.mjs` | surový test tlače cez Portos |
| `server/scripts/portos-fiscal-test-receipt.mjs` | **pozor**: pošle reálny 1 € test-chek do eKasy |
| `server/scripts/portos-vat-sync.mjs` | zosúladí `menu_items.vat_rate` s Portos |
| `scripts/check-portos-profile-on-kasa.mjs` | overí `/api/company-profile` a compare |
| `scripts/portos-cert-probe.mjs` | probe `identities`, `certificates`, `printers/status`, … |

---

## 6. Najdôležitejšie runtime premenné

| Premenná | Popis |
| --- | --- |
| `DATABASE_URL` | Postgres pripojenie (compose prepisuje na `postgresql://pos:pos@db:5432/pos`) |
| `JWT_SECRET` | podpisovací kľúč pre tokeny (dlhší náhodný reťazec!) |
| `PORT`, `HTTPS_PORT` | HTTP / HTTPS porty backendu |
| `CORS_ALLOW_LAN` | `true` → API povoľuje origins zo súkromných LAN IP (telefón/tablet) |
| `PORTOS_ENABLED` | `true|false` — zapnutie fiškalizácie |
| `PORTOS_BASE_URL` | URL Portos API, v Dockeri `http://host.docker.internal:3010` |
| `PORTOS_CASH_REGISTER_CODE` | fallback kód kasy (hlavný zdroj je DB) |
| `PORTOS_PRINTER_NAME` | `pos` (papier/CHDU), `pdf`, `email` — NineDigit kanál, **nie** Windows názov tlačiarne |
| `PORTOS_TIMEOUT_MS` | timeout pre Portos calls (default 10 000) |
| `PORTOS_PROFILE_SYNC_MS` | interval auto-syncu identity z Portos (default 300 000 = 5 min) |
| `PRINTER_IP`, `PRINTER_PORT` | adresa ESC/POS tlačiarne pre legacy `/api/print/*` |

---

## 7. Testy a vývoj

```bash
cd server
npm install
cp .env.example .env       # uprav si DATABASE_URL
createdb pos_test          # testy bežia proti pos_test
npm test
```

- `npm test` → `node:test` sériovo (`server/scripts/run-tests.mjs`), pokrýva auth, validate, orders lifecycle, payments + Portos (mocky), fiscal documents, company profile, storno, menu VAT atď.
- `npm run portos:readiness` / `portos:printer-test` — diagnostika Portos lokálne.

---

## 8. Fiškálne stavy a čo znamenajú

| `resultMode` | Kedy vzniká |
| --- | --- |
| `online_success` | Portos 200/201 + podpis CHDU |
| `offline_accepted` | Portos 202 — uloží do fronty CHDU, synchronizuje neskôr |
| `reconciled_online_success` / `reconciled_offline_accepted` | počiatočný network fail, ale `findReceiptByExternalId` našiel doklad |
| `ambiguous` | transportná chyba, Portos doklad zatiaľ nevidíme — obsluha nesmie platbu opakovať |
| `validation_error` | Portos 400 — nesprávne sadzby DPH, chýba cert, alias nesedí, nekonzistencia súm |
| `rejected` | Portos 403 |
| `blocked` | hardvérový problém (CHDU, tlačiareň, storage) |
| `disabled` | `PORTOS_ENABLED=false` — platba sa uzavrie lokálne, do eKasy nejde |

STORNO je dostupné iba pre `online_success`, `offline_accepted`, `reconciled_*` s existujúcim `receiptId`/OKP a bez už odoslaného STORNO (`external_id = order-<id>-payment-storno`).

---

## 9. Ako pridať novú fiškálnu prevádzku

1. Zaregistrovať kasu v **Portos** (nová firma + CHDU + certifikát pre nový alias).
2. V `server/.env` na kase voliteľne aktualizovať `PORTOS_CASH_REGISTER_CODE` (nepovinné — DB > .env).
3. Reštart kontajnera (`docker compose restart app`). Background sync ťahá novú identitu a prepíše `company_profiles` (názov, IČO, DIČ, IČ DPH, adresu, kód kasy).
4. Admin → **Nastavenia** → „Obnoviť údaje z Portos“ prinúti okamžitú synchronizáciu.
5. Ak firma nie je platiteľom DPH, pri prvom sync sa v logu objaví `VAT mode = NON-REGISTERED` — všetky nové bločky pôjdu s `vatRate = 0`.
6. V **Admin → Platby** nastav `Rozsah = Iba aktuálna eKasa` (default) — stará história sa skryje. Voliteľne prepni na „Všetky“, ak ju potrebuješ.

---

## 10. Zoznam referenčných dokumentov

- `docs/AGENT_METHODOLOGY_KASA.md` — metodika pre AI agenta: štruktúra, SSH, Docker, deploy, testy.
- `docs/agent-pos-kasa-access.md` — rovnaký obsah v compact forme.
- `docs/PORTOS_AFTER_CHDU.md` — postup po inštalácii Portos/CHDU.
- `server/PORTOS_RUNBOOK.md` — fiškálny runbook (runtime konfigurácia, UAT, verifikácia).
- `server/PORTOS_PILOT_LOG.md` — log pilotného rozbehu.
- `PORTOS_ROLLOUT.md` — playbook spustenia.

---

## 11. Licencia a kontakt

Interný projekt, všetky práva vyhradené. Kontakt: **@Yevheni55** (GitHub).
