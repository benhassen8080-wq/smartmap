// خريطتي الذكية — main app (PWA). Everything personal stays on this device.
import { $, $$, esc, h, safeUrl, distance, bearing, relAngle, fmtDist, fmtTime, fmtDateTime, fmtDate, fmtDur, relTime, dms, sameDay, debounce, toast, sleep, fetchJSON } from './util.js';
import { History, Emergency, Keys, Settings } from './store.js';
import * as S from './sources.js';
import { rulesFor, flag, CAM_TITLE, sortedCountries } from './laws.js';

Settings.load();

// ───────────────────────── State ─────────────────────────
const st = {
  map: null, baseLayers: [], me: null, meMarker: null, heading: null, cc: null, place: null, lastGeo: null,
  active: new Set(Settings.v.layers || []), items: {}, status: {}, lastRefresh: {}, lastKey: {},
  groups: {}, markers: {}, overlays: {}, weather: null, weatherLoading: false, radar: null,
  zones: [], verdict: null, search: [], local: [], answer: null, selected: null, pinned: null,
  trip: null, sats: [], satGroupLoaded: null, satTrack: null, histDay: null, histLine: null,
  online: navigator.onLine, aiBusy: false, suggestions: [], watchId: null, highAcc: false,
  stay: null, visitId: null, lastTrack: null, wake: null, compassOn: false
};
const country = () => rulesFor(st.cc);

const LAYERS = {
  weather: { title: 'الطقس الذكي (6 نماذج + AI)', icon: '🌦️', group: 'الطقس', src: 'Open-Meteo: ECMWF AIFS (ذكاء اصطناعي)، IFS، DWD ICON، GFS، Météo-France، GEM + جودة الهواء + تحذيرات DWD', interval: 600 },
  radar: { title: 'رادار الأمطار والعواصف', icon: '🌧️', group: 'الطقس', src: 'RainViewer – حيّ كل 10 دقائق', interval: 600 },
  clouds: { title: 'السحب (صور أقمار صناعية)', icon: '☁️', group: 'الطقس', src: 'NASA GIBS – VIIRS يومية', interval: 10800 },
  aircraft: { title: 'الملاحة الجوية الحيّة', icon: '✈️', group: 'الأجواء والفضاء', src: 'adsb.lol / airplanes.live / adsb.fi / OpenSky – ADS-B حيّ', interval: 12, maxKm: 1500 },
  drones: { title: 'مناطق الدرون والقوانين', icon: '🛸', group: 'الأجواء والفضاء', src: 'OpenStreetMap (مطارات، مناطق عسكرية، محميات…) + قوانين الدولة + الرياح', interval: 900, maxKm: 80 },
  satellites: { title: 'الأقمار الصناعية', icon: '🛰️', group: 'الأجواء والفضاء', src: 'CelesTrak (عناصر NORAD الرسمية) + نموذج SGP4 على الجهاز', interval: 7200 },
  marine: { title: 'الملاحة البحرية الحيّة', icon: '🚢', group: 'البحر', src: 'Fintraffic Digitraffic – AIS حيّ (بحر البلطيق وشمال أوروبا)', interval: 60, maxKm: 900 },
  webcams: { title: 'كاميرات مفتوحة المصدر', icon: '📹', group: 'استكشاف', src: 'OpenStreetMap + Windy (مفتاح مجاني اختياري)', interval: 1800, maxKm: 80 },
  culture: { title: 'أنشطة وأماكن ثقافية', icon: '🎭', group: 'استكشاف', src: 'OpenStreetMap – متاحف، مسارح، معارض، مراكز ثقافية', interval: 1800, maxKm: 80 },
  markets: { title: 'أسواق و Flohmarkt', icon: '🛍️', group: 'استكشاف', src: 'OpenStreetMap – أسواق، Flohmarkt، مستعمل', interval: 1800, maxKm: 80 },
  wildlife: { title: 'الحيوانات في المنطقة', icon: '🐾', group: 'استكشاف', src: 'iNaturalist – مشاهدات علمية موثّقة', interval: 3600, maxKm: 220 },
  fires: { title: 'الحرائق النشطة', icon: '🔥', group: 'السلامة والطريق', src: 'NASA EONET + NASA FIRMS (مفتاح اختياري)', interval: 1800 },
  quakes: { title: 'الزلازل (24 ساعة)', icon: '〰️', group: 'السلامة والطريق', src: 'USGS', interval: 600 },
  speedCams: { title: 'رادارات السرعة', icon: '📸', group: 'السلامة والطريق', src: 'OpenStreetMap – تحترم قانون الدولة تلقائياً', interval: 1800, maxKm: 80 },
  emergency: { title: 'الملاجئ ونقاط الطوارئ', icon: '🏥', group: 'السلامة والطريق', src: 'OpenStreetMap – ملاجئ، مستشفيات، شرطة، إطفاء، AED، مياه', interval: 1800, maxKm: 80 }
};
const GROUPS = ['الطقس', 'الأجواء والفضاء', 'البحر', 'استكشاف', 'السلامة والطريق'];

const BASES = {
  standard: { name: 'عادية', make: () => [L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' })] },
  light: { name: 'هادئة', make: () => [L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 20, attribution: '© OpenStreetMap © CARTO' })] },
  satellite: { name: 'قمر صناعي', make: () => [esri()] },
  hybrid: { name: 'هجينة', make: () => [esri(), L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 20, attribution: '© CARTO' })] },
  dark: { name: 'ليلية', make: () => [L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 20, attribution: '© OpenStreetMap © CARTO' })] },
  topo: { name: 'تضاريس', make: () => [L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { subdomains: 'abc', maxZoom: 17, attribution: '© OpenTopoMap © OpenStreetMap' })] }
};
const esri = () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 18, attribution: 'Esri, Maxar, Earthstar' });

// ───────────────────────── Boot ─────────────────────────
async function boot() {
  await new Promise(r => (window.L ? r() : window.addEventListener('load', r)));
  if (!window.L) { document.body.innerHTML = '<p style="padding:30px">تعذّر تحميل مكتبة الخريطة. تحقق من الإنترنت ثم أعد الفتح.</p>'; return; }
  const last = JSON.parse(localStorage.getItem('smartmap-view') || 'null');
  st.map = L.map('map', { zoomControl: false, worldCopyJump: true, attributionControl: true, preferCanvas: false })
    .setView(last ? [last.lat, last.lon] : [52.52, 13.405], last ? last.z : 11);
  setBase(Settings.v.basemap);
  st.map.on('moveend', onMove);
  st.map.on('contextmenu', e => pinPoint(e.latlng.lat, e.latlng.lng));
  for (const k of Object.keys(LAYERS)) { st.groups[k] = L.layerGroup().addTo(st.map); st.markers[k] = new Map(); }
  st.groups.search = L.layerGroup().addTo(st.map); st.markers.search = new Map();
  st.groups.zones = L.layerGroup().addTo(st.map);
  st.groups.hist = L.layerGroup().addTo(st.map);

  await History.load();
  History.listeners.add(() => { if (st.sheetKind === 'history') renderHistory(); });
  wireUI();
  startLocation();
  for (const l of st.active) activateLayer(l, true);
  renderChips();
  setInterval(tick, 3000);
  window.addEventListener('online', () => { st.online = true; renderInfo(); });
  window.addEventListener('offline', () => { st.online = false; renderInfo(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { History.saveNow(); closeStayOnHide(); } else { lockIfNeeded(); tick(); } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!Settings.v.onboarded) onboarding();
  lockIfNeeded();
  buildSuggestions();
}

// ───────────────────────── Map helpers ─────────────────────────
function setBase(key) {
  if (!BASES[key]) key = 'standard';
  st.baseLayers.forEach(l => st.map.removeLayer(l));
  st.baseLayers = BASES[key].make();
  st.baseLayers.forEach((l, i) => { l.addTo(st.map); if (i === 0) l.bringToBack(); });
  Settings.set('basemap', key);
}
const center = () => { const c = st.map.getCenter(); return { lat: c.lat, lon: ((c.lng + 540) % 360) - 180 }; };
const spanKm = () => { const b = st.map.getBounds(); return distance({ lat: b.getSouth(), lon: b.getWest() }, { lat: b.getNorth(), lon: b.getWest() }) / 1000; };
const goTo = (lat, lon, z = 15) => st.map.flyTo([lat, lon], z, { duration: 0.8 });
function fit(pts) {
  if (!pts.length) return;
  if (pts.length === 1) return goTo(pts[0].lat, pts[0].lon, 15);
  st.map.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lon])).pad(0.2), { maxZoom: 16 });
}

