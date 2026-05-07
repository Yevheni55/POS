// Týždeň — detailná štatistika podľa hodín:
//   • predaj podľa hodín (stacked bar/kuchyňa)
//   • zaťaženosť kuchyne podľa hodín
//   • efektivita kuchára (kitchen €/hod cook)
//
// Dodržuje DESIGN-CODE.md — žiadne hex hodnoty, žiadne nové fonty,
// všetko cez tokens.css a admin patterns (.stat-grid, .panel, .data-table).

let _container = null;
let _data = null;
let _from = null;
let _to = null;

function $(s){ return _container.querySelector(s); }

function fmtEur(n, opts){
  opts = opts || {};
  const x = Number(n) || 0;
  return x.toLocaleString('sk-SK', {
    minimumFractionDigits: opts.dec != null ? opts.dec : 2,
    maximumFractionDigits: opts.dec != null ? opts.dec : 2,
  }) + ' €';
}
function fmtInt(n){ return (Number(n) || 0).toLocaleString('sk-SK'); }
function fmtHours(min){
  const h = Math.floor((min || 0) / 60);
  const m = Math.round((min || 0) % 60);
  return h + 'h ' + String(m).padStart(2,'0') + 'm';
}
function escapeHtml(s){
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Pondelok = ISO 1, Nedeľa = ISO 7
const DOW_LABEL = { 1:'Po', 2:'Ut', 3:'St', 4:'Št', 5:'Pi', 6:'So', 7:'Ne' };
const DOW_FULL  = { 1:'Pondelok', 2:'Utorok', 3:'Streda', 4:'Štvrtok', 5:'Piatok', 6:'Sobota', 7:'Nedeľa' };

function todayStr(){ return new Date().toISOString().split('T')[0]; }
function thisMondayStr(){
  const d = new Date();
  const dow = d.getDay() === 0 ? 6 : d.getDay() - 1; // Po=0..Ne=6
  d.setDate(d.getDate() - dow);
  return d.toISOString().split('T')[0];
}
function lastSundayStr(){
  const d = new Date();
  const dow = d.getDay() === 0 ? 6 : d.getDay() - 1;
  d.setDate(d.getDate() - dow + 6);
  return d.toISOString().split('T')[0];
}
function shiftWeek(deltaWeeks){
  const fromD = new Date(_from);
  fromD.setDate(fromD.getDate() + deltaWeeks * 7);
  const toD = new Date(_to);
  toD.setDate(toD.getDate() + deltaWeeks * 7);
  _from = fromD.toISOString().split('T')[0];
  _to = toD.toISOString().split('T')[0];
  load();
}
function fmtDateSk(iso){
  const [y,m,d] = iso.split('-');
  return d + '.' + m + '.';
}

async function load(){
  $('#weeklyContent').innerHTML = '<div class="loading-text" style="text-align:center;padding:60px 20px">Načítavam...</div>';
  try {
    // Paralelný fetch — sales + weather. Počasie je len doplňujúce
    // (ak Open-Meteo zlyhá, sales sa stále zobrazia).
    const [data, weather] = await Promise.all([
      api.get('/reports/weekly?from=' + _from + '&to=' + _to),
      api.get('/reports/weather?from=' + _from + '&to=' + _to).catch(() => ({ observations: [] })),
    ]);
    _data = data;
    _data.weather = weather.observations || [];
    render();
  } catch (err) {
    $('#weeklyContent').innerHTML = '<div class="empty-state" style="padding:60px;text-align:center"><div class="empty-state-title" style="color:var(--color-danger)">Chyba načítania</div><div class="empty-state-text">' + (err.message || 'API zlyhalo') + '</div></div>';
  }
}

// Weather code → emoji + slovak label. Mirror of server/lib/weather.js
function weatherInfo(code){
  const c = Number(code);
  if (c === 0) return { label: 'jasno', emoji: '☀️' };
  if (c === 1) return { label: 'prevažne jasno', emoji: '🌤️' };
  if (c === 2) return { label: 'polooblačno', emoji: '⛅' };
  if (c === 3) return { label: 'zamračené', emoji: '☁️' };
  if (c === 45 || c === 48) return { label: 'hmla', emoji: '🌫️' };
  if (c >= 51 && c <= 57) return { label: 'mrholenie', emoji: '🌦️' };
  if (c >= 61 && c <= 67) return { label: 'dážď', emoji: '🌧️' };
  if (c >= 71 && c <= 77) return { label: 'sneženie', emoji: '🌨️' };
  if (c >= 80 && c <= 82) return { label: 'prehánky', emoji: '🌧️' };
  if (c === 85 || c === 86) return { label: 'snehové prehánky', emoji: '🌨️' };
  if (c >= 95) return { label: 'búrka', emoji: '⛈️' };
  return { label: '—', emoji: '·' };
}

// Build a map: date|hour → weather observation (latest if duplicate)
function buildWeatherMap(observations){
  const m = new Map();
  for (const o of observations || []){
    m.set(o.date + '|' + o.hour, o);
  }
  return m;
}

function render(){
  const d = _data;
  if (!d) return;

  const totals = d.totals || {};
  const totalRev = (totals.kitchenRevenue || 0) + (totals.barRevenue || 0);
  const kitchenPct = totalRev > 0 ? ((totals.kitchenRevenue || 0) / totalRev * 100) : 0;

  const peakHourSale = (d.byHour || []).reduce((best, h) =>
    (h.totalRevenue > (best?.totalRevenue || 0)) ? h : best, null);
  const peakHourKitchen = (d.byHour || []).reduce((best, h) =>
    (h.kitchenRevenue > (best?.kitchenRevenue || 0)) ? h : best, null);

  const html = `
    <div class="filter-bar">
      <div class="period-btns">
        <button class="period-btn" id="prevWeek">‹ Predošlý</button>
        <button class="period-btn active" style="cursor:default">${fmtDateSk(_from)} – ${fmtDateSk(_to)}</button>
        <button class="period-btn" id="nextWeek">Ďalší ›</button>
        <button class="period-btn" id="thisWeek">Tento týždeň</button>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-icon ice">
          <svg aria-hidden="true" viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        </div>
        <div class="stat-info">
          <div class="stat-label">Tržby týždňa</div>
          <div class="stat-value">${fmtEur(totalRev)}</div>
          <div class="stat-change neutral">${fmtPct(kitchenPct)} z kuchyne</div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon mint">
          <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M9 6V3h6v3"/></svg>
        </div>
        <div class="stat-info">
          <div class="stat-label">Tržby kuchyne</div>
          <div class="stat-value">${fmtEur(totals.kitchenRevenue || 0)}</div>
          <div class="stat-change neutral">${peakHourKitchen && peakHourKitchen.kitchenRevenue > 0 ? 'peak ' + String(peakHourKitchen.hour).padStart(2,'0') + ':00' : '—'}</div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon lavender">
          <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <div class="stat-info">
          <div class="stat-label">Hodiny v kuchyni</div>
          <div class="stat-value">${fmtHours((totals.cookHours || 0) * 60)}</div>
          <div class="stat-change neutral">${(d.cooks || []).length} ${(d.cooks || []).length === 1 ? 'osoba' : 'os.'}</div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon amber">
          <svg aria-hidden="true" viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        </div>
        <div class="stat-info">
          <div class="stat-label">Zisk kuchyne</div>
          <div class="stat-value" style="color:${(totals.kitchenNetProfit||0) >= 0 ? 'var(--color-success)' : 'var(--color-danger)'}">${(totals.kitchenNetProfit||0) >= 0 ? '+' : ''}${fmtEur(totals.kitchenNetProfit || 0)}</div>
          <div class="stat-change neutral">tržby ${fmtEur(totals.kitchenRevenue||0)} − suroviny ${fmtEur(totals.kitchenCogs||0)} − mzdy ${fmtEur(totals.kitchenWage||0)} · marža ${(totals.kitchenNetMarginPct||0).toFixed(1)} %</div>
        </div>
      </div>
    </div>

    ${d.noKitchenStaff ? `
      <div class="panel" style="margin-bottom:16px;border-color:rgba(232,184,74,.3);background:rgba(232,184,74,.06)">
        <div style="display:flex;gap:14px;align-items:center">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent-amber)" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r=".5" fill="var(--accent-amber)"/></svg>
          <div>
            <div style="font-weight:var(--weight-semibold);color:var(--color-text);font-size:var(--text-md)">Žiadny zamestnanec s pozíciou „kuchár"</div>
            <div style="font-size:var(--text-sm);color:var(--color-text-sec);margin-top:2px">
              Pre presnú efektivitu kuchára nastav v admin → Zamestnanci → pozícia text obsahujúci „kuchár"/„cook"/„chef".
              Teraz počítam s celým personálom.
            </div>
          </div>
        </div>
      </div>
    ` : ''}

    <div class="panel" style="margin-bottom:16px">
      <div class="panel-title">Predaj podľa hodín</div>
      <div style="font-size:var(--text-sm);color:var(--color-text-sec);margin-top:-8px;margin-bottom:14px">stĺpce ukazujú tržby bar + kuchyňa</div>
      ${renderHourlyChart(d.byHour || [])}
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="panel-title">Zaťaženosť kuchyne</div>
      <div style="font-size:var(--text-sm);color:var(--color-text-sec);margin-top:-8px;margin-bottom:14px">tržby kuchyne podľa dňa × hodiny</div>
      ${renderHeatmap(d.heatmap || [])}
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="panel-title">Zisk kuchyne podľa kuchára</div>
      <div style="font-size:var(--text-sm);color:var(--color-text-sec);margin-top:-8px;margin-bottom:14px">tržby − suroviny − mzda = čistý zisk z kuchyne pripočítaný kuchárovi</div>
      ${renderCookTable(d.cooks || [])}
    </div>

    <div class="panel">
      <div class="panel-title">Detail dňa</div>
      <div style="font-size:var(--text-sm);color:var(--color-text-sec);margin-top:-8px;margin-bottom:14px">klikni na deň → uvidíš plnú hodinovú štatistiku s reálnym počasím tej hodiny</div>
      ${renderDayTabs(d.dailyHours || [])}
      <div id="dayDetail" style="margin-top:14px"></div>
    </div>
  `;

  $('#weeklyContent').innerHTML = html;
  $('#prevWeek').addEventListener('click', () => shiftWeek(-1));
  $('#nextWeek').addEventListener('click', () => shiftWeek(1));
  $('#thisWeek').addEventListener('click', () => {
    _from = thisMondayStr();
    _to = lastSundayStr();
    load();
  });

  // Day-tab kliky — prepínajú detailnú hodinovú tabuľku v paneli „Detail dňa"
  Array.from(document.querySelectorAll('.weekly-day-tab')).forEach(btn => {
    btn.addEventListener('click', () => {
      Array.from(document.querySelectorAll('.weekly-day-tab')).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderDayDetail(btn.dataset.date);
    });
  });

  // Auto-select today (or first day with data) — render hneď default
  const days = (d.dailyHours || []);
  if (days.length){
    const todayIso = new Date().toISOString().split('T')[0];
    const initial = days.find(x => x.date === todayIso) || days[days.length - 1];
    const initBtn = document.querySelector('.weekly-day-tab[data-date="' + initial.date + '"]');
    if (initBtn) initBtn.classList.add('active');
    renderDayDetail(initial.date);
  } else {
    document.getElementById('dayDetail').innerHTML = '<div class="td-empty" style="padding:30px;text-align:center;color:var(--color-text-dim)">Žiadne dni s dátami v tomto týždni</div>';
  }
}

