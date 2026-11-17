// Private, encrypted, on-device storage.
// - History (visits, track, trips, usage) is encrypted with AES-GCM 256 (WebCrypto).
// - The key is a NON-EXTRACTABLE CryptoKey kept in this browser's IndexedDB:
//   scripts can use it but can never read its bytes, and it never leaves the phone.
// - Nothing in this file talks to the network.

const DB_NAME = 'smartmap-secure';
const DB_VER = 1;

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function kvGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readonly');
    const q = tx.objectStore('kv').get(key);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}

async function kvSet(key, val) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function kvDel(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function getKey() {
  let k = await kvGet('aes-key');
  if (!k) {
    k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await kvSet('aes-key', k);
  }
  return k;
}

const emptyDB = () => ({ visits: [], track: [], trips: [], usage: [] });

export const History = {
  db: emptyDB(),
  listeners: new Set(),
  _saveTimer: null,

  async load() {
    try {
      const blob = await kvGet('history');
      if (!blob) return;
      const key = await getKey();
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.iv }, key, blob.data);
      this.db = { ...emptyDB(), ...JSON.parse(new TextDecoder().decode(plain)) };
    } catch (e) {
      console.warn('history load failed', e);
      this.db = emptyDB();
    }
  },

  async saveNow() {
    try {
      const key = await getKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(this.db)));
      await kvSet('history', { iv, data });
    } catch (e) { console.warn('history save failed', e); }
  },

  mutate(fn) {
    fn(this.db);
    const d = this.db;
    if (d.track.length > 30000) d.track.splice(0, d.track.length - 30000);
    if (d.usage.length > 6000) d.usage.splice(0, d.usage.length - 6000);
    if (d.visits.length > 8000) d.visits.splice(0, d.visits.length - 8000);
    if (d.trips.length > 800) d.trips.splice(0, d.trips.length - 800);
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 1500);
    this.listeners.forEach(l => l());
  },

  log(kind, value) { this.mutate(d => d.usage.push({ t: Date.now(), kind, value: String(value).slice(0, 120) })); },

  async deleteAll() {
    this.db = emptyDB();
    await kvDel('history');
    await kvDel('aes-key');
    this.listeners.forEach(l => l());
  },

  summary() {
    const d = this.db;
    return `${d.visits.length} زيارة • ${d.track.length} نقطة مسار • ${d.trips.length} رحلة • ${d.usage.length} حدث`;
  }
};

// Offline emergency pack (not personal: public OSM data) — plain IndexedDB
export const Emergency = {
  async load() { return (await kvGet('emergency-pack')) || null; },
  async save(p) { await kvSet('emergency-pack', p); },
  async clear() { await kvDel('emergency-pack'); }
};

// Optional API keys: stored only in this browser, never in the code or the link.
export const Keys = {
  get: async name => (await kvGet('key:' + name)) || null,
  set: async (name, v) => v ? kvSet('key:' + name, String(v).trim()) : kvDel('key:' + name)
};

const SETTINGS_DEFAULTS = {
  historyEnabled: false,
  layers: [],
  basemap: 'standard',
  satGroup: 'visual',
  battery: 'smart',
  aircraftRadius: 120,
  showGround: false,
  cloudAI: false,
  cloudWeb: true,
  claudeModel: 'claude-sonnet-5-5',
  onboarded: false,
  lockPin: null
};

export const Settings = {
  v: { ...SETTINGS_DEFAULTS },
  load() {
    try { this.v = { ...SETTINGS_DEFAULTS, ...JSON.parse(localStorage.getItem('smartmap-settings') || '{}') }; } catch { this.v = { ...SETTINGS_DEFAULTS }; }
  },
  set(k, val) {
    this.v[k] = val;
    try { localStorage.setItem('smartmap-settings', JSON.stringify(this.v)); } catch {}
  }
};

export async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