const PLANE = 'M12 2c.8 0 1.3.8 1.3 1.8V9l7.7 4.6v2l-7.7-2.3v4.5l2.2 1.7V21L12 20l-3.5 1v-1.5l2.2-1.7v-4.5L3 15.6v-2L10.7 9V3.8C10.7 2.8 11.2 2 12 2z';
function iconFor(it) {
  const k = S.KIND[it.kind] || S.KIND.search;
  if (it.kind === 'aircraft' || it.kind === 'drone' || it.kind === 'vessel') {
    const col = it.emergency ? '#ef4444' : k.color;
    const path = it.kind === 'vessel' ? 'M12 2 L18 21 L12 17 L6 21 Z' : PLANE;
    const size = it.kind === 'vessel' ? 18 : 26;
    return L.divIcon({ className: 'mv', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      html: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="transform:rotate(${Math.round(it.heading || 0)}deg)"><path fill="${col}" stroke="#000" stroke-width=".7" d="${path}"/></svg>` });
  }
  if (it.kind === 'satellite') return L.divIcon({ className: 'mv', iconSize: [22, 22], iconAnchor: [11, 11], html: '<div style="font-size:20px">🛰️</div>' });
  if (it.kind === 'quake') {
    const s = Math.round(14 + (it.mag || 3) * 5);
    return L.divIcon({ className: '', iconSize: [s, s], iconAnchor: [s / 2, s / 2], html: `<div class="mk" style="width:${s}px;height:${s}px;background:${k.color}cc;font-size:11px;color:#fff">${(it.mag || 0).toFixed(1)}</div>` });
  }
  return L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="mk" style="background:${k.color}">${k.icon}</div>` });
}

function renderItems(key, items) {
  const grp = st.groups[key], mk = st.markers[key];
  const seen = new Set();
  for (const it of items.slice(0, 900)) {
    if (it.lat == null || it.lon == null) continue;
    seen.add(it.id);
    const sig = `${it.kind}|${Math.round(it.heading || 0)}|${it.emergency ? 1 : 0}|${it.mag || ''}`;
    let m = mk.get(it.id);
    if (m) {
      m.setLatLng([it.lat, it.lon]);
      if (m._sig !== sig) { m.setIcon(iconFor(it)); m._sig = sig; }
      m._item = it;
    } else {
      m = L.marker([it.lat, it.lon], { icon: iconFor(it), keyboard: false, riseOnHover: true });
      m._sig = sig; m._item = it;
      m.on('click', () => openDetail(m._item));
      m.addTo(grp); mk.set(it.id, m);
    }
  }
  for (const [id, m] of mk) if (!seen.has(id)) { grp.removeLayer(m); mk.delete(id); }
}
const clearLayer = key => { st.groups[key]?.clearLayers(); st.markers[key]?.clear(); };

// ───────────────────────── Layers & scheduler ─────────────────────────
function batteryFactor() {
  let f = Settings.v.battery === 'saver' ? 2.5 : Settings.v.battery === 'performance' ? 0.7 : 1;
  if (navigator.connection?.saveData) f *= 2;
  return f;
}

function toggleLayer(k) {
  if (st.active.has(k)) deactivateLayer(k); else { st.active.add(k); activateLayer(k); History.log('layer', k); }
  Settings.set('layers', [...st.active]);
  renderChips();
  if (st.sheetKind === 'layers') renderLayers();
}
function activateLayer(k, silent) {
  st.active.add(k); st.lastKey[k] = null;
  if (k === 'drones' && !st.weather) loadWeather(center(), false);
  refresh(k);
}
function deactivateLayer(k) {
  st.active.delete(k); st.items[k] = []; st.status[k] = null; clearLayer(k);
  if (st.overlays[k]) { st.map.removeLayer(st.overlays[k]); delete st.overlays[k]; }
  if (k === 'drones') { st.groups.zones.clearLayers(); st.zones = []; st.verdict = null; }
  if (k === 'satellites' && st.satTrack) { st.map.removeLayer(st.satTrack); st.satTrack = null; }
}

function regionKey() {
  const b = st.map.getBounds(); const q = Math.max((b.getNorth() - b.getSouth()) / 3, 0.005);
  return `${Math.round(b.getCenter().lat / q)}_${Math.round(b.getCenter().lng / q)}_${st.map.getZoom()}`;
}

const onMove = debounce(() => {
  const c = st.map.getCenter();
  localStorage.setItem('smartmap-view', JSON.stringify({ lat: c.lat, lon: c.lng, z: st.map.getZoom() }));
  for (const k of st.active) {
    if (['radar', 'clouds', 'quakes', 'satellites'].includes(k)) continue;
    if (k === 'weather') { if (!st.weather || distance(center(), st.weather) > 15000) refresh(k); continue; }
    if (regionKey() !== st.lastKey[k]) refresh(k);
  }
  if (st.active.has('drones')) computeVerdict();
}, 900);

function tick() {
  if (document.hidden || st.locked) return;
  if (st.active.has('satellites')) updateSats();
  const now = Date.now();
  for (const k of st.active) {
    const iv = LAYERS[k].interval * 1000 * batteryFactor();
    if (now - (st.lastRefresh[k] || 0) > iv) refresh(k);
  }
}

function setStatus(k, s) { st.status[k] = s; renderChips(); if (st.sheetKind === 'layers') renderLayers(); }

async function refresh(k) {
  if (!st.active.has(k)) return;
  st.lastRefresh[k] = Date.now();
  const def = LAYERS[k];
  if (def.maxKm && spanKm() > def.maxKm) { setStatus(k, { t: 'zoom' }); clearLayer(k); if (k === 'drones') st.groups.zones.clearLayers(); return; }
  st.lastKey[k] = regionKey();
  if (!(st.items[k] || []).length) setStatus(k, { t: 'load' });
  const b = st.map.getBounds(), c = center();
  try {
    let items = [];
    switch (k) {
      case 'weather': await loadWeather(c, false); break;
      case 'radar': {
        st.radar = await S.radarTemplate();
        if (st.overlays.radar) st.map.removeLayer(st.overlays.radar);
        st.overlays.radar = L.tileLayer(st.radar.url, { opacity: 0.65, maxNativeZoom: 7, maxZoom: 19, zIndex: 400, attribution: 'RainViewer' }).addTo(st.map);
        break;
      }
      case 'clouds':
        if (st.overlays.clouds) st.map.removeLayer(st.overlays.clouds);
        st.overlays.clouds = L.tileLayer(S.cloudTemplate(), { opacity: 0.8, maxNativeZoom: 9, maxZoom: 19, zIndex: 390, attribution: 'NASA GIBS' }).addTo(st.map);
        break;
      case 'aircraft': {
        const r = Math.min(Settings.v.aircraftRadius, Math.max(25, spanKm() / 1.852 * 0.75));
        items = await S.aircraft(c.lat, c.lon, r, Settings.v.showGround); break;
      }
      case 'drones': {
        st.zones = await S.droneZones(b);
        drawZones(); computeVerdict();
        items = st.zones.map(z => ({ id: z.id, kind: 'restriction', lat: z.lat, lon: z.lon, title: z.name, sub: z.reason, link: country().droneMap || z.link,
          lines: [['السبب', z.reason], ['نصف القطر التقريبي', fmtDist(z.radius)], ['المستوى', z.level === 2 ? 'ممنوع دون تصريح' : 'مقيّد / بحذر'], ['المصدر', 'OpenStreetMap – للاسترشاد فقط']] }));
        break;
      }
      case 'satellites': await loadSats(); items = satItems(); break;
      case 'marine':
        if (!S.coversDigitraffic(b)) { setStatus(k, { t: 'key', msg: 'البيانات المجانية الحيّة: بحر البلطيق وشمال أوروبا' }); clearLayer(k); return; }
        items = await S.shipsDigitraffic(b); break;
      case 'webcams': {
        items = await S.osmLayer('webcams', b);
        const wk = await Keys.get('windy');
        if (wk) try { items = items.concat(await S.windyWebcams(c.lat, c.lon, spanKm() / 2, wk)); } catch {}
        break;
      }
      case 'fires': items = await S.fires(b, await Keys.get('firms')); break;
      case 'quakes': items = await S.quakes(); break;
      case 'speedCams':
        if (st.trip?.mode === 'drive' && country().camWarner === 'banned') {
          clearLayer(k); st.items[k] = [];
          setStatus(k, { t: 'key', msg: `مخفية أثناء القيادة – ممنوعة قانونياً في ${country().name}` }); return;
        }
        items = await S.osmLayer('speedCams', b); break;
      case 'wildlife': items = await S.wildlife(c.lat, c.lon, Math.max(2, spanKm() / 2)); break;
      default: items = await S.osmLayer(k, b);
    }
    if (!st.active.has(k)) return;
    st.items[k] = items;
    renderItems(k, items);
    setStatus(k, { t: 'ok', n: ['weather', 'radar', 'clouds'].includes(k) ? null : items.length, at: Date.now() });
  } catch (e) {
    setStatus(k, { t: 'err', msg: navigator.onLine ? (e.message || 'تعذّر التحميل') : 'دون إنترنت' });
  }
}

function statusText(s) {
  if (!s) return '…';
  if (s.t === 'ok') return (s.n != null ? s.n + ' • ' : '') + fmtTime(s.at);
  if (s.t === 'load') return 'تحميل…';
  if (s.t === 'zoom') return 'قرّب الخريطة';
  if (s.t === 'key') return s.msg;
  return 'خطأ: ' + (s.msg || '');
}

// ───────────────────────── Satellites (SGP4 on device) ─────────────────────────
async function loadSats() {
  if (!window.satellite) throw new Error('مكتبة الأقمار غير محمّلة');
  if (st.satGroupLoaded === Settings.v.satGroup && st.sats.length) return;
  const list = await S.satelliteTLE(Settings.v.satGroup);
  st.sats = list.map(t => { try { return { ...t, rec: satellite.twoline2satrec(t.l1, t.l2), norad: t.l1.slice(2, 7).trim() }; } catch { return null; } }).filter(Boolean);
  st.satGroupLoaded = Settings.v.satGroup;
}
function satPos(rec, date = new Date()) {
  const pv = satellite.propagate(rec, date);
  if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
  const gmst = satellite.gstime(date);
  const gd = satellite.eciToGeodetic(pv.position, gmst);
  const v = pv.velocity;
  return { lat: satellite.degreesLat(gd.latitude), lon: satellite.degreesLong(gd.longitude), alt: gd.height, speed: Math.hypot(v.x, v.y, v.z), ecf: satellite.eciToEcf(pv.position, gmst) };
}
function satItems() {
  const now = new Date();
  return st.sats.map(s => {
    const p = satPos(s.rec, now); if (!p) return null;
    const orbit = p.alt < 2000 ? 'مدار منخفض LEO' : p.alt < 30000 ? 'مدار متوسط MEO' : 'مدار ثابت/مرتفع GEO';
    const periodMin = 2 * Math.PI / s.rec.no;
    return { id: 'sat-' + s.norad, kind: 'satellite', lat: p.lat, lon: p.lon, title: s.name, sub: `${Math.round(p.alt)} كم • ${orbit}`, ref: s.norad,
      lines: [['رقم NORAD', s.norad], ['الارتفاع', Math.round(p.alt) + ' كم'], ['السرعة', `${p.speed.toFixed(2)} كم/ث (${Math.round(p.speed * 3600)} كم/س)`],
        ['الميل المداري', (s.rec.inclo * 180 / Math.PI).toFixed(1) + '°'], ['الدورة', periodMin.toFixed(1) + ' دقيقة'], ['نوع المدار', orbit], ['المصدر', 'CelesTrak + SGP4']],
      link: `https://celestrak.org/satcat/table-satcat.php?CATNR=${s.norad}` };
  }).filter(Boolean);
}
function updateSats() {
  if (!st.sats.length || !window.satellite) return;
  st.items.satellites = satItems();
  renderItems('satellites', st.items.satellites);
}
function satTrack(norad) {
  const s = st.sats.find(x => x.norad === norad); if (!s) return;
  if (st.satTrack) st.map.removeLayer(st.satTrack);
  const segs = [[]]; let last = null;
  for (let m = -10; m <= 95; m++) {
    const p = satPos(s.rec, new Date(Date.now() + m * 60000)); if (!p) continue;
    if (last != null && Math.abs(p.lon - last) > 180) segs.push([]);
    segs.at(-1).push([p.lat, p.lon]); last = p.lon;
  }
  st.satTrack = L.polyline(segs, { color: '#2dd4bf', weight: 2, dashArray: '6 4' }).addTo(st.map);
}
function nextPass(norad, obs) {
  const s = st.sats.find(x => x.norad === norad); if (!s) return null;
  const gd = { longitude: satellite.degreesToRadians(obs.lon), latitude: satellite.degreesToRadians(obs.lat), height: 0.05 };
  let t = Date.now(), inPass = false, start, maxE = -90, maxT, end = t + 36 * 3600000;
  while (t < end) {
    const p = satPos(s.rec, new Date(t));
    if (p) {
      const el = satellite.radiansToDegrees(satellite.ecfToLookAngles(gd, p.ecf).elevation);
      if (el >= 10) { if (!inPass) { inPass = true; start = t; } if (el > maxE) { maxE = el; maxT = t; } }
      else if (inPass) return { start, maxT, maxE, end: t };
    }
    t += inPass ? 10000 : 30000;
  }
  return null;
}

// ───────────────────────── Drones ─────────────────────────
function drawZones() {
  st.groups.zones.clearLayers();
  for (const z of st.zones.slice(0, 400)) {
    const col = z.level === 2 ? '#ef4444' : '#f59e0b';
    L.circle([z.lat, z.lon], { radius: z.radius, color: col, weight: 1.5, fillColor: col, fillOpacity: 0.12, interactive: false }).addTo(st.groups.zones);
  }
}
function computeVerdict() {
  const c = center(); const reasons = []; let level = 0;
  for (const z of st.zones) {
    const d = distance(z, c);
    if (d <= z.radius) { level = Math.max(level, z.level); reasons.push(`${z.level === 2 ? '⛔️' : '⚠️'} ${z.reason}: ${z.name} (على بعد ${fmtDist(d)})`); }
  }
  const w = st.weather?.current;
  if (w) {
    if (w.gusts > 35) { level = Math.max(level, 1); reasons.push(`💨 هبّات رياح ${Math.round(w.gusts)} كم/س – خطر فقدان السيطرة`); }
    else if (w.wind > 25) { level = Math.max(level, 1); reasons.push(`💨 رياح ${Math.round(w.wind)} كم/س`); }
    if (st.weather.thunder >= 2) { level = Math.max(level, 1); reasons.push('⚡️ خطر عواصف رعدية'); }
    if (w.precip > 0.2) { level = Math.max(level, 1); reasons.push('🌧 أمطار – أغلب الدرونات غير مقاومة للماء'); }
    if (!w.day) { level = Math.max(level, 1); reasons.push('🌙 ليل – دول كثيرة تقيّد الطيران الليلي'); }
  }
  const r = country();
  if (['TN', 'MA', 'DZ', 'EG'].includes(r.id)) { level = 2; reasons.unshift(`⛔️ الدرونات تتطلب ترخيصاً مسبقاً في ${r.name}`); }
  if (!reasons.length) reasons.push('✅ لا مطارات أو مناطق محظورة قريبة في البيانات المفتوحة.');
  reasons.push(`ℹ️ القرار النهائي للخريطة الرسمية: ${r.droneAuthority}`);
  st.verdict = { level, title: level === 2 ? 'ممنوع هنا دون تصريح' : level === 1 ? 'مسموح بحذر / بشروط' : 'لا قيود معروفة هنا حسب البيانات المفتوحة', reasons };
  if (st.sheetKind === 'drone') renderDrone();
}

// ───────────────────────── Weather ─────────────────────────
async function loadWeather(c, open = true) {
  st.weatherLoading = true;
  if (open) renderWeather();
  try { st.weather = await S.weather(c.lat, c.lon); } catch { st.weather = null; }
  st.weatherLoading = false;
  renderInfo();
  if (st.sheetKind === 'weather') renderWeather();
  if (st.active.has('drones')) computeVerdict();
}

// ───────────────────────── Location, compass, country ─────────────────────────
function startLocation(high = false) {
  if (!('geolocation' in navigator)) return;
  if (st.watchId != null) navigator.geolocation.clearWatch(st.watchId);
  st.highAcc = high;
  st.watchId = navigator.geolocation.watchPosition(onPos, () => {}, { enableHighAccuracy: high || !!st.trip, maximumAge: high ? 0 : 15000, timeout: 30000 });
}
function onPos(p) {
  const first = !st.me;
  const prev = st.me;
  st.me = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude, speed: p.coords.speed, course: p.coords.heading, t: p.timestamp };
  if (st.me.speed == null && prev) { const dt = (st.me.t - prev.t) / 1000; if (dt > 0) st.me.speed = distance(prev, st.me) / dt; }
  if (!st.meMarker) st.meMarker = L.marker([st.me.lat, st.me.lon], { icon: L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html: '<div class="me"></div>' }), zIndexOffset: 1000, interactive: false }).addTo(st.map);
  else st.meMarker.setLatLng([st.me.lat, st.me.lon]);
  if (first && !localStorage.getItem('smartmap-view')) goTo(st.me.lat, st.me.lon, 13);
  if (!st.lastGeo || distance(st.lastGeo, st.me) > 3000) { st.lastGeo = { ...st.me }; detectCountry(); }
  if (st.trip) updateTrip();
  if (Settings.v.historyEnabled) recordHistory();
  if (st.full === 'ar') renderAR();
  if (st.full === 'emergency') drawRadar();
}
async function detectCountry() {
  try {
    const g = await S.reverseGeocode(st.me.lat, st.me.lon);
    const old = st.cc; st.cc = g.cc || st.cc; st.place = g.city || g.country;
    renderInfo();
    if (old && old !== st.cc) {
      showAnswer(`🌍 دخلت ${flag(st.cc)} ${country().name} – تم تحديث القوانين المحلية تلقائياً.`);
      if (st.active.has('speedCams')) refresh('speedCams');
      if (st.active.has('drones')) computeVerdict();
    }
  } catch {}
}
async function enableCompass() {
  if (st.compassOn) return true;
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      if (await DeviceOrientationEvent.requestPermission() !== 'granted') return false;
    }
    const handler = e => {
      let hd = null;
      if (typeof e.webkitCompassHeading === 'number') hd = e.webkitCompassHeading;
      else if (e.absolute && e.alpha != null) hd = (360 - e.alpha) % 360;
      if (hd != null) { st.heading = hd; if (st.full === 'ar') renderAR(); if (st.full === 'emergency') drawRadar(); }
    };
    window.addEventListener('deviceorientationabsolute', handler);
    window.addEventListener('deviceorientation', handler);
    st.compassOn = true; return true;
  } catch { return false; }
}

