# Surf Spirit POS — Android tablet app (natívna, Kotlin + Compose)

Natívna Android appka pre 10.1" tablet, ktorá beží proti **existujúcemu POS
serveru** (Express + Postgres na kase). Nie je to ďalší backend — appka volá
rovnaké REST API (`/api/...`) ako web POS.

## Prečo natívne + čo je hotové

Web POS funguje a beží na tablete v prehliadači. Natívna verzia dáva lepší
tablet UX (žiadny prehliadač, kiosk režim, rýchlejšie), ale znamená prepísať
**celý frontend** po vrstvách. Toto je **prvá funkčná vrstva (slice 1)**:

- ✅ **Nastavenie adresy servera** v appke (IP:port) — rieši zmenu IP po DHCP
- ✅ **Prihlásenie PIN-om** → `POST /api/auth/login`, JWT uložený, posielaný ako Bearer
- ✅ **Plán stolov** (`GET /api/tables`) — zoskupené po zónach, farba podľa stavu
  (zelená = voľný, terra = obsadený, …)
- ✅ **Jadro objednávky** — menu (`GET /api/menu`), pridávanie položiek,
  **Poslať objednávku** (`POST /api/orders` / `/items` + `/send-and-print`)
- ✅ **Platba** — Hotovosť / Karta (`POST /api/payments`); fiškál (Portos)
  rieši server, tlač bloku tiež. Po zaplatení sa stôl uvoľní a appka sa
  vráti na plán stolov (auto-refresh).
- ✅ Kiosk: fullscreen immersive, landscape lock, obrazovka stále zapnutá
- ✅ Daylight dizajn (cream + terra), zhoda s web POS

### Ešte nie je (ďalšie slice)
Účty/split/presun, zľavy, predúčet, paragón offline fallback, dochádzka,
admin (menu, recepty, reporty, cashflow, sklad), staff meal, shisha, TTLock.
Tieto pribudnú postupne — každá ako samostatná vrstva proti už existujúcim
API endpointom.

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
  core/AppPrefs.kt         server URL + JWT (SharedPreferences)
  net/Api.kt               DTOs + Retrofit service + interceptory
  ui/AppNav.kt             navigácia login → floor → order
  ui/LoginScreen.kt        PIN pad + server config
  ui/FloorScreen.kt        stoly po zónach
  ui/OrderScreen.kt        menu + objednávka + poslať
  ui/theme/Theme.kt        Daylight cream/terra paleta
```
