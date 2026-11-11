/* COPY OF lambda/times.js (same file, same chain, same rules).
   Kept as a copy because the scheduler runs in its own repo and must
   NOT import across repos. SYNC RULE: if the chain changes in the
   skill's lambda/times.js, copy it here again and re-run the dry-run
   test before the next scheduled prayer. Do not edit the chain here. */
'use strict';
require('./fetch-shim'); // No-op on Node 18+; installs a fetch polyfill on older runtimes.
/* Prayer-times chain for the Alexa skill — adapted from the PWA
   (~/workspace/pwa-standalone/app.js). Same chain, same rules:
     Tier 1: nearest verified mosque WITH a published table (<= 50 km)
     Tier 2: UAE Awqaf published times at region level
     Tier 3: labeled calculated times via AlAdhan
   No prayer times are hardcoded; every value comes from a live fetch
   or a labeled calculation. A failed published fetch falls through to
   labeled calculated — never a guessed time.
   Differences from the PWA:
   - No Netlify proxy (Lambda has no CORS problem): published pages are
     fetched directly, then via allorigins as a fallback.
   - UAE region matching uses English tokens only. Alexa device
     addresses are returned in English, so the Arabic tokens from the
     PWA were not copied; region display names are English too.
   - The Awqaf API key comes from the AWQAF_API_KEY environment
     variable only. It is NEVER written in this file. Without it, UAE
     requests fall back to labeled calculated times. */
const MASJIDBOX_URL = 'https://masjidbox.com/prayer-times/adams';
const MCLEAN_URL = 'https://www.mcleanislamicsociety.org/';
const AWQAF_PAGE_URL = 'https://www.awqaf.gov.ae/prayer-times';
const AWQAF_API_URL = 'https://internationalprayertime.awqaf.gov.ae/api/v1/prayertimes';
// Public key from the official Awqaf page's own code (the same key the
// page's own JavaScript uses in the browser). Set it as the
// AWQAF_API_KEY Lambda environment variable. Never paste the value here.
const AWQAF_API_KEY = process.env.AWQAF_API_KEY || '';
const AWQAF_IQAMA_OFFSETS = { Fajr: 25, Dhuhr: 20, Asr: 20, Maghrib: 8, Isha: 20 };
// Iqama is the official page's own rule: adhan + fixed offset.
const ALLORIGINS_RAW = 'https://api.allorigins.win/raw?url=';
const ALLORIGINS_GET = 'https://api.allorigins.win/get?url=';
const FETCH_TIMEOUT_MS = 10000;

/* ---------------- Verified published registry ----------------
   Same registry as the PWA. hasTimetable=false entries exist so the
   scan can prove a nearer no-table mosque never shadows a farther
   published one. McLean Islamic Center (Vienna, VA) is deliberately
   NOT in this registry: its times are app-only, no published web
   timetable. */
const REGISTRY = [
  { id: 'adams-sterling', name: 'ADAMS Sterling', address: '46903 Sugarland Rd, Sterling, VA', lat: 39.006, lon: -77.379, hasTimetable: true, sourceId: 'masjidbox:adams' },
  { id: 'adams-ashburn', name: 'ADAMS Ashburn', address: '21740 Beaumeade Cir, Ashburn, VA', lat: 39.042, lon: -77.466, hasTimetable: true, sourceId: 'masjidbox:adams' },
  { id: 'aqsa-sterling', name: 'AQSA Center, Sterling', address: 'Sterling, VA', lat: 39.020, lon: -77.410, hasTimetable: false, sourceId: null },
  { id: 'mclean-islamic-society', name: 'McLean Islamic Society', address: '1340 Old Chain Bridge Rd, McLean, VA 22101', lat: 38.93797, lon: -77.17628, hasTimetable: true, sourceId: 'mclean:homepage' }
];

/* ---------------- AlAdhan methods (20) ----------------
   Same list as the PWA (verified from https://api.aladhan.com/v1/methods).
   Removed: 0 (Jafari), 7 (Tehran), 8 (Gulf). Method 16 is the
   "Ministry of Awqaf method" label (same Dubai method, same numbers). */
