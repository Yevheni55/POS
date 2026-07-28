// Shared API client for all POS pages
const API_BASE = window.location.origin + '/api';

// PR-C: do not auto-replay fiscal/payment writes on reconnect. The cashier
// must explicitly retry online so the operator confirms the action.
const OFFLINE_NO_QUEUE_PREFIXES = ['/payments', '/fiscal-documents'];

function _shouldBlockOfflineQueue(path) {
  if (typeof path !== 'string') return false;
  for (var i = 0; i < OFFLINE_NO_QUEUE_PREFIXES.length; i++) {
    var prefix = OFFLINE_NO_QUEUE_PREFIXES[i];
    if (path === prefix || path.indexOf(prefix + '/') === 0) return true;
  }
  return false;
}

// Den v Europe/Bratislava, nie UTC — server interpretuje datumy (from/to,
// z-report date) ako bratislavske polnoci, takze medzi 00:00 a 01:00/02:00
// miestneho casu (presne pocas uzavierky) by UTC datum z toISOString()
// vratil vcerajsok. Locale en-CA formatuje rovno YYYY-MM-DD. Jediny zdroj
// "dnes" pre POS aj admin stranky (api.js nacitavaju oba shelly).
function bratislavaDayIso(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date || new Date());
}

// Kalendarna aritmetika nad 'YYYY-MM-DD'. Pocita sa v UTC priestore, takze
// prechod letneho/zimneho casu ani koniec mesiaca posun nepokazia — na rozdiel
// od `d.setDate(d.getDate()-n); d.toISOString()`, kde sa lokalna polnoc pri
// prevode do UTC prepadne o den dozadu.
function isoAddDays(iso, delta) {
  var p = String(iso).split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// Prvy den aktualneho mesiaca v bratislavskom case.
// `new Date(y, m, 1).toISOString().split('T')[0]` vracia cely letny cas
// POSLEDNY DEN PREDOSLEHO MESIACA (lokalna polnoc 1. = 22:00 UTC 31. / 30.),
// takze mesacny report zacinal o den skor a tahal do sumy cudzi den.
function bratislavaMonthStartIso(date) {
  return bratislavaDayIso(date).slice(0, 8) + '01';
}

// Pondelok toho tyzdna, v ktorom lezi bratislavske 'dnes' (ISO: Po=1..Ne=7).
function bratislavaMondayIso(date) {
  var iso = bratislavaDayIso(date);
  var p = iso.split('-');
  var dow = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay(); // Ne=0
  return isoAddDays(iso, -(dow === 0 ? 6 : dow - 1));
}

const api = {
  _offline: false,
  _queue: [],

  isOnline() {
    return navigator.onLine && !this._offline;
  },

  // Fronta sa nesmie donekonečna nafukovať ani prehrať prastaré zápisy:
  // po dvoch dňoch výpadku by replay založil účty, ktoré nikto nezakladal.
  _QUEUE_MAX: 200,
  _QUEUE_TTL_MS: 6 * 60 * 60 * 1000,

  _saveQueue() {
    try {
      // Pri prekročení stropu zahadzujeme NAJSTARŠIE — najnovšie zápisy sú
      // tie, ktoré ešte dávajú prevádzkovo zmysel.
      if (this._queue.length > this._QUEUE_MAX) {
        var over = this._queue.length - this._QUEUE_MAX;
        console.warn('Offline queue over cap — dropping', over, 'oldest ops');
        this._queue.splice(0, over);
      }
      localStorage.setItem('pos_offline_queue', JSON.stringify(this._queue));
    } catch (e) {
      // QuotaExceeded / private mode. Predtým to vyhodilo výnimku rovno do
      // request(), takže z „operácia sa uložila offline" bola nečakaná chyba.
      console.error('Offline queue save failed:', e && e.message);
    }
  },

  // Clears OFFLINE state + banner once a fetch succeeds. Stale banner stays
  // until next request otherwise — see fix in claude/amazing-mccarthy-f841b1.
  // Only toggles the .show class (does NOT remove the element) so the same
  // banner can be re-shown on a later outage — otherwise the first recovery
  // deletes #offlineBanner from the DOM and _setOffline() can never find it.
  _setOnline() {
    if (this._offline) {
      this._offline = false;
      var b = document.querySelector('#offlineBanner, .offline-banner');
      if (b && b.classList) b.classList.remove('show');
      if (document.body) document.body.classList.remove('is-offline');
      this._stopOfflineHeartbeat();
      // Fronta sa predtým prehrávala VÝHRADNE na `window 'online'`. Ten event
      // hlási stav sieťového rozhrania — pri `docker compose up -d --build`
      // (teda pri každom vlastnom deployi), páde servera alebo reštarte
      // kontajnera wifi nikdy nespadne, takže sa nevystrelil a zaradené
      // objednávky viseli vo fronte NAVŽDY: kuchyňa nedostala bon a účet sa
      // dal medzitým zaplatiť bez nich.
      this._flushQueueSoon('reconnect');
    }
  },

  // Reentrancia: syncQueue sa dá spustiť z 'online' eventu aj z _setOnline
  // naraz — bez guardu by tú istú operáciu poslali dvakrát.
  _flushing: false,
  async _flushQueueSoon(reason) {
    if (this._flushing) return null;
    if (!this._queue.length) return null;
    this._flushing = true;
    try {
      var result = await this.syncQueue();
      if (result && result.synced && typeof showToast === 'function') {
        showToast('Synchronizovaných operácií: ' + result.synced, 'success');
      }
      if (result && result.remaining && typeof showToast === 'function') {
        showToast('Nepodarilo sa odoslať: ' + result.remaining + ' — skúsim znova', 'warning');
      }
      return result;
    } catch (e) {
      console.error('Queue flush failed (' + reason + '):', e);
      return null;
    } finally {
      this._flushing = false;
    }
  },

  // Kým sme offline, ťukáme na /health. Toto je jediný spôsob, ako zistiť, že
  // sa server vrátil, keď sieťové rozhranie nikdy nespadlo.
  _hbTimer: null,
  _startOfflineHeartbeat() {
    if (this._hbTimer) return;
    var self = this;
    this._hbTimer = setInterval(function () {
      if (!self._offline) { self._stopOfflineHeartbeat(); return; }
      fetch(API_BASE + '/health', { method: 'GET', cache: 'no-store' })
        .then(function (r) { if (r && r.ok) self._setOnline(); })
        .catch(function () { /* stále dole — skúsime o 10 s */ });
    }, 10000);
  },
  _stopOfflineHeartbeat() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
  },

  // Rozpoznanie výpadku prenosu. Predtým to bolo `err.message.includes('fetch')`,
  // čo je hláška závislá od prehliadača: Chrome hovorí „Failed to fetch", ale
  // Safari/iOS „Load failed" a Firefox „NetworkError when attempting to fetch
  // resource". Na iPhone sa teda POST nezaradil do fronty a spadol ako obyčajná
  // chyba — čašník videl „Chyba sync: Load failed" a položky zmizli.
  _isTransportError(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    if (err.name !== 'TypeError') return false;
    // TypeError bez HTTP statusu = fetch sa vôbec nedostal na server.
    return err.status === undefined;
  },

  // Mirror of _setOnline: surface the OFFLINE banner + a one-shot warning
  // toast on the false→true transition. Driven by api._offline (the
  // server-down / wifi-up path in request()), NOT only the window 'offline'
  // event — that event tracks the OS network interface, so a crashed server
  // or downed proxy with wifi still up never fires it and the cashier would
  // otherwise build a whole order whose kitchen tickets silently queue.
  _setOffline(msg) {
    var wasOffline = this._offline;
    this._offline = true;
    this._startOfflineHeartbeat();
    var b = document.getElementById('offlineBanner') || document.querySelector('.offline-banner');
    if (b && b.classList) b.classList.add('show');
    if (document.body) document.body.classList.add('is-offline');
    if (!wasOffline && typeof showToast === 'function') {
      showToast(msg || 'Server nedostupný — objednávky sa ukladajú lokálne', 'warning');
    }
  },

  _loadQueue() {
    try {
      var raw = JSON.parse(localStorage.getItem('pos_offline_queue') || '[]');
      if (!Array.isArray(raw)) raw = [];
      var cutoff = Date.now() - this._QUEUE_TTL_MS;
      var fresh = raw.filter(function (op) {
        return op && (!op.timestamp || op.timestamp >= cutoff);
      });
      if (fresh.length !== raw.length) {
        console.warn('Offline queue: dropped', raw.length - fresh.length, 'stale ops (>6h)');
      }
      this._queue = fresh.slice(-this._QUEUE_MAX);
      if (fresh.length !== raw.length || this._queue.length !== fresh.length) this._saveQueue();
    } catch {
      this._queue = [];
    }
  },

  async syncQueue() {
    if (!this._queue.length) return;
    const queue = [...this._queue];
    this._queue = [];
    this._saveQueue();

    let synced = 0;
    let failed = 0;
    let dropped = 0;
    let deferred = 0;
    const currentUser = this.getUser();
    const currentStaffId = currentUser && currentUser.id != null ? currentUser.id : null;

    for (const op of queue) {
      // Defensive: drop any legacy queued fiscal/payment ops left behind from
      // a pre-PR-C client. They must never auto-replay.
      if (op && _shouldBlockOfflineQueue(op.path)) {
        console.warn('Dropped queued fiscal/payment op (cannot auto-replay):', op.method, op.path);
        dropped++;
        continue;
      }
      // Cudzí zápis neposielame pod aktuálnym tokenom — server by ho pripísal
      // prihlásenému používateľovi. Necháme ho vo fronte, kým sa pôvodný
      // človek prihlási späť (TTL v _loadQueue ho po 6 h aj tak upratá).
      if (op && op.staffId != null && currentStaffId != null && op.staffId !== currentStaffId) {
        this._queue.push(op);
        deferred++;
        continue;
      }
      try {
        const headers = {};
        if (op.idempotencyKey) headers['X-Idempotency-Key'] = op.idempotencyKey;
        const res = await this.request(op.path, {
          method: op.method,
          body: op.body ? JSON.stringify(op.body) : undefined,
          headers,
          // Bez tohto by request() pri opätovnom výpadku zaradil operáciu
          // späť BEZ idempotency kľúča — a ďalší replay by na serveri založil
          // duplikát.
          _idempotencyKey: op.idempotencyKey || null,
        });
        // request() vracia null, keď sme stále offline — vtedy si operáciu
        // sám zaradil späť do fronty. Predtým sa to počítalo ako `synced++`,
        // takže obsluha videla „N operácií synchronizovaných", hoci sa
        // neodoslalo nič. Znovu ju tu pushovať NESMIEME (duplikát).
        if (res === null) { failed++; continue; }
        synced++;
      } catch (e) {
        console.error('Sync failed:', op, e);
        this._queue.push(op);
        failed++;
      }
    }
    this._saveQueue();
    if (deferred) {
      console.warn('Offline queue: ' + deferred + ' op(s) belong to another staff member — kept for them');
    }
    return { synced, failed, dropped, deferred, remaining: this._queue.length };
  },

  getToken() {
    return sessionStorage.getItem('pos_token');
  },

  setToken(token) {
    sessionStorage.setItem('pos_token', token);
  },

  getUser() {
    try {
      return JSON.parse(sessionStorage.getItem('pos_user'));
    } catch {
      return null;
    }
  },

  setUser(user) {
    sessionStorage.setItem('pos_user', JSON.stringify(user));
  },

  logout() {
    sessionStorage.removeItem('pos_token');
    sessionStorage.removeItem('pos_user');
    window.location.href = '/login.html';
  },

  // Cesty, kde server pri roli 'cisnik' vyžaduje manažérsku eleváciu
  // (storno UŽ ODOSLANEJ položky). Token razí /auth/verify-manager po zadaní
  // PINu a platí 120 s; drží sa v pamäti v js/pos-payments.js.
  _needsManagerElevation(path, method) {
    if (!method || method === 'GET') return false;
    var clean = String(path).split('?')[0];
    // PUT/DELETE /orders/:id/items/:itemId  a  POST /orders/:id/batch
    return /^\/orders\/\d+\/items(\/|$)/.test(clean) || /^\/orders\/\d+\/batch$/.test(clean);
  },

  async request(path, options = {}) {
    const token = this.getToken();
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    // Elevačný token pripájame LEN na cesty, ktoré ho naozaj potrebujú —
    // je to kredenciál manažéra a nemá čo chodiť na nesúvisiace endpointy.
    // Bez tohto by čašník po zadaní SPRÁVNEHO manažérskeho PINu dostal na
    // storno odoslanej položky 403 (server od 2026-07 eleváciu vyžaduje),
    // pričom klient je optimistic-local-first — položka by z účtu zmizla
    // lokálne, ale na serveri by zostala. Presne rozchod POS vs server.
    if (!headers['X-Manager-Token'] && typeof getManagerElevationToken === 'function'
        && this._needsManagerElevation(path, options.method)) {
      const mt = getManagerElevationToken();
      if (mt) headers['X-Manager-Token'] = mt;
    }

    try {
      const res = await fetch(API_BASE + path, { ...options, headers });
      const text = await res.text();

      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      if (res.status === 401) {
        // _noAuthRedirect: callers like manager-PIN verify pass this so a
        // wrong MANAGER pin (401 from /auth/verify-manager) doesn't log out
        // and bounce the whole terminal to /login — that 401 means "wrong
        // pin", not "cashier session expired".
        if (!options._noAuthRedirect) this.logout();
        const err = new Error((data && data.error) || 'Neplatny token');
        err.status = res.status;
        err.data = data;
        err.path = path;
        err.method = options.method || 'GET';
        throw err;
      }

      if (res.status === 409) {
        const err = new Error((data && data.error) || 'Conflict - data bola zmenena');
        err.status = res.status;
        err.data = data;
        err.path = path;
        err.method = options.method || 'GET';
        throw err;
      }

      if (!res.ok) {
        const err = new Error((data && data.error) || (data && data.message) || 'Request failed');
        err.status = res.status;
        err.data = data;
        err.path = path;
        err.method = options.method || 'GET';
        throw err;
      }

      this._setOnline();
      return data;
    } catch (err) {
      if (this._isTransportError(err)) {
        this._setOffline();
        if (options.method && options.method !== 'GET') {
          // PR-C: fiscal/payment paths must not be auto-replayed. Refuse at
          // queue time and surface a distinct error so the caller can show
          // "must be online" instead of a misleading "queued" banner.
          if (_shouldBlockOfflineQueue(path)) {
            const offlineErr = new Error('Pripojenie nie je dostupne — operacia vyzaduje online stav.');
            offlineErr.code = 'OFFLINE_NO_QUEUE';
            offlineErr.path = path;
            offlineErr.method = options.method;
            console.warn('Offline: refused to queue fiscal op', options.method, path);
            throw offlineErr;
          }
          var _qUser = this.getUser();
          this._queue.push({
            path,
            method: options.method,
            body: options.body ? JSON.parse(options.body) : null,
            idempotencyKey: options._idempotencyKey || null,
            timestamp: Date.now(),
            // KTO operáciu zaradil. Tablet je zdieľaný: čašník A zaradí zápis
            // offline, odhlási sa, prihlási sa čašník B — a replay by prebehol
            // pod tokenom B, takže server (`staffId: req.user.id`) by tržbu aj
            // audit pripísal B. To ide priamo do mzdových reportov.
            staffId: _qUser && _qUser.id != null ? _qUser.id : null,
            staffName: _qUser && _qUser.name ? _qUser.name : null,
          });
          this._saveQueue();
          console.warn('Offline: queued', options.method, path);
          return null;
        }
        throw new Error('Offline - data nie su dostupne');
      }
      throw err;
    }
  },

  _inflight: {},

  async get(path) {
    if (this._inflight[path]) return this._inflight[path];
    const promise = this.request(path).finally(() => {
      delete this._inflight[path];
    });
    this._inflight[path] = promise;
    return promise;
  },

  _menuCache: null,
  _menuCacheTime: 0,

  async getMenu() {
    if (this._menuCache && Date.now() - this._menuCacheTime < 300000) {
      return this._menuCache;
    }
    this._menuCache = await this.get('/menu');
    this._menuCacheTime = Date.now();
    return this._menuCache;
  },

  // Top-sold items in the last 14 days — backs the "Najcastejsie" pseudo-tab.
  // Not cached client-side: pos-state.js manages refresh cadence.
  getTopItems() {
    return this.request('/menu/top', { method: 'GET' });
  },

  getPortosStatus() {
    return this.get('/integrations/portos/status');
  },

  getCompanyProfile(options) {
    var refresh = options && options.refresh;
    return this.get('/company-profile' + (refresh ? '?refresh=1' : ''));
  },

  updateCompanyProfile(body) {
    return this.put('/company-profile', body);
  },

  getCompanyProfilePortosCompare() {
    return this.get('/company-profile/portos-compare');
  },

  /** Manažér/admin: uloží identitu z Portos do DB a vráti profil. */
  async syncCompanyProfileFromPortos() {
    const body = await this.post('/company-profile/sync-from-portos', {});
    if (body && body.profile) return body.profile;
    return body;
  },

  /** Zosúladí pos_settings (názov prevádzky, IČO, …) s profilom zo servera — POS hlavička a tlač. */
  mergeCompanyProfileIntoPosSettingsCache(profile) {
    if (!profile || typeof profile !== 'object') return;
    try {
      var raw = localStorage.getItem('pos_settings');
      var settings = raw ? JSON.parse(raw) : {};
      if (!settings || typeof settings !== 'object') settings = {};
      if (profile.businessName) settings.sName = profile.businessName;
      if (profile.registeredAddress !== undefined) {
        settings.sAddress = profile.registeredAddress || settings.sAddress;
      }
      if (profile.contactPhone !== undefined) {
        settings.sPhone = profile.contactPhone || settings.sPhone;
      }
      if (profile.contactEmail !== undefined) {
        settings.sEmail = profile.contactEmail || settings.sEmail;
      }
      if (profile.ico !== undefined) settings.sIco = profile.ico || settings.sIco;
      if (profile.dic !== undefined) settings.sDic = profile.dic || settings.sDic;
      if (profile.icDph !== undefined) settings.sIcDph = profile.icDph || settings.sIcDph;
      if (profile.branchName !== undefined) settings.sBranchName = profile.branchName || settings.sBranchName;
      if (profile.branchAddress !== undefined) {
        settings.sBranchAddress = profile.branchAddress || settings.sBranchAddress;
      }
      if (profile.cashRegisterCode !== undefined) {
        settings.sCashRegisterCode = profile.cashRegisterCode || settings.sCashRegisterCode;
      }
      localStorage.setItem('pos_settings', JSON.stringify(settings));
    } catch (e) {
      console.warn('mergeCompanyProfileIntoPosSettingsCache', e);
    }
  },

  searchFiscalDocuments(params = {}) {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      query.set(key, String(value));
    });
    return this.get('/fiscal-documents/search?' + query.toString());
  },

  getFiscalDocument(id) {
    return this.get('/fiscal-documents/' + id);
  },

  stornoFiscalDocument(id) {
    return this.post('/fiscal-documents/' + id + '/storno', {});
  },

  getPaymentsHistory(params) {
    var q = new URLSearchParams();
    if (params && params.method) q.set('method', params.method);
    if (params && params.q) q.set('q', params.q);
    if (params && params.limit) q.set('limit', String(params.limit));
    if (params && params.scope) q.set('scope', params.scope);
    var qs = q.toString();
    return this.get('/payments/history' + (qs ? '?' + qs : ''));
  },

  stornoPayment(paymentId) {
    return this.post('/payments/' + paymentId + '/fiscal-storno', {});
  },

  // Položky dokladu pre admin Históriu platieb (manazer/admin).
  getPaymentItems(paymentId) {
    return this.get('/payments/' + paymentId + '/items');
  },

  printReceiptCopy(paymentId) {
    return this.post('/payments/' + paymentId + '/receipt-copy', {});
  },

  refiscalizePayment(paymentId) {
    return this.post('/payments/' + paymentId + '/refiscalize', {});
  },

  // Zmena sposobu platby na uz vytlacenom doklade. Backend (POST
  // /payments/:id/change-method) urobi: storno povodneho dokladu cez Portos
  // → novy sale doklad s novym sposobom → UPDATE payments.method.
  changePaymentMethod(paymentId, newMethod) {
    return this.post('/payments/' + paymentId + '/change-method', { newMethod: newMethod });
  },

  invalidateMenu() {
    this._menuCache = null;
    this._menuCacheTime = 0;
  },

  _genIdempotencyKey() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now() + '-' + Math.random().toString(36).slice(2);
  },

  // idempotencyKey (voliteľný) — keď volajúci potrebuje, aby sa OPAKOVANÝ
  // pokus o tú istú logickú operáciu na serveri zlúčil do jednej. Bez neho
  // dostane každé volanie nový kľúč, takže offline zaradený POST a neskorší
  // priamy POST toho istého sú pre server dve rôzne operácie.
  post(path, body, idempotencyKey) {
    const key = idempotencyKey || this._genIdempotencyKey();
    return this.request(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'X-Idempotency-Key': key },
      _idempotencyKey: key,
    });
  },

  put(path, body) {
    const key = this._genIdempotencyKey();
    return this.request(path, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'X-Idempotency-Key': key },
      _idempotencyKey: key,
    });
  },

  patch(path, body) {
    const key = this._genIdempotencyKey();
    return this.request(path, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'X-Idempotency-Key': key },
      _idempotencyKey: key,
    });
  },

  del(path, body) {
    const key = this._genIdempotencyKey();
    const opts = { method: 'DELETE', headers: { 'X-Idempotency-Key': key }, _idempotencyKey: key };
    if (body) opts.body = JSON.stringify(body);
    return this.request(path, opts);
  },

  async login(pin) {
    const res = await fetch(API_BASE + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Login failed');
    }
    const data = await res.json();
    this.setToken(data.token);
    this.setUser(data.user);
    return data;
  },

  requireAuth() {
    if (!this.getToken()) {
      // Preserve where the user wanted to go so login can deep-link
      // them back. Same-origin only — encodeURIComponent guards the
      // path in transit. Skip when we're already on /login* to avoid
      // a recursion loop.
      var here = window.location.pathname + window.location.search;
      if (!/^\/login(\.html)?$/.test(window.location.pathname) && /^\/[^\/]/.test(here)) {
        window.location.href = '/login.html?redirect=' + encodeURIComponent(here);
      } else {
        window.location.href = '/login.html';
      }
      return false;
    }
    return true;
  },
};

