# POS Design Code

**Single source of truth pre dizajn všetkých POS + Admin obrazoviek.**
Každá nová funkcia, page, komponent alebo modál musí dodržať pravidlá
uvedené v tomto dokumente. Bez výnimky — keď tento dokument povie že
*„buttony majú radius `--radius-sm`"*, znamená to že žiaden button v
POS nepoužíva inú hodnotu.

---

## 0. Princípy (najpovinnejšie)

| # | Pravidlo | Prečo |
|---|---|---|
| 1 | **Vždy importuj `tokens.css` ako prvý** | Jediná centrálna definícia palety, spacingu, fontov |
| 2 | **Žiadne hex hodnoty v komponentnom CSS** — používaj `var(--color-*)` | Jeden zdroj pravdy, dark/light theme niekedy v budúcnosti |
| 3 | **Žiadne `!important`** okrem `[hidden]` overridov | Špecificita rieš architektúrou, nie hammer-om |
| 4 | **Žiadne nové fonty** mimo Sora + Manrope (POS), Instrument Serif + Plus Jakarta Sans + Caveat (web) | Brand consistency |
| 5 | **Touch targets ≥ 44 px** (`--btn-h-md`) | iOS HIG + Material Design A11y |
| 6 | **Kontrast WCAG AA** — všetok text proti pozadiu min. 4.5:1, large text 3:1 | Operátor v slnku na terase musí čítať |
| 7 | **Mobile-first** — píš najprv pre 375 px (iPhone SE), enhance pre tablet/desktop | Kasa je iPad, telefón čašníka, často slabé wifi |
| 8 | **`prefers-reduced-motion`** vypína všetky animácie | A11y povinnosť |

---

## 1. Farby

### 1.1 Pozadia (elevation ladder — POS dark theme)

```
--color-bg-sunken     #0b0915   recessed (footers, secondary header)
--color-bg            #0f0d1a   page canvas
--color-bg-elevated   #161328   panels, sidebar, header
--color-bg-surface    rgba(255,255,255,.07)   cards, inputs
--color-bg-hover      rgba(255,255,255,.11)   hover state
--color-bg-active     rgba(255,255,255,.15)   pressed/selected
--color-overlay       rgba(0,0,0,.60)         modal backdrop
```

**Pravidlo:** Komponent na pozadí `--color-bg` (kanvas) používa surface
`--color-bg-surface`. Modál na overlayi používa `--color-bg-elevated`.
**Nikdy nepoužívaj fixné hex pre pozadie.**

### 1.2 Primárny accent (purple — interaktivita)

```
--color-accent          #8B7CF6   primary actions, active state
--color-accent-bg       rgba(139,124,246,.08)
--color-accent-bg-hover rgba(139,124,246,.15)
--color-accent-border   rgba(139,124,246,.12)
```

**Použitie:** active tab, selected item, primary button, link, focus ring.

### 1.3 Sémantické farby

| Farba | Premenná | Použitie |
|---|---|---|
| 🟢 Success | `--color-success #5CC49E` | „Vyplatené", „Free", confirm OK, drop targets |
| 🔴 Danger | `--color-danger #E07070` | Storno, error, „Zrušiť", delete |
| 🟡 Amber | `--accent-amber #e8b84a` | Warning, „Čaká", source-of-move (ZDROJ badge) |

**Pravidlo:** Žiadny komponent nesmie miešať dve sémantické farby
naraz — nepoužívaj amber + red dohromady. Vyber tú dôležitejšiu.

### 1.4 Web (surfspirit.sk) paleta — *iná*

Webka má samostatnú paletu (water blues + sand + sunset). Detail:

```
--blue-700    #0c3768   primary water
--blue-900    #04122a   abyss / footer
--cyan-300    #6ae0e2   foam highlight (matches logo)
--sand-50     #fdf9f3   paper bg
--sunset-orange #ff7b54  CTA color
```

**Použitie:** *iba* pre `web/index.html`. POS / admin sú dark theme s
purple accent.

