// Shared API client for all POS pages
const API_BASE = window.location.origin + '/api';

const api = {
  _offline: false,
  _queue: [],

  isOnline() {
    return navigator.onLine && !this._offline;
  },

  _saveQueue() {
    localStorage.setItem('pos_offline_queue', JSON.stringify(this._queue));
  },

  _loadQueue() {
    try {
      this._queue = JSON.parse(localStorage.getItem('pos_offline_queue') || '[]');
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
    for (const op of queue) {
      try {
        const headers = {};
        if (op.idempotencyKey) headers['X-Idempotency-Key'] = op.idempotencyKey;
        await this.request(op.path, {
          method: op.method,
          body: op.body ? JSON.stringify(op.body) : undefined,
          headers,
        });
        synced++;
      } catch (e) {
        console.error('Sync failed:', op, e);
        this._queue.push(op);
        failed++;
      }
    }
    this._saveQueue();
    return { synced, failed, remaining: this._queue.length };
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

  async request(path, options = {}) {
    const token = this.getToken();
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (token) headers['Authorization'] = 'Bearer ' + token;

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
        this.logout();
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

      this._offline = false;
      return data;
    } catch (err) {
      if (err.name === 'TypeError' && err.message.includes('fetch')) {
        this._offline = true;
        if (options.method && options.method !== 'GET') {
          this._queue.push({
            path,
            method: options.method,
            body: options.body ? JSON.parse(options.body) : null,
            idempotencyKey: options._idempotencyKey || null,
            timestamp: Date.now(),
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

  getPortosStatus() {
    return this.get('/integrations/portos/status');
  },

  getCompanyProfile() {
    return this.get('/company-profile');
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

  invalidateMenu() {
    this._menuCache = null;
    this._menuCacheTime = 0;
  },

  _genIdempotencyKey() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now() + '-' + Math.random().toString(36).slice(2);
  },

  post(path, body) {
    const key = this._genIdempotencyKey();
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
      window.location.href = '/login.html';
      return false;
    }
    return true;
  },
};

window.addEventListener('online', async () => {
  api._offline = false;
  document.getElementById('offlineBanner')?.classList.remove('show');
  document.body.classList.remove('is-offline');
  const result = await api.syncQueue();
  if (result && result.synced) {
    if (typeof showToast === 'function') showToast('Online - ' + result.synced + ' operacii synchronizovanych', true);
  } else {
    if (typeof showToast === 'function') showToast('Pripojenie obnovene', 'success');
  }
});

window.addEventListener('offline', () => {
  api._offline = true;
  document.getElementById('offlineBanner')?.classList.add('show');
  document.body.classList.add('is-offline');
  if (typeof showToast === 'function') showToast('Ste offline - zmeny budu ulozene lokalne', 'warning');
});

api._loadQueue();

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

    const self = this;
    const handler = () => {
      self.enter();
      document.removeEventListener('click', handler, true);
      document.removeEventListener('touchstart', handler, true);
      document.removeEventListener('keydown', handler, true);
    };
    document.addEventListener('click', handler, { capture: true, once: false });
    document.addEventListener('touchstart', handler, { capture: true, once: false });
    document.addEventListener('keydown', handler, { capture: true, once: false });
  },
};

document.addEventListener('fullscreenchange', () => {
  localStorage.setItem(posFullscreen.FS_KEY, posFullscreen.isActive() ? '1' : '0');
});
document.addEventListener('webkitfullscreenchange', () => {
  localStorage.setItem(posFullscreen.FS_KEY, posFullscreen.isActive() ? '1' : '0');
});

posFullscreen.autoRestore();