window.addEventListener('online', async () => {
  // _setOnline() zhodí banner, zastaví heartbeat a spustí flush fronty.
  // Flush voláme aj explicitne — keď server nikdy nespadol a offline bola len
  // wifi, `api._offline` už mohlo byť false a _setOnline() by nespravil nič.
  // Reentrancia guard v _flushQueueSoon zaručí, že sa fronta nepošle dvakrát.
  api._setOnline();
  if (typeof showToast === 'function') showToast('Pripojenie obnovené', 'success');
  await api._flushQueueSoon('online-event');
});

window.addEventListener('offline', () => {
  // NIC-level offline (OS reports the network interface down) — distinct copy
  // from the server-down default in _setOffline().
  api._setOffline('Ste offline — zmeny budú uložené lokálne');
});

api._loadQueue();

// ── Telemetria klientských chýb ────────────────────────────────────────────
// Kasa beží na tablete ako fullscreen PWA — nikto tam neotvorí DevTools. Bez
// tohto sa „kasa nešla" nedalo dohľadať vôbec: v celom projekte nebol jediný
// window.onerror ani unhandledrejection handler, takže výnimka, ktorá zabije
// render, zmizla bez stopy. sendBeacon prežije aj zavretie tabu a nikdy
// neblokuje UI.
(function () {
  var SENT_CAP = 20;          // strop na jedno načítanie stránky
  var sent = 0;
  var lastKey = '';

  function report(kind, payload) {
    try {
      if (sent >= SENT_CAP) return;
      // Ten istý error v slučke by inak zaplavil sieť aj server.
      var key = kind + '|' + (payload.message || '') + '|' + (payload.line || '');
      if (key === lastKey) return;
      lastKey = key;
      sent++;

      var user = null;
      try { user = api.getUser(); } catch (e) {}
      var body = JSON.stringify({
        kind: kind,
        message: payload.message || '',
        source: payload.source || '',
        line: payload.line || null,
        col: payload.col || null,
        stack: payload.stack || '',
        url: location.pathname + location.search,
        staff: user && user.name ? user.name : null,
      });

      if (navigator.sendBeacon) {
        navigator.sendBeacon(API_BASE + '/client-errors', new Blob([body], { type: 'application/json' }));
      } else {
        fetch(API_BASE + '/client-errors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true,
        }).catch(function () {});
      }
    } catch (e) { /* telemetria nikdy nesmie zhodiť appku */ }
  }

  window.addEventListener('error', function (e) {
    report('error', {
      message: e.message,
      source: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: e.error && e.error.stack ? e.error.stack : '',
    });
  });

  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    report('unhandledrejection', {
      message: (r && r.message) ? r.message : String(r),
      stack: (r && r.stack) ? r.stack : '',
    });
  });

  // Ručné hlásenie z aplikačného kódu (napr. catch vetva, ktorá by inak
  // skončila len v console.error).
  window.reportClientError = function (message, extra) {
    report('manual', Object.assign({ message: String(message || '') }, extra || {}));
  };
})();