const METHODS = [
  { id: 1, en: 'University of Islamic Sciences, Karachi' },
  { id: 2, en: 'Islamic Society of North America (ISNA)' },
  { id: 3, en: 'Muslim World League (MWL)' },
  { id: 4, en: 'Umm Al-Qura University, Makkah' },
  { id: 5, en: 'Egyptian General Authority of Survey' },
  { id: 9, en: 'Kuwait' },
  { id: 10, en: 'Qatar' },
  { id: 11, en: 'Singapore' },
  { id: 12, en: 'France' },
  { id: 13, en: 'Turkey' },
  { id: 14, en: 'Russia' },
  { id: 15, en: 'Moonsighting Committee Worldwide' },
  { id: 16, en: 'Ministry of Awqaf method' },
  { id: 17, en: 'Malaysia (JAKIM)' },
  { id: 18, en: 'Tunisia' },
  { id: 19, en: 'Algeria' },
  { id: 20, en: 'Indonesia' },
  { id: 21, en: 'Morocco' },
  { id: 22, en: 'Portugal' },
  { id: 23, en: 'Jordan' }
];
const REMOVED_METHODS = new Set([0, 7, 8]);
const COUNTRY_DEFAULTS = {
  AE: 16, BH: 3, OM: 3, IR: 3, US: 2, EG: 5, SA: 4, KW: 9, QA: 10,
  TR: 13, MY: 17, ID: 20, DZ: 19, TN: 18, MA: 21, FR: 12, RU: 14,
  SG: 11, JO: 23, PT: 22
};
const DEFAULT_METHOD = 3;

/* ---------------- UAE Awqaf regions (41) ----------------
   Official region ids from the Awqaf location/emirates endpoint.
   Tokens are English only (see header note). Within each emirate,
   specific-area regions come before the capital region so a city
   match wins over an emirate match. Unmatched UAE areas fall back to
   labeled calculated, never a guessed region. */
