# POS — náčrt nového dizajnového kódu

**Stav:** iba koncept, nie implementácia.  
**Zdroje:** `tokens.css`, `css/pos.css`, `pos-enterprise.html`, `login.html`, mobilná vrstva `.mob-*`, modály `.u-*`.

---

## 1. Súčasný stav (čo funguje / kde je dlh)

### Silné stránky
- **Jeden zdroj pravdy** pre farby a spacing v `tokens.css`; WCAG orientácia na tmavom pozadí.
- **Jasná doménová logika:** mapa stolov → menu → panel objednávky; mobil má paralelnú štruktúru (tab bar).
- **Sémantické stavy:** úspech (hotovosť, odoslané), nebezpečenstvo (zrušiť), akcent (karta, akcie) sú v kóde rozpoznateľné.
- **Modálny systém** `.u-overlay` / `.u-modal` / `.u-btn-*` je konzistentný a znovupoužiteľný.

### Dlh a riziká
| Oblast | Poznámka |
|--------|-----------|
| **Typografia** | Miešanie `px`, tokenov (`--text-*`) a magických čísel (`17px`, `12px`) v `pos.css`; dve rodiny fontov na POS vs **Bricolage/Newsreader** na `login.html` — vizuálne dva produkty. |
| **Povrchy** | `rgba(255,255,255,.0x)` sa opakuje na desiatkach miest; chýba **sémantický názov** (napr. `surface-interactive` vs `surface-canvas`). |
| **Tlačidlá** | `.btn`, `.admin-btn`, `.u-btn-*`, `.mob-btn-*` — rovnaká úloha, rôzne „jazyky“; ťažko držať jednu hierarchiu Primary / Secondary / Tertiary / Destructive. |
| **Akcent** | Fialová je všade (kategórie, stoly, karta); **rezervovaný** stôl má zlato, ale produktové karty môžu konkurovať rovnakou silou — vizuálna priorita sa mieša. |
| **Animácie** | `cardIn`, ripple, `translateY` na tlačidlách — na kiosku OK, na dlhej zmene zbytočný šum; chýba **pravidlo kedy animovať**. |
| **Inline štýly** | V HTML (`pos-enterprise.html`) sú stále `style=` na častiach objednávky/modálov — obchádza tokeny a sťažuje témy. |
| **Texty / i18n** | Zmes SK bez diakritiky a občas CZ; dizajn kód by mal počítať s **jednou jazykovou vrstvou** (aspoň konzistentné názvy komponentov v kóde). |

---

## 2. Ciele nového dizajnového kódu (princípy)

1. **Prevádzka prvé:** za 2 sekundy musí byť jasné: režim (stoly/menu), čas, účet, ďalší krok (poslať / zaplatiť).
2. **Jedna vizuálna reč:** login a POS zdieľajú **rovnaké fonty a tokeny** (alebo zámerný, zdokumentovaný výnimkový režim „lock screen“).
3. **Tri úrovne povrchu + jedna akcia:** používateľ vždy vie, čo je pozadie, čo je panel, čo je karta, čo je **jedna** primárna akcia na obrazovke.
4. **Tablet minimum:** cieľ 44px dotyk; kompaktné varianty len ako `density="compact"` pre desktop, nie default.
5. **Žiadna náhodná dekorácia:** žiadne gradienty bez funkcie (napr. gradient len na **celkom** alebo **aktívnom režime**, nie na každej karte).

---

## 3. Návrh vrstvy tokenov (semantic + raw)

### 3.1 Zachovať `:root` numerické tokeny
Ponechať súčasné `--space-*`, `--radius-*`, `--text-*` ako **primitives**.

### 3.2 Pridať sémantickú vrstvu (aliasy)
Nový blok napr. `:root` alebo `[data-theme="pos"]`:

```text
--surface-app        → mapuje na bg canvas + prípadný jemný gradient
--surface-raised     → panely (header, order panel, modál)
--surface-sunken     → toolbar, vstupy v pozadí
--surface-card       → product-card, chip ako „list item“
--border-default / --border-focus
--text-primary / --text-secondary / --text-muted
--action-primary     → jedna farba pre „ďalší krok“ (môže ostať accent)
--action-success     → hotovosť, odoslané, voľný stôl
--action-danger      → zrušenie, chyba
--accent-amber       → rezervácia (už existuje v praxi)
```

**Pravidlo:** komponenty používajú len sémantiku; primitives sa menia pri téme alebo white-label.