// === DAY TABS — list of clickable day chips, one per day in period ===
function renderDayTabs(dailyHours){
  if (!dailyHours.length){
    return '<div style="font-size:var(--text-sm);color:var(--color-text-dim);padding:14px 0">Žiadne dni s dátami</div>';
  }
  return `<div class="weekly-day-tabs">
    ${dailyHours.map(day => {
      const hasData = day.totalRevenue > 0;
      const dowLabel = DOW_LABEL[day.weekday] || '?';
      const dateD = new Date(day.date + 'T12:00:00');
      const dnum = dateD.getDate() + '.' + (dateD.getMonth() + 1) + '.';
      return `<button class="weekly-day-tab${hasData ? '' : ' empty'}" data-date="${day.date}" type="button">
        <div class="dt-dow">${dowLabel}</div>
        <div class="dt-date">${dnum}</div>
        <div class="dt-rev">${hasData ? fmtEur(day.totalRevenue) : '—'}</div>
      </button>`;
    }).join('')}
  </div>`;
}

function renderDayDetail(dateIso){
  const day = (_data.dailyHours || []).find(d => d.date === dateIso);
  const host = document.getElementById('dayDetail');
  if (!day){
    host.innerHTML = '<div class="td-empty" style="padding:30px;text-align:center;color:var(--color-text-dim)">Žiadne dáta pre tento deň</div>';
    return;
  }
  const dateD = new Date(dateIso + 'T12:00:00');
  const dowFull = ['Nedeľa','Pondelok','Utorok','Streda','Štvrtok','Piatok','Sobota'][dateD.getDay()];
  const fullDate = dateD.getDate() + '. ' + ['januára','februára','marca','apríla','mája','júna','júla','augusta','septembra','októbra','novembra','decembra'][dateD.getMonth()] + ' ' + dateD.getFullYear();

  // Per-hour weather mapa pre TENTO deň
  const weatherForDay = (_data.weather || []).filter(o => o.date === dateIso);
  const wMap = new Map();
  for (const o of weatherForDay) wMap.set(o.hour, o);

  const filtered = (day.hours || []).filter(h => h.totalRevenue > 0 || h.cookMinutes > 0);
  if (!filtered.length){
    host.innerHTML = `<div style="font-size:var(--text-md);color:var(--color-text);margin-bottom:8px">${dowFull} · ${fullDate}</div>
      <div class="td-empty" style="padding:30px;text-align:center;color:var(--color-text-dim)">V tento deň nebola žiadna aktivita.</div>`;
    return;
  }

  // Day-level aggregates
  const dayCookMinutes = filtered.reduce((s, h) => s + (h.cookMinutes || 0), 0);
  const dayKitchenWage = filtered.reduce((s, h) => s + (h.kitchenWage || 0), 0);
  const dayKitchenNetProfit = filtered.reduce((s, h) => s + (h.kitchenNetProfit || 0), 0);
  const dayOrders = filtered.reduce((s, h) => s + (h.orders || 0), 0);
  const dayItemsKitchen = filtered.reduce((s, h) => s + (h.kitchenItems || 0), 0);
  const dayMargin = day.kitchenRevenue > 0 ? (dayKitchenNetProfit / day.kitchenRevenue * 100) : 0;
  const peakHour = filtered.reduce((best, h) => h.totalRevenue > (best?.totalRevenue || 0) ? h : best, null);
  const profitColor = dayKitchenNetProfit >= 0 ? 'var(--color-success)' : 'var(--color-danger)';

  // Day-level weather summary — peak temp, mode condition
  const tempVals = weatherForDay.map(o => o.temperatureC).filter(v => v !== null);
  const windVals = weatherForDay.map(o => o.windSpeedKmh).filter(v => v !== null);
  const peakTemp = tempVals.length ? Math.max(...tempVals) : null;
  const minTemp = tempVals.length ? Math.min(...tempVals) : null;
  const avgWind = windVals.length ? windVals.reduce((a,b) => a+b, 0) / windVals.length : null;
  const codeCounts = new Map();
  for (const o of weatherForDay){
    if (o.weatherCode === null || o.weatherCode === undefined) continue;
    codeCounts.set(o.weatherCode, (codeCounts.get(o.weatherCode) || 0) + 1);
  }
  let modeCode = null, bestN = 0;
  for (const [k, n] of codeCounts) if (n > bestN) { modeCode = k; bestN = n; }
  const dayWeather = modeCode !== null ? weatherInfo(modeCode) : null;

  host.innerHTML = `
    <!-- Day header — meno dňa + dátum + denný weather summary chip -->
    <div class="weekly-day-header">
      <div>
        <div class="weekly-day-name">${dowFull}</div>
        <div class="weekly-day-date">${fullDate}</div>
      </div>
      ${dayWeather ? `
        <div class="weekly-day-weather" title="Prevažujúce počasie + extrémy dňa">
          <div class="dw-emoji">${dayWeather.emoji}</div>
          <div class="dw-meta">
            <div class="dw-label">${escapeHtml(dayWeather.label)}</div>
            ${(peakTemp !== null && minTemp !== null) ? `<div class="dw-temps">${minTemp.toFixed(1)} – ${peakTemp.toFixed(1)} °C${avgWind !== null ? ' · vietor ' + avgWind.toFixed(0) + ' km/h' : ''}</div>` : ''}
          </div>
        </div>
      ` : ''}
    </div>

    <!-- 4 day stat cards — rovnaký tier ako týždeň, len per-day hodnoty -->
    <div class="stat-grid" style="margin-bottom:16px">
      <div class="stat-card">
        <div class="stat-icon ice">
          <svg aria-hidden="true" viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        </div>
        <div class="stat-info">
          <div class="stat-label">Tržby dňa</div>
          <div class="stat-value">${fmtEur(day.totalRevenue)}</div>
          <div class="stat-change neutral">${fmtInt(dayOrders)} obj.${peakHour ? ' · peak ' + String(peakHour.hour).padStart(2,'0') + ':00' : ''}</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon mint">
          <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M9 6V3h6v3"/></svg>
        </div>
        <div class="stat-info">
          <div class="stat-label">Tržby kuchyne</div>
          <div class="stat-value">${fmtEur(day.kitchenRevenue)}</div>
          <div class="stat-change neutral">${fmtInt(dayItemsKitchen)} ks · suroviny ${fmtEur(day.kitchenCogs)}</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon lavender">
          <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <div class="stat-info">
          <div class="stat-label">Hodiny v kuchyni</div>
          <div class="stat-value">${fmtHours(dayCookMinutes)}</div>
          <div class="stat-change neutral">mzda ${fmtEur(dayKitchenWage)}</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon amber">
          <svg aria-hidden="true" viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        </div>
        <div class="stat-info">
          <div class="stat-label">Zisk kuchyne</div>
          <div class="stat-value" style="color:${profitColor}">${dayKitchenNetProfit >= 0 ? '+' : ''}${fmtEur(dayKitchenNetProfit)}</div>
          <div class="stat-change neutral">marža ${dayMargin.toFixed(1)} %</div>
        </div>
      </div>
    </div>

    <!-- Hodinová tabuľka — vyrovnané stĺpce cez colgroup pre konzistentné šírky -->
    <div class="table-scroll-wrap">
    <table class="data-table weekly-day-table">
      <colgroup>
        <col style="width:60px">
        <col style="width:55px">
        <col style="width:90px">
        <col style="width:100px">
        <col style="width:90px">
        <col style="width:75px">
        <col style="width:110px">
        <col style="width:60px">
        <col style="width:75px">
        <col style="width:75px">
      </colgroup>
      <thead>
        <tr>
          <th>Hodina</th>
          <th class="text-right">Obj.</th>
          <th class="text-right">Bar</th>
          <th class="text-right">Kuch. tržby</th>
          <th class="text-right">Suroviny</th>
          <th class="text-right">Mzdy</th>
          <th class="text-right">Zisk kuchyne</th>
          <th class="text-center">Počasie</th>
          <th class="text-right">Teplota</th>
          <th class="text-right">Vietor</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map(h => {
          const w = wMap.get(h.hour);
          const wInfo = w && w.weatherCode !== null && w.weatherCode !== undefined ? weatherInfo(w.weatherCode) : null;
          const netProfit = h.kitchenNetProfit || 0;
          const rowProfitColor = netProfit >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
          return `<tr>
            <td class="num">${String(h.hour).padStart(2,'0')}:00</td>
            <td class="num text-right">${fmtInt(h.orders)}</td>
            <td class="num text-right">${h.barRevenue > 0 ? fmtEur(h.barRevenue) : '<span class="td-dim">—</span>'}</td>
            <td class="num text-right">${h.kitchenRevenue > 0 ? fmtEur(h.kitchenRevenue) : '<span class="td-dim">—</span>'}</td>
            <td class="num text-right td-sec">${h.kitchenCogs > 0 ? fmtEur(h.kitchenCogs) : '<span class="td-dim">—</span>'}</td>
            <td class="num text-right td-sec">${h.kitchenWage > 0 ? fmtEur(h.kitchenWage) : '<span class="td-dim">—</span>'}</td>
            <td class="num text-right" style="color:${h.kitchenRevenue > 0 ? rowProfitColor : 'var(--color-text-dim)'};font-weight:${h.kitchenRevenue > 0 ? 'var(--weight-bold)' : 'normal'}">${h.kitchenRevenue > 0 ? (netProfit >= 0 ? '+' : '') + fmtEur(netProfit) : '—'}</td>
            <td class="text-center" title="${wInfo ? escapeHtml(wInfo.label) : ''}">${wInfo ? wInfo.emoji : '<span class="td-dim">—</span>'}</td>
            <td class="num text-right">${w && w.temperatureC !== null ? Number(w.temperatureC).toFixed(1) + ' °C' : '<span class="td-dim">—</span>'}</td>
            <td class="num text-right">${w && w.windSpeedKmh !== null ? Math.round(Number(w.windSpeedKmh)) + ' km/h' : '<span class="td-dim">—</span>'}</td>
          </tr>`;
        }).join('')}
      </tbody>
      <tfoot>
        <tr>
          <td>Spolu</td>
          <td class="num text-right">${fmtInt(dayOrders)}</td>
          <td class="num text-right">${fmtEur(day.barRevenue)}</td>
          <td class="num text-right">${fmtEur(day.kitchenRevenue)}</td>
          <td class="num text-right td-sec">${fmtEur(day.kitchenCogs)}</td>
          <td class="num text-right td-sec">${fmtEur(dayKitchenWage)}</td>
          <td class="num text-right" style="color:${profitColor}">${dayKitchenNetProfit >= 0 ? '+' : ''}${fmtEur(dayKitchenNetProfit)}</td>
          <td class="text-center"></td>
          <td class="num text-right">${peakTemp !== null ? peakTemp.toFixed(1) + ' °C' : '—'}</td>
          <td class="num text-right">${avgWind !== null ? avgWind.toFixed(0) + ' km/h' : '—'}</td>
        </tr>
      </tfoot>
    </table>
    </div>
    <div style="margin-top:10px;font-size:var(--text-xs);color:var(--color-text-dim)">
      Počasie pre presnú hodinu z Open-Meteo (Draždiak 48,1014°N, 17,1136°E).
      Footer riadok ukazuje sumár za celý deň + extrémne hodnoty počasia (max teplota, priemer vetra).
    </div>
  `;
}

