// Live data from free, public, reliable sources. Every function returns plain items:
// { id, kind, lat, lon, title, sub, heading, lines: [[label, value]], link, img, ref }
import { fetchJSON, fetchText, qs, distance, safeUrl, fmtDist, relTime, fmtDateTime } from './util.js';

const bboxOf = b => ({ s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() });

// ───────────────────────── Weather (multi-model + AI model) ─────────────────────────
export const MODELS = [
  { key: 'ecmwf_aifs025_single', name: 'ECMWF AIFS – ذكاء اصطناعي', ai: true },
  { key: 'ecmwf_ifs025', name: 'ECMWF IFS' },
  { key: 'icon_seamless', name: 'DWD ICON' },
  { key: 'gfs_seamless', name: 'NOAA GFS' },
  { key: 'meteofrance_seamless', name: 'Météo-France' },
  { key: 'gem_seamless', name: 'Canada GEM' }
];

function modelWeight(key, lat, lon) {
  const europe = lat > 30 && lat < 72 && lon > -30 && lon < 45;
  return ({ ecmwf_aifs025_single: 1.25, ecmwf_ifs025: 1.25, icon_seamless: europe ? 1.35 : 0.9,
    meteofrance_seamless: europe ? 1.1 : 0.8, gfs_seamless: 0.9, gem_seamless: (lat > 40 && lon < -50) ? 1.1 : 0.8 })[key] ?? 1;
}

