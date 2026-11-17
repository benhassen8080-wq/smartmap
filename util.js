// Small helpers shared by every module. No external code, no tracking.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape any text that came from the network before putting it in HTML. */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
}

/** Only allow http(s) links coming from data sources. */
export function safeUrl(u) {
  try {
    const url = new URL(String(u).startsWith('http') ? u : 'https://' + u);
    return (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : null;
  } catch { return null; }
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export async function fetchJSON(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

export async function fetchText(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

export function qs(params) {
  return new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
}

const R = 6371008.8;
const rad = d => d * Math.PI / 180;
export function distance(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
export function bearing(a, b) {
  const p1 = rad(a.lat), p2 = rad(b.lat), dl = rad(b.lon - a.lon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
export function relAngle(b, heading) {
  let r = b - heading;
  while (r > 180) r -= 360;
  while (r < -180) r += 360;
  return r;
}

export function fmtDist(m) {
  if (m == null || isNaN(m)) return '—';
  if (m < 1000) return Math.round(m) + ' م';
  if (m < 10000) return (m / 1000).toFixed(1) + ' كم';
  return Math.round(m / 1000) + ' كم';
}
export const fmtTime = d => new Date(d).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit', hour12: false });
export const fmtDateTime = d => new Date(d).toLocaleString('ar', { dateStyle: 'medium', timeStyle: 'short', hour12: false });
export const fmtDate = d => new Date(d).toLocaleDateString('ar', { dateStyle: 'full' });
export function fmtDur(s) {
  const m = Math.round(s / 60);
  return m < 60 ? `${m} د` : `${Math.floor(m / 60)} س ${m % 60} د`;
}
export function relTime(d) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('ar', { numeric: 'auto', style: 'short' });
  if (Math.abs(s) < 60) return rtf.format(-Math.round(s), 'second');
  if (Math.abs(s) < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (Math.abs(s) < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}
export function dms(lat, lon) {
  const f = (v, p, n) => {
    const a = Math.abs(v), d = Math.floor(a), mf = (a - d) * 60, m = Math.floor(mf), s = (mf - m) * 60;
    return `${d}°${String(m).padStart(2, '0')}'${s.toFixed(1)}"${v >= 0 ? p : n}`;
  };
  return f(lat, 'N', 'S') + ' ' + f(lon, 'E', 'W');
}
export const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function toast(msg, ms = 3500) {
  const t = h('div', { class: 'toast', text: msg });
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, ms);
}