### 1.5 Text

```
--color-text       rgba(220,240,245,.92)   primary
--color-text-sec   rgba(220,240,245,.55)   secondary, labels
--color-text-dim   rgba(220,240,245,.25)   placeholder, decorative
```

---

## 2. Typografia

### 2.1 Fonty

| Stack | Použitie |
|---|---|
| `--font-display` (`Sora`) | Veľké čísla, stat values, suma €, hero title |
| `--font-body` (`Manrope`) | Default, labels, UI text |

**Web (surfspirit.sk):** Instrument Serif (display, italic) + Plus
Jakarta Sans (body) + Caveat (handwritten accents).

### 2.2 Type scale

```
--text-2xs  9px    badges, status dots
--text-xs  10px    labels (uppercase tracking)
--text-sm  11px    secondary meta
--text-base 12px   tertiary
--text-md  13px    body small
--text-lg  14px    body default
--text-xl  15px    forms, inputs
--text-2xl 16px    body large
--text-3xl 18px    section heading
--text-4xl 20px    page heading
--text-5xl 22px    modal title
--text-6xl 28px    stat number
--text-7xl 36px    hero number
--text-8xl 48px    splash / hero giant
```

**Pravidlo:** Nepoužívaj inú hodnotu mimo škály. `font-size: 17px` je
**zakázaný** — používaj `--text-2xl` (16px) alebo `--text-3xl` (18px).

### 2.3 Weight + spacing

```
--weight-normal     400
--weight-medium     500   meta, secondary
--weight-semibold   600   labels, button text
--weight-bold       700   primary actions, emphasis
--weight-extrabold  800   hero, display
```

```
--leading-tight    1.15   headings, big numbers
--leading-snug     1.30   subheadings
--leading-normal   1.45   body (default)
--leading-relaxed  1.60   long-form body
```

```
--tracking-tight   -.3px   display headings (Sora)
--tracking-wide     .3px   labels (uppercase)
--tracking-wider    .8px   pill labels, eyebrows
```

### 2.4 Uppercase labels — vzor

```css
.section-label {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-wider);
  text-transform: uppercase;
  color: var(--color-text-sec);
}
```

---

## 3. Spacing — 8 px base

```
--space-1   4px
--space-2   8px
--space-3   12px
--space-4   16px   (default page padding mobile)
--space-5   20px
--space-6   24px   (default page padding desktop)
--space-8   32px
--space-12  48px
```

**Pravidlo:** Žiadne `padding: 17px` — vyber z týchto siedmich.
Vertikálny rytmus medzi sekciami: `--space-6` mobile, `--space-8`+ desktop.

---

## 4. Radius — 5 tier

```
--radius-xs    4px     badge, indicator dot, kbd hint
--radius-sm    8px     button, input, chip, icon container
--radius-md    14px    card, panel, table-chip
--radius-lg    22px    modal, sheet, big card
--radius-full  9999px  pill, circle (avatar, FAB, status dot)
```

**Pravidlo:** Vyber tier podľa veľkosti komponentu, nie podľa estetiky.
Veľký panel s `radius-sm` vyzerá hranato; malý badge s `radius-md`
vyzerá bublinato.

---

## 5. Tlačidlá

### 5.1 Min-height (touch targets)

```
--btn-h-xs   32px   inline only, NIKDY ako standalone tap target
--btn-h-sm   36px   compact utility (admin tables)
--btn-h-md   44px   DEFAULT — minimum pre tap target
--btn-h-lg   52px   primary CTA, hero
```

### 5.2 Varianty