export async function weather(lat, lon) {
  const base = 'https://api.open-meteo.com/v1/forecast?';
  const curP = fetchJSON(base + qs({ latitude: lat, longitude: lon, timezone: 'auto',
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day' })).catch(() => null);
  const aqP = fetchJSON('https://air-quality-api.open-meteo.com/v1/air-quality?' + qs({ latitude: lat, longitude: lon, current: 'european_aqi,pm2_5,pm10' })).catch(() => null);
  const alP = fetchJSON('https://api.brightsky.dev/alerts?' + qs({ lat, lon })).catch(() => null);
  const models = (await Promise.all(MODELS.map(async m => {
    try {
      const j = await fetchJSON(base + qs({ latitude: lat, longitude: lon, timezone: 'auto', timeformat: 'unixtime', forecast_days: 2, models: m.key,
        hourly: 'temperature_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,cape,lightning_potential' }));
      const H = j.hourly; if (!H || !H.temperature_2m?.some(v => v != null)) return null;
      return { ...m, t: H.time.map(x => x * 1000), temp: H.temperature_2m, precip: H.precipitation || [], code: H.weather_code || [],
        cloud: H.cloud_cover || [], wind: H.wind_speed_10m || [], cape: H.cape || [], lp: H.lightning_potential || [] };
    } catch { return null; }
  }))).filter(Boolean);
  const [cur, aq, al] = await Promise.all([curP, aqP, alP]);
  const c = cur?.current;
  const blend = makeBlend(models, lat, lon);
  const b = {
    lat, lon, fetched: Date.now(), models, blend,
    current: c ? { temp: c.temperature_2m, feels: c.apparent_temperature, hum: c.relative_humidity_2m, precip: c.precipitation, code: c.weather_code,
      cloud: c.cloud_cover, wind: c.wind_speed_10m, windDir: c.wind_direction_10m, gusts: c.wind_gusts_10m, day: !!c.is_day } : null,
    aqi: aq?.current?.european_aqi, pm25: aq?.current?.pm2_5, pm10: aq?.current?.pm10,
    alerts: (al?.alerts || []).map(a => ({ head: a.headline_de || a.headline_en || 'تحذير', desc: a.description_de || a.description_en || '', sev: a.severity }))
  };
  b.confidence = confidence(blend, models.length);
  b.thunder = thunderRisk(models);
  b.summary = summary(b);
  return b;
}

function makeBlend(models, lat, lon) {
  if (!models.length) return [];
  const out = [];
  const h0 = Math.floor(Date.now() / 3600000) * 3600000;
  for (let h = 0; h < 24; h++) {
    const t = h0 + h * 3600000;
    let ws = 0, ts = 0, ps = 0, temps = [], rainy = 0, n = 0, codes = {};
    for (const m of models) {
      const i = m.t.findIndex(x => Math.abs(x - t) < 1800000);
      if (i < 0 || m.temp[i] == null) continue;
      const w = modelWeight(m.key, lat, lon);
      ws += w; ts += m.temp[i] * w; temps.push(m.temp[i]);
      const p = m.precip[i] ?? 0; ps += p * w; n++; if (p >= 0.2) rainy++;
      if (m.code[i] != null) codes[m.code[i]] = (codes[m.code[i]] || 0) + w;
    }
    if (!ws) continue;
    const mean = temps.reduce((a, b) => a + b, 0) / temps.length;
    const spread = Math.sqrt(temps.reduce((a, b) => a + (b - mean) ** 2, 0) / temps.length);
    const code = +Object.entries(codes).sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
    out.push({ t, temp: ts / ws, precip: ps / ws, agree: n ? rainy / n : 0, code, spread, n });
  }
  return out;
}

function confidence(blend, nModels) {
  const f = blend.slice(0, 12);
  if (!f.length) return 0;
  const spread = f.reduce((a, b) => a + b.spread, 0) / f.length;
  const dis = f.reduce((a, b) => a + Math.min(b.agree, 1 - b.agree) * 2, 0) / f.length;
  let c = 100 - spread * 12 - dis * 35 - (nModels < 3 ? 15 : 0);
  return Math.round(Math.max(5, Math.min(98, c)));
}

function thunderRisk(models) {
  const now = Date.now(); let s = 0;
  for (const m of models) m.t.forEach((t, i) => {
    if (t < now - 3600000 || t > now + 12 * 3600000) return;
    if (m.code[i] >= 95) s += 2;
    if (m.cape[i] > 1000) s += 1;
    if (m.lp[i] > 50) s += 2;
  });
  return s >= 12 ? 3 : s >= 5 ? 2 : s >= 1 ? 1 : 0;
}

export function wDesc(c) {
  if (c === 0) return 'صافٍ'; if (c === 1) return 'صافٍ غالباً'; if (c === 2) return 'غائم جزئياً'; if (c === 3) return 'غائم';
  if (c === 45 || c === 48) return 'ضباب'; if (c >= 51 && c <= 57) return 'رذاذ'; if (c >= 61 && c <= 67) return 'مطر';
  if (c >= 71 && c <= 77) return 'ثلج'; if (c >= 80 && c <= 82) return 'زخات مطر'; if (c === 85 || c === 86) return 'زخات ثلج';
  if (c === 95) return 'عاصفة رعدية'; if (c >= 96) return 'عاصفة رعدية مع بَرَد'; return '—';
}
export function wIcon(c, day = true) {
  if (c === 0) return day ? '☀️' : '🌙'; if (c <= 2) return day ? '⛅️' : '☁️'; if (c === 3) return '☁️';
  if (c === 45 || c === 48) return '🌫️'; if (c >= 51 && c <= 67) return '🌧️'; if ((c >= 71 && c <= 77) || c === 85 || c === 86) return '🌨️';
  if (c >= 80 && c <= 82) return '🌦️'; if (c >= 95) return '⛈️'; return '☁️';
}
export function aqiText(v) {
  if (v == null) return '—';
  return v < 20 ? `ممتازة (${Math.round(v)})` : v < 40 ? `جيدة (${Math.round(v)})` : v < 60 ? `متوسطة (${Math.round(v)})` : v < 80 ? `سيئة (${Math.round(v)})` : `سيئة جداً (${Math.round(v)})`;
}

function summary(b) {
  const p = [];
  if (b.current) p.push(`الآن ${Math.round(b.current.temp)}° – ${wDesc(b.current.code)}.`);
  const nx = b.blend.slice(0, 12);
  if (nx.length) {
    const agree = Math.max(...nx.map(x => x.agree)); const tot = nx.reduce((a, x) => a + x.precip, 0);
    p.push(agree >= 0.5 ? `مطر متوقع خلال 12 ساعة (~${tot.toFixed(1)} مم، اتفاق ${Math.round(agree * 100)}% من النماذج).` : 'لا أمطار تُذكر خلال 12 ساعة.');
    p.push(`الحرارة بين ${Math.round(Math.min(...nx.map(x => x.temp)))}° و ${Math.round(Math.max(...nx.map(x => x.temp)))}°.`);
  }
  if (b.thunder === 3) p.push('⚡️ خطر عواصف رعدية مرتفع.'); else if (b.thunder === 2) p.push('⚡️ احتمال عواصف رعدية.'); else if (b.thunder === 1) p.push('احتمال ضعيف لعواصف رعدية.');
  if (b.alerts.length) p.push(`⚠️ ${b.alerts.length} تحذير رسمي نشط.`);
  p.push(`ثقة التوقع ${b.confidence}% (${b.models.length} نماذج).`);
  return p.join(' ');
}

export async function radarTemplate() {
  const j = await fetchJSON('https://api.rainviewer.com/public/weather-maps.json');
  const last = j.radar?.past?.at(-1);
  if (!last) throw new Error('no radar');
  return { url: j.host + last.path + '/256/{z}/{x}/{y}/2/1_1.png', time: last.time * 1000 };
}

export function cloudTemplate() {
  const now = new Date();
  const d = new Date(now.getTime() - (now.getUTCHours() < 18 ? 86400000 : 0));
  const day = d.toISOString().slice(0, 10);
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/${day}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;
}

// ───────────────────────── Aircraft (ADS-B) ─────────────────────────
const CAT = { A1: 'طائرة خفيفة', A2: 'طائرة صغيرة', A3: 'طائرة كبيرة', A4: 'طائرة كبيرة (B757)', A5: 'طائرة ثقيلة', A6: 'عالية الأداء', A7: 'مروحية',
  B1: 'طائرة شراعية', B2: 'منطاد', B4: 'رياضية خفيفة', B6: 'طائرة بدون طيار (درون)', C1: 'مركبة طوارئ في المطار', C2: 'مركبة خدمة في المطار' };
const SQUAWK = { '7500': '⚠️ 7500 – اختطاف', '7600': '⚠️ 7600 – عطل اتصال لاسلكي', '7700': '🚨 7700 – حالة طوارئ' };

export async function aircraft(lat, lon, radiusNM, showGround) {
  const r = Math.max(5, Math.min(250, Math.round(radiusNM)));
  const p = `${lat.toFixed(4)}/${lon.toFixed(4)}/${r}`;
  let list = null, src = '';
  for (const [u, s] of [[`https://api.adsb.lol/v2/point/${p}`, 'adsb.lol'], [`https://api.airplanes.live/v2/point/${p}`, 'airplanes.live'], [`https://opendata.adsb.fi/api/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${r}`, 'adsb.fi']]) {
    try { const j = await fetchJSON(u, {}, 12000); list = j.ac || j.aircraft || []; src = s; break; } catch {}
  }
  if (list) {
    return list.filter(a => a.lat != null && a.lon != null && (showGround || a.alt_baro !== 'ground')).map(a => {
      const ground = a.alt_baro === 'ground';
      const alt = ground ? 0 : (typeof a.alt_baro === 'number' ? a.alt_baro : a.alt_geom);
      const L = [];
      if (a.flight?.trim()) L.push(['رمز النداء', a.flight.trim()]);
      if (a.r) L.push(['التسجيل', a.r]);
      if (a.desc || a.t) L.push(['الطراز', a.desc || a.t]);
      if (a.ownOp) L.push(['المشغّل', a.ownOp]);
      L.push(['الفئة', CAT[a.category] || 'غير محدد']);
      L.push(ground ? ['الحالة', 'على الأرض'] : ['الارتفاع', alt != null ? `${Math.round(alt)} قدم (${Math.round(alt * 0.3048)} م)` : '—']);
      if (a.gs != null) L.push(['السرعة', `${Math.round(a.gs)} عقدة (${Math.round(a.gs * 1.852)} كم/س)`]);
      const vr = a.baro_rate ?? a.geom_rate; if (vr && Math.abs(vr) > 200) L.push(['معدل الصعود', vr > 0 ? `↑ ${vr} قدم/د` : `↓ ${-vr} قدم/د`]);
      if (a.track != null) L.push(['الاتجاه', Math.round(a.track) + '°']);
      if (a.squawk) L.push(['Squawk', SQUAWK[a.squawk] || a.squawk]);
      L.push(['ICAO', a.hex.toUpperCase()]); L.push(['المصدر', src + ' (ADS-B حيّ)']);
      return { id: 'ac-' + a.hex, kind: a.category === 'B6' ? 'drone' : 'aircraft', lat: a.lat, lon: a.lon, heading: a.track ?? a.true_heading,
        title: a.flight?.trim() || a.r || a.hex.toUpperCase(), sub: [a.desc || a.t, !ground && alt != null ? 'FL' + Math.round(alt / 100) : ''].filter(Boolean).join(' • '),
        lines: L, link: `https://globe.adsb.lol/?icao=${a.hex}`, ref: a.hex, emergency: !!SQUAWK[a.squawk], callsign: a.flight?.trim() };
    });
  }
  // Fallback: OpenSky Network (anonymous, rate limited)
  const d = r / 60;
  const j = await fetchJSON('https://opensky-network.org/api/states/all?' + qs({ lamin: lat - d, lamax: lat + d, lomin: lon - d * 1.5, lomax: lon + d * 1.5 }));
  return (j.states || []).filter(s => s[6] != null && (showGround || !s[8])).map(s => ({
    id: 'ac-' + s[0], kind: 'aircraft', lat: s[6], lon: s[5], heading: s[10], title: (s[1] || '').trim() || s[0].toUpperCase(),
    sub: s[7] ? `${Math.round(s[7])} م` : '', ref: s[0], callsign: (s[1] || '').trim(), link: `https://globe.adsb.lol/?icao=${s[0]}`,
    lines: [['رمز النداء', (s[1] || '').trim()], ['البلد', s[2]], ['الارتفاع', s[7] != null ? `${Math.round(s[7])} م` : '—'],
      ['السرعة', s[9] != null ? `${Math.round(s[9] * 3.6)} كم/س` : '—'], ['ICAO', s[0].toUpperCase()], ['المصدر', 'OpenSky Network']]
  }));
}

export async function flightRoute(callsign, lat, lon) {
  try {
    const j = await fetchJSON('https://api.adsb.lol/api/0/routeset', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planes: [{ callsign, lat, lng: lon }] }) }, 10000);
    const f = j?.[0]; if (!f) return null;
    if (f._airports?.length) return f._airports.map(a => a.location ? `${a.name} (${a.location})` : a.name).join(' ← ');
    return f._airport_codes_iata || f.airport_codes || null;
  } catch { return null; }
}