// ───────────────────────── Private history (on device) ─────────────────────────
const CAT_AR = { restaurant: 'مطعم', cafe: 'مقهى', fast_food: 'وجبات سريعة', bakery: 'مخبز', supermarket: 'سوبرماركت', mall: 'مركز تسوق', clothes: 'ملابس',
  fitness_centre: 'نادي رياضي', sports_centre: 'مركز رياضي', hospital: 'مستشفى', clinic: 'عيادة', doctors: 'طبيب', pharmacy: 'صيدلية', school: 'مدرسة',
  university: 'جامعة', college: 'كلية', park: 'حديقة', museum: 'متحف', theatre: 'مسرح', cinema: 'سينما', library: 'مكتبة', fuel: 'محطة وقود',
  station: 'محطة', bus_stop: 'موقف حافلات', aerodrome: 'مطار', hotel: 'فندق', bank: 'بنك', bar: 'سهر', pub: 'سهر', beach: 'شاطئ', stadium: 'ملعب',
  zoo: 'حديقة حيوان', post_office: 'بريد', place_of_worship: 'دار عبادة', office: 'مكتب', company: 'شركة', house: 'سكن', residential: 'منطقة سكنية', apartments: 'سكن' };

function recordHistory() {
  const me = st.me; if (!me || me.acc > 200) return;
  if (!st.lastTrack || distance(st.lastTrack, me) > 150 || me.t - st.lastTrack.t > 600000) {
    st.lastTrack = { lat: me.lat, lon: me.lon, t: me.t };
    History.mutate(d => d.track.push({ t: me.t, lat: me.lat, lon: me.lon, speed: me.speed || 0 }));
  }
  if (!st.stay || distance(st.stay, me) > 120) {
    finishStay(me.t);
    st.stay = { lat: me.lat, lon: me.lon, start: me.t, last: me.t };
  } else {
    st.stay.last = me.t;
    if (!st.visitId && me.t - st.stay.start > 8 * 60000) openVisit();
  }
}
function openVisit() {
  const s = st.stay; const id = crypto.randomUUID();
  const prev = History.db.visits.at(-1);
  let activity = null, distBefore = null;
  if (prev) {
    distBefore = distance(prev, s);
    const from = prev.departure || prev.arrival; const dt = (s.start - from) / 3600000;
    const kmh = dt > 0 ? distBefore / 1000 / dt : 0;
    activity = kmh > 25 ? 'سيارة / مواصلات' : kmh > 9 ? 'دراجة' : kmh > 2 ? 'مشي' : null;
  }
  History.mutate(d => d.visits.push({ id, arrival: s.start, departure: null, lat: s.lat, lon: s.lon, activityBefore: activity, distanceBefore: distBefore }));
  st.visitId = id;
  S.reverseGeocode(s.lat, s.lon).then(g => History.mutate(d => {
    const v = d.visits.find(x => x.id === id); if (!v) return;
    v.name = g.name || g.city; v.category = g.type; v.categoryAr = CAT_AR[g.type] || null;
  })).catch(() => {});
}
function finishStay(t) {
  if (st.visitId) { const id = st.visitId; History.mutate(d => { const v = d.visits.find(x => x.id === id); if (v) v.departure = st.stay?.last || t; }); }
  st.visitId = null;
}
function closeStayOnHide() { /* keep the open visit; departure is set when we next see the user elsewhere */ }

function clusters() {
  const out = [];
  for (const v of History.db.visits) {
    let c = out.find(x => distance(x, v) < 150);
    if (!c) { c = { id: out.length, lat: v.lat, lon: v.lon, visits: [], names: {} }; out.push(c); }
    c.visits.push(v); if (v.name) c.names[v.name] = (c.names[v.name] || 0) + 1;
  }
  const dur = v => (v.departure || v.arrival) - v.arrival;
  for (const c of out) {
    c.name = Object.entries(c.names).sort((a, b) => b[1] - a[1])[0]?.[0] || 'مكان';
    c.total = c.visits.reduce((a, v) => a + dur(v), 0);
    c.cat = c.visits.find(v => v.categoryAr)?.categoryAr;
    c.night = c.visits.reduce((a, v) => { const hh = new Date(v.arrival).getHours(); return a + ((hh >= 19 || hh < 5) ? dur(v) : 0); }, 0);
    c.work = c.visits.reduce((a, v) => { const d = new Date(v.arrival); const wd = d.getDay(); return a + ((wd >= 1 && wd <= 5 && d.getHours() >= 6 && d.getHours() <= 12) ? dur(v) : 0); }, 0);
  }
  const home = out.slice().sort((a, b) => b.night - a.night)[0];
  if (home && home.night > 4 * 3600000) home.label = 'المنزل';
  const work = out.filter(c => !c.label).sort((a, b) => b.work - a.work)[0];
  if (work && work.work > 6 * 3600000) work.label = 'العمل / الدراسة';
  return out.sort((a, b) => b.visits.length - a.visits.length);
}
function predict(cl, now = new Date()) {
  const hh = now.getHours(), we = [0, 6].includes(now.getDay());
  let best = null;
  for (const c of cl) {
    const n = c.visits.filter(v => { const d = new Date(v.arrival); return [0, 6].includes(d.getDay()) === we && d.getHours() >= hh && d.getHours() <= hh + 2; }).length;
    if (n >= 3 && n > (best?.n || 0)) best = { c, n };
  }
  return best;
}
function guess(v, label) {
  const hh = new Date(v.arrival).getHours(); const mins = ((v.departure || v.arrival) - v.arrival) / 60000;
  if (label === 'المنزل') return (hh >= 19 || hh < 6) ? 'راحة / نوم في المنزل' : 'وقت في المنزل';
  if (label?.startsWith('العمل')) return 'عمل أو دراسة';
  switch (v.category) {
    case 'restaurant': case 'fast_food': return (hh >= 11 && hh <= 14) ? 'غداء على الأرجح' : hh >= 18 ? 'عشاء على الأرجح' : 'وجبة';
    case 'cafe': case 'bakery': return 'قهوة / استراحة';
    case 'supermarket': case 'mall': case 'clothes': return 'تسوّق';
    case 'fitness_centre': case 'sports_centre': return 'تمرين رياضي';
    case 'park': case 'beach': return 'نزهة / استرخاء';
    case 'hospital': case 'clinic': case 'doctors': case 'pharmacy': return 'موعد صحي أو دواء';
    case 'museum': case 'theatre': case 'cinema': return 'نشاط ثقافي / ترفيه';
    case 'fuel': return 'تزوّد بالوقود';
    case 'place_of_worship': return 'عبادة';
    case 'school': case 'university': case 'college': return 'دراسة';
  }
  return mins < 15 ? 'توقّف قصير' : mins > 240 ? 'إقامة طويلة' : 'زيارة';
}
function dayStory(day) {
  const cl = clusters(); const d = History.db; const items = [];
  const vis = d.visits.filter(v => sameDay(v.arrival, day)).sort((a, b) => a.arrival - b.arrival);
  for (const v of vis) {
    const label = cl.find(c => c.visits.includes(v))?.label;
    if (v.activityBefore) items.push({ t: v.arrival - 60000, icon: v.activityBefore.startsWith('سيارة') ? '🚗' : v.activityBefore === 'دراجة' ? '🚲' : '🚶', title: `تنقّل: ${v.activityBefore}${v.distanceBefore ? ' (~' + fmtDist(v.distanceBefore) + ')' : ''}`, detail: 'مستنتج من سرعة تنقّلك' });
    let det = 'وصول ' + fmtTime(v.arrival); if (v.departure) det += ' • مغادرة ' + fmtTime(v.departure) + ' • ' + fmtDur((v.departure - v.arrival) / 1000);
    if (v.categoryAr) det += ' • ' + v.categoryAr;
    items.push({ t: v.arrival, icon: label === 'المنزل' ? '🏠' : '📍', title: `${label || v.name || 'مكان غير مسمّى'} – ${guess(v, label)}`, detail: det, lat: v.lat, lon: v.lon });
  }
  for (const t of d.trips.filter(t => sameDay(t.start, day)))
    items.push({ t: t.start, icon: TRIP[t.mode]?.icon || '🧭', title: `رحلة ${TRIP[t.mode]?.name || ''} مسجّلة: ${fmtDist(t.distance)}`, detail: `المدة ${fmtDur((t.end - t.start) / 1000)} • أقصى ${Math.round(t.max * 3.6)} كم/س`, lat: t.pts[0]?.lat, lon: t.pts[0]?.lon });
  for (const u of d.usage.filter(u => u.kind === 'search' && sameDay(u.t, day)).slice(-10)) items.push({ t: u.t, icon: '🔎', title: 'بحثت عن: ' + u.value, detail: '' });
  return items.sort((a, b) => a.t - b.t);
}
function routineLines(cl) {
  const out = []; const names = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  for (const c of cl.slice(0, 6)) {
    if (c.visits.length < 3) continue;
    const wk = c.visits.filter(v => { const wd = new Date(v.arrival).getDay(); return wd >= 1 && wd <= 5; }).map(v => { const d = new Date(v.arrival); return d.getHours() * 60 + d.getMinutes(); }).sort((a, b) => a - b);
    if (wk.length >= 3) { const m = wk[Math.floor(wk.length / 2)]; out.push(`أيام الأسبوع: تصل إلى «${c.label || c.name}» عادة حوالي ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}.`); }
    const days = Array(7).fill(0); c.visits.forEach(v => days[new Date(v.arrival).getDay()]++);
    const mx = Math.max(...days); if (mx >= 3) out.push(`أكثر يوم تزور فيه «${c.label || c.name}»: ${names[days.indexOf(mx)]}.`);
  }
  return out;
}
function topLayers(hour) {
  const cnt = {};
  for (const u of History.db.usage) if (u.kind === 'layer' && (hour == null || Math.abs(new Date(u.t).getHours() - hour) <= 2)) cnt[u.value] = (cnt[u.value] || 0) + 1;
  return Object.entries(cnt).sort((a, b) => b[1] - a[1]);
}
function topSearches() {
  const cnt = {}; for (const u of History.db.usage) if (u.kind === 'search') cnt[u.value.toLowerCase()] = (cnt[u.value.toLowerCase()] || 0) + 1;
  return Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 4).map(x => x[0]);
}
function showHistoryDay(day) {
  st.histDay = day; st.groups.hist.clearLayers();
  if (!day) return;
  const pts = [...History.db.track.filter(p => sameDay(p.t, day)), ...History.db.visits.filter(v => sameDay(v.arrival, day)).map(v => ({ ...v, t: v.arrival })),
    ...History.db.trips.filter(t => sameDay(t.start, day)).flatMap(t => t.pts)].sort((a, b) => a.t - b.t);
  if (pts.length > 1) L.polyline(pts.map(p => [p.lat, p.lon]), { color: '#a855f7', weight: 4 }).addTo(st.groups.hist);
  for (const v of History.db.visits.filter(v => sameDay(v.arrival, day))) {
    const it = { id: 'visit-' + v.id, kind: 'visit', lat: v.lat, lon: v.lon, title: v.name || 'زيارة', sub: fmtTime(v.arrival) + (v.departure ? ' – ' + fmtTime(v.departure) : ''),
      lines: [['الوصول', fmtDateTime(v.arrival)], ['المغادرة', v.departure ? fmtDateTime(v.departure) : 'ما زلت هنا'], ['النشاط المستنتج', guess(v)]] };
    L.marker([v.lat, v.lon], { icon: iconFor(it) }).on('click', () => openDetail(it)).addTo(st.groups.hist);
  }
  if (pts.length) fit(pts);
}