function fmtPct(n){ return (Number(n) || 0).toFixed(1) + ' %'; }

// === Hourly chart — stacked bars (bar + kitchen) ===
function renderHourlyChart(byHour){
  const max = Math.max(...byHour.map(h => h.totalRevenue), 1);
  return `
    <div class="weekly-hourly-chart">
      ${byHour.map(h => {
        const total = h.totalRevenue || 0;
        const heightPct = (total / max) * 100;
        const barH = total > 0 ? (h.barRevenue / total) * heightPct : 0;
        const kitchH = total > 0 ? (h.kitchenRevenue / total) * heightPct : 0;
        return `<div class="weekly-bar" title="${String(h.hour).padStart(2,'0')}:00 — ${fmtEur(total)} (kuchyňa ${fmtEur(h.kitchenRevenue)} · bar ${fmtEur(h.barRevenue)})">
          <div class="weekly-bar-stack">
            <div class="weekly-bar-fill kitchen" style="height:${kitchH}%"></div>
            <div class="weekly-bar-fill bar" style="height:${barH}%"></div>
          </div>
          <div class="weekly-bar-hour">${String(h.hour).padStart(2,'0')}</div>
        </div>`;
      }).join('')}
    </div>
    <div class="weekly-chart-legend">
      <span><span class="legend-dot kitchen"></span>Kuchyňa</span>
      <span><span class="legend-dot bar"></span>Bar</span>
    </div>
  `;
}

