# Surf Spirit POS — Android tablet app (natívna, Kotlin + Compose)

Natívna Android appka pre 10.1" tablet, ktorá beží proti **existujúcemu POS
serveru** (Express + Postgres na kase). Nie je to ďalší backend — appka volá
rovnaké REST API (`/api/...`) ako web POS.

## Prečo natívne + čo je hotové

Web POS funguje a beží na tablete v prehliadači. Natívna verzia dáva lepší
tablet UX (žiadny prehliadač, kiosk režim, rýchlejšie), ale znamená prepísať
**celý frontend** po vrstvách. Cieľ: **funkčná zhoda s web POS pre čašníka**
(admin ostáva len vo webe). Stav v **v1.4** — plná funkčná parita s web kasou:

- ✅ **Nastavenie adresy servera** v appke (IP:port) — rieši zmenu IP po DHCP
- ✅ **Prihlásenie PIN-om** → `POST /api/auth/login`, JWT uložený, posielaný ako Bearer
- ✅ **Plán stolov** (`GET /api/tables` + `GET /api/orders`) — zóny, stav, **sumy
  a počet účtov** na obsadenom stole, **tržby dnes** v shift-stripe (z-report)
- ✅ **Menu** — kategórie, **🔥 Najčastejšie** (`/menu/top`), hľadanie, produktové karty
- ✅ **Viac účtov na stole** (taby), `+ Nový účet`, **⇄ Spojiť účty**
- ✅ **Položky** — pridanie, **+/− množstvo**, **poznámka**, odobratie; odoslané
  (zelené) položky sa dajú **stornovať** (manažérsky PIN), tlač storno-bonu
- ✅ **Combo omáčky** (sauce picker) + **companion** položky (napr. záloha fľaša)
- ✅ **Poslať objednávku** (`/send-and-print`) — odpočet skladu + **tlač bonu
  rozdelene kuchyňa/bar** (`/print/kitchen`); 422 limit → manažérsky override
- ✅ **Predúčet** (`/print/pre-bill`) — nedaňový informatívny účet
- ✅ **Platba** — Hotovosť (numpad + **výpočet výdavku**) / Karta (`POST /api/payments`);
  fiškál (Portos) rieši server, stav fiškálu sa vyhodnocuje. Po zaplatení sa stôl
  uvoľní a appka sa vráti na plán stolov.
- ✅ **Zľava** (`/orders/:id/discount`, manažér), **Rozdeliť účet** (rovnomerne / po
  položkách), **Presun účtu na iný stôl** (`/move-items`), **Zrušiť objednávku**
- ✅ **Zamestnanecká spotreba** (len zóna `zamestanci`, `/close-as-staff-meal`)
- ✅ **Zmena (shift)** — auto-otvorenie pri vstupe, **uzávierka + kontrola kasy**
  (`/shifts/current|summary|open|close`) pri odhlásení
- ✅ **Manažérsky PIN** (`/auth/verify-manager`) — brána pre storno/zľavu/zrušenie
- ✅ Kiosk: fullscreen immersive, landscape lock, obrazovka stále zapnutá
- ✅ Daylight dizajn (cream + terra), Sora+Manrope, zhoda s web POS

- ✅ **Auto-update** — appka pri štarte skontroluje `/api/app/latest` na kase;
  ak je vyššia verzia, ponúkne *„Aktualizovať"* → stiahne APK z kasy
  (`/api/app/download`) → spustí inštalátor (1 tap kvôli sideload bezpečnosti).

### Nové vo v1.4 — plná parita s web kasou

- ✅ **Live sync** — tichý polling (floor 15 s, objednávka 10 s); zmeny z web
  kasy / druhého tabletu sa zobrazia samé (web má WS + 30 s poll)
- ✅ **Offline režim** — menu/stoly/zóny/top v cache (boot bez siete), červený
  OFFLINE banner, fronta čakajúcich operácií (storno zápis, delete retry)
  s replayom po obnove spojenia
- ✅ **Draft košík per stôl** — rozpísaný účet prežije návrat na plán stolov,
  reštart appky aj výpadok; **auto-send pri odchode zo stola** (neodoslané
  položky sa nikdy ticho nestratia — pri zlyhaní sa navigácia zablokuje)