// ───────────────────────── AI search ─────────────────────────
const LAYER_WORDS = [
  ['radar', ['رادار المطر', 'رادار الطقس', 'regenradar', 'rain radar']], ['clouds', ['سحب', 'غيوم', 'wolken', 'clouds']],
  ['weather', ['طقس', 'الطقس', 'مطر', 'رعد', 'برق', 'عاصفة', 'wetter', 'gewitter', 'weather', 'storm']],
  ['drones', ['درون', 'مسيرة', 'مسيّرة', 'drone', 'drohne']], ['aircraft', ['طائرات', 'الطائرات', 'رحلات', 'طيران', 'flugzeug', 'flights', 'aircraft', 'planes']],
  ['satellites', ['قمر صناعي', 'أقمار', 'الأقمار', 'satellit', 'satellite', 'iss', 'ستارلينك', 'starlink']], ['marine', ['سفن', 'سفينة', 'بحرية', 'schiff', 'ships', 'ais']],
  ['webcams', ['كاميرا', 'كاميرات', 'webcam']], ['fires', ['حريق', 'حرائق', 'waldbrand', 'wildfire', 'fires']], ['quakes', ['زلزال', 'زلازل', 'erdbeben', 'earthquake']],
  ['speedCams', ['رادار سرعة', 'رادارات', 'blitzer', 'speed camera']], ['wildlife', ['حيوان', 'حيوانات', 'tiere', 'wildlife', 'animals']],
  ['culture', ['ثقافة', 'ثقافية', 'متحف', 'متاحف', 'مسرح', 'kultur', 'museum', 'theater', 'culture']], ['markets', ['flohmarkt', 'سوق', 'أسواق', 'flea market', 'trödel']],
  ['emergency', ['ملجأ', 'ملاجئ', 'طوارئ', 'استغاثة', 'notfall', 'shelter', 'emergency', 'schutzraum']]
];
const CATS = [
  [['مطعم', 'مطاعم', 'restaurant', 'essen'], ['["amenity"="restaurant"]']], [['مقهى', 'قهوة', 'كافيه', 'cafe', 'café', 'kaffee'], ['["amenity"="cafe"]']],
  [['صيدلية', 'صيدليات', 'apotheke', 'pharmacy'], ['["amenity"="pharmacy"]']], [['مستشفى', 'krankenhaus', 'hospital'], ['["amenity"="hospital"]']],
  [['طبيب', 'arzt', 'doctor'], ['["amenity"="doctors"]']], [['سوبرماركت', 'بقالة', 'supermarkt', 'supermarket'], ['["shop"="supermarket"]']],
  [['محطة وقود', 'بنزين', 'tankstelle', 'gas station', 'fuel'], ['["amenity"="fuel"]']], [['شحن', 'ladestation', 'charging'], ['["amenity"="charging_station"]']],
  [['صراف', 'atm', 'geldautomat'], ['["amenity"="atm"]']], [['بنك', 'bank'], ['["amenity"="bank"]']], [['فندق', 'hotel'], ['["tourism"="hotel"]']],
  [['موقف', 'parkplatz', 'parking'], ['["amenity"="parking"]']], [['حمام', 'مرحاض', 'toilette', 'toilet'], ['["amenity"="toilets"]']],
  [['حديقة', 'حدائق', 'park'], ['["leisure"="park"]']], [['ملعب أطفال', 'spielplatz', 'playground'], ['["leisure"="playground"]']],
  [['مسجد', 'مساجد', 'moschee', 'mosque'], ['["amenity"="place_of_worship"]["religion"="muslim"]']], [['كنيسة', 'kirche', 'church'], ['["amenity"="place_of_worship"]["religion"="christian"]']],
  [['مخبز', 'bäckerei', 'bakery'], ['["shop"="bakery"]']], [['نادي رياضي', 'جيم', 'fitness', 'gym'], ['["leisure"="fitness_centre"]']],
  [['حلال', 'halal'], ['["diet:halal"~"yes|only"]', '["cuisine"~"kebab|turkish|arab|lebanese"]']], [['كباب', 'شاورما', 'döner', 'doner', 'kebab'], ['["cuisine"~"kebab|shawarma"]']],
  [['بيتزا', 'pizza'], ['["cuisine"~"pizza"]']], [['محطة قطار', 'bahnhof', 'train station'], ['["railway"="station"]']],
  [['شاطئ', 'strand', 'beach'], ['["natural"="beach"]']], [['منظر', 'إطلالة', 'aussicht', 'viewpoint'], ['["tourism"="viewpoint"]']],
  [['سينما', 'kino', 'cinema'], ['["amenity"="cinema"]']], [['مكتبة', 'bibliothek', 'library'], ['["amenity"="library"]']], [['بريد', 'post'], ['["amenity"="post_office"]']],
  [['شرطة', 'polizei', 'police'], ['["amenity"="police"]']], [['مدرسة', 'schule', 'school'], ['["amenity"="school"]']]
];
function ruleIntent(raw) {
  const t = raw.toLowerCase().trim(); const words = t.split(/\s+/).length;
  const wantsShow = ['اعرض', 'أظهر', 'اظهر', 'شغل', 'شغّل', 'فعل', 'فعّل', 'طبقة', 'zeige', 'show', 'layer'].some(w => t.includes(w));
  for (const [layer, ws] of LAYER_WORDS) if (ws.some(w => t.includes(w)) && (wantsShow || (words <= 4 && !['markets', 'culture'].includes(layer)))) return { action: 'layer', layer };
  for (const p of ['اذهب إلى ', 'اذهب الى ', 'خذني إلى ', 'انتقل إلى ', 'go to ', 'gehe zu ']) if (t.startsWith(p)) return { action: 'goto', place: raw.slice(p.length) };
  for (const sep of [' في ', ' قرب ', ' بالقرب من ', ' in ', ' near ', ' bei ']) { const i = t.indexOf(sep); if (i > 0) return { action: 'search', query: raw.slice(0, i), place: raw.slice(i + sep.length) }; }
  if (['?', '؟', 'ما ', 'ماذا', 'كيف', 'لماذا', 'هل ', 'متى', 'what', 'how', 'why', 'wie ', 'was '].some(w => t.includes(w)) && words > 3) return { action: 'question', query: raw };
  return { action: 'search', query: raw };
}
const catFor = q => { const t = q.toLowerCase(); return CATS.find(([ws]) => ws.some(w => t.includes(w)))?.[1] || null; };

async function claude(system, prompt, web) {
  const key = await Keys.get('claude');
  if (!Settings.v.cloudAI || !key) return null;
  const body = { model: Settings.v.claudeModel, max_tokens: 1200, system, messages: [{ role: 'user', content: prompt }] };
  if (web) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }];
  const j = await fetchJSON('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify(body) }, 60000);
  return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n') || null;
}
function mapContext() {
  const r = country(); const c = center();
  let s = `الدولة: ${r.name}. المدينة: ${st.place || 'غير معروفة'}. مركز الخريطة: ${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}. الوقت: ${fmtDateTime(Date.now())}.`;
  if (st.weather) s += ' الطقس: ' + st.weather.summary;
  const act = [...st.active].map(k => `${LAYERS[k].title}: ${(st.items[k] || []).length}`).join('، '); if (act) s += ' الطبقات: ' + act + '.';
  const names = Object.values(st.items).flat().slice(0, 25).map(i => (S.KIND[i.kind]?.name || '') + ' ' + i.title).join('؛ '); if (names) s += ' عناصر ظاهرة: ' + names + '.';
  return s;
}

async function search(raw) {
  const text = raw.trim(); if (!text) return;
  st.aiBusy = true; $('#searchIcon').classList.add('busy'); st.local = []; History.log('search', text);
  try {
    const lower = text.toLowerCase();
    const local = Object.values(st.items).flat().filter(i => (i.title || '').toLowerCase().includes(lower) || (i.ref || '').toLowerCase() === lower);
    let intent = ruleIntent(text);
    if (intent.action !== 'layer' && Settings.v.cloudAI) {
      try {
        const raw2 = await claude('Return ONLY compact JSON {"action":"search|layer|goto|question","query":"","place":"","layer":""}. Layers: ' + Object.keys(LAYERS).join(', ') + '. Keep query in the user language.', text, false);
        const m = raw2?.match(/\{[\s\S]*\}/); if (m) { const j = JSON.parse(m[0]); if (['search', 'layer', 'goto', 'question'].includes(j.action)) intent = j; }
      } catch {}
    }
    if (intent.action === 'layer' && LAYERS[intent.layer]) {
      if (!st.active.has(intent.layer)) toggleLayer(intent.layer);
      showAnswer('✅ تم تفعيل: ' + LAYERS[intent.layer].title);
      if (intent.layer === 'weather') openWeather(); if (intent.layer === 'drones') openDrone();
      return;
    }
    if (intent.action === 'goto') { if (await geocodeGo(intent.place || text)) return; }
    if (intent.action === 'question') {
      let a = null;
      try { a = await claude('أنت مساعد خرائط ذكي داخل تطبيق خاص. أجب بالعربية بإيجاز ودقة، واذكر المصادر عند البحث. لا تخترع معلومات عن القوانين أو السلامة.', 'سياق الخريطة:\n' + mapContext() + '\n\nالسؤال: ' + text, Settings.v.cloudWeb); } catch {}
      if (!a) a = offlineAnswer(text);
      showAnswer(a, true);
      if (!intent.place) { openSearch(); return; }
    }
    if (local.length && intent.action !== 'question') {
      st.local = local; showSearchResults([]); fit(local.slice(0, 30));
      showAnswer(`وجدت ${local.length} عنصراً على الخريطة يطابق «${text}».`); openSearch(); return;
    }
    let bounds = st.map.getBounds(); let placeLabel = '';
    const q = intent.query || text;
    if (intent.place) {
      const g = (await S.photon(intent.place, center().lat, center().lon, 1))[0];
      if (g) { placeLabel = g.title; bounds = L.latLngBounds([g.lat - 0.08, g.lon - 0.12], [g.lat + 0.08, g.lon + 0.12]); }
    } else if (spanKm() > 30) {
      const c = center(); bounds = L.latLngBounds([c.lat - 0.1, c.lon - 0.15], [c.lat + 0.1, c.lon + 0.15]);
    }
    let results = [];
    const cat = catFor(q);
    if (cat) { try { results = await S.osmCategory(cat, bounds); } catch {} }
    if (!results.length) { const c = bounds.getCenter(); results = await S.photon(intent.place ? `${q} ${intent.place}` : q, c.lat, c.lng, 25); }
    if (!results.length) { if (!(await geocodeGo(text))) showAnswer(`لم أجد نتائج لـ «${text}». جرّب صياغة أخرى أو اسم مدينة.`); return; }
    if (st.me) results.sort((a, b) => distance(st.me, a) - distance(st.me, b));
    showSearchResults(results);
    fit(results.slice(0, 40));
    if (intent.action !== 'question') showAnswer(`🔎 ${results.length} نتيجة لـ «${q}»${placeLabel ? ' في ' + placeLabel : ''}`);
    openSearch();
  } catch (e) {
    showAnswer(navigator.onLine ? 'حدث خطأ أثناء البحث. حاول مرة أخرى.' : 'لا يوجد اتصال بالإنترنت. خريطة الطوارئ تعمل دون إنترنت.');
  } finally { st.aiBusy = false; $('#searchIcon').classList.remove('busy'); }
}
function offlineAnswer(q) {
  const t = q.toLowerCase(); const r = country();
  if (/درون|drone|drohne/.test(t)) { computeVerdict(); return `حسب البيانات المتاحة لمركز الخريطة: ${st.verdict?.title || '—'}. قواعد ${r.name}: ${r.drone.slice(0, 2).join(' ')} (فعّل طبقة الدرون للتفاصيل)`; }
  if (/سرعة|speed|radar|رادار|blitzer/.test(t)) return `في ${r.flag || flag(r.id)} ${r.name}: ${r.speed}. تنبيهات الرادار: ${CAM_TITLE[r.camWarner]}. ${r.camNote}`;
  if (/كحول|alcohol|promille/.test(t)) return `حد الكحول في ${r.name}: ${r.alcohol}`;
  if (/طوارئ|emergency|notruf|رقم/.test(t)) return `رقم الطوارئ في ${r.name}: ${r.emergency}. ${r.numbers.map(n => n.label + ' ' + n.value).join(' • ')}`;
  if (/طقس|مطر|weather|wetter/.test(t) && st.weather) return st.weather.summary;
  return 'للإجابة على الأسئلة الحرة فعّل «الذكاء السحابي» في الإعدادات (مفتاح Claude). بحثت لك في الخريطة بدلاً من ذلك.';
}
async function geocodeGo(q) {
  try {
    const g = (await S.photon(q, center().lat, center().lon, 1))[0]; if (!g) return false;
    if (g.extent) st.map.fitBounds([[g.extent[3], g.extent[0]], [g.extent[1], g.extent[2]]]); else goTo(g.lat, g.lon, ['city', 'country', 'state'].includes(g.placeType) ? 11 : 15);
    showAnswer('📍 ' + g.title + (g.sub ? ' – ' + g.sub : '')); return true;
  } catch { return false; }
}
function showSearchResults(results) {
  st.search = results; clearLayer('search');
  renderItems('search', results);
}
function showAnswer(text, rich = false) {
  st.answer = text;
  const box = $('#answer'); box.replaceChildren(h('span', { text: '✨' }), h('div', { style: 'flex:1;white-space:pre-wrap', text }), h('button', { class: 'x', text: '✕', onclick: () => { box.classList.add('hidden'); st.answer = null; } }));
  box.classList.remove('hidden');
  $('#qClear').classList.remove('hidden');
}

// ───────────────────────── Sheets ─────────────────────────
function openSheet(kind, title, tall = false) {
  st.sheetKind = kind;
  $('#sheetTitle').textContent = title;
  $('#sheet').classList.toggle('tall', tall);
  $('#sheet').classList.remove('hidden');
  $('#sheet').scrollTop = 0;
  return $('#sheetBody');
}
function closeSheet() {
  $('#sheet').classList.add('hidden'); st.sheetKind = null;
  if (st.satTrack && st.selected?.kind === 'satellite') { st.map.removeLayer(st.satTrack); st.satTrack = null; }
}
function openFull(kind, title, node) {
  st.full = kind; $('#fullTitle').textContent = title; $('#fullBody').replaceChildren(node); $('#full').classList.remove('hidden');
}
function closeFull() {
  const k = st.full; st.full = null; $('#full').classList.add('hidden'); $('#fullBody').replaceChildren();
  if (k === 'emergency') stopSOS();
}
const sec = (title, ...kids) => h('div', { class: 'sec' }, title ? h('h3', { text: title }) : null, ...kids);
const row = (l, v) => h('div', { class: 'row' }, h('span', { class: 'l', text: l }), h('span', { class: 'v', text: v ?? '—' }));
const muted = t => h('p', { class: 'muted', text: t });
const btn = (label, onclick, cls = 'btn') => h('button', { class: cls, onclick, text: label });
const linkBtn = (label, href) => { const u = safeUrl(href); return u ? h('a', { class: 'btn', href: u, target: '_blank', rel: 'noopener noreferrer', text: label }) : null; };
function toggleRow(title, sub, checked, onchange) {
  const inp = h('input', { type: 'checkbox' }); inp.checked = !!checked; inp.addEventListener('change', () => onchange(inp.checked, inp));
  return h('label', { class: 'toggle' }, h('div', { class: 't' }, title, sub ? h('small', { text: sub }) : null), h('span', { class: 'sw' }, inp, h('span')));
}
function seg(options, value, onpick) {
  return h('div', { class: 'seg' }, options.map(([v, label]) => h('button', { class: v === value ? 'on' : '', text: label, onclick: () => onpick(v) })));
}

// Layers
function renderLayers() {
  const body = $('#sheetBody');
  const nodes = [sec('نمط الخريطة', seg(Object.entries(BASES).map(([k, b]) => [k, b.name]), Settings.v.basemap, k => { setBase(k); renderLayers(); }))];
  for (const g of GROUPS) {
    nodes.push(sec(g, ...Object.entries(LAYERS).filter(([, d]) => d.group === g).map(([k, d]) => {
      const on = st.active.has(k);
      return h('div', {}, toggleRow(`${d.icon} ${d.title}`, on ? statusText(st.status[k]) : d.src, on, () => toggleLayer(k)));
    })));
  }
  nodes.push(muted('كل البيانات حيّة من مصادر مجانية وموثوقة وتتحدث تلقائياً. الطبقات المحلية (رادارات، كاميرات، أسواق…) تحتاج تقريب الخريطة. اضغط مطوّلاً على الخريطة لاختيار أي نقطة.'));
  body.replaceChildren(...nodes);
}
const openLayers = () => { openSheet('layers', 'طبقات الخريطة', true); renderLayers(); };