export async function planePhoto(hex) {
  try {
    const j = await fetchJSON(`https://api.planespotters.net/pub/photos/hex/${hex}`, {}, 8000);
    const p = j.photos?.[0]; if (!p) return null;
    return { src: p.thumbnail_large?.src, by: p.photographer, link: p.link };
  } catch { return null; }
}

// ───────────────────────── Satellites (CelesTrak + SGP4) ─────────────────────────
export async function satelliteTLE(group) {
  const cacheKey = 'tle-' + group;
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (c && Date.now() - c.t < 2 * 3600000) return c.list;
  } catch {}
  const txt = await fetchText(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`);
  const lines = txt.split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
  const list = [];
  for (let i = 0; i + 2 < lines.length + 1; i += 3) {
    if (!lines[i + 1]?.startsWith('1 ') || !lines[i + 2]?.startsWith('2 ')) continue;
    list.push({ name: lines[i].trim(), l1: lines[i + 1], l2: lines[i + 2] });
    if (list.length >= 700) break;
  }
  try { localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), list })); } catch {}
  return list;
}

// ───────────────────────── Marine (AIS) ─────────────────────────
const SHIP = t => t == null ? 'غير معروف' : t === 30 ? 'صيد' : (t === 31 || t === 32 || t === 52) ? 'قاطرة' : t === 35 ? 'عسكرية' : t === 36 ? 'شراعية' :
  t === 37 ? 'نزهة/يخت' : (t >= 40 && t < 50) ? 'عالية السرعة' : t === 51 ? 'بحث وإنقاذ' : t === 55 ? 'إنفاذ القانون' : (t >= 60 && t < 70) ? 'ركاب' :
  (t >= 70 && t < 80) ? 'شحن' : (t >= 80 && t < 90) ? 'ناقلة نفط/غاز' : `أخرى (${t})`;
const NAV = { 0: 'تبحر بالمحرك', 1: 'راسية', 5: 'مربوطة في الميناء', 6: 'جانحة', 7: 'تصطاد', 8: 'تبحر بالشراع', 14: '⚠️ استغاثة AIS-SART' };
let vesselMeta = null;

export const coversDigitraffic = b => b.getNorth() > 53.5 && b.getSouth() < 66.5 && b.getEast() > 9 && b.getWest() < 31;

export async function shipsDigitraffic(bounds) {
  const H = { headers: { 'Digitraffic-User': 'SmartMap-PWA/1.0' } };
  if (!vesselMeta) {
    vesselMeta = new Map();
    try { (await fetchJSON('https://meri.digitraffic.fi/api/ais/v1/vessels', H, 30000)).forEach(v => vesselMeta.set(v.mmsi, v)); } catch {}
  }
  const j = await fetchJSON('https://meri.digitraffic.fi/api/ais/v1/locations?from=' + (Date.now() - 900000), H, 30000);
  const b = bboxOf(bounds);
  return (j.features || []).filter(f => { const [lo, la] = f.geometry.coordinates; return la >= b.s && la <= b.n && lo >= b.w && lo <= b.e; })
    .slice(0, 900).map(f => {
      const [lon, lat] = f.geometry.coordinates; const p = f.properties || {}; const m = vesselMeta.get(f.mmsi) || {};
      const L = [['MMSI', f.mmsi], ['النوع', SHIP(m.shipType)]];
      if (NAV[p.navStat]) L.push(['الحالة', NAV[p.navStat]]);
      if (p.sog != null) L.push(['السرعة', `${p.sog.toFixed(1)} عقدة (${Math.round(p.sog * 1.852)} كم/س)`]);
      if (m.destination) L.push(['الوجهة', m.destination]);
      if (p.timestampExternal) L.push(['آخر تحديث', relTime(p.timestampExternal)]);
      L.push(['المصدر', 'Fintraffic Digitraffic (AIS حيّ)']);
      return { id: 'ship-' + f.mmsi, kind: 'vessel', lat, lon, heading: (p.heading != null && p.heading < 360) ? p.heading : p.cog,
        title: m.name || 'MMSI ' + f.mmsi, sub: SHIP(m.shipType), lines: L, link: `https://www.marinetraffic.com/en/ais/details/ships/mmsi:${f.mmsi}` };
    });
}