- ✅ **Paragón offline fallback** (§ 10 z. 289/2008) — keď Portos/eKasa
  blokuje alebo je nedostupná: potvrdenie → `POST /api/paragons` →
  ESC/POS tlač (`/print/paragon`) → automatická registrácia po obnove
- ✅ **Plný fiškálny stavový automat** — online/offline_accepted/disabled/
  ambiguous/blocked presne ako web (vrátane „Neposielaj to hneď znovu")
- ✅ **Storno dôvod** — dvojkrokový modal (pripravené? + dôvod + poznámka)
  → `POST /api/storno-basket` pre admin Storno stránku
- ✅ **Výsledok tlače bonov** — ✔ vytlačený / ⏳ vo fronte (tlačiareň offline) /
  chyba, per kuchyňa+bar; 🔢 čísla len na kuchynský bon a len s jedlom
- ✅ **Priestorový plán stolov** — x/y/veľkosť/tvar ako admin; zónové pills
  s obsadenosťou (terasa 3/8); **edit mód** (manažér): drag + resize + uloženie
- ✅ **Zabudnutý stôl** (>20 min) ⏰, rezervačný čas, stav „vyčistiť/otvorený"
- ✅ **Presun položiek** — multi-select s čiastočným množstvom (1/Polovica/
  Všetko) na iný účet / nový účet / iný stôl; split po položkách s partial qty
- ✅ **TTLock Zámok** — vygenerovanie kódu zámku + tlač + veľký popup
- ✅ **Long-press na kartu** = hromadné pridanie (1–10), **hold na +/−** opakuje,
  qty badge na kartách, account picker pri viacerých účtoch, taby s metou
- ✅ **Receipt preview v platbe** + guard „Zákazník dal menej", presety do 100 €
- ✅ **Logická adjacencia menu** (rodina + objem: Pivo 0,3 vedľa 0,5),
  Najčastejšie = top 12, hľadanie aj v popise
- ✅ **Uzávierka aj z objednávky**, obnovenie posledného stola po reštarte,
  trvanie zmeny v strip-e, kategórie farebne, 8 toggle preset poznámok,
  „Opakovať omáčku" CTA, haptika na send/platbu

#### Publikovanie novej verzie (auto-update)
1. Zdvihni `versionCode` (+`versionName`) v `app/build.gradle.kts`.
2. Zbuilduj APK (Android Studio / `gradle assembleDebug` v `C:\at`).
3. `./publish-update.sh <APK> <versionCode> <versionName> "<poznámky>"`
   — nahrá APK + manifest na kasu do durable `/backups/app` (prežije redeploy).
4. Tablety pri ďalšom štarte ponúknu aktualizáciu na jeden klik.

Server: `GET /api/app/latest` (manifest) + `/api/app/download` (APK), public,
číta z `/backups/app` (volume `pos_backups`).

### Admin na tablete — NATÍVNY (v2.0)

- ✅ **17 natívnych Compose obrazoviek** (ui/admin/pages/, ~13 000 riadkov,
  Daylight dizajn) — tlačidlo ⚙ v headri (len manažér/admin):
  Dashboard (kto je v práci, denné karty, týždenný graf, top produkty,
  platobné metódy, uzávierka + tlač) · Reporty (Denný z-report + Trendy:
  Týždeň/Sezóna) · História (Platby s akciami kópia/refiškalizácia/storno/
  zmena metódy · Fiškálne doklady · Audit objednávok) · Cashflow · Menu
  (kategórie+položky CRUD) · Receptúry (food cost, fmtCost) · Zamestnanci
  (CRUD+PIN) · Dochádzka (záznamy, úpravy, výplaty) · Zam. spotreba ·
  Storno kôš (vrátiť/odpísať) · Sklad: Prehľad · Materiály (Suroviny/Tovar/
  Dodávatelia) · Pohyby (log/odpisy) · Shisha · Stoly (zóny + odkaz na
  natívny floor editor).
- Architektúra: každá obrazovka = samostatný súbor s vlastnými DTOs +
  private Retrofit interface cez `Api.create()` — žiadne zdieľané kolízie.
  Admin shell = ľavý rail so sekciami (web sidebar parita).
- WebView fallback ostáva LEN pre Objednávky skladu, Majetok a Nastavenia
  (zriedkavé/konfiguračné stránky) — deep-link na hash route živého adminu.

### Zámerné rozdiely oproti webu (nie sú chýbajúce features)
- Vlastná on-screen klávesnica pre poznámku — web ňou obchádza browser IME;
  appka používa systémovú klávesnicu + toggle chipy (lepšie na Androide).
- WebSocket — appka používa polling (10–15 s); behaviorálne ekvivalent
  web 30 s fallback pollu, bez novej závislosti v offline gradle toolchaine.
- Sent+unsent riadky sa zobrazujú oddelene (web ich display-merguje do
  jedného); '−' na sent riadku ale rovnako najprv berie z unsent dvojčaťa.
- Produktové fotky na kartách — appka má emoji + kategóriové farby (bez
  image-loading závislosti).

## Build (Android Studio — najjednoduchšie)

1. Otvor priečinok `android-tablet/` v **Android Studio** (Hedgehog+).
2. Studio dotiahne Gradle wrapper + závislosti (online prvýkrát).
3. Pripoj tablet (USB, zapnuté USB ladenie) alebo emulátor → **Run ▶**.

## Build z príkazového riadku (APK)

```sh
cd android-tablet
gradle wrapper            # vygeneruje gradlew (raz; alebo to spraví Studio)
./gradlew assembleDebug   # APK → app/build/outputs/apk/debug/app-debug.apk
```

Inštalácia na tablet:
```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Prvé spustenie
1. Na úvodnej obrazovke klikni **Server** a zadaj IP kasy, napr.
   `192.168.1.235:3080` → **Uložiť adresu**.
2. Zadaj PIN zamestnanca → **OK**.
3. Vyber stôl → pridaj položky → **Poslať objednávku**.

> Tablet musí byť na **rovnakej WiFi** ako kasa (a kasa nesmie byť na gostevej
> sieti s izoláciou klientov — viď pozn. v hlavnom POS).

## Technické
- Kotlin 1.9.24, AGP 8.5.2, Compose BOM 2024.06, Material3
- minSdk 26 (Android 8.0), targetSdk 34
- Retrofit + OkHttp + kotlinx-serialization
- Dynamická base URL (interceptor prepisuje host z nastavení — bez rebuildu)
- HTTP cleartext povolený (LAN). Pre self-signed HTTPS (3443) treba doplniť
  trust manager — zatiaľ default HTTP 3080.

## Štruktúra
```
app/src/main/java/sk/surfspirit/pos/
  MainActivity.kt          immersive kiosk + init
  core/AppPrefs.kt         server URL + JWT + rola (SharedPreferences)
  core/Pos.kt              money(), errorMessage(), fiškálny stavový automat,
                           itemDest()/splitForPrint() (kuchyňa/bar + 🔢 čísla),
                           menuLogicComparator (rodina+objem triedenie)
  core/Store.kt            offline cache (menu/stoly/zóny/top), draft košíky
                           per stôl, offline fronta (storno/delete) + replay
  net/Api.kt               DTOs + Retrofit service (všetky čašnícke endpointy
                           vrátane /paragons, /storno-basket, /ttlock, PUT /tables)
  ui/AppNav.kt             navigácia login → floor → order/{tableId} + restore
  ui/LoginScreen.kt        PIN pad + server config
  ui/FloorScreen.kt        priestorový plán (x/y, edit mód), zónové pills,
                           polling, offline banner, TTLock, uzávierka
  ui/OrderScreen.kt        menu + účty + položky + send/pay/zľava/split/presun
                           + move-mode + paragón + storno dôvod + draft košík
  ui/components/Brand.kt   header (Stoly|Objednávka, čas, user, Zámok),
                           shift strip (trvanie zmeny), OFFLINE banner
  ui/components/Dialogs.kt manager PIN, poznámka, omáčka (repeat), zľava,
                           split (partial qty), platba (receipt preview),
                           storno dôvod, qty popupy, TTLock kód, uzávierka
  ui/update/UpdateGate.kt  auto-update (stiahni APK + inštalátor)
  ui/theme/Theme.kt        Daylight cream/terra paleta + Sora/Manrope
```