const UAE_REGIONS = [
  {
    "id": 37,
    "name": "Al Ain",
    "match": [
      "al ain",
      "alain"
    ]
  },
  {
    "id": 39,
    "name": "Hameem",
    "match": []
  },
  {
    "id": 40,
    "name": "Ghantoot",
    "match": [
      "ghantoot"
    ]
  },
  {
    "id": 43,
    "name": "Al Dhahra",
    "match": []
  },
  {
    "id": 45,
    "name": "Das Island",
    "match": [
      "das island"
    ]
  },
  {
    "id": 46,
    "name": "Dalma Island",
    "match": [
      "dalma island"
    ]
  },
  {
    "id": 47,
    "name": "Al Shuwaib",
    "match": []
  },
  {
    "id": 50,
    "name": "Sila",
    "match": [
      "sila",
      "al sila",
      "ghweifat"
    ]
  },
  {
    "id": 51,
    "name": "Al Quo'a",
    "match": []
  },
  {
    "id": 52,
    "name": "Jebel Hafeet",
    "match": [
      "jebel hafeet",
      "jabal hafeet"
    ]
  },
  {
    "id": 54,
    "name": "Al Khazna",
    "match": []
  },
  {
    "id": 56,
    "name": "Liwa",
    "match": [
      "liwa"
    ]
  },
  {
    "id": 57,
    "name": "Madinat Zayed",
    "match": [
      "madinat zayed"
    ]
  },
  {
    "id": 58,
    "name": "Mirfa",
    "match": [
      "mirfa",
      "al mirfa"
    ]
  },
  {
    "id": 61,
    "name": "Ruwais",
    "match": [
      "ruwais"
    ]
  },
  {
    "id": 63,
    "name": "Sweihan",
    "match": [
      "sweihan"
    ]
  },
  {
    "id": 65,
    "name": "Zirku",
    "match": [
      "zirku"
    ]
  },
  {
    "id": 36,
    "name": "Abu Dhabi",
    "match": [
      "abu dhabi",
      "abudhabi"
    ]
  },
  {
    "id": 70,
    "name": "Nazwa",
    "match": [
      "lahbab",
      "margham",
      "nazwa",
      "lisaili"
    ]
  },
  {
    "id": 71,
    "name": "Hatta",
    "match": [
      "hatta"
    ]
  },
  {
    "id": 69,
    "name": "Dubai",
    "match": [
      "dubai"
    ]
  },
  {
    "id": 72,
    "name": "Dibba Al Hisn",
    "match": [
      "dibba al hisn",
      "dibba al-hisn"
    ]
  },
  {
    "id": 86,
    "name": "Abu Musa",
    "match": [
      "abu musa"
    ]
  },
  {
    "id": 87,
    "name": "Al Dhaid",
    "match": [
      "al dhaid",
      "dhaid",
      "bataeh",
      "al bataeh"
    ]
  },
  {
    "id": 88,
    "name": "Khor Fakkan",
    "match": [
      "khor fakkan",
      "kalba"
    ]
  },
  {
    "id": 89,
    "name": "Maliha",
    "match": [
      "maliha",
      "mleiha",
      "al madam",
      "madam"
    ]
  },
  {
    "id": 92,
    "name": "Sir Bu Nair",
    "match": [
      "sir bu nair"
    ]
  },
  {
    "id": 91,
    "name": "Sharjah",
    "match": [
      "sharjah"
    ]
  },
  {
    "id": 67,
    "name": "Manama",
    "match": [
      "manama"
    ]
  },
  {
    "id": 68,
    "name": "Masfout",
    "match": [
      "masfout",
      "masfut"
    ]
  },
  {
    "id": 66,
    "name": "Ajman City",
    "match": [
      "ajman city",
      "ajman"
    ]
  },
  {
    "id": 94,
    "name": "Umm Al Quwain",
    "match": [
      "umm al quwain",
      "umm al qaiwain",
      "uaq"
    ]
  },
  {
    "id": 80,
    "name": "Jebel Jais",
    "match": [
      "jebel jais",
      "jabal jais",
      "jais"
    ]
  },
  {
    "id": 81,
    "name": "Al Huwailat",
    "match": []
  },
  {
    "id": 83,
    "name": "Ghalila",
    "match": [
      "ghalila",
      "shaam",
      "sha'am"
    ]
  },
  {
    "id": 84,
    "name": "Masafi (Ras Al Khaimah)",
    "match": []
  },
  {
    "id": 85,
    "name": "Tunb",
    "match": [
      "tunb"
    ]
  },
  {
    "id": 82,
    "name": "Ras Al Khaimah",
    "match": [
      "ras al khaimah",
      "ras al khaima",
      "rak"
    ]
  },
  {
    "id": 74,
    "name": "Al Sarm",
    "match": []
  },
  {
    "id": 75,
    "name": "Masafi (Fujairah)",
    "match": []
  },
  {
    "id": 73,
    "name": "Fujairah",
    "match": [
      "fujairah"
    ]
  }
];