// ───────────────────────── OpenStreetMap (Overpass) ─────────────────────────
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];

export async function overpass(body) {
  const data = 'data=' + encodeURIComponent('[out:json][timeout:25];' + body);
  let err;
  for (const ep of OVERPASS) {
    try {
      const j = await fetchJSON(ep, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: data }, 30000);
      return j.elements || [];
    } catch (e) { err = e; }
  }
  throw err || new Error('Overpass');
}

const ocoord = e => e.lat != null ? { lat: e.lat, lon: e.lon } : e.center ? { lat: e.center.lat, lon: e.center.lon } :
  e.bounds ? { lat: (e.bounds.minlat + e.bounds.maxlat) / 2, lon: (e.bounds.minlon + e.bounds.maxlon) / 2 } : null;
const oradius = e => e.bounds ? distance({ lat: e.bounds.minlat, lon: e.bounds.minlon }, { lat: e.bounds.maxlat, lon: e.bounds.maxlon }) / 2 : 0;
const oname = t => t['name:ar'] || t.name || t['name:en'] || t.operator || t.brand || null;
const olink = e => `https://www.openstreetmap.org/${e.type}/${e.id}`;
function olines(t) {
  const L = [];
  const addr = [t['addr:street'], t['addr:housenumber'], t['addr:postcode'], t['addr:city']].filter(Boolean).join(' ');
  if (addr) L.push(['العنوان', addr]);
  if (t.opening_hours) L.push(['أوقات العمل', t.opening_hours]);
  if (t.phone || t['contact:phone']) L.push(['الهاتف', t.phone || t['contact:phone']]);
  if (t.website || t['contact:website']) L.push(['الموقع', t.website || t['contact:website']]);
  if (t.description) L.push(['وصف', t.description]);
  return L;
}
const bb = b => `(${b.getSouth().toFixed(5)},${b.getWest().toFixed(5)},${b.getNorth().toFixed(5)},${b.getEast().toFixed(5)})`;