| Variant | Background | Border | Text | Použitie |
|---|---|---|---|---|
| **Primary** | `--color-accent` | none | `#fff` | hlavná akcia (Pridať, Uložiť) |
| **Secondary** | `transparent` | `--color-border` | `--color-text` | sekundárna (Zrušiť) |
| **Success** | `--color-success` | none | `#fff` | „Pridat surovinu", konfirm |
| **Danger** | `--color-danger` | none | `#fff` | Storno, Vymazať |
| **Ghost** | `transparent` | `transparent` | `--color-text-sec` | toolbar icon, „×" close |
| **Tinted** | `rgba(accent,.12)` | `rgba(accent,.4)` | `var(--accent)` | secondary action zafarbený |

**Vzor (tinted, napr. „Presun" tlačidlo v footeri účtu):**

```css
.btn-move {
  background: rgba(92, 196, 158, .12);     /* .12 alpha tint */
  color: var(--color-success);
  border: 1px solid rgba(92, 196, 158, .4); /* .4 alpha border */
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  padding: var(--space-2) var(--space-3);
  min-height: var(--btn-h-xs);
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast),
              transform var(--transition-fast);
}
.btn-move:hover  { background: rgba(92,196,158,.22); transform: translateY(-1px); }
.btn-move:active { transform: translateY(1px); }
```

**Pravidlo:** Tlačidlá s **tinted** variantom musia mať farbu zhodnú s
následnou akciou (klik na „Presun" → zelené move-mode UI).

### 5.3 Focus ring (povinné)

```css
.btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(139, 124, 246, .35);
}
```

---

## 6. Karty / Panely

### 6.1 Štandardná karta

```css
.card {
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-4) var(--space-5);
}
```

### 6.2 Hover

Iba ak je karta interaktívna (klik):

```css
.card-interactive:hover {
  background: var(--color-bg-hover);
  border-color: var(--color-border-hover);
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}
```

**Pravidlo:** Žiaden hover na neklikovateľnej karte. Inak používateľ
očakáva akciu a frustruje sa.

### 6.3 Tinted karty (sémantická signalizácia)

Top a low day cards na *Sezóna* stránke:

```css
.card.success { border-color: rgba(92,196,158,.3); background: linear-gradient(135deg, rgba(92,196,158,.04), var(--color-bg-surface) 70%); }
.card.danger  { border-color: rgba(224,112,112,.3); background: linear-gradient(135deg, rgba(224,112,112,.04), var(--color-bg-surface) 70%); }
```

---

## 7. Modaly + Overlay

```css
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--color-overlay);
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
}
.modal-overlay[hidden] { display: none !important; }  /* POVINNÉ — viď 11.2 */

.modal {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
  max-width: 520px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
}
```

**Pravidlo:** Modaly **vždy** majú `[hidden] { display: none !important }`
explicitne — `display: flex` z autorskej CSS by inak prebil UA pravidlo.

---

## 8. Inputs / Forms

```css
input, select, textarea {
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font: inherit;
  padding: var(--space-3) var(--space-4);
  min-height: var(--btn-h-md);   /* tap target */
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
input:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-glow);
}
```

**Custom checkbox + radio + select** — definované globálne v `tokens.css`.
**Nedefinuj ich znovu v komponentnej CSS.**

### 8.1 Number input — desatinné miesta

| Hodnota | step |
|---|---|
| Cena položky (€/ks) | `step="0.01"` |
| Sub-cent food cost (€/g) | `step="0.0001"` |
| Množstvo na sklade | `step="0.001"` |
| Recept qty (g) | `step="0.001"` |

---

## 9. Animácie & motion

### 9.1 Transition timing

```
--transition-fast    150ms ease   hover, focus, color shift
--transition-normal  250ms ease   modal open, panel slide
--transition-slow    350ms ease   page transition, hero
```

**Pravidlo:** Hover state ide vždy `--transition-fast`. Modal open
`--transition-normal`. Nikdy custom timing.

### 9.2 Motion-safe (povinné)

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    scroll-behavior: auto !important;
  }
}
```

Každá nová stránka MUSÍ obsahovať tento blok.

### 9.3 Akceptovateľné animácie

- Scale + opacity reveal pri scroll (IntersectionObserver)
- Hover lift `translateY(-2px)`
- Press `translateY(1px)`
- Pulse pre status dot (live indikátor)
- Marquee ticker (jasný text content)

**Zakázané:** parallax na celej stránke, autoplay carousel, blink/strobe,
viac ako 3 simultánne animácie v rámci viditeľnej obrazovky.

---

## 10. Z-index hierarchia

```
--z-base       1
--z-dropdown   50
--z-modal      200
--z-toast      300
--z-overlay    400   (move-mode banner, system warning)
```

**Pravidlo:** Nepoužívaj `z-index: 9999`. Vyber z týchto piatich.
Ak potrebuješ niečo nad modal, použi `--z-toast` alebo `--z-overlay`.

---

## 11. Časté nástrahy & poistky

### 11.1 Sub-cent ceny

`Number.toFixed(2)` zaokrúhli `0.00114 €/g` na `0,00 €` — operátor si
myslí že položka je zadarmo. Použí adaptívny formátter:

```js
function fmtCost(n) {
  const x = Number(n);
  if (!isFinite(x) || x === 0) return '0,00';
  const abs = Math.abs(x);
  if (abs >= 1)    return x.toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 0.01) return x.toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return x.toLocaleString('sk-SK', { minimumFractionDigits: 4, maximumFractionDigits: 5 });
}
```

A vždy ukáž jednotku za sumou: `"0,0052 €/g"` namiesto `"0,01 €"`.

### 11.2 `[hidden]` attribute vs. `display:flex`

UA stylesheet má `[hidden] { display: none }` (bez `!important`).
Akýkoľvek autorský `display: flex` to prebije a `el.hidden = true`
nezakryje element. Vždy pridaj explicitný override:

```css
.my-overlay[hidden] { display: none !important; }
```

### 11.3 Timezone na bonoch

Server beží v Docker UTC. `new Date().getHours()` vracia UTC. **Vždy**
používaj `Intl.DateTimeFormat` s `timeZone: 'Europe/Bratislava'`:

```js
function localTimeHHMM(date = new Date()) {
  return new Intl.DateTimeFormat('sk-SK', {
    timeZone: 'Europe/Bratislava',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}
```

### 11.4 Veľký počet desatinných v Slovak locale

Použiť `'sk-SK'` locale → čiarka ako desatinný oddeľovač (`12,40 €`).
Používať bodku v UI je **chyba** v slovenskej prevádzke.

### 11.5 Mobile keyboard kryje vstup

Numerické vstupy v modáli (cash given, qty picker) — nepoužívaj
natívnu klávesnicu, postav vlastný numpad. `inputmode="none"` +
`readonly` na inpute, klikni cez vlastné tlačidlá. Detail: viď
`js/pos-payments.js _setupCashHelper()`.

---

## 12. A11y povinnosti (PWAs musia spĺňať)

| # | Pravidlo |
|---|---|
| 1 | Každý interaktívny prvok má `aria-label` alebo viditeľný text |
| 2 | `<button>` namiesto `<div onclick>` |
| 3 | Focus ring viditeľný (`:focus-visible` 3px ring na accent) |
| 4 | Kontrast WCAG AA — `--color-text` na `--color-bg` má 12.7:1 ✓ |
| 5 | Tap targets ≥ 44px |
| 6 | Form labels viazané na inputy cez `for=` / `<label>` wrap |
| 7 | `prefers-reduced-motion` rešpektovaný |
| 8 | iOS `safe-area-inset-{top,bottom,left,right}` na fixed/sticky |

---

## 13. Šablóna novej page module

Každá nová admin stránka (`admin/pages/foo.js`) musí mať túto kostru:

```js
let _container = null;

function $(s) { return _container.querySelector(s); }

const TEMPLATE = `
<style>
  /* Použí len tokens — žiadne hex hodnoty mimo úrovne komponenty */
  .foo-page { padding: var(--space-6); }
  .foo-card {
    background: var(--color-bg-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-5);
  }
  /* Motion-safe */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0s !important;
      transition-duration: 0s !important;
    }
  }
</style>
<div class="foo-page">…</div>
`;

export function init(container) {
  _container = container;
  container.innerHTML = TEMPLATE;
  load();
}

export function destroy() {
  _container = null;
}
```

A doplniť do `admin/router.js` + sidebar nav v `admin/index.html`.

---

## 14. Komponenty — tokens cheatsheet

```
Card:           bg-surface + border + radius-md + space-5
Modal:          bg-elevated + border-strong + radius-lg + space-6
Button primary: accent bg + radius-sm + btn-h-md + weight-semibold
Pill / chip:    bg-surface + radius-full + space-2 space-3
Badge:          tint-bg + tint-color + radius-xs + text-2xs uppercase
Input:          bg-surface + border + radius-sm + btn-h-md
Section title:  font-display + text-3xl + weight-semibold + tracking-tight
Eyebrow:        text-xs + uppercase + tracking-wider + color-text-sec
Stat number:    font-display + text-6xl + weight-bold
```

---

## 15. Príklad „good" vs „bad"

### ✅ Good

```css
.season-stat-num {
  font-family: var(--font-display);
  font-size: var(--text-6xl);
  font-weight: var(--weight-normal);
  color: var(--color-text);
  letter-spacing: var(--tracking-tight);
}
```

### ❌ Bad

```css
.stat-number {
  font-family: 'Helvetica Neue', sans-serif;   /* ❌ nepovolený font */
  font-size: 27px;                              /* ❌ mimo škálu */
  font-weight: 600;                             /* ❌ nepoužitá premenná */
  color: #ddd;                                  /* ❌ hex */
  letter-spacing: -1px;                         /* ❌ mimo škálu */
}
```

---

## 16. Checklist pred merge

Predtým ako pridáš novú page / komponent:

- [ ] Importujem `tokens.css` (alebo som v admin / pos kde už importovaná je)
- [ ] Žiadne hex hodnoty okrem `tokens.css`
- [ ] Žiadne nové fonty
- [ ] Type scale — všetky `font-size` z premenných
- [ ] Spacing — všetky padding/margin z `--space-*`
- [ ] Radius — z `--radius-*`
- [ ] Tlačidlá majú min-height ≥ 44px
- [ ] Focus ring na všetkých interaktívnych
- [ ] `[hidden]` override pre overlays / modaly
- [ ] `prefers-reduced-motion` motion-safe blok
- [ ] iOS safe-area-inset pre fixed/sticky
- [ ] Sub-cent suma cez `fmtCost()` (nie `toFixed(2)`)
- [ ] Slovak locale — čiarka oddeľovač, `sk-SK`
- [ ] Bratislava TZ — `Intl.DateTimeFormat` s explicitným timeZone

---

## 17. Kde sú definované

| Súbor | Účel |
|---|---|
| `tokens.css` | **Single source of truth.** Importovať ako prvý. |
| `a11y.css` | Globálne a11y overrides (focus ring, sr-only) |
| `css/pos.css` | POS app komponenty + utility classes |
| `admin/admin.css` | Admin layout + table + modal patterns |
| `web/index.html` (inline) | Webka — *odlišná* paleta |
| `examples/design-code-showcase.css` | Storybook-like showcase pre dc-* premenné |

---

## 18. Audit existujúceho kódu

Ak nájdeš v existujúcom kóde porušenie tohto Design Code (napr. hex
hodnota, nepovolený font, magic číslo padding) — **oprav to v rámci
súčasného PR**, nie samostatne. Inak sa technický dlh hromadí.

Bug fix s prílohou: *"Plus refactored hero-section colors to tokens."*
je platná zmena. Otvárať osobitný PR len kvôli tomu nie je.

---

**Posledná aktualizácia:** 2026-05-07. Za zmeny zodpovedá Yevhen
(majiteľ). Pri zásadnej zmene palety / spacing scale — update tento
dokument PRED úpravou kódu.