/* ---------------- Pure logic ---------------- */
function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLon = (bLon - aLon) * Math.PI / 180;
  const s1 = Math.sin(dLat / 2) ** 2;
  const s2 = Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s1 + s2));
}
function scanPublishedRegistry(lat, lon, registry) {
  const list = (registry || REGISTRY).map((m) => ({
    ...m, distanceKm: haversineKm(lat, lon, m.lat, m.lon)
  })).sort((a, b) => a.distanceKm - b.distanceKm);
  const within = list.filter((m) => m.distanceKm <= 50);
  const published = within.find((m) => m.hasTimetable && m.sourceId);
  return { sorted: list, within, published: published || null };
}
function methodById(id) {
  return METHODS.find((m) => m.id === id) || METHODS.find((m) => m.id === DEFAULT_METHOD);
}
function countryDefaultMethod(countryCode) {
  if (!countryCode) return DEFAULT_METHOD;
  return COUNTRY_DEFAULTS[countryCode.toUpperCase()] || DEFAULT_METHOD;
}
function resolveStoredMethod(storedId, countryCode) {
  const n = Number(storedId);
  if (!Number.isFinite(n) || REMOVED_METHODS.has(n) || !METHODS.some((m) => m.id === n)) {
    return countryDefaultMethod(countryCode);
  }
  return n;
}
function addMinutesToTime(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (h * 60 + m + minutes) % (24 * 60);
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}
function awqafIqama(adhan) {
  const out = {};
  for (const key of ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']) {
    if (adhan[key]) out[key] = addMinutesToTime(adhan[key], AWQAF_IQAMA_OFFSETS[key]);
  }
  return out;
}
function matchAwqafRegion(address) {
  if (!address) return null;
  const parts = ['city', 'town', 'village', 'municipality', 'county', 'state', 'suburb']
    .map((k) => (address[k] || '').toLowerCase()).filter(Boolean);
  for (const region of UAE_REGIONS) {
    for (const token of region.match) {
      if (parts.some((p) => p === token || p.includes(token) || token.includes(p))) return region;
    }
  }
  return null;
}
function isUAEPlace(place) {
  if (place && place.countryCode && place.countryCode.toUpperCase() === 'AE') return true;
  if (place && typeof place.lat === 'number' && typeof place.lon === 'number') {
    return place.lat >= 22.6 && place.lat <= 26.1 && place.lon >= 51.6 && place.lon <= 56.4;
  }
  return false;
}
function normalizeTime(t) {
  if (!t) return null;
  const s = String(t).trim();
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}
function to24h(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\.?/i);
  if (m) {
    let h = Number(m[1]);
    const ap = m[3].toUpperCase();
    if (ap === 'P' && h < 12) h += 12;
    if (ap === 'A' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m[2]}`;
  }
  return normalizeTime(s);
}
const PRAYER_KEYS = [
  ['fajr', 'Fajr'], ['sunrise', 'Sunrise'], ['shuruq', 'Sunrise'],
  ['dhuhr', 'Dhuhr'], ['zuhr', 'Dhuhr'], ['asr', 'Asr'],
  ['maghrib', 'Maghrib'], ['isha', 'Isha']
];
function canonPrayer(name) {
  const n = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  for (const [key, canon] of PRAYER_KEYS) if (n.includes(key)) return canon;
  if (n.includes('jumuah') || n.includes('jumah') || n.includes('friday')) return 'Jumuah';
  return null;
}
function timeToMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}
// Next prayer after nowMinutes (minutes since midnight, same day).
// Returns { key, time, inMinutes } or null when the day is over (after Isha).
function nextPrayer(adhan, nowMinutes) {
  const order = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
  for (const key of order) {
    if (!adhan[key]) continue;
    const t = timeToMinutes(adhan[key]);
    if (t > nowMinutes) return { key, time: adhan[key], inMinutes: t - nowMinutes };
  }
  return null;
}

/* ---------------- Fetch helpers ---------------- */
function timeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  } catch (e) { /* no timeout */ }
  return undefined;
}
async function fetchText(url) {
  // Order: (1) direct fetch (no CORS problem server-side);
  // (2) allorigins /raw; (3) allorigins /get. Each attempt ~10 s.
  try {
    const opts = {};
    const sig = timeoutSignal(FETCH_TIMEOUT_MS);
    if (sig) opts.signal = sig;
    const r0 = await fetch(url, opts);
    if (r0.ok) {
      const t = await r0.text();
      if (t && t.length > 200) return t;
    }
  } catch (e) { /* fall through */ }
  try {
    const opts = {};
    const sig = timeoutSignal(FETCH_TIMEOUT_MS);
    if (sig) opts.signal = sig;
    const r1 = await fetch(ALLORIGINS_RAW + encodeURIComponent(url), opts);
    if (r1.ok) {
      const t = await r1.text();
      if (t && t.length > 200) return t;
    }
  } catch (e) { /* fall through */ }
  try {
    const opts = {};
    const sig = timeoutSignal(FETCH_TIMEOUT_MS);
    if (sig) opts.signal = sig;
    const r2 = await fetch(ALLORIGINS_GET + encodeURIComponent(url), opts);
    if (r2.ok) {
      const j = await r2.json();
      if (j && j.contents && j.contents.length > 200) return j.contents;
    }
  } catch (e) { /* give up */ }
  return null;
}
function stripTags(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
}

/* ---------------- MasjidBox parser (ADAMS) ---------------- */
function tolerantDecodePercent(str) {
  let out = String(str).replace(/%(?![0-9A-Fa-f]{2})/g, '%25');
  try { out = decodeURIComponent(out); } catch (e) { /* keep partially decoded */ }
  out = out.replace(/%u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return out;
}
function extractReduxState(html) {
  const idx = html.indexOf('REDUX_STATE');
  if (idx === -1) return null;
  const rest = html.slice(idx);
  const quoted = rest.match(/REDUX_STATE\s*=\s*'([^']*)'/);
  if (quoted) {
    try { return JSON.parse(tolerantDecodePercent(quoted[1])); } catch (e) { return null; }
  }
  const dquoted = rest.match(/REDUX_STATE\s*=\s*"((?:\\.|[^"\\])*)"/);
  if (dquoted) {
    try { return JSON.parse(tolerantDecodePercent(dquoted[1])); } catch (e) { /* fall through to legacy */ }
  }
  const start = html.indexOf('{', idx);
  if (start === -1) return null;
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(start, i + 1)); } catch (e) { return null; } } }
  }
  return null;
}
function walkPrayerTimes(node, adhan, iqama, depth) {
  if (!node || depth > 12) return;
  if (Array.isArray(node)) { for (const v of node) walkPrayerTimes(v, adhan, iqama, depth + 1); return; }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const lk = k.toLowerCase();
      const canon = canonPrayer(lk);
      if (canon && canon !== 'Jumuah' && typeof v === 'string') {
        const t = to24h(v);
        if (t) {
          if (lk.includes('iqam')) iqama[canon] = t;
          else if (!adhan[canon]) adhan[canon] = t;
        }
      }
      if (v && typeof v === 'object') walkPrayerTimes(v, adhan, iqama, depth + 1);
    }
  }
}
function timetableEntryDate(e) {
  if (!e || typeof e !== 'object') return null;
  if (typeof e.date === 'string') {
    const m = e.date.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  if (e.hijri && typeof e.hijri.gregorian === 'string') return e.hijri.gregorian;
  return null;
}
function pickTimetableEntry(tt, targetDate) {
  if (!Array.isArray(tt) || !tt.length) return null;
  let want = targetDate;
  if (!want) {
    const n = new Date();
    want = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  }
  return tt.find((e) => timetableEntryDate(e) === want) || null;
}
function pickTimes(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  const lower = {};
  for (const [k, v] of Object.entries(obj)) lower[String(k).toLowerCase()] = v;
  for (const k of keys) {
    const t = to24h(lower[k.toLowerCase()]);
    if (t) out[k] = t;
  }
  return out;
}
function parseMasjidbox(html, targetDate) {
  if (!html) return null;
  const state = extractReduxState(html);
  if (state) {
    const tt = state.masjidbox && state.masjidbox.masjidboxAthany && state.masjidbox.masjidboxAthany.timetable;
    if (Array.isArray(tt)) {
      const entry = pickTimetableEntry(tt, targetDate);
      if (entry) {
        const adhan = pickTimes(entry, ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']);
        const iqama = pickTimes(entry.iqamah, ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']);
        if (adhan.Fajr && adhan.Dhuhr && adhan.Asr && adhan.Maghrib && adhan.Isha) {
          const jumuah = Array.isArray(entry.jumuah) && entry.jumuah[0] ? to24h(entry.jumuah[0]) : null;
          return { adhan, iqama: Object.keys(iqama).length ? iqama : null, jumuah };
        }
      }
      // Timetable present but no entry for the target date: fail
      // honestly instead of showing another day's times.
      return null;
    }
    const adhan = {}; const iqama = {};
    walkPrayerTimes(state, adhan, iqama, 0);
    if (adhan.Fajr && adhan.Dhuhr && adhan.Asr && adhan.Maghrib && adhan.Isha) {
      return { adhan, iqama: Object.keys(iqama).length ? iqama : null, jumuah: null };
    }
  }
  const text = stripTags(html);
  const adhan = {}; const iqama = {};
  for (const name of ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']) {
    const re = new RegExp(name + '[^0-9]{0,30}?(\\d{1,2}:\\d{2}\\s*(?:[AP]\\.?M\\.?)?)', 'i');
    const m = text.match(re);
    if (m) adhan[name] = to24h(m[1]);
  }
  if (adhan.Fajr && adhan.Dhuhr && adhan.Asr && adhan.Maghrib && adhan.Isha) {
    return { adhan, iqama: null, jumuah: null };
  }
  return null;
}

/* ---------------- McLean Islamic Society parser ----------------
   Homepage with 7 dated day-blocks; each block has prayer-name /
   athan-time / iqama-time rows. The block matching the target date
   is used; nothing is guessed when no block matches. */
const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11, jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
function parseDateLabel(s) {
  if (!s) return null;
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})(?:,?\s+(\d{4}))?/i);
  if (m) {
    const year = m[3] ? Number(m[3]) : new Date().getFullYear();
    return `${year}-${String(MONTHS[m[1].toLowerCase()] + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
  }
  m = s.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
  if (m) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()] + 1).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
  return null;
}
function parseMclean(html, targetDate, cityTodayStr) {
  if (!html) return null;
  const parts = html.split(/gregorian-date/i);
  const blocks = [];
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i].slice(0, 6000);
    const dateText = seg.slice(0, 300);
    const date = parseDateLabel(dateText) || parseDateLabel(seg.slice(0, 1200));
    const adhan = {}; const iqama = {}; let jumuah = null;
    const rowRe = /prayer-name[^>]*>(?:<[^>]*>)*([^<]+)<(?:(?!<\/tr>)[\s\S]){0,600}?athan-time[^>]*>(?:<[^>]*>)*([^<]+)<((?:(?!<\/tr>)[\s\S]){0,600}?iqama-time[^>]*>(?:<[^>]*>)*([^<]+)<)?/gi;
    let rm;
    while ((rm = rowRe.exec(seg)) !== null) {
      const canon = canonPrayer(rm[1]);
      const a = to24h(rm[2]);
      const iq = rm[4] ? to24h(rm[4]) : null;
      if (canon === 'Jumuah') { if (a) jumuah = a; continue; }
      if (canon && a) { if (!adhan[canon]) adhan[canon] = a; if (iq && !iqama[canon]) iqama[canon] = iq; }
    }
    if (!adhan.Sunrise) {
      const sm = seg.match(/prayer-name[^>]*>(?:<[^>]*>)*Sunrise<\/td>\s*<td[^>]*>(?:<[^>]*>)*\s*([^<]+)</i);
      if (sm) { const s = to24h(sm[1]); if (s) adhan.Sunrise = s; }
    }
    if (adhan.Fajr && adhan.Dhuhr && adhan.Asr && adhan.Maghrib && adhan.Isha) {
      blocks.push({ date, adhan, iqama: Object.keys(iqama).length ? iqama : null, jumuah });
    }
  }
  if (!blocks.length) return null;
  const exact = blocks.find((b) => b.date && b.date === targetDate);
  if (exact) return exact;
  if (!blocks.some((b) => b.date) && targetDate === cityTodayStr) return blocks[0];
  const firstDated = blocks.find((b) => b.date);
  if (firstDated) {
    const t = new Date(targetDate + 'T12:00:00Z').getTime();
    const f = new Date(firstDated.date + 'T12:00:00Z').getTime();
    const idx = Math.round((t - f) / 86400000);
    const firstIdx = blocks.indexOf(firstDated);
    const pick = blocks[firstIdx + idx];
    if (pick && pick.date === targetDate) return pick;
  }
  return null;
}