export async function osmLayer(layer, bounds) {
  const B = bb(bounds);
  if (layer === 'speedCams') {
    const els = await overpass(`(node["highway"="speed_camera"]${B};node["enforcement"="maxspeed"]${B};relation["enforcement"="maxspeed"]${B};);out bb 600;`);
    return els.map(e => { const c = ocoord(e); if (!c) return null; const t = e.tags || {};
      const L = olines(t); if (t.maxspeed) L.unshift(['الحد الأقصى', t.maxspeed + ' كم/س']); if (t.direction) L.push(['الاتجاه', t.direction]);
      return { id: 'cam-' + e.type + e.id, kind: 'speedCam', ...c, title: 'رادار سرعة', sub: t.maxspeed ? t.maxspeed + ' كم/س' : '', lines: L, link: olink(e) }; }).filter(Boolean);
  }
  if (layer === 'webcams') {
    const els = await overpass(`(nwr["contact:webcam"]${B};nwr["webcam"]${B};nwr["surveillance:type"="webcam"]${B};);out bb 400;`);
    return els.map(e => { const c = ocoord(e); if (!c) return null; const t = e.tags || {};
      const link = safeUrl(t['contact:webcam'] || t.webcam || t.url || t.website); if (!link) return null;
      return { id: 'wc-' + e.type + e.id, kind: 'webcam', ...c, title: oname(t) || 'كاميرا ويب علنية', sub: 'OpenStreetMap', lines: olines(t), link }; }).filter(Boolean);
  }
  if (layer === 'markets') {
    const els = await overpass(`(nwr["amenity"="marketplace"]${B};nwr["shop"="second_hand"]${B};nwr["shop"="antiques"]${B};nwr["shop"="charity"]${B};);out bb 400;`);
    return els.map(e => { const c = ocoord(e); if (!c) return null; const t = e.tags || {};
      const sub = t.amenity === 'marketplace' ? 'سوق / Markt' : t.shop === 'antiques' ? 'تحف وأنتيكات' : 'مستعمل / Second-hand';
      return { id: 'mk-' + e.type + e.id, kind: 'market', ...c, title: oname(t) || sub, sub, lines: olines(t), link: olink(e) }; }).filter(Boolean);
  }
  if (layer === 'culture') {
    const K = { museum: 'متحف', gallery: 'معرض فني', theatre: 'مسرح', arts_centre: 'مركز فنون', cinema: 'سينما', library: 'مكتبة', community_centre: 'مركز ثقافي',
      planetarium: 'قبة فلكية', castle: 'قلعة', monument: 'نصب تذكاري', archaeological_site: 'موقع أثري' };
    const els = await overpass(`(nwr["tourism"~"^(museum|gallery)$"]${B};nwr["amenity"~"^(theatre|arts_centre|cinema|library|community_centre|planetarium)$"]${B};nwr["historic"~"^(castle|monument|archaeological_site)$"]${B};);out bb 500;`);
    return els.map(e => { const c = ocoord(e); const t = e.tags || {}; const n = oname(t); if (!c || !n) return null;
      return { id: 'cu-' + e.type + e.id, kind: 'culture', ...c, title: n, sub: K[t.tourism || t.amenity || t.historic] || 'مكان ثقافي', lines: olines(t), link: safeUrl(t.website) || olink(e) }; }).filter(Boolean);
  }
  if (layer === 'emergency') {
    return (await overpass(emergencyQuery(B) + 'out bb 900;')).map(emergencyItem).filter(Boolean);
  }
  return [];
}