### 3.3 Voliteľná téma (náčrt)
- `data-theme="pos-dark"` (default)  
- neskôr `pos-contrast` (vyšší kontrast pre jasné miestnosti) — bez zmeny HTML komponentov, len aliasy.

---

## 4. Informačná architektúra shellu

### Desktop (`pos-enterprise`)
```
[ AppChrome: header ]
[ Workspace: table-view | products-panel ]  +  [ OrderDock: order-panel ]
```

**Náčrt zmeny:**  
- **OrderDock** vizuálne oddelený tokenom `--surface-raised` + jedna silná ľavá border čiara (nie len `1px` rovnaká ako všade).  
- **Workspace** zostáva najširší „plátený“ povrch; toolbar pod hlavičkou = `--surface-sunken` pre odlíšenie od canvasu.

### Mobile (`.mob-app`)
- Horný bar = zjednodušiť na **2 riadky max** alebo **1 riadok + sheet** pre stôl.  
- Spodný tab bar = držať **rovnakú ikonografiu** ako desktop prepínač (SVG set), nie emoji + SVG mix.

---

## 5. Komponentová slovníková knižnica (náčrt)

| Úroveň | Použitie | POS dnes | Cieľ |
|--------|-----------|----------|------|
| **Primary** | Poslať objednávku, Potvrdiť platbu | `.btn-send`, časti `.u-btn-ice` | Jedna trieda `ButtonPrimary` / token `action-primary` |
| **Secondary** | Karta, rozdeliť, zľava | `.btn-card`, `.btn-split` | `ButtonSecondary` + jasná vizuálna váha pod primary |
| **Tertiary** | Ghost, späť | `.u-btn-ghost` | Zachovať |
| **Destructive** | Zrušiť objednávku, odhlásenie potvrdenie | `.btn-cancel`, `.u-btn-rose` | Vždy rovnaká červená logika |
| **Chip / Toggle** | Stoly/Objednávka, zóny | `.view-btn`, `.zone-btn`, `.cat-btn` | Spoločný základ `SegmentedControl` + varianty hustoty |

**Karty produktov:** zjednotiť „hornú čiaru“ a gradient ceny — buď **jeden** štýl pre „cena“ (solid + tabular nums), alebo gradient len pri hover; v náčrte odporúčam **solid pre čitateľnosť**.

**Table chip:** tri jasné stavy (voľný / obsadený / rezervovaný) + legenda vždy rovnaká paleta ako chip.

---

## 6. Typografia (náčrt)

- **Display (Sora):** názvy obrazoviek, celkom, čas v hlavičke.  
- **Body (Manrope):** zoznamy, tlačidlá, popisky.  
- **Čísla:** `font-variant-numeric: tabular-nums` pre **ceny, časy, počty** všade.  
- **Mierka:** zrušiť orphan `px`; všetko cez `--text-*` + 1–2 utility triedy (`text-label`, `text-body`, `text-title`).

**Login:** preniesť na `var(--font-display)` / `var(--font-body)` alebo naopak dokumentovať „Newsreader = brand mark“.

---

## 7. Pohyb a hustota

- **Pravidlo:** animácia max 200 ms pre interakciu; žiadne stagger na celú mriežku pri každom prepnutí kategórie (náklad na slabších zariadeniach).  
- **Density token:** `--density: comfortable | compact` na úrovni `html` alebo `.app` — ovplyvní padding mriežky a výšku riadkov objednávky.

---

## 8. Mapovanie na súbory (pri budúcej implementácii)

| Krok | Súbor / akcia |
|------|----------------|
| 1 | Rozšíriť `tokens.css` o sémantické aliasy (bez zmeny vizuálu). |
| 2 | Postupne nahrádzať v `pos.css` priame rgba za aliasy v jednej oblasti (napr. order panel). |
| 3 | Zosúladiť `login.html` fonty s tokenmi. |
| 4 | Vyčistiť inline štýly v `pos-enterprise.html` do tried. |
| 5 | Dokumentovať komponenty v jednom mieste (môže byť táto zložka `examples/` alebo `docs/`). |

---

## 9. Zhrnutie jednou vetou

**Nový dizajn kód** = sémantické tokeny na povrch a akciu + zjednotená hierarchia tlačidiel + rovnaká typografia/login ako POS + menej dekoratívneho šumu pri zachovaní tmavého „pro“ vzhľadu vhodného pre prevádzku.

---

*Posledná aktualizácia: náčrt podľa stavu repozitára (POS enterprise + tokens + pos.css).*