/* ---------------- Published fetch dispatcher ---------------- */
async function fetchPublished(sourceId, targetDate, cityTodayStr) {
  if (sourceId === 'masjidbox:adams') {
    const html = await fetchText(MASJIDBOX_URL);
    const parsed = parseMasjidbox(html, targetDate);
    if (!parsed) return null;
    return { ...parsed, sourceUrl: MASJIDBOX_URL };
  }
  if (sourceId === 'mclean:homepage') {
    const html = await fetchText(MCLEAN_URL);
    const parsed = parseMclean(html, targetDate, cityTodayStr);
    if (!parsed) return null;
    return { ...parsed, sourceUrl: MCLEAN_URL };
  }
  return null;
}

/* ---------------- Awqaf (UAE) ---------------- */
async function fetchAwqaf(regionId, dateStr) {
  if (!AWQAF_API_KEY) return { error: 'not-configured' };
  try {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    const res = await fetch(AWQAF_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': AWQAF_API_KEY },
      body: JSON.stringify({ official_id: regionId, start_date: dateStr, end_date: d.toISOString().slice(0, 10) })
    });
    if (!res.ok) return { error: 'http-' + res.status };
    const json = await res.json();
    const adhan = extractAwqafTimes(json);
    if (!adhan || !adhan.Fajr || !adhan.Maghrib) return { error: 'parse' };
    return { adhan, iqama: awqafIqama(adhan), sourceUrl: AWQAF_PAGE_URL };
  } catch (e) {
    return { error: 'network' };
  }
}
function extractAwqafTimes(json) {
  const candidates = [];
  const walk = (node, depth) => {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }
    if (typeof node === 'object') {
      const lower = {};
      for (const [k, v] of Object.entries(node)) lower[k.toLowerCase()] = v;
      for (const [alias, canon] of [['fajer', 'fajr'], ['dhohur', 'dhuhr'], ['aser', 'asr'], ['maghreb', 'maghrib']]) {
        if (lower[alias] !== undefined && lower[canon] === undefined) lower[canon] = lower[alias];
      }
      const has = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'].every((k) => typeof lower[k] === 'string' || (lower[k] && typeof lower[k] === 'object'));
      if (has) candidates.push(lower);
      for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(json, 0);
  for (const c of candidates) {
    const pick = (v) => {
      if (typeof v === 'string') return to24h(v);
      if (v && typeof v === 'object') {
        for (const k of ['time', 'athan', 'adhan', 'value']) if (typeof v[k] === 'string') return to24h(v[k]);
      }
      return null;
    };
    const adhan = { Fajr: pick(c.fajr), Sunrise: pick(c.shuroq), Dhuhr: pick(c.dhuhr), Asr: pick(c.asr), Maghrib: pick(c.maghrib), Isha: pick(c.isha) };
    if (adhan.Fajr && adhan.Dhuhr && adhan.Asr && adhan.Maghrib && adhan.Isha) return adhan;
  }
  return null;
}

/* ---------------- Calculated (AlAdhan) ---------------- */
async function fetchCalculated(lat, lon, methodId, dateDDMMYYYY) {
  const url = `https://api.aladhan.com/v1/timings/${dateDDMMYYYY}?latitude=${lat}&longitude=${lon}&method=${methodId}`;
  const opts = {};
  const sig = timeoutSignal(FETCH_TIMEOUT_MS);
  if (sig) opts.signal = sig;
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error('aladhan-' + res.status);
  const json = await res.json();
  const t = json.data.timings;
  const adhan = { Fajr: normalizeTime(t.Fajr), Sunrise: normalizeTime(t.Sunrise), Dhuhr: normalizeTime(t.Dhuhr), Asr: normalizeTime(t.Asr), Maghrib: normalizeTime(t.Maghrib), Isha: normalizeTime(t.Isha) };
  const hijri = json.data.date && json.data.date.hijri ? `${json.data.date.hijri.day} ${json.data.date.hijri.month.en} ${json.data.date.hijri.year}` : '';
  return { adhan, iqama: null, timezone: json.data.meta ? json.data.meta.timezone : null, hijri };
}

/* ---------------- The chain ----------------
   Input: lat/lon, country code (ISO, e.g. 'US'), address parts
   { city, town, village, municipality, county, state, suburb } and
   dateStr 'YYYY-MM-DD' in the device's timezone.
   Output: { adhan, iqama, tier, sourceLabel, sourceName, sourceUrl,
   methodName, methodId, regionName, timezone, hijri }.
   tier is 'published' | 'awqaf' | 'calculated'. */
function toDDMMYYYY(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-');
  return `${d}-${m}-${y}`;
}
async function fetchCalculatedTier(lat, lon, countryCode, dateStr) {
  const methodId = countryDefaultMethod(countryCode);
  const calc = await fetchCalculated(lat, lon, methodId, toDDMMYYYY(dateStr));
  return {
    adhan: calc.adhan, iqama: null, tier: 'calculated',
    sourceLabel: 'calculated times', sourceName: null, sourceUrl: null,
    methodName: methodById(methodId).en, methodId,
    regionName: null, timezone: calc.timezone, hijri: calc.hijri
  };
}
async function getPrayerTimes({ lat, lon, countryCode, address, dateStr }) {
  // Tier 1: nearest verified mosque WITH a published table (<= 50 km).
  // Try each DISTINCT published source in distance order before any
  // calculated fallback (e.g. McLean after ADAMS, and vice versa).
  const scan = scanPublishedRegistry(lat, lon);
  if (scan.published) {
    const seenSources = new Set();
    const candidates = [];
    for (const m of scan.within) {
      if (m.hasTimetable && m.sourceId && !seenSources.has(m.sourceId)) {
        seenSources.add(m.sourceId);
        candidates.push(m);
      }
    }
    for (const cand of candidates) {
      const pub = await fetchPublished(cand.sourceId, dateStr, dateStr);
      if (pub) {
        return {
          adhan: pub.adhan, iqama: pub.iqama || null, tier: 'published',
          sourceLabel: cand.name + ' published schedule', sourceName: cand.name, sourceUrl: pub.sourceUrl,
          methodName: null, methodId: null, regionName: null, timezone: null,
          jumuah: pub.jumuah || null, hijri: ''
        };
      }
    }
    // All published fetches failed: fall through to labeled calculated.
    return fetchCalculatedTier(lat, lon, countryCode, dateStr);
  }
  // Tier 2: UAE Awqaf published at region level.
  if (isUAEPlace({ lat, lon, countryCode })) {
    const region = matchAwqafRegion(address);
    if (region) {
      const aw = await fetchAwqaf(region.id, dateStr);
      if (aw && !aw.error) {
        return {
          adhan: aw.adhan, iqama: aw.iqama || null, tier: 'awqaf',
          sourceLabel: 'Awqaf published times for ' + region.name, sourceName: null, sourceUrl: aw.sourceUrl,
          methodName: null, methodId: null, regionName: region.name, timezone: null, hijri: ''
        };
      }
      // Fetch failed (or key not configured): labeled calculated.
      return fetchCalculatedTier(lat, lon, countryCode, dateStr);
    }
    // Region could not be determined: labeled calculated.
    return fetchCalculatedTier(lat, lon, countryCode, dateStr);
  }
  // Tier 3: labeled calculated.
  return fetchCalculatedTier(lat, lon, countryCode, dateStr);
}

module.exports = {
  getPrayerTimes, fetchCalculated, fetchPublished, fetchAwqaf,
  scanPublishedRegistry, matchAwqafRegion, isUAEPlace, nextPrayer,
  timeToMinutes, addMinutesToTime, awqafIqama, to24h, normalizeTime,
  parseMasjidbox, parseMclean, methodById, countryDefaultMethod,
  resolveStoredMethod, haversineKm,
  REGISTRY, METHODS, UAE_REGIONS, COUNTRY_DEFAULTS, AWQAF_IQAMA_OFFSETS,
  MASJIDBOX_URL, MCLEAN_URL, AWQAF_PAGE_URL
};