// Weather
function renderWeather() {
  const body = $('#sheetBody'); const w = st.weather; const nodes = [];
  nodes.push(h('div', { class: 'btns' }, ['weather', 'radar', 'clouds'].map(k => h('button', { class: 'btn', style: st.active.has(k) ? 'background:#3b82f6;color:#fff' : '', text: `${LAYERS[k].icon} ${k === 'weather' ? 'التوقعات' : k === 'radar' ? 'الرادار' : 'السحب'}`, onclick: () => { toggleLayer(k); renderWeather(); } }))));
  if (st.weatherLoading && !w) nodes.push(muted('جارٍ مقارنة النماذج…'));
  else if (!w) nodes.push(btn('تحميل الطقس لمركز الخريطة', () => loadWeather(center()), 'primary'));
  else {
    const c = w.current;
    if (c) nodes.push(h('div', { style: 'display:flex;align-items:center;gap:14px' }, h('div', { style: 'font-size:56px', text: S.wIcon(c.code, c.day) }),
      h('div', {}, h('div', { class: 'big', text: Math.round(c.temp) + '°' }), h('div', { text: S.wDesc(c.code) }), muted(`الإحساس ${Math.round(c.feels)}° • رياح ${Math.round(c.wind)} كم/س • هبّات ${Math.round(c.gusts)} • رطوبة ${Math.round(c.hum)}% • سحب ${Math.round(c.cloud)}%`))));
    const bar = h('div', { class: 'bar' }, h('i', { style: `width:${w.confidence}%;background:${w.confidence > 75 ? '#22c55e' : w.confidence > 50 ? '#f59e0b' : '#ef4444'}` }));
    nodes.push(sec('✨ خلاصة الذكاء الاصطناعي', h('p', { text: w.summary }), bar, muted('الثقة تُحسب من مدى اتفاق النماذج المستقلة. كلما اتفقت النماذج زادت المصداقية.')));
    if (w.thunder > 0) nodes.push(sec('⛈️ الرعد والبرق', h('p', { text: ['', 'احتمال ضعيف', 'احتمال متوسط لعواصف رعدية', 'خطر مرتفع لعواصف رعدية وبرق'][w.thunder] }), muted('مستنتج من رموز العواصف وطاقة الحمل الحراري CAPE ومؤشر البرق خلال 12 ساعة. شغّل الرادار لمتابعة العاصفة مباشرة.')));
    if (w.alerts.length) nodes.push(sec('⚠️ تحذيرات رسمية (DWD)', ...w.alerts.map(a => h('div', {}, h('b', { text: a.head }), muted(a.desc.slice(0, 300))))));
    nodes.push(sec('🕐 الـ 24 ساعة القادمة (مزيج النماذج)', h('div', { class: 'hours' }, w.blend.map(x => h('div', {}, fmtTime(x.t), h('div', { style: 'font-size:20px', text: S.wIcon(x.code) }), h('b', { text: Math.round(x.temp) + '°' }), h('span', { style: 'color:#60a5fa', text: x.precip > 0.05 ? x.precip.toFixed(1) : '–' }), h('div', { class: 'muted', text: '±' + x.spread.toFixed(1) }))))));
    nodes.push(sec('🧠 مقارنة النماذج (6 ساعات)', ...w.models.map(m => {
      const idx = m.t.map((t, i) => [t, i]).filter(([t]) => t >= Date.now() - 1800000 && t <= Date.now() + 6 * 3600000).map(([, i]) => i);
      const temps = idx.map(i => m.temp[i]).filter(v => v != null); const rain = idx.reduce((a, i) => a + (m.precip[i] || 0), 0);
      return row((m.ai ? '🧠 ' : '') + m.name, temps.length ? `${Math.round(Math.min(...temps))}°–${Math.round(Math.max(...temps))}° • ${rain.toFixed(1)} مم` : '—');
    }), muted('AIFS هو نموذج الذكاء الاصطناعي التشغيلي لدى المركز الأوروبي ECMWF.')));
    nodes.push(sec('🌫️ جودة الهواء', row('المؤشر الأوروبي', S.aqiText(w.aqi)), row('PM2.5', w.pm25 != null ? w.pm25.toFixed(1) + ' µg/m³' : '—'), row('PM10', w.pm10 != null ? w.pm10.toFixed(1) + ' µg/m³' : '—')));
    nodes.push(btn('تحديث لمركز الخريطة', () => loadWeather(center())));
    nodes.push(muted(`المصادر: Open-Meteo (ECMWF، DWD، NOAA، Météo-France، GEM) • Bright Sky/DWD • RainViewer • NASA GIBS. آخر تحديث ${fmtTime(w.fetched)}.`));
  }
  body.replaceChildren(...nodes);
}
const openWeather = () => { openSheet('weather', '🌦️ الطقس الذكي', true); renderWeather(); if (!st.weather && !st.weatherLoading) loadWeather(center()); };

// Laws
function renderLaws(code) {
  const r = rulesFor(code ?? st.cc);
  const sel = h('select', { onchange: e => renderLaws(e.target.value || null) }, h('option', { value: '', text: 'دولتي الحالية' }), sortedCountries().map(c => h('option', { value: c.id, text: `${flag(c.id)} ${c.name}` })));
  if (code) sel.value = code;
  $('#sheetTitle').textContent = `قوانين ${flag(r.id)} ${r.name}`;
  $('#sheetBody').replaceChildren(
    muted(code ? 'عرض دولة أخرى' : (st.cc ? 'تتغيّر تلقائياً حسب الدولة التي توجد فيها.' : 'لم يتم تحديد دولتك بعد (اسمح بالموقع).')), sel,
    sec('📞 أرقام الطوارئ', row('الطوارئ', r.emergency), ...r.numbers.map(n => row(n.label, n.value))),
    sec('🚗 القيادة', row('حدود السرعة', r.speed), row('الكحول', r.alcohol), row('تنبيهات الرادار', CAM_TITLE[r.camWarner]), muted(r.camNote), ...r.notes.map(n => h('p', { text: '• ' + n }))),
    sec('🛸 الدرونات', ...r.drone.map(d => h('p', { text: '• ' + d })), row('الجهة المختصة', r.droneAuthority), r.droneMap ? linkBtn('الخريطة / البوابة الرسمية ↗', r.droneMap) : null),
    muted('⚠️ ملخّص إرشادي (مراجعة 2026) وليس استشارة قانونية. القوانين تتغيّر – تحقق دائماً من المصدر الرسمي.'));
}
const openLaws = () => { openSheet('laws', 'القوانين', true); renderLaws(null); };

// Drone
function renderDrone() {
  const v = st.verdict; const r = country(); const nodes = [];
  if (!st.active.has('drones')) nodes.push(btn('تفعيل طبقة الدرون', () => { toggleLayer('drones'); renderDrone(); }, 'primary'));
  if (v) {
    nodes.push(h('div', { class: 'verdict' }, h('span', { class: 'e', text: v.level === 2 ? '⛔️' : v.level === 1 ? '⚠️' : '✅' }), h('div', {}, v.title, muted('لمركز الخريطة الحالي'))));
    nodes.push(sec('الأسباب', ...v.reasons.map(x => h('p', { text: x }))));
  } else if (st.active.has('drones')) nodes.push(muted(statusText(st.status.drones)));
  const adsbDrones = (st.items.aircraft || []).filter(i => i.kind === 'drone');
  nodes.push(sec('🛸 درونات تبث ADS-B قريبة', adsbDrones.length ? h('div', {}, adsbDrones.map(d => listItem(d))) : muted('لا يوجد حالياً. (التقاط Remote ID عبر البلوتوث غير متاح في متصفح iPhone.)')));
  nodes.push(sec(`📜 قواعد ${flag(r.id)} ${r.name}`, ...r.drone.map(d => h('p', { text: '• ' + d })), r.droneMap ? linkBtn('افتح الخريطة الرسمية للدرون ↗', r.droneMap) : null));
  nodes.push(sec('🎨 دليل الألوان', h('p', { text: '🔴 أحمر: ممنوع دون تصريح (مطارات، عسكري، سجون، منشآت حساسة)' }), h('p', { text: '🟠 برتقالي: مقيّد / بحذر (محميات، مستشفيات، مهابط)' }), muted('الدوائر تقريبية من OpenStreetMap ولا تغني عن الخرائط الرسمية.')));
  $('#sheetBody').replaceChildren(...nodes);
}
const openDrone = () => { openSheet('drone', '🛸 هل يمكنني الطيران هنا؟', true); computeVerdict(); renderDrone(); };

// Detail
function listItem(it, onclick) {
  const k = S.KIND[it.kind] || S.KIND.search;
  const d = st.me ? fmtDist(distance(st.me, it)) : '';
  return h('button', { class: 'list-item', onclick: onclick || (() => { goTo(it.lat, it.lon, Math.max(st.map.getZoom(), 14)); openDetail(it); }) },
    h('span', { class: 'ic', text: k.icon }), h('span', { class: 'tx' }, h('b', { text: it.title }), it.sub ? h('small', { text: it.sub }) : null), h('small', { text: d }));
}
async function openDetail(it) {
  st.selected = it;
  const k = S.KIND[it.kind] || S.KIND.search;
  const body = openSheet('detail', `${k.icon} ${it.title}`);
  History.log('open', it.kind);
  const extra = h('div');
  const nodes = [];
  nodes.push(muted([it.sub || k.name, st.me ? 'على بعد ' + fmtDist(distance(st.me, it)) : ''].filter(Boolean).join(' • ')));
  if (it.img) nodes.push(h('img', { class: 'photo', src: it.img, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }));
  nodes.push(extra);
  if (it.lines?.length) nodes.push(sec('ℹ️ المعلومات', ...it.lines.map(([l, v]) => row(l, v))));
  const fixed = !['aircraft', 'drone', 'satellite'].includes(it.kind);
  nodes.push(h('div', { class: 'btns' },
    fixed ? h('a', { class: 'btn', href: `https://maps.apple.com/?daddr=${it.lat},${it.lon}`, target: '_blank', rel: 'noopener', text: '🧭 الاتجاهات' }) : null,
    fixed ? btn('📷 إرشاد بالكاميرا', () => { closeSheet(); openAR(it); }) : null,
    btn('🌦️ الطقس هنا', () => { closeSheet(); loadWeather(it); openWeather(); }),
    btn('🛸 درون هنا؟', () => { closeSheet(); goTo(it.lat, it.lon, 13); if (!st.active.has('drones')) toggleLayer('drones'); setTimeout(openDrone, 1200); }),
    it.link ? linkBtn('🔗 المصدر / المزيد', it.link) : null,
    navigator.share ? btn('📤 مشاركة', () => navigator.share({ title: it.title, text: it.title, url: `https://maps.apple.com/?ll=${it.lat},${it.lon}&q=${encodeURIComponent(it.title)}` }).catch(() => {})) : null));
  body.replaceChildren(...nodes);

  if (it.kind === 'aircraft' || it.kind === 'drone') {
    const [photo, route] = await Promise.all([S.planePhoto(it.ref), it.callsign ? S.flightRoute(it.callsign, it.lat, it.lon) : null]);
    if (st.selected !== it) return;
    if (route) extra.append(sec('🛫 مسار الرحلة', h('p', { text: route }), muted('من قاعدة بيانات المسارات المفتوحة – قد لا تكون دقيقة دائماً.')));
    if (photo?.src) extra.append(h('img', { class: 'photo', src: photo.src, alt: '', referrerpolicy: 'no-referrer' }), muted('© ' + (photo.by || '') + ' – planespotters.net'));
  }
  if (it.kind === 'satellite' && window.satellite) {
    satTrack(it.ref);
    const obs = st.me || center();
    const p = nextPass(it.ref, obs);
    extra.append(sec('👀 المرور القادم فوقك', h('p', { text: p ? `يبدأ ${fmtDateTime(p.start)} • أعلى ارتفاع ${Math.round(p.maxE)}° عند ${fmtTime(p.maxT)} • ينتهي ${fmtTime(p.end)}.${p.maxE > 30 ? ' مرور جيد للرؤية إذا كانت السماء صافية بعد الغروب.' : ''}` : 'لا يوجد مرور فوق 10° خلال 36 ساعة.' })));
  }
  if (it.kind === 'animal') {
    const sp = await S.species(it.lat, it.lon, 5);
    if (st.selected !== it || !sp.length) return;
    extra.append(sec('🐾 حيوانات موثّقة في المنطقة', ...sp.slice(0, 15).map(s => h('div', { class: 'list-item' },
      s.img ? h('img', { src: s.img, alt: '', width: 36, height: 36, style: 'border-radius:8px;object-fit:cover', referrerpolicy: 'no-referrer' }) : h('span', { class: 'ic', text: '🐾' }),
      h('span', { class: 'tx' }, h('b', { text: s.name }), h('small', { text: `${s.group} • ${s.sci}` })), h('small', { text: String(s.count) })))));
  }
}
async function pinPoint(lat, lon) {
  if (navigator.vibrate) navigator.vibrate(20);
  const it = { id: 'pinned', kind: 'pinned', lat, lon, title: 'نقطة مختارة', sub: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lines: [['الإحداثيات', `${lat.toFixed(5)}, ${lon.toFixed(5)}`], ['DMS', dms(lat, lon)]] };
  renderItems('search', [...st.search, it]);
  openDetail(it);
  try { const g = await S.reverseGeocode(lat, lon); it.title = g.name || g.city || it.title; it.lines.unshift(['العنوان', g.display || '']); if (st.selected === it) openDetail(it); } catch {}
}

// Search sheet
function openSearch() {
  const body = openSheet('search', '✨ البحث الذكي');
  const nodes = [];
  if (st.answer) nodes.push(sec(null, h('div', { style: 'white-space:pre-wrap', text: st.answer }), muted('المحرك: ' + (Settings.v.cloudAI ? 'Claude (سحابي اختياري) + محرك محلي' : 'محرك ذكي محلي + OpenStreetMap'))));
  if (st.local.length) nodes.push(sec('على الخريطة الآن', ...st.local.slice(0, 50).map(i => listItem(i))));
  if (st.search.length) nodes.push(sec('نتائج البحث', ...st.search.slice(0, 60).map(i => listItem(i))));
  if (!nodes.length) nodes.push(muted('اكتب سؤالك أو ما تبحث عنه في الأعلى.'));
  body.replaceChildren(...nodes);
}