function emergencyQuery(A) {
  return `(nwr["amenity"="shelter"]["shelter_type"!="public_transport"]${A};nwr["social_facility"="shelter"]${A};nwr["emergency"="assembly_point"]${A};` +
    `nwr["emergency"="defibrillator"]${A};nwr["amenity"~"^(hospital|police|fire_station|pharmacy|drinking_water)$"]${A};nwr["healthcare"="hospital"]${A};);`;
}
const EK = { shelter: 'shelter', hospital: 'hospital', police: 'police', fire_station: 'fireStation', pharmacy: 'pharmacy', drinking_water: 'water' };
function emergencyItem(e) {
  const c = ocoord(e); if (!c) return null; const t = e.tags || {};
  let k = t.emergency === 'defibrillator' ? 'aed' : t.emergency === 'assembly_point' ? 'assembly' : EK[t.amenity] ||
    (t.social_facility === 'shelter' ? 'shelter' : t.healthcare === 'hospital' ? 'hospital' : null);
  if (!k) return null;
  const L = olines(t); if (k === 'hospital' && t.emergency === 'yes') L.unshift(['طوارئ', 'قسم طوارئ متوفر']);
  return { id: 'em-' + e.type + e.id, kind: k, ...c, title: oname(t) || KIND[k].name, sub: KIND[k].name, lines: L, link: olink(e), phone: t.phone || t['contact:phone'] };
}

export async function emergencyPack(lat, lon, radiusM) {
  return (await overpass(emergencyQuery(`(around:${radiusM},${lat},${lon})`) + 'out bb 3000;')).map(emergencyItem).filter(Boolean);
}

export async function droneZones(bounds) {
  const B = bb(bounds);
  const els = await overpass(`(nwr["aeroway"~"^(aerodrome|heliport|helipad)$"]${B};nwr["landuse"="military"]${B};nwr["military"~"^(base|airfield|range|danger_area|barracks|naval_base)$"]${B};` +
    `nwr["amenity"="prison"]${B};nwr["leisure"="nature_reserve"]${B};nwr["boundary"="national_park"]${B};nwr["power"="plant"]${B};nwr["amenity"="hospital"]${B};` +
    `nwr["diplomatic"="embassy"]${B};);out bb 700;`);
  return els.map(e => {
    const c = ocoord(e); if (!c) return null; const t = e.tags || {}; const base = oradius(e);
    let level = 1, rad = Math.max(100, base + 100), reason = '';
    if (t.aeroway === 'aerodrome') { const major = t.iata || t['aerodrome:type'] === 'international' || t.aerodrome === 'international';
      level = 2; rad = Math.max(base, 500) + (major ? 5000 : 1500); reason = major ? 'مطار دولي – منطقة تحكم جوي' : 'مطار/مدرج – 1.5 كم على الأقل'; }
    else if (t.aeroway === 'heliport') { level = 2; rad = Math.max(base, 100) + 1000; reason = 'مهبط مروحيات'; }
    else if (t.aeroway === 'helipad') { level = 1; rad = 300; reason = 'مهبط مروحيات (مستشفى/طوارئ غالباً)'; }
    else if (t.landuse === 'military' || t.military) { level = 2; reason = 'منطقة عسكرية'; }
    else if (t.amenity === 'prison') { level = 2; reason = 'سجن'; }
    else if (t.diplomatic === 'embassy') { level = 2; reason = 'سفارة / منشأة دبلوماسية'; }
    else if (t.power === 'plant') { level = 2; reason = 'محطة طاقة / منشأة حساسة'; }
    else if (t.leisure === 'nature_reserve' || t.boundary === 'national_park') { level = 1; rad = Math.min(Math.max(base, 300), 8000); reason = 'محمية طبيعية – غالباً ممنوع أو يحتاج إذناً'; }
    else if (t.amenity === 'hospital') { level = 1; reason = 'مستشفى – مسافة أمان مطلوبة'; }
    if (!reason) return null;
    return { id: 'dz-' + e.type + e.id, ...c, radius: Math.min(rad, 12000), level, reason, name: oname(t) || reason, link: olink(e) };
  }).filter(Boolean);
}

/** Free-text category search inside the current view (used by the AI search). */
export async function osmCategory(tagFilter, bounds) {
  const B = bb(bounds);
  const els = await overpass(`(${tagFilter.map(f => `nwr${f}${B};`).join('')});out bb 80;`);
  return els.map(e => { const c = ocoord(e); const t = e.tags || {}; if (!c) return null;
    return { id: 'sr-' + e.type + e.id, kind: 'search', ...c, title: oname(t) || 'بدون اسم', sub: t.cuisine || t.amenity || t.shop || t.tourism || t.leisure || '', lines: olines(t), link: safeUrl(t.website) || olink(e) }; }).filter(Boolean);
}

