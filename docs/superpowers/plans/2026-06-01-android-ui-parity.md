# Android UI Parity (zhoda s web POS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Steps use `- [ ]`.

**Goal:** Doladiť natívne Android UI (Compose) aby vizuálne sedelo s web POS — Daylight cream/terra, Sora+Manrope fonty, web-like header/shift strip, kategórie, product karty, order panel.

**Architecture:** Compose appka volá existujúce REST API. Meníme len UI vrstvu (theme + 3 screeny). Build overujeme cez nainštalovaný toolchain (`C:\at-tools`), APK do Downloads.

**Tech Stack:** Kotlin/Compose Material3, Retrofit. Fonty Sora + Manrope (res/font). Build: Gradle 8.7, SDK 34, JDK 17.

**Build kópia:** `C:\at` (krátka cesta). Zdroj pravdy: repo `android-tablet/`. Po každej oprave sync zmenené súbory → `C:\at`, rebuild, na konci commit do repa.

---

## File Structure
| File | Zodpovednosť |
|---|---|
| `app/src/main/res/font/*.ttf` | Sora + Manrope fonty (nové) |
| `ui/theme/Theme.kt` | FontFamily + Typography + paleta (zhoda s tokens.css) |
| `ui/components/Brand.kt` | zdieľané: logo SSS, header bar, shift strip, status dot |
| `ui/FloorScreen.kt` | web-like table chips |
| `ui/OrderScreen.kt` | kategórie + product karty + order panel + akčné tlačidlá |
| `ui/LoginScreen.kt` | drobné zladenie fontu/loga |

---

### Task 1: Fonty Sora + Manrope

**Files:** Create `app/src/main/res/font/sora_*.ttf`, `manrope_*.ttf`; Modify `ui/theme/Theme.kt`

- [ ] Stiahnuť ttf z gstatic (Sora 400/600/700/800, Manrope 400/500/600/700) do `android-tablet/app/src/main/res/font/` s lowercase názvami (`sora_regular.ttf` atď.)
- [ ] V Theme.kt definovať `FontFamily` Sora + Manrope cez `Font(R.font.sora_*, weight)`, nastaviť `PosTypography` (display→Sora, body→Manrope), priradiť do `MaterialTheme(typography=...)`.
- [ ] Sync → C:\at, `gradle assembleDebug`, čakať BUILD SUCCESSFUL.
- [ ] Commit.

### Task 2: Brand komponenty (header + shift strip)

**Files:** Create `ui/components/Brand.kt`; Modify `FloorScreen.kt` (použiť header)

- [ ] `PosHeader(title, userName, onLogout)`: cream surface, vľavo terra zaoblený „SSS" + „Kaviareň & Bar / Pokladničný systém", vpravo user chip + odhlásiť.
- [ ] `ShiftStrip(openTables, totalTables, revenueToday?)`: riadok „Otvorené stoly: X/Y · Tržby dnes: …€" (revenue best-effort, skryť ak nedostupné).
- [ ] `StatusDot(status)`: bod + glyph (○ voľný, ● obsadený) — zhoda s web T2.
- [ ] Build + commit.

### Task 3: Floor parity

**Files:** Modify `FloorScreen.kt`

- [ ] Table chip ako web: gradient cream karta, radius-md, status dot + glyph, obsadený = jemný terra tint, názov Sora bold, hover/press scale. Zóny ako sekcie.
- [ ] Header = `PosHeader("Stoly", ...)`, pod ním `ShiftStrip`.
- [ ] Build + commit.

### Task 4: Order screen parity

**Files:** Modify `OrderScreen.kt`

- [ ] Kategórie: horizontálne pill chipy, aktívny = terra tint + bold (web `.cat-btn.active`), ikona + label.
- [ ] Product karty: `--cat-color` štýl — emoji v zaoblenom boxe (34dp), názov 2 riadky, cena terra bold dole; gradient cream, radius-sm, press scale.
- [ ] Order panel: hlavička stola + „N ks v kuchyni"; položky s qty **steppermi (− / +)**, zelený ✓ pri odoslaných; SPOLU veľké; akčné tlačidlá: **Poslať** (terra-gold filled), **Predúčet** (outline), **Hotovosť/Karta** (web farby), riadok **Presun účet / Rozdeliť / Zľava** (zatiaľ Presun aktívne, ostatné disabled placeholder).
- [ ] Build + commit.

### Task 5: Finalizácia

- [ ] Plný `gradle assembleDebug` → BUILD SUCCESSFUL.
- [ ] APK → `Downloads/SurfSpiritPOS-debug.apk`.
- [ ] Sync všetky zmenené súbory do repa, commit + push.

---

## Self-Review
- Spec = „UI ako web": fonty (T1), header/strip (T2), floor (T3), kategórie+karty+panel (T4) — pokryté.
- Nové funkcie (qty steppers) sú web-parity afordancie, nie nové biznis toky; send/pay ostávajú.
- Žiadne placeholdery v exekúcii — reálny kód píšem pri vykonaní, plán je checklist.
- Mimo rozsah (ďalšie slice): split/zľava/predúčet logika, dochádzka, admin.