// History sheet
let histTab = 0, histDate = new Date();
function renderHistory() {
  const body = $('#sheetBody'); const cl = clusters(); const nodes = [];
  nodes.push(sec(null, toggleRow('🔒 تسجيل تحركاتي (خاص ومشفّر)', 'مشفّر AES-256 على هذا الهاتف فقط. ملاحظة: متصفح iPhone يسجّل فقط أثناء فتح التطبيق.', Settings.v.historyEnabled, on => { Settings.set('historyEnabled', on); if (on) startLocation(st.highAcc); renderHistory(); })));
  nodes.push(seg([[0, 'يومياتي'], [1, 'أماكني'], [2, 'روتيني'], [3, 'رحلاتي']], histTab, v => { histTab = v; renderHistory(); }));
  if (histTab === 0) {
    const di = h('input', { type: 'date', value: new Date(histDate.getTime() - histDate.getTimezoneOffset() * 60000).toISOString().slice(0, 10), max: new Date().toISOString().slice(0, 10),
      onchange: e => { histDate = new Date(e.target.value + 'T12:00'); renderHistory(); } });
    nodes.push(sec(null, di, h('div', { class: 'btns' }, btn('🗺️ عرض مسار اليوم على الخريطة', () => { closeSheet(); showHistoryDay(histDate); }), st.histDay ? btn('إخفاء المسار', () => { showHistoryDay(null); renderHistory(); }) : null)));
    const story = dayStory(histDate);
    nodes.push(sec('ماذا فعلت – ' + fmtDate(histDate), story.length ? h('div', {}, story.map(s => h('button', { class: 'list-item', onclick: () => { if (s.lat) { closeSheet(); goTo(s.lat, s.lon, 16); } } },
      h('small', { text: fmtTime(s.t), style: 'width:42px' }), h('span', { class: 'ic', text: s.icon }), h('span', { class: 'tx' }, h('b', { text: s.title }), s.detail ? h('small', { text: s.detail }) : null)))) :
      muted(Settings.v.historyEnabled ? 'لا توجد بيانات لهذا اليوم بعد.' : 'فعّل التسجيل لتبدأ يومياتك التلقائية.')));
  } else if (histTab === 1) {
    nodes.push(sec('الأماكن الأكثر زيارة', cl.length ? h('div', {}, cl.slice(0, 40).map(c => h('button', { class: 'list-item', onclick: () => { closeSheet(); goTo(c.lat, c.lon, 16); } },
      h('span', { class: 'ic', text: c.label === 'المنزل' ? '🏠' : c.label ? '💼' : '📍' }), h('span', { class: 'tx' }, h('b', { text: c.label ? `${c.label} – ${c.name}` : c.name }),
        h('small', { text: `${c.visits.length} زيارة • ${fmtDur(c.total / 1000)}${c.cat ? ' • ' + c.cat : ''}` })), h('small', { text: relTime(Math.max(...c.visits.map(v => v.arrival))) })))) : muted('لا توجد أماكن بعد.')));
  } else if (histTab === 2) {
    const lines = routineLines(cl); const p = predict(cl);
    nodes.push(sec('ما تعلّمه التطبيق عنك (على الجهاز فقط)', ...(lines.length ? lines.map(l => h('p', { text: l })) : [muted('يحتاج التطبيق بضعة أيام من الاستخدام ليتعرّف على روتينك.')]),
      p ? h('p', { text: `🔁 الآن عادةً: «${p.c.label || p.c.name}» (${p.n} مرات)` }) : null));
    const tl = topLayers().slice(0, 5);
    nodes.push(sec('اهتماماتك', ...(tl.length ? tl.map(([k, n]) => row(LAYERS[k]?.title || k, n + '×')) : [muted('لا توجد بيانات كافية بعد.')]), ...topSearches().map(s => row('بحث متكرر', s))));
  } else {
    const trips = History.db.trips.slice().reverse();
    nodes.push(sec('الرحلات المسجّلة', trips.length ? h('div', {}, trips.slice(0, 50).map(t => h('button', { class: 'list-item', onclick: () => { closeSheet(); showHistoryDay(new Date(t.start)); } },
      h('span', { class: 'ic', text: TRIP[t.mode]?.icon || '🧭' }), h('span', { class: 'tx' }, h('b', { text: `${TRIP[t.mode]?.name || ''} • ${fmtDist(t.distance)}` }),
        h('small', { text: `${fmtDateTime(t.start)} • أقصى ${Math.round(t.max * 3.6)} كم/س • متوسط ${Math.round(t.avg * 3.6)} كم/س` }))))) : muted('ابدأ رحلة من زر «التنقّل».')));
  }
  body.replaceChildren(...nodes);
}
const openHistory = () => { openSheet('history', '🕓 سجلّي الخاص', true); renderHistory(); };

// Suggestions
async function buildSuggestions() {
  const out = []; const cl = clusters(); const now = new Date(); const hr = now.getHours(); const wd = now.getDay();
  const p = predict(cl);
  if (p) out.push({ icon: '🔁', title: `عادةً تذهب في هذا الوقت إلى «${p.c.label || p.c.name}»`, detail: `تكرر ذلك ${p.n} مرات في أيام مشابهة.`, go: () => goTo(p.c.lat, p.c.lon, 15) });
  const tl = topLayers(hr)[0];
  if (tl && LAYERS[tl[0]] && !st.active.has(tl[0]) && tl[1] >= 2) out.push({ icon: LAYERS[tl[0]].icon, title: `تفتح عادةً «${LAYERS[tl[0]].title}» في هذا الوقت`, detail: 'تفعيل بلمسة واحدة.', go: () => toggleLayer(tl[0]) });
  if (wd === 0 || wd === 6) out.push({ icon: '🛍️', title: 'عطلة نهاية الأسبوع: أسواق و Flohmarkt', detail: 'اعرض الأسواق ومحلات المستعمل حولك.', go: () => { if (!st.active.has('markets')) toggleLayer('markets'); } });
  const w = st.weather;
  if (w?.current) {
    const rainSoon = Math.max(0, ...w.blend.slice(0, 6).map(x => x.agree));
    if (w.thunder >= 2) out.push({ icon: '⛈️', title: 'عواصف رعدية محتملة', detail: 'شغّل رادار الأمطار لمتابعة العاصفة.', go: () => { if (!st.active.has('radar')) toggleLayer('radar'); } });
    else if (w.current.temp >= 12 && w.current.temp <= 28 && rainSoon < 0.4 && w.current.day) out.push({ icon: '☀️', title: 'طقس جميل للخروج', detail: 'حدائق ومناظر طبيعية قريبة.', go: () => search('حديقة') });
    else if (rainSoon >= 0.5) out.push({ icon: '🏛️', title: 'مطر قادم – أنشطة داخلية', detail: 'متاحف ومعارض ومسارح قريبة.', go: () => { if (!st.active.has('culture')) toggleLayer('culture'); } });
  } else if (!st.active.has('weather')) out.push({ icon: '🌦️', title: 'شغّل الطقس الذكي', detail: '6 نماذج عالمية بينها نموذج الذكاء الاصطناعي AIFS.', go: () => toggleLayer('weather') });
  const cats = {}; History.db.visits.forEach(v => { if (v.categoryAr) cats[v.categoryAr] = (cats[v.categoryAr] || 0) + 1; });
  const topCat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];
  if (topCat) out.push({ icon: '✨', title: `اكتشف أماكن جديدة من نوع «${topCat[0]}»`, detail: 'لأنك تزور هذا النوع كثيراً.', go: () => search(topCat[0]) });
  for (const s of topSearches().slice(0, 2)) out.push({ icon: '🔎', title: 'ابحث مجدداً: ' + s, detail: 'من عمليات بحثك المتكررة.', go: () => search(s) });
  if (hr >= 18 || hr < 5) out.push({ icon: '🛰️', title: 'الليل مناسب لرصد الأقمار الصناعية', detail: 'محطة الفضاء الدولية ومتى تمرّ فوقك.', go: () => { if (!st.active.has('satellites')) toggleLayer('satellites'); } });
  if (!(await Emergency.load())) out.push({ icon: '🆘', title: 'حمّل خريطة الطوارئ لتعمل دون إنترنت', detail: 'ملاجئ ومستشفيات وشرطة حولك – مهمة عند انقطاع الشبكة.', go: () => openEmergency() });
  if (!st.active.has('aircraft')) out.push({ icon: '✈️', title: 'ماذا يطير فوقك الآن؟', detail: 'الطائرات الحيّة مع مسارها ونوعها وصورتها.', go: () => toggleLayer('aircraft') });
  if (!st.active.has('wildlife')) out.push({ icon: '🐾', title: 'اكتشف الحيوانات حولك', detail: 'مشاهدات علمية موثّقة.', go: () => toggleLayer('wildlife') });
  st.suggestions = out;
  st.routine = routineLines(cl);
}
async function openIdeas() {
  const body = openSheet('ideas', '✨ أفكار ذكية لك', true);
  body.replaceChildren(muted('…'));
  await buildSuggestions();
  body.replaceChildren(
    st.routine?.length ? sec('روتينك باختصار', ...st.routine.map(l => h('p', { text: l }))) : null,
    sec('اقتراحات لك الآن', ...st.suggestions.map(s => h('button', { class: 'list-item', onclick: () => { closeSheet(); s.go(); } }, h('span', { class: 'ic', text: s.icon }), h('span', { class: 'tx' }, h('b', { text: s.title }), h('small', { text: s.detail }))))),
    muted('الاقتراحات تُحسب على هاتفك من استخدامك وطقسك وروتينك. لا يُرسل شيء من سجلك إلى الإنترنت.')
  );
}

// Settings
async function openSettings() {
  const body = openSheet('settings', '⚙️ الإعدادات', true);
  const keyField = async (name, title, url) => {
    const has = !!(await Keys.get(name));
    const inp = h('input', { type: 'password', placeholder: has ? 'محفوظ على هذا الجهاز ✓' : 'الصق المفتاح هنا', autocomplete: 'off' });
    return h('div', { style: 'margin:10px 0' }, h('b', { text: title + (has ? ' ✅' : '') }), inp,
      h('div', { class: 'btns' }, btn('حفظ', async () => { await Keys.set(name, inp.value); toast('تم الحفظ على هذا الجهاز'); openSettings(); }),
        has ? btn('حذف', async () => { await Keys.set(name, null); openSettings(); }) : null, url ? linkBtn('احصل على مفتاح مجاني ↗', url) : null));
  };
  const lockOn = !!Settings.v.lockCred;
  body.replaceChildren(
    sec('🔒 الخصوصية والأمان',
      toggleRow('سجل التحركات الخاص', 'مشفّر على الجهاز فقط', Settings.v.historyEnabled, on => Settings.set('historyEnabled', on)),
      toggleRow('قفل التطبيق بـ Face ID', 'يطلب Face ID عند فتح التطبيق', lockOn, async (on, inp) => { if (on) { if (!(await setupLock())) inp.checked = false; } else Settings.set('lockCred', null); }),
      row('المخزّن على الجهاز', History.summary()),
      muted('• تشفير AES-GCM 256 بمفتاح غير قابل للاستخراج يبقى في هذا المتصفح.\n• لا حسابات، لا إعلانات، لا كوكيز، لا مكتبات تتبّع.\n• سياسة أمان محتوى (CSP) صارمة وكل النصوص الخارجية تُعرض بشكل آمن.'),
      btn('🗑️ حذف كل بياناتي نهائياً', async () => { if (confirm('سيتم حذف سجلّك ورحلاتك وروتينك وحزمة الطوارئ نهائياً. متابعة؟')) { await History.deleteAll(); await Emergency.clear(); showHistoryDay(null); toast('تم حذف كل البيانات'); openSettings(); } }, 'btn danger')),
    sec('🧠 الذكاء الاصطناعي',
      muted('افتراضياً: محرك ذكي محلي يفهم العربية والألمانية والإنجليزية + بحث OpenStreetMap. الذكاء السحابي اختياري.'),
      toggleRow('ذكاء سحابي اختياري (Claude)', 'لأسئلة حرّة وبحث في الويب عن الفعاليات والأسواق', Settings.v.cloudAI, on => { Settings.set('cloudAI', on); openSettings(); }),
      Settings.v.cloudAI ? toggleRow('السماح بالبحث في الويب', null, Settings.v.cloudWeb, on => Settings.set('cloudWeb', on)) : null,
      Settings.v.cloudAI ? h('input', { type: 'text', value: Settings.v.claudeModel, onchange: e => Settings.set('claudeModel', e.target.value.trim()) }) : null,
      Settings.v.cloudAI ? await keyField('claude', 'مفتاح Claude API', 'https://console.anthropic.com') : null,
      Settings.v.cloudAI ? muted('يُرسل فقط نص سؤالك وسياق الخريطة الظاهر – أبداً سجلّك أو روتينك.') : null),
    sec('🔑 مفاتيح مجانية اختيارية', await keyField('windy', 'Windy Webcams (كاميرات أكثر)', 'https://api.windy.com/keys'), await keyField('firms', 'NASA FIRMS (حرائق أدق)', 'https://firms.modaps.eosdis.nasa.gov/api/map_key/')),
    sec('🛰️ الأقمار الصناعية', h('select', { onchange: e => { Settings.set('satGroup', e.target.value); st.satGroupLoaded = null; if (st.active.has('satellites')) refresh('satellites'); } },
      [['stations', 'محطات فضائية (ISS، تيانغونغ)'], ['visual', 'الأكثر سطوعاً'], ['weather', 'أقمار الطقس'], ['gps-ops', 'GPS'], ['galileo', 'Galileo'], ['science', 'علمية'], ['starlink', 'Starlink (عدد كبير)']]
        .map(([v, t]) => { const o = h('option', { value: v, text: t }); if (v === Settings.v.satGroup) o.selected = true; return o; }))),
    sec('✈️ الطيران',
      h('label', {}, `نصف القطر: ${Settings.v.aircraftRadius} ميل بحري`, h('input', { type: 'range', min: 25, max: 250, step: 5, value: Settings.v.aircraftRadius, style: 'width:100%', onchange: e => { Settings.set('aircraftRadius', +e.target.value); openSettings(); } })),
      toggleRow('إظهار الطائرات على الأرض', null, Settings.v.showGround, on => Settings.set('showGround', on))),
    sec('🔋 البطارية', seg([['smart', 'ذكي'], ['saver', 'توفير قوي'], ['performance', 'أداء عالٍ']], Settings.v.battery, v => { Settings.set('battery', v); openSettings(); }),
      muted('يتوقف كل التحديث عندما يكون التطبيق في الخلفية. GPS الدقيق يعمل فقط أثناء الرحلات والإرشاد بالكاميرا.')),
    sec('📚 المصادر والتراخيص', ...Object.values(LAYERS).map(l => row(l.icon + ' ' + l.title, l.src)),
      muted('© OpenStreetMap contributors (ODbL) • adsb.lol (ODbL) • CelesTrak • NASA • USGS • iNaturalist • Open-Meteo (CC BY 4.0) • Esri • CARTO • OpenTopoMap • Photon/Komoot')),
    sec('ℹ️ حدود متصفح iPhone', muted('• لا يمكن للتطبيق العمل في الخلفية: السجل والرحلات تُسجّل أثناء فتحه فقط.\n• لا يمكن التقاط Remote ID للدرونات عبر البلوتوث.\n• السفن الحيّة المجانية دون مفتاح متاحة لبحر البلطيق وشمال أوروبا.\n• لا يوجد مصدر رسمي مجاني لضربات البرق لحظياً؛ الخطر يُستنتج من النماذج والرادار.'))
  );
}