// ───────────────────────── Hazards ─────────────────────────
export async function fires(bounds, firmsKey) {
  const out = [];
  try {
    const j = await fetchJSON('https://eonet.gsfc.nasa.gov/api/v3/events?' + qs({ category: 'wildfires', status: 'open', days: 30 }));
    for (const ev of j.events || []) {
      const g = ev.geometry?.at(-1); if (!g || g.type !== 'Point') continue;
      out.push({ id: 'eonet-' + ev.id, kind: 'fire', lat: g.coordinates[1], lon: g.coordinates[0], title: ev.title, sub: 'NASA EONET',
        lines: [['آخر رصد', fmtDateTime(g.date)], ['المصدر', 'NASA EONET']], link: safeUrl(ev.sources?.[0]?.url) || safeUrl(ev.link) });
    }
  } catch {}
  if (firmsKey) {
    try {
      const area = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].map(v => v.toFixed(3)).join(',');
      const csv = await fetchText(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(firmsKey)}/VIIRS_NOAA20_NRT/${area}/1`);
      const rows = csv.trim().split('\n').map(r => r.split(','));
      const H = rows.shift() || []; const ix = n => H.indexOf(n);
      rows.slice(0, 1500).forEach((r, i) => {
        const lat = +r[ix('latitude')], lon = +r[ix('longitude')]; if (isNaN(lat)) return;
        out.push({ id: `firms-${i}-${lat}-${lon}`, kind: 'fire', lat, lon, title: 'بؤرة حرارية (حريق محتمل)', sub: 'NASA FIRMS',
          lines: [['التاريخ', r[ix('acq_date')]], ['الوقت UTC', r[ix('acq_time')]], ['الثقة', r[ix('confidence')]], ['الإشعاع الحراري', r[ix('frp')] + ' MW'], ['المصدر', 'NASA FIRMS – VIIRS']] });
      });
    } catch {}
  }
  return out;
}

export async function quakes() {
  const j = await fetchJSON('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson');
  return (j.features || []).map(f => {
    const p = f.properties, [lon, lat, depth] = f.geometry.coordinates;
    return { id: 'q-' + f.id, kind: 'quake', lat, lon, mag: p.mag, title: `زلزال بقوة ${(p.mag ?? 0).toFixed(1)}`, sub: p.place || '',
      lines: [['القوة', (p.mag ?? 0).toFixed(1)], ['العمق', Math.round(depth) + ' كم'], ['الوقت', fmtDateTime(p.time)], ['المكان', p.place || '—'], ['تحذير تسونامي', p.tsunami ? 'نعم – تابع السلطات' : 'لا']],
      link: safeUrl(p.url) };
  });
}

// ───────────────────────── Wildlife (iNaturalist) ─────────────────────────
const TAXA = 'Mammalia,Aves,Reptilia,Amphibia,Actinopterygii,Insecta,Arachnida,Mollusca';
const GROUP = { Mammalia: 'ثدييات', Aves: 'طيور', Reptilia: 'زواحف', Amphibia: 'برمائيات', Actinopterygii: 'أسماك', Insecta: 'حشرات', Arachnida: 'عنكبوتيات', Mollusca: 'رخويات' };

export async function wildlife(lat, lon, radiusKm) {
  const j = await fetchJSON('https://api.inaturalist.org/v1/observations?' + qs({ lat, lng: lon, radius: Math.max(1, Math.min(50, Math.round(radiusKm))),
    iconic_taxa: TAXA, quality_grade: 'research', photos: 'true', order_by: 'observed_on', order: 'desc', per_page: 100, locale: 'ar' }));
  return (j.results || []).filter(r => r.geojson && r.taxon).map(r => ({
    id: 'inat-' + r.id, kind: 'animal', lat: r.geojson.coordinates[1], lon: r.geojson.coordinates[0],
    title: r.taxon.preferred_common_name || r.taxon.name, sub: GROUP[r.taxon.iconic_taxon_name] || 'حيوان',
    img: safeUrl(r.taxon.default_photo?.medium_url || r.taxon.default_photo?.square_url),
    lines: [['الاسم العلمي', r.taxon.name], ['المجموعة', GROUP[r.taxon.iconic_taxon_name] || '—'], ['تاريخ المشاهدة', r.observed_on || '—'], ['المصدر', 'iNaturalist (موثّقة)']],
    link: safeUrl(r.uri)
  }));
}

export async function species(lat, lon, radiusKm = 5) {
  try {
    const j = await fetchJSON('https://api.inaturalist.org/v1/observations/species_counts?' + qs({ lat, lng: lon, radius: radiusKm, iconic_taxa: TAXA, quality_grade: 'research', per_page: 30, locale: 'ar' }));
    return (j.results || []).map(r => ({ name: r.taxon.preferred_common_name || r.taxon.name, sci: r.taxon.name, group: GROUP[r.taxon.iconic_taxon_name] || '', count: r.count, img: safeUrl(r.taxon.default_photo?.square_url) }));
  } catch { return []; }
}

// ───────────────────────── Optional Windy webcams ─────────────────────────
export async function windyWebcams(lat, lon, radiusKm, key) {
  const j = await fetchJSON('https://api.windy.com/webcams/api/v3/webcams?' + qs({ nearby: `${lat},${lon},${Math.max(1, Math.min(250, Math.round(radiusKm)))}`, limit: 50, include: 'images,location,urls' }),
    { headers: { 'x-windy-api-key': key } });
  return (j.webcams || []).map(w => ({ id: 'windy-' + w.webcamId, kind: 'webcam', lat: w.location.latitude, lon: w.location.longitude, title: w.title, sub: w.location.city || 'Windy',
    img: safeUrl(w.images?.current?.preview), link: safeUrl(w.urls?.detail), lines: [['المصدر', 'Windy.com Webcams']] }));
}

// ───────────────────────── Geocoding & search ─────────────────────────
export async function reverseGeocode(lat, lon) {
  const j = await fetchJSON('https://nominatim.openstreetmap.org/reverse?' + qs({ format: 'jsonv2', lat, lon, zoom: 18, addressdetails: 1, 'accept-language': 'ar,de,en' }), { referrerPolicy: 'strict-origin' }, 12000);
  const a = j.address || {};
  return { name: j.name || a.road || j.display_name?.split(',')[0], city: a.city || a.town || a.village || a.county || a.state, country: a.country,
    cc: (a.country_code || '').toUpperCase(), category: j.category, type: j.type, display: j.display_name };
}

export async function photon(q, lat, lon, limit = 25) {
  const j = await fetchJSON('https://photon.komoot.io/api/?' + qs({ q, lat, lon, limit, lang: 'de' }), {}, 12000);
  return (j.features || []).map((f, i) => {
    const p = f.properties || {}; const [lo, la] = f.geometry.coordinates;
    const addr = [p.street, p.housenumber, p.postcode, p.city, p.country].filter(Boolean).join(' ');
    return { id: `ph-${i}-${la}-${lo}`, kind: 'search', lat: la, lon: lo, title: p.name || addr || q, sub: [p.osm_value, p.city || p.state, p.country].filter(Boolean).join(' • '),
      lines: addr ? [['العنوان', addr]] : [], link: p.osm_id ? `https://www.openstreetmap.org/${({ N: 'node', W: 'way', R: 'relation' })[p.osm_type] || 'node'}/${p.osm_id}` : null,
      placeType: p.type, extent: p.extent };
  });
}