// === Weekday × hour heatmap of kitchen revenue ===
function renderHeatmap(heatmap){
  // Build 7×24 grid (filter to active hour range)
  const max = Math.max(...heatmap.map(c => c.kitchenRevenue), 0);
  const minHour = Math.min(...heatmap.map(c => c.hour), 23);
  const maxHour = Math.max(...heatmap.map(c => c.hour), 0);
  if (max === 0) return '<div class="td-empty" style="padding:30px;text-align:center;color:var(--color-text-dim)">Žiadne kuchynské tržby v období</div>';

  const cellMap = new Map();
  for (const c of heatmap) cellMap.set(c.weekday + '|' + c.hour, c);

  let html = '<div class="weekly-heatmap"><table class="weekly-hm-table">';
  // Header row — hours
  html += '<thead><tr><th></th>';
  for (let h = minHour; h <= maxHour; h++){
    html += '<th>' + String(h).padStart(2,'0') + '</th>';
  }
  html += '</tr></thead><tbody>';
  for (let dow = 1; dow <= 7; dow++){
    html += '<tr><th class="dow-label">' + DOW_LABEL[dow] + '</th>';
    for (let h = minHour; h <= maxHour; h++){
      const c = cellMap.get(dow + '|' + h);
      const val = c ? c.kitchenRevenue : 0;
      const pct = max > 0 ? (val / max) * 100 : 0;
      const tier = pct === 0 ? 0 : pct < 25 ? 1 : pct < 50 ? 2 : pct < 75 ? 3 : 4;
      html += `<td class="hm-cell tier-${tier}" title="${DOW_FULL[dow]} ${String(h).padStart(2,'0')}:00 — ${fmtEur(val)}">${val > 0 ? Math.round(val) : ''}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  html += '<div class="weekly-chart-legend"><span><span class="legend-dot tier-1"></span>menej</span><span><span class="legend-dot tier-2"></span></span><span><span class="legend-dot tier-3"></span></span><span><span class="legend-dot tier-4"></span>viac</span></div>';
  return html;
}

function renderCookTable(cooks){
  if (!cooks.length){
    return '<div class="td-empty" style="padding:30px;text-align:center;color:var(--color-text-dim)">Žiadne smeny v týždni</div>';
  }
  return `
    <div class="table-scroll-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th>Meno</th>
          <th>Pozícia</th>
          <th class="text-right">Hodiny</th>
          <th class="text-right">Tržby kuchyne</th>
          <th class="text-right">Suroviny</th>
          <th class="text-right">Mzda</th>
          <th class="text-right">Čistý zisk</th>
          <th class="text-right">Marža</th>
        </tr>
      </thead>
      <tbody>
        ${cooks.map(c => {
          const profitColor = c.netProfit >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
          return `<tr>
            <td class="td-name">${escapeHtml(c.name)}</td>
            <td>${escapeHtml(c.position) || '<span style="color:var(--color-text-dim)">—</span>'}</td>
            <td class="num text-right">${fmtHours(c.minutes)}</td>
            <td class="num text-right">${fmtEur(c.kitchenRevenue)}</td>
            <td class="num text-right" style="color:var(--color-text-sec)">${fmtEur(c.kitchenCogs)}</td>
            <td class="num text-right" style="color:var(--color-text-sec)">${fmtEur(c.wage)}</td>
            <td class="num text-right" style="color:${profitColor};font-weight:var(--weight-bold)">${c.netProfit >= 0 ? '+' : ''}${fmtEur(c.netProfit)}</td>
            <td class="num text-right" style="color:${profitColor}">${(c.netMarginPct || 0).toFixed(1)} %</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    </div>
    <div style="margin-top:10px;font-size:var(--text-xs);color:var(--color-text-dim)">
      Atribúcia: tržby + náklady na suroviny v kuchyni sa rozdelia medzi aktívnych kuchárov pomerom ich minút v každej hodine.
    </div>
  `;
}

function renderHourTable(byHour){
  // Tabuľka per (date, hour) — kombinujeme dáta cez dni v týždni.
  // Pre každý deň × hodinu zlúčime sales + weather.
  const fromD = new Date(_from);
  const toD = new Date(_to);
  const days = [];
  for (let d = new Date(fromD); d <= toD; d.setDate(d.getDate() + 1)){
    days.push(d.toISOString().split('T')[0]);
  }

  // Sales mapy: date|hour → kitchen/bar/orders. Server vracia byHour
  // agregované cez celé obdobie, ale pre per-day-per-hour potrebujeme
  // ísť do heatmap[dow|hour] a duplicitne to nasplit-ovať... server už
  // hodinové dáta nepriviazal na konkrétny dátum v tomto endpointe —
  // zobrazíme byHour agregované, plus počasie ako "priemer hodiny" cez
  // všetky dni v perióde.
  const filtered = byHour.filter(h => h.totalRevenue > 0 || h.cookMinutes > 0);
  if (!filtered.length){
    return '<div class="td-empty" style="padding:30px;text-align:center;color:var(--color-text-dim)">Žiadne dáta</div>';
  }

  // Aggregate weather by hour-of-day across the period (avg temp, wind).
  const weatherMap = buildWeatherMap(_data.weather || []);
  const wByHour = new Map();
  for (const o of _data.weather || []){
    if (!wByHour.has(o.hour)){
      wByHour.set(o.hour, { temps: [], winds: [], clouds: [], precs: [], codes: [] });
    }
    const a = wByHour.get(o.hour);
    if (o.temperatureC !== null) a.temps.push(o.temperatureC);
    if (o.windSpeedKmh !== null) a.winds.push(o.windSpeedKmh);
    if (o.cloudCoverPct !== null) a.clouds.push(o.cloudCoverPct);
    if (o.precipitationMm !== null) a.precs.push(o.precipitationMm);
    if (o.weatherCode !== null && o.weatherCode !== undefined) a.codes.push(o.weatherCode);
  }
  const avg = (arr) => arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : null;
  const mode = (arr) => {
    if (!arr.length) return null;
    const c = new Map();
    arr.forEach(x => c.set(x, (c.get(x)||0)+1));
    let best = arr[0], bn = 0;
    for (const [k, n] of c) if (n > bn) { best = k; bn = n; }
    return best;
  };

  return `
    <div class="table-scroll-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th>Hodina</th>
          <th class="text-right">Obj.</th>
          <th class="text-right">Bar</th>
          <th class="text-right">Kuch. tržby</th>
          <th class="text-right">Suroviny</th>
          <th class="text-right">Mzdy</th>
          <th class="text-right">Zisk kuchyne</th>
          <th class="text-center">Počasie</th>
          <th class="text-right">Teplota</th>
          <th class="text-right">Vietor</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map(h => {
          const w = wByHour.get(h.hour);
          const avgTemp = w ? avg(w.temps) : null;
          const avgWind = w ? avg(w.winds) : null;
          const code = w ? mode(w.codes) : null;
          const wInfo = code !== null ? weatherInfo(code) : null;
          const netProfit = h.kitchenNetProfit || 0;
          const profitColor = netProfit >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
          return `<tr>
            <td class="num">${String(h.hour).padStart(2,'0')}:00</td>
            <td class="num text-right">${fmtInt(h.orders)}</td>
            <td class="num text-right">${h.barRevenue > 0 ? fmtEur(h.barRevenue) : '<span style="color:var(--color-text-dim)">—</span>'}</td>
            <td class="num text-right">${h.kitchenRevenue > 0 ? fmtEur(h.kitchenRevenue) : '<span style="color:var(--color-text-dim)">—</span>'}</td>
            <td class="num text-right" style="color:var(--color-text-sec)">${h.kitchenCogs > 0 ? fmtEur(h.kitchenCogs) : '<span style="color:var(--color-text-dim)">—</span>'}</td>
            <td class="num text-right" style="color:var(--color-text-sec)">${h.kitchenWage > 0 ? fmtEur(h.kitchenWage) : '<span style="color:var(--color-text-dim)">—</span>'}</td>
            <td class="num text-right" style="color:${h.kitchenRevenue > 0 ? profitColor : 'var(--color-text-dim)'};font-weight:${h.kitchenRevenue > 0 ? 'var(--weight-bold)' : 'normal'}">${h.kitchenRevenue > 0 ? (netProfit >= 0 ? '+' : '') + fmtEur(netProfit) : '—'}</td>
            <td class="text-center" title="${wInfo ? escapeHtml(wInfo.label) : ''}">${wInfo ? wInfo.emoji : '<span style="color:var(--color-text-dim)">—</span>'}</td>
            <td class="num text-right">${avgTemp !== null ? avgTemp.toFixed(1) + ' °C' : '<span style="color:var(--color-text-dim)">—</span>'}</td>
            <td class="num text-right">${avgWind !== null ? avgWind.toFixed(0) + ' km/h' : '<span style="color:var(--color-text-dim)">—</span>'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    </div>
    <div style="margin-top:10px;font-size:var(--text-xs);color:var(--color-text-dim)">
      Počasie: priemer cez všetky dni v období pre danú hodinu — <a href="https://open-meteo.com/" target="_blank" rel="noopener" style="color:var(--color-text-sec)">Open-Meteo</a>, lokalita Draždiak (48,1014°N, 17,1136°E).
    </div>
  `;
}

// Page CSS — only chart/heatmap specific styles. Everything else cez tokens + admin.css.
const PAGE_CSS = `
<style>
  .weekly-hourly-chart{
    display:flex;
    align-items:flex-end;
    gap:3px;
    height:200px;
    padding:8px 2px 4px;
    overflow-x:auto;
  }
  .weekly-bar{
    flex:1 0 32px;
    min-width:32px;
    height:100%;
    display:flex;
    flex-direction:column;
    align-items:center;
    justify-content:flex-end;
    gap:4px;
  }
  .weekly-bar-stack{
    width:100%;
    height:calc(100% - 18px);
    display:flex;
    flex-direction:column;
    justify-content:flex-end;
  }
  .weekly-bar-fill{
    width:100%;
    transition: filter var(--transition-fast);
  }
  .weekly-bar-fill.kitchen{
    background: linear-gradient(180deg, var(--color-success), rgba(92,196,158,.7));
    border-radius: var(--radius-xs) var(--radius-xs) 0 0;
  }
  .weekly-bar-fill.bar{
    background: linear-gradient(180deg, var(--color-accent-dim), rgba(123,110,199,.6));
  }
  .weekly-bar:hover .weekly-bar-fill{ filter: brightness(1.2) }
  .weekly-bar-hour{
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-sec);
    font-variant-numeric: tabular-nums;
  }

  .weekly-chart-legend{
    display:flex;
    gap:18px;
    margin-top:14px;
    font-size: var(--text-sm);
    color: var(--color-text-sec);
    flex-wrap:wrap;
  }
  .weekly-chart-legend .legend-dot{
    display:inline-block;
    width:10px; height:10px;
    border-radius: var(--radius-xs);
    margin-right:6px;
    vertical-align: middle;
  }
  .legend-dot.kitchen{ background: var(--color-success) }
  .legend-dot.bar    { background: var(--color-accent) }
  .legend-dot.tier-1 { background: rgba(139,124,246,.18) }
  .legend-dot.tier-2 { background: rgba(139,124,246,.40) }
  .legend-dot.tier-3 { background: rgba(139,124,246,.65) }
  .legend-dot.tier-4 { background: var(--color-accent) }

  /* Heatmap — 7 rows (Po-Ne) × N hours */
  .weekly-heatmap{ overflow-x: auto; -webkit-overflow-scrolling: touch }
  .weekly-hm-table{
    border-collapse: separate;
    border-spacing: 2px;
    font-size: var(--text-xs);
  }
  .weekly-hm-table th{
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-sec);
    padding: 4px 6px;
    text-align: center;
    background: transparent;
    border-bottom: none;
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
  }
  .weekly-hm-table th.dow-label{
    text-align: right;
    padding-right: 10px;
    color: var(--color-text);
    font-weight: var(--weight-bold);
    background: transparent;
    text-transform: none;
    letter-spacing: 0;
    font-size: var(--text-sm);
  }
  .weekly-hm-table td.hm-cell{
    width: 38px; height: 30px;
    text-align: center;
    border-radius: var(--radius-xs);
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-sec);
    font-variant-numeric: tabular-nums;
    transition: transform var(--transition-fast);
  }
  .weekly-hm-table td.hm-cell:hover{ transform: scale(1.08) }
  .hm-cell.tier-0{ background: rgba(255,255,255,.03); color: var(--color-text-dim) }
  .hm-cell.tier-1{ background: rgba(139,124,246,.18); color: var(--color-text) }
  .hm-cell.tier-2{ background: rgba(139,124,246,.40); color: var(--color-text) }
  .hm-cell.tier-3{ background: rgba(139,124,246,.65); color: #fff; font-weight: var(--weight-bold) }
  .hm-cell.tier-4{ background: var(--color-accent); color: #fff; font-weight: var(--weight-bold) }

  /* Day tabs — kliknuteľné chips per deň v týždni */
  .weekly-day-tabs{
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 8px;
  }
  .weekly-day-tab{
    background: var(--color-bg-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 12px 10px;
    text-align: left;
    cursor: pointer;
    transition: background var(--transition-fast),
                border-color var(--transition-fast),
                transform var(--transition-fast);
    font-family: inherit;
    color: var(--color-text);
  }
  .weekly-day-tab:hover{
    background: var(--color-bg-hover);
    border-color: var(--color-border-hover);
    transform: translateY(-1px);
  }
  .weekly-day-tab.empty{
    opacity: .55;
  }
  .weekly-day-tab.active{
    background: var(--color-accent-bg-hover);
    border-color: var(--color-accent);
    color: var(--color-accent);
  }
  .weekly-day-tab .dt-dow{
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    color: var(--color-text-sec);
  }
  .weekly-day-tab.active .dt-dow{ color: var(--color-accent) }
  .weekly-day-tab .dt-date{
    font-size: var(--text-md);
    font-weight: var(--weight-bold);
    margin-top: 2px;
    font-family: var(--font-display);
  }
  .weekly-day-tab .dt-rev{
    font-size: var(--text-sm);
    color: var(--color-text);
    font-family: var(--font-display);
    font-weight: var(--weight-semibold);
    margin-top: 6px;
    font-variant-numeric: tabular-nums;
  }
  .weekly-day-tab.empty .dt-rev{ color: var(--color-text-dim) }

  /* Day-detail header — meno dňa + dátum vľavo, weather chip vpravo */
  .weekly-day-header{
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .weekly-day-name{
    font-family: var(--font-display);
    font-size: var(--text-lg);
    font-weight: var(--weight-bold);
    color: var(--color-text);
    letter-spacing: var(--tracking-tight);
  }
  .weekly-day-date{
    font-size: var(--text-sm);
    color: var(--color-text-sec);
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
  }
  .weekly-day-weather{
    display: inline-flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    background: var(--color-bg-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
  }
  .weekly-day-weather .dw-emoji{
    font-size: 28px;
    line-height: 1;
  }
  .weekly-day-weather .dw-meta{
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .weekly-day-weather .dw-label{
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
    text-transform: capitalize;
  }
  .weekly-day-weather .dw-temps{
    font-size: var(--text-xs);
    color: var(--color-text-sec);
    font-variant-numeric: tabular-nums;
  }

  /* Day hour table — vyrovnané stĺpce, sekundárne hodnoty stlmené */
  .weekly-day-table{
    table-layout: fixed;
    width: 100%;
  }
  .weekly-day-table td,
  .weekly-day-table th{
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .weekly-day-table tfoot td{
    font-weight: var(--weight-bold);
    border-top: 1px solid var(--color-border);
    background: var(--color-bg-subtle, rgba(255,255,255,.02));
  }
  .weekly-day-table .td-sec{ color: var(--color-text-sec) }
  .weekly-day-table .td-dim{ color: var(--color-text-dim) }

  /* Motion-safe — DESIGN-CODE.md § 9.2 */
  @media (prefers-reduced-motion: reduce){
    *, *::before, *::after{
      animation-duration: 0s !important;
      transition-duration: 0s !important;
    }
  }
</style>
`;

const TEMPLATE = PAGE_CSS + `
<div id="weeklyContent">
  <div class="loading-text" style="text-align:center;padding:80px 20px">Načítavam...</div>
</div>
`;

export function init(container){
  _container = container;
  container.innerHTML = TEMPLATE;
  _from = thisMondayStr();
  _to   = lastSundayStr();
  load();
}

export function destroy(){
  _container = null;
  _data = null;
}