const posFullscreen = {
  FS_KEY: 'pos_fullscreen',

  isActive() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  },

  enter() {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) req.call(el).catch(() => {});
    localStorage.setItem(this.FS_KEY, '1');
  },

  exit() {
    const ex = document.exitFullscreen || document.webkitExitFullscreen;
    if (ex && this.isActive()) ex.call(document).catch(() => {});
    localStorage.setItem(this.FS_KEY, '0');
  },

  toggle() {
    this.isActive() ? this.exit() : this.enter();
  },

  shouldRestore() {
    return localStorage.getItem(this.FS_KEY) === '1';
  },

  autoRestore() {
    const navRestore = localStorage.getItem('pos_fs_restore') === '1';
    localStorage.removeItem('pos_fs_restore');
    if ((!this.shouldRestore() && !navRestore) || this.isActive()) return;

    // Browser API obmedzuje že requestFullscreen() vyžaduje user gesture —
    // po location.href navigácii nemáme aktuálne gesture, takže nemôžeme
    // automaticky vstúpiť. Riešenie: zaregistrujeme handler na PRVÝ klick
    // a zobrazíme viditeľný hint aby user vedel ze treba klepnut.
    const self = this;
    self._showFsHint();
    const handler = () => {
      self.enter();
      self._hideFsHint();
      document.removeEventListener('click', handler, true);
      document.removeEventListener('touchstart', handler, true);
      document.removeEventListener('keydown', handler, true);
    };
    document.addEventListener('click', handler, { capture: true, once: false });
    document.addEventListener('touchstart', handler, { capture: true, once: false });
    document.addEventListener('keydown', handler, { capture: true, once: false });
  },

  _showFsHint() {
    if (document.getElementById('fsRestoreHint')) return;
    // Lazy-inject keyframes once (idempotent — guarded by id check above for hint)
    if (!document.getElementById('fsHintStyle')) {
      const s = document.createElement('style');
      s.id = 'fsHintStyle';
      s.textContent = '@keyframes fsHintPulse{0%,100%{opacity:.88;transform:translateX(-50%) translateY(0)}50%{opacity:1;transform:translateX(-50%) translateY(-3px)}}';
      document.head.appendChild(s);
    }
    const wrap = document.createElement('div');
    wrap.id = 'fsRestoreHint';
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-live', 'polite');
    // Inline styles — no dependency on Daylight tokens (api.js loads before
    // pos.css na niektorých stránkach a hint má byť visible aj na login).
    wrap.style.cssText = [
      'position:fixed',
      'bottom:80px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:9999',
      'padding:11px 20px',
      'background:rgba(30,24,18,.92)',
      'color:#fff',
      'border-radius:9999px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'font-size:13px',
      'font-weight:600',
      'letter-spacing:.01em',
      'box-shadow:0 8px 24px rgba(0,0,0,.32)',
      'pointer-events:none',
      'animation:fsHintPulse 1.6s ease-in-out infinite',
      'display:flex',
      'align-items:center',
      'gap:8px',
    ].join(';');
    wrap.innerHTML = ''
      + '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>'
      + '</svg>'
      + '<span>Klepni kdekoľvek pre celú obrazovku</span>';
    document.body.appendChild(wrap);
    // Auto-hide after 8s in case user is doing something else and doesn't
    // want to enter fullscreen — handler is still armed; first click in
    // next 24h restores. Hint isn't required to function.
    setTimeout(() => {
      // Only hide if still present (user hasn't clicked yet)
      const h = document.getElementById('fsRestoreHint');
      if (h) h.style.opacity = '0';
      setTimeout(() => this._hideFsHint(), 400);
    }, 8000);
  },

  _hideFsHint() {
    const h = document.getElementById('fsRestoreHint');
    if (h) h.remove();
  },
};

document.addEventListener('fullscreenchange', () => {
  localStorage.setItem(posFullscreen.FS_KEY, posFullscreen.isActive() ? '1' : '0');
});
document.addEventListener('webkitfullscreenchange', () => {
  localStorage.setItem(posFullscreen.FS_KEY, posFullscreen.isActive() ? '1' : '0');
});

posFullscreen.autoRestore();