export const KIND = {
  aircraft: { name: 'طائرة', icon: '✈️', color: '#f5c518' }, drone: { name: 'درون', icon: '🛸', color: '#ff4f9a' },
  satellite: { name: 'قمر صناعي', icon: '🛰️', color: '#2dd4bf' }, vessel: { name: 'سفينة', icon: '🚢', color: '#3b82f6' },
  fire: { name: 'حريق', icon: '🔥', color: '#ef4444' }, quake: { name: 'زلزال', icon: '〰️', color: '#a16207' },
  speedCam: { name: 'رادار سرعة', icon: '📸', color: '#f97316' }, webcam: { name: 'كاميرا مفتوحة', icon: '📹', color: '#6366f1' },
  animal: { name: 'حيوان', icon: '🐾', color: '#22c55e' }, market: { name: 'سوق', icon: '🛍️', color: '#14b8a6' },
  culture: { name: 'ثقافة', icon: '🎭', color: '#a855f7' }, shelter: { name: 'ملجأ', icon: '🏠', color: '#16a34a' },
  hospital: { name: 'مستشفى', icon: '🏥', color: '#dc2626' }, pharmacy: { name: 'صيدلية', icon: '💊', color: '#10b981' },
  police: { name: 'شرطة', icon: '🚓', color: '#2563eb' }, fireStation: { name: 'إطفاء', icon: '🚒', color: '#b91c1c' },
  water: { name: 'مياه شرب', icon: '🚰', color: '#06b6d4' }, aed: { name: 'جهاز إنعاش AED', icon: '❤️', color: '#ec4899' },
  assembly: { name: 'نقطة تجمّع', icon: '🧑‍🤝‍🧑', color: '#f59e0b' }, restriction: { name: 'منطقة مقيّدة', icon: '⛔️', color: '#ef4444' },
  search: { name: 'نتيجة بحث', icon: '📍', color: '#e11d48' }, pinned: { name: 'نقطة مختارة', icon: '📌', color: '#4f46e5' },
  visit: { name: 'زيارة', icon: '🕓', color: '#6b7280' }, suggestion: { name: 'اقتراح', icon: '💡', color: '#eab308' }
};

export { fmtDist };