// ───────────────────────── Face ID lock (WebAuthn, local) ─────────────────────────
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function setupLock() {
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { name: 'خريطتي الذكية' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'smartmap', displayName: 'خريطتي' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' }, timeout: 60000 } });
    Settings.set('lockCred', b64(cred.rawId)); toast('تم تفعيل القفل بـ Face ID'); return true;
  } catch { toast('تعذّر تفعيل Face ID على هذا الجهاز'); return false; }
}
function lockIfNeeded() {
  if (!Settings.v.lockCred || st.unlockedAt && Date.now() - st.unlockedAt < 60000) return;
  st.locked = true; $('#lock').classList.remove('hidden');
}
async function unlock() {
  try {
    await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), allowCredentials: [{ type: 'public-key', id: unb64(Settings.v.lockCred) }], userVerification: 'required', timeout: 60000 } });
    st.locked = false; st.unlockedAt = Date.now(); $('#lock').classList.add('hidden'); tick();
  } catch { toast('لم يتم التحقق'); }
}

// ───────────────────────── Emergency (works offline) ─────────────────────────
let sosTimer = null, emFilter = null, emRadius = 25;
async function openEmergency() {
  closeSheet(); await enableCompass();
  st.emPack = await Emergency.load();
  const node = h('div', { id: 'emWrap' });
  openFull('emergency', '🆘 خريطة الاستغاثة', node);
  renderEmergency();
}
function renderEmergency() {
  const wrap = $('#emWrap'); if (!wrap) return;
  const r = country(); const num = (r.emergency.match(/\d+/) || ['112'])[0]; const me = st.me;
  const smsBody = me ? `🆘 أحتاج مساعدة!\nموقعي: ${me.lat.toFixed(5)}, ${me.lon.toFixed(5)}\n${dms(me.lat, me.lon)}\nhttps://maps.apple.com/?ll=${me.lat},${me.lon}\n${fmtDateTime(Date.now())}` : 'أحتاج مساعدة. موقعي غير متاح حالياً.';
  const pts = emPoints();
  wrap.replaceChildren(
    sec(null, h('b', { text: navigator.onLine ? '🟢 متصل بالإنترنت' : '🔴 دون إنترنت – GPS والبوصلة يعملان' }),
      me ? h('div', { class: 'big', style: 'font-size:24px;direction:ltr;text-align:right', text: `${me.lat.toFixed(5)}, ${me.lon.toFixed(5)}` }) : h('p', { text: 'جارٍ تحديد الموقع… اخرج إلى مكان مفتوح إن أمكن.' }),
      me ? muted(`${dms(me.lat, me.lon)} • الدقة ±${Math.round(me.acc)} م${me.alt != null ? ' • الارتفاع ' + Math.round(me.alt) + ' م' : ''}`) : null),
    h('a', { class: 'primary danger', style: 'display:block;text-align:center;text-decoration:none;margin:8px 0', href: 'tel:' + num, text: `📞 اتصل بالطوارئ ${num} (${flag(r.id)} ${r.name})` }),
    h('div', { class: 'btns' },
      h('a', { class: 'btn', style: 'background:#f59e0b;color:#000', href: 'sms:&body=' + encodeURIComponent(smsBody), text: '💬 SMS بموقعي' }),
      btn(sosTimer ? '⏹ إيقاف SOS' : '🔦 إشارة SOS بالشاشة', () => { sosTimer ? stopSOS() : startSOS(); renderEmergency(); }),
      navigator.share ? btn('📤 مشاركة موقعي', () => navigator.share({ text: smsBody }).catch(() => {})) : null),
    muted('الرسالة القصيرة تعمل عبر شبكة الهاتف حتى دون إنترنت. ' + r.numbers.map(n => `${n.label} ${n.value}`).join(' • ')),
    h('div', { class: 'sec' }, h('h3', { text: '🧭 خريطة دون إنترنت' }),
      seg([[null, 'الكل'], ['shelter', '🏠'], ['hospital', '🏥'], ['pharmacy', '💊'], ['police', '🚓'], ['fireStation', '🚒'], ['aed', '❤️'], ['water', '🚰'], ['assembly', '🧑‍🤝‍🧑']], emFilter, v => { emFilter = v; renderEmergency(); }),
      h('canvas', { id: 'radar', width: 700, height: 640 })),
    sec(pts.length ? 'الأقرب إليك' : null, ...(pts.length ? pts.slice(0, 25).map(p => h('div', { class: 'list-item' },
      h('span', { class: 'ic', text: S.KIND[p.kind]?.icon || '📍' }), h('span', { class: 'tx' }, h('b', { text: p.title }), h('small', { text: (S.KIND[p.kind]?.name || '') + (p.phone ? ' • ☎︎ ' + p.phone : '') })),
      me ? h('span', { style: `display:inline-block;transform:rotate(${Math.round(bearing(me, p) - (st.heading || 0))}deg)`, text: '⬆️' }) : null,
      me ? h('small', { text: fmtDist(distance(me, p)) }) : null,
      btn('📷', () => { closeFull(); openAR(p); }, 'ghost'))) : [muted('لا توجد حزمة طوارئ بعد. حمّلها الآن وأنت متصل لتعمل لاحقاً دون إنترنت.')])),
    sec('📦 حزمة الطوارئ', st.emPack ? muted(`${st.emPack.points.length} نقطة • نصف قطر ${st.emPack.radiusKm} كم • ${fmtDateTime(st.emPack.created)}`) : null,
      seg([[10, '10 كم'], [25, '25 كم'], [50, '50 كم']], emRadius, v => { emRadius = v; renderEmergency(); }),
      btn('⬇️ تحميل / تحديث الحزمة', downloadPack, 'primary')),
    sec('💡 إرشادات سريعة', ...['زلزال: انخفض، احتمِ تحت طاولة متينة، وتمسّك. ابتعد عن النوافذ.', 'حريق: ابقَ منخفضاً تحت الدخان، تحسّس الأبواب قبل فتحها، ولا تستعمل المصعد.',
      'فيضان: اصعد إلى مكان مرتفع، ولا تعبر المياه الجارية بالسيارة.', 'عاصفة رعدية: ابتعد عن الأشجار المنفردة والمرتفعات والمياه.', 'وفّر البطارية: خفّض السطوع وفعّل وضع توفير الطاقة.'].map(t => h('p', { text: '• ' + t })))
  );
  drawRadar();
}
function emPoints() {
  const p = (st.emPack?.points || []).filter(x => !emFilter || x.kind === emFilter);
  return st.me ? p.slice().sort((a, b) => distance(st.me, a) - distance(st.me, b)) : p;
}
async function downloadPack() {
  if (!navigator.onLine) return toast('تحتاج اتصالاً بالإنترنت لتحميل الحزمة');
  const c = st.me || center();
  toast('جارٍ التحميل…');
  try {
    const points = await S.emergencyPack(c.lat, c.lon, emRadius * 1000);
    st.emPack = { created: Date.now(), lat: c.lat, lon: c.lon, radiusKm: emRadius, cc: st.cc, points: points.map(p => ({ id: p.id, kind: p.kind, title: p.title, lat: p.lat, lon: p.lon, phone: p.phone })) };
    await Emergency.save(st.emPack); toast(`تم حفظ ${points.length} نقطة للاستخدام دون إنترنت`); renderEmergency();
  } catch { toast('تعذّر التحميل، حاول مرة أخرى'); }
}
function drawRadar() {
  const cv = $('#radar'); if (!cv) return;
  const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 24;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const me = st.me; const pts = emPoints().slice(0, 60);
  const maxD = me ? Math.max(1000, ...pts.slice(0, 30).map(p => distance(me, p))) * 1.1 : 1000;
  ctx.strokeStyle = '#22c55e66'; ctx.fillStyle = '#22c55e'; ctx.font = '20px sans-serif';
  for (const f of [0.25, 0.5, 1]) { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke(); ctx.fillText(fmtDist(maxD * f), cx + R * f - 60, cy - 6); }
  const hd = (st.heading || 0) * Math.PI / 180;
  ctx.fillStyle = '#ef4444'; ctx.font = 'bold 26px sans-serif'; ctx.fillText('N', cx + Math.sin(-hd) * (R + 6) - 8, cy - Math.cos(-hd) * (R + 6) + 9);
  if (!me) { ctx.fillStyle = '#fff'; ctx.fillText('لا يوجد موقع GPS بعد', cx - 120, cy); return; }
  for (const p of pts) {
    const d = distance(me, p); if (d > maxD) continue;
    const b = (bearing(me, p) - (st.heading || 0)) * Math.PI / 180; const r = R * d / maxD;
    ctx.fillStyle = S.KIND[p.kind]?.color || '#fff'; ctx.beginPath(); ctx.arc(cx + Math.sin(b) * r, cy - Math.cos(b) * r, 8, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#3b82f6'; ctx.beginPath(); ctx.arc(cx, cy, 11, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(cx, cy - 30); ctx.lineTo(cx - 9, cy - 14); ctx.lineTo(cx + 9, cy - 14); ctx.fill();
}
function startSOS() {
  let flash = $('#sosFlash'); if (!flash) { flash = h('div', { id: 'sosFlash', onclick: () => { stopSOS(); renderEmergency(); } }); document.body.append(flash); }
  const pat = [1, 1, 1, 1, 1, 3, 3, 1, 3, 1, 3, 3, 1, 1, 1, 1, 1, 7]; let i = 0;
  const step = () => { const on = i % 2 === 0; flash.style.display = on ? 'block' : 'none'; sosTimer = setTimeout(step, pat[i % pat.length] * 220); i++; };
  step(); toast('اضغط على الشاشة البيضاء لإيقاف SOS');
}
function stopSOS() { clearTimeout(sosTimer); sosTimer = null; const f = $('#sosFlash'); if (f) f.style.display = 'none'; }

// ───────────────────────── Trips ─────────────────────────
const TRIP = { drive: { name: 'قيادة', icon: '🚗', max: 200 }, bike: { name: 'دراجة', icon: '🚲', max: 60 }, walk: { name: 'مشي', icon: '🚶', max: 20 }, flight: { name: 'طائرة', icon: '✈️', max: 1000 } };
let tripMode = 'drive', tripTimer = null;
async function openTrip() {
  closeSheet();
  openFull('trip', '🧭 التنقّل', h('div', { id: 'tripWrap' }));
  renderTrip();
  clearInterval(tripTimer); tripTimer = setInterval(() => { if (st.full === 'trip') renderTrip(); else clearInterval(tripTimer); }, 1000);
}
function renderTrip() {
  const wrap = $('#tripWrap'); if (!wrap) return;
  const t = st.trip; const mode = t?.mode || tripMode; const me = st.me; const fl = mode === 'flight';
  const sp = Math.max(0, t ? t.cur : (me?.speed || 0));
  const val = fl ? Math.round(sp * 1.94384) : Math.round(sp * 3.6);
  const el = t ? (Date.now() - t.start) / 1000 : 0; const avg = t && el > 0 ? t.distance / el : 0;
  const r = country();
  const note = mode === 'drive' ? `${flag(r.id)} ${r.speed}\nتنبيه الرادارات: ${CAM_TITLE[r.camWarner]}.${r.camWarner === 'banned' ? ' لذلك تُخفى الرادارات تلقائياً أثناء القيادة.' : ''}` :
    fl ? '✈️ GPS يعمل في وضع الطيران دون إنترنت. اجلس قرب النافذة لدقة أفضل. السرعة هنا سرعة أرضية.' : mode === 'bike' ? '🚲 تُسجَّل الرحلة على هاتفك فقط.' : '🚶 المسافة والارتفاع والمدة.';
  const fmtSp = v => fl ? Math.round(v * 1.94384) + ' kt' : Math.round(v * 3.6) + ' كم/س';
  wrap.replaceChildren(
    t ? null : seg(Object.entries(TRIP).map(([k, v]) => [k, v.icon + ' ' + v.name]), tripMode, v => { tripMode = v; renderTrip(); }),
    h('div', { class: 'speedo' }, h('div', { style: 'font-size:28px', text: TRIP[mode].icon }), h('div', { class: 'v', text: String(val) }), h('div', { class: 'muted', text: fl ? 'عقدة' : 'كم/س' }),
      h('div', { class: 'bar' }, h('i', { style: `width:${Math.min(100, sp * 3.6 / TRIP[mode].max * 100)}%;background:linear-gradient(90deg,#22c55e,#f59e0b,#ef4444)` }))),
    st.tripAlert ? h('div', { id: 'tripAlertBig', style: 'background:#f59e0b;color:#fff;font-weight:700;padding:12px;border-radius:14px;text-align:center', text: st.tripAlert }) : null,
    h('div', { class: 'grid2' },
      tile('📏 المسافة', t ? fmtDist(t.distance) : '—'), tile('⏱ المدة', t ? fmtDur(el) : '—'),
      tile('🏁 السرعة القصوى', t ? fmtSp(t.max) : '—'), tile('📊 المتوسط', t ? fmtSp(avg) : '—'),
      tile('⛰ الارتفاع', me?.alt != null ? (fl ? Math.round(me.alt * 3.28084) + ' قدم' : Math.round(me.alt) + ' م') : '—'),
      tile('🧭 الاتجاه', me?.course != null && !isNaN(me.course) && me.course >= 0 ? Math.round(me.course) + '°' : '—')),
    h('p', { class: 'muted', style: 'white-space:pre-wrap', text: note }),
    btn(t ? '⏹ إنهاء وحفظ الرحلة' : '▶️ ابدأ الرحلة', () => { t ? stopTrip() : startTrip(tripMode); renderTrip(); }, 'primary ' + (t ? 'danger' : '')),
    muted('أبقِ التطبيق مفتوحاً أثناء الرحلة (متصفح iPhone لا يتتبّع في الخلفية). الشاشة تبقى مضاءة تلقائياً.')
  );
}
const tile = (l, v) => h('div', { class: 'tile' }, h('small', { text: l }), h('b', { text: v }));
async function startTrip(mode) {
  st.trip = { mode, start: Date.now(), distance: 0, max: 0, cur: 0, pts: [], last: null };
  startLocation(true); History.log('trip', mode);
  try { st.wake = await navigator.wakeLock?.request('screen'); } catch {}
  if (st.active.has('speedCams')) refresh('speedCams');
  renderInfo();
}
function stopTrip() {
  const t = st.trip; if (!t) return;
  if (t.distance > 50) {
    const el = (Date.now() - t.start) / 1000; const step = Math.max(1, Math.ceil(t.pts.length / 1500));
    History.mutate(d => d.trips.push({ id: crypto.randomUUID(), mode: t.mode, start: t.start, end: Date.now(), distance: t.distance, max: t.max, avg: el ? t.distance / el : 0, pts: t.pts.filter((_, i) => i % step === 0) }));
  }
  st.trip = null; st.tripAlert = null; startLocation(false);
  try { st.wake?.release(); } catch {} st.wake = null;
  if (st.tripLine) { st.map.removeLayer(st.tripLine); st.tripLine = null; }
  if (st.active.has('speedCams')) refresh('speedCams');
  renderInfo(); $('#tripAlert').classList.add('hidden');
}
function updateTrip() {
  const t = st.trip, me = st.me; if (!t || !me || me.acc > 60) return;
  if (t.last) { const d = distance(t.last, me); if (d > 2) t.distance += d; }
  t.last = { lat: me.lat, lon: me.lon }; t.cur = Math.max(0, me.speed || 0); t.max = Math.max(t.max, t.cur);
  t.pts.push({ t: me.t, lat: me.lat, lon: me.lon, speed: t.cur });
  if (!st.tripLine) st.tripLine = L.polyline([], { color: '#3b82f6', weight: 5 }).addTo(st.map);
  st.tripLine.addLatLng([me.lat, me.lon]);
  // Speed-camera warning only where the law allows it
  st.tripAlert = null;
  if (t.mode === 'drive' && country().camWarner !== 'banned' && st.active.has('speedCams')) {
    const near = (st.items.speedCams || []).map(c => [c, distance(me, c)]).filter(x => x[1] < 450).sort((a, b) => a[1] - b[1])[0];
    if (near) {
      let ahead = true;
      if (me.course != null && me.course >= 0) { let df = Math.abs(bearing(me, near[0]) - me.course); if (df > 180) df = 360 - df; ahead = df <= 60; }
      if (ahead) st.tripAlert = `📸 رادار سرعة بعد ${fmtDist(near[1])}${near[0].sub ? ' – ' + near[0].sub : ''}`;
    }
  }
  const ta = $('#tripAlert'); ta.textContent = st.tripAlert || ''; ta.classList.toggle('hidden', !st.tripAlert);
  renderInfo();
}

// ───────────────────────── Camera guidance (AR) ─────────────────────────
let arTarget = null, arStream = null;
async function openAR(target) {
  arTarget = target; closeSheet(); closeFull();
  if (!(await enableCompass())) toast('اسمح بالوصول إلى البوصلة لاستعمال الإرشاد');
  startLocation(true);
  const video = h('video', { autoplay: true, playsinline: true, muted: true });
  const wrap = h('div', { id: 'arWrap' }, video, h('div', { id: 'arLayer' }),
    h('div', { id: 'arArrow' }),
    h('div', { id: 'arTop' }, h('button', { class: 'ghost', style: 'color:#fff;font-size:22px', text: '✕', onclick: closeAR }), h('div', { id: 'arName' })),
    h('div', { id: 'arBottom', text: 'جارٍ التحضير…' }));
  $('#arArrow', wrap).innerHTML = '<svg viewBox="0 0 100 100" width="110" height="110"><circle cx="50" cy="50" r="46" fill="#2563ebcc"/><path d="M50 14 L74 58 L56 52 L56 84 L44 84 L44 52 L26 58 Z" fill="#fff"/></svg>';
  document.body.append(wrap); st.full = 'ar';
  try {
    arStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = arStream;
  } catch { $('#arBottom').textContent = 'اسمح بالكاميرا من إعدادات Safari لاستعمال الإرشاد بالكاميرا.'; }
  renderAR();
}
function closeAR() {
  arStream?.getTracks().forEach(t => t.stop()); arStream = null;
  $('#arWrap')?.remove(); st.full = null; if (!st.trip) startLocation(false);
}
function renderAR() {
  const layer = $('#arLayer'); if (!layer || !arTarget) return;
  const me = st.me, hd = st.heading; const W = innerWidth, H = innerHeight, FOV = 60;
  $('#arName').replaceChildren(h('b', { text: arTarget.title }), h('div', { text: me ? fmtDist(distance(me, arTarget)) : '…' }));
  const bottom = $('#arBottom'); const arrow = $('#arArrow');
  if (!me) { bottom.textContent = 'جارٍ تحديد موقعك…'; return; }
  const d = distance(me, arTarget);
  if (hd == null) { bottom.textContent = 'حرّك الهاتف على شكل 8 لمعايرة البوصلة'; return; }
  const rel = relAngle(bearing(me, arTarget), hd);
  arrow.style.transform = `rotate(${rel}deg)`;
  bottom.textContent = d < 15 ? '🎉 وصلت تقريباً!' : Math.abs(rel) < 12 ? `⬆️ تقدّم للأمام ${fmtDist(d)}` : Math.abs(rel) > 150 ? '↩️ استدر للخلف' : rel > 0 ? `➡️ استدر يميناً ${Math.round(rel)}°` : `⬅️ استدر يساراً ${Math.round(-rel)}°`;
  const nearby = Object.values(st.items).flat().filter(i => i.lat != null && !['aircraft', 'satellite', 'vessel', 'drone'].includes(i.kind) && distance(me, i) < 2000)
    .sort((a, b) => distance(me, a) - distance(me, b)).slice(0, 12);
  const all = [{ ...arTarget, target: true }, ...nearby.filter(i => i.id !== arTarget.id)];
  layer.replaceChildren(...all.map(i => {
    const r = relAngle(bearing(me, i), hd); if (Math.abs(r) > FOV / 2) return null;
    const dist = distance(me, i);
    const x = W / 2 + (r / (FOV / 2)) * W / 2; const y = H * 0.42 - Math.max(0, 1 - Math.min(dist, 2000) / 2000) * 120 - (i.target ? 60 : 0);
    return h('div', { class: 'arMk' + (i.target ? ' target' : ''), style: `left:${x}px;top:${y}px` }, h('div', { class: 'i', text: i.target ? '🏁' : (S.KIND[i.kind]?.icon || '📍') }), h('div', { text: i.title.slice(0, 24) }), h('div', { text: fmtDist(dist) }));
  }).filter(Boolean));
}

// ───────────────────────── Chips & info pills ─────────────────────────
function renderChips() {
  const box = $('#chips');
  box.replaceChildren(...[...st.active].map(k => {
    const s = st.status[k]; const cls = !s ? 'load' : s.t === 'ok' ? 'ok' : s.t === 'zoom' ? 'zoom' : s.t === 'key' ? 'key' : s.t === 'err' ? 'err' : 'load';
    return h('button', { class: 'chip ' + cls, text: `${LAYERS[k].icon} ${statusText(s)}`, onclick: () => (['weather', 'radar', 'clouds'].includes(k) ? openWeather() : k === 'drones' ? openDrone() : openLayers()) });
  }));
}
function renderInfo() {
  const r = country();
  $('#countryPill').textContent = `${flag(r.id)} ${st.place || r.name} 🏛️${st.online ? '' : ' 📵'}`;
  const w = st.weather?.current;
  const wm = $('#weatherMini');
  if (w && st.active.has('weather')) { wm.textContent = `${S.wIcon(w.code, w.day)} ${Math.round(w.temp)}°${st.weather.thunder >= 2 ? ' ⚡️' : ''}${st.weather.alerts.length ? ' ⚠️' : ''} • ${st.weather.confidence}%`; wm.classList.remove('hidden'); }
  else wm.classList.add('hidden');
  const tm = $('#tripMini');
  if (st.trip) { const sp = st.trip.cur; tm.textContent = `${TRIP[st.trip.mode].icon} ${st.trip.mode === 'flight' ? Math.round(sp * 1.94384) + ' kt' : Math.round(sp * 3.6) + ' كم/س'} • ${fmtDist(st.trip.distance)}`; tm.classList.remove('hidden'); }
  else tm.classList.add('hidden');
}

// ───────────────────────── Onboarding ─────────────────────────
function onboarding() {
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const body = openSheet('onboard', '🌍 أهلاً في خريطتي الذكية', true);
  body.replaceChildren(
    h('p', { text: 'خريطة حيّة مدعومة بالذكاء الاصطناعي: طقس من 6 نماذج، طائرات وسفن وأقمار صناعية لحظياً، قوانين كل دولة، درونات، طوارئ دون إنترنت، سجلّ خاص وروتين ذكي.' }),
    sec('🔒 خصوصية أولاً', h('p', { text: 'سجل تحركاتك وروتينك مشفّر (AES-256) ومحفوظ على هاتفك فقط. لا حسابات، لا إعلانات، لا تتبّع. الذكاء السحابي اختياري ومطفأ افتراضياً.' })),
    standalone ? null : sec('📲 أضف الأيقونة إلى شاشتك', h('p', { text: 'في Safari: اضغط زر المشاركة ⬆️ ثم «إضافة إلى الشاشة الرئيسية». سيعمل التطبيق بملء الشاشة وحتى دون إنترنت.' })),
    sec(null, toggleRow('تفعيل سجل التحركات الخاص', 'يمكنك تغييره لاحقاً من الإعدادات', Settings.v.historyEnabled, on => Settings.set('historyEnabled', on))),
    muted('⚠️ المعلومات القانونية ومناطق الدرون للاسترشاد فقط؛ القرار للجهات الرسمية.'),
    btn('ابدأ', () => { Settings.set('onboarded', true); closeSheet(); if (!st.active.size) { toggleLayer('weather'); } }, 'primary')
  );
}

// ───────────────────────── Wiring ─────────────────────────
function wireUI() {
  $('#searchForm').addEventListener('submit', e => { e.preventDefault(); $('#q').blur(); search($('#q').value); });
  $('#q').addEventListener('input', () => $('#qClear').classList.toggle('hidden', !$('#q').value && !st.search.length));
  $('#qClear').addEventListener('click', () => { $('#q').value = ''; st.search = []; st.local = []; clearLayer('search'); $('#answer').classList.add('hidden'); $('#qClear').classList.add('hidden'); });
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#fullClose').addEventListener('click', closeFull);
  $('#btnLocate').addEventListener('click', () => { if (st.me) goTo(st.me.lat, st.me.lon, 16); else { startLocation(); toast('جارٍ تحديد موقعك… اسمح بالوصول إلى الموقع'); } });
  $('#btnIdeas').addEventListener('click', openIdeas);
  $('#btnStyle').addEventListener('click', () => { const keys = Object.keys(BASES); const i = (keys.indexOf(Settings.v.basemap) + 1) % keys.length; setBase(keys[i]); toast('نمط الخريطة: ' + BASES[keys[i]].name, 1500); });
  $('#countryPill').addEventListener('click', openLaws);
  $('#weatherMini').addEventListener('click', openWeather);
  $('#tripMini').addEventListener('click', openTrip);
  $('#unlockBtn').addEventListener('click', unlock);
  $$('#bottom button').forEach(b => b.addEventListener('click', () => ({ layers: openLayers, trip: openTrip, emergency: openEmergency, history: openHistory, settings: openSettings })[b.dataset.open]()));
  // Long-press on touch devices to drop a pin
  let lp = null;
  $('#map').addEventListener('touchstart', e => { if (e.touches.length !== 1) return; const t = e.touches[0]; lp = setTimeout(() => { const ll = st.map.containerPointToLatLng(L.point(t.clientX, t.clientY)); pinPoint(ll.lat, ll.lng); }, 650); }, { passive: true });
  ['touchend', 'touchmove', 'touchcancel'].forEach(ev => $('#map').addEventListener(ev, () => clearTimeout(lp), { passive: true }));
}

boot();
