'use strict';
/* Adhan scheduler — GitHub Actions job, runs every 5 minutes (UTC).
   Computes TODAY's prayer times with the skill's own chain
   (./times.js: ADAMS published -> Awqaf published -> labeled
   calculated) and, at each prayer time, sends a ChangeReport to the
   Alexa Event Gateway flipping that prayer's virtual motion sensor to
   DETECTED. The sensor's routine then plays the adhan on the ONE
   named Echo. Five minutes later the sensor is re-armed
   (NOT_DETECTED) so tomorrow's DETECTED is a state change again.

   Location is FIXED to the home area (Ashburn, VA — the same
   coordinates the skill falls back to when no device address is
   available). Override with SCHED_LAT / SCHED_LON / SCHED_TZ if the
   household ever moves.

   Environment (GitHub Secrets, set by the user in the repo UI):
     ALEXA_CLIENT_ID / ALEXA_CLIENT_SECRET — skill PERMISSIONS ->
       "Alexa Skill Messaging". Used only for token refresh.
     LWA_ACCESS_TOKEN / LWA_REFRESH_TOKEN — written by the Smart Home
       Lambda at AcceptGrant time; refreshed here and written back.
     GH_PAT — fine-grained PAT (repo scope) for Variables/Secrets.
     AWQAF_API_KEY — optional, UAE tier only.
   Modes:
     DRY_RUN=1   compute times and log what WOULD fire; send nothing.
     --fire dhuhr   send one DETECTED ChangeReport for that sensor
                    (manual Test 2 trigger). Needs a valid access token.
     --rearm dhuhr  send one NOT_DETECTED ChangeReport for that sensor.
   No token value is ever logged. */

const { getPrayerTimes, timeToMinutes } = require('./times');
const gh = require('./github');

const TIMEZONE = process.env.SCHED_TZ || 'America/New_York';
const LOCATION = {
  lat: Number(process.env.SCHED_LAT || 39.009),
  lon: Number(process.env.SCHED_LON || -77.501),
  countryCode: 'US',
  address: { city: 'Ashburn', state: 'Virginia' },
};
const EVENT_GATEWAY = 'https://api.amazonalexa.com/v3/events';
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const FIRE_WINDOW_MIN = 10; // catch-up: a run up to 10 min late still fires
const REARM_AFTER_MIN = 10; // re-arm a sensor DETECTED for >10 min

const PRAYERS = [
  { key: 'Fajr', endpointId: 'prayer-adhan-fajr' },
  { key: 'Dhuhr', endpointId: 'prayer-adhan-dhuhr' },
  { key: 'Asr', endpointId: 'prayer-adhan-asr' },
  { key: 'Maghrib', endpointId: 'prayer-adhan-maghrib' },
  { key: 'Isha', endpointId: 'prayer-adhan-isha' },
];

function log(...args) { console.log('[scheduler]', ...args); }
function warn(...args) { console.warn('[scheduler]', ...args); }
function fail(msg) { console.error('[scheduler] FATAL:', msg); process.exit(1); }

// Local date/time in the prayer timezone.
function localNow() {
  const now = new Date();
  const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23' });
  const dateStr = dateFmt.format(now); // YYYY-MM-DD
  const [hh, mm] = timeFmt.format(now).split(':').map(Number);
  return { dateStr, minutes: hh * 60 + mm, iso: now.toISOString() };
}

function newState(dateStr) {
  return { date: dateStr, fired: {}, sensors: {}, detectedAt: {} };
}

async function loadState(dateStr) {
  try {
    const raw = await gh.getVariable('PRAYER_STATE');
    if (!raw) return newState(dateStr);
    const state = JSON.parse(raw);
    if (!state || state.date !== dateStr) return newState(dateStr);
    state.fired = state.fired || {};
    state.sensors = state.sensors || {};
    state.detectedAt = state.detectedAt || {};
    return state;
  } catch (e) {
    warn('could not read PRAYER_STATE, starting fresh:', e.message);
    return newState(dateStr);
  }
}

async function saveState(state) {
  await gh.setVariable('PRAYER_STATE', JSON.stringify(state));
}

// ---- LWA tokens: refresh when the access token is missing or about
// to expire; write the new pair back to repo Secrets. ----
async function ensureAccessToken() {
  let accessToken = process.env.LWA_ACCESS_TOKEN || '';
  const refreshToken = process.env.LWA_REFRESH_TOKEN || '';
  let expiresAt = 0;
  try {
    const metaRaw = await gh.getVariable('LWA_TOKEN_META');
    if (metaRaw) {
      const meta = JSON.parse(metaRaw);
      expiresAt = Number(meta.access_expires_at) || 0;
    }
  } catch (e) { warn('could not read LWA_TOKEN_META:', e.message); }

  const needsRefresh = !accessToken || !expiresAt || expiresAt - Date.now() < 15 * 60 * 1000;
  if (!needsRefresh) return accessToken;
  if (!refreshToken) {
    log('No refresh token available — skill not linked yet, or Secrets not set. Skipping this run.');
    return null;
  }
  const clientId = process.env.ALEXA_CLIENT_ID || '';
  const clientSecret = process.env.ALEXA_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) fail('Cannot refresh: ALEXA_CLIENT_ID / ALEXA_CLIENT_SECRET secrets are not set.');
  const form = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: refreshToken,
    client_id: clientId, client_secret: clientSecret,
  });
  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) fail('LWA token refresh failed (HTTP ' + res.status + ').');
  const data = await res.json();
  if (!data.access_token || !data.refresh_token) fail('LWA token refresh returned no tokens.');
  const newExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  await gh.setSecret('LWA_ACCESS_TOKEN', data.access_token);
  await gh.setSecret('LWA_REFRESH_TOKEN', data.refresh_token);
  await gh.setVariable('LWA_TOKEN_META', JSON.stringify({ access_expires_at: newExpiresAt }));
  log('Access token refreshed and stored.');
  return data.access_token;
}

// ---- ChangeReport to the Alexa Event Gateway ----
async function sendChangeReport(accessToken, endpointId, detectionState) {
  const t = new Date().toISOString();
  const body = {
    context: {
      properties: [
        { namespace: 'Alexa.MotionSensor', name: 'detectionState', value: detectionState, timeOfSample: t, uncertaintyInMilliseconds: 0 },
        { namespace: 'Alexa.EndpointHealth', name: 'connectivity', value: 'OK', timeOfSample: t, uncertaintyInMilliseconds: 0 },
      ],
    },
    event: {
      header: { namespace: 'Alexa', name: 'ChangeReport', payloadVersion: '3', messageId: require('crypto').randomUUID() },
      endpoint: { scope: { type: 'BearerToken', token: accessToken }, endpointId },
      payload: {
        change: {
          cause: { type: 'PERIODIC' },
          properties: [
            { namespace: 'Alexa.MotionSensor', name: 'detectionState', value: detectionState, timeOfSample: t, uncertaintyInMilliseconds: 0 },
          ],
        },
      },
    },
  };
  const res = await fetch(EVENT_GATEWAY, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return res.status;
}

// ---- monthly keepalive: public-repo schedules auto-disable after
// 60 days without repository activity. ----
async function maybeKeepalive(dateStr) {
  const monthKey = dateStr.slice(0, 7); // YYYY-MM
  if (dateStr.slice(8, 10) !== '01') return; // only on the 1st
  try {
    const last = await gh.getVariable('LAST_KEEPALIVE');
    if (last === monthKey) return;
    await gh.commitKeepalive(monthKey);
    await gh.setVariable('LAST_KEEPALIVE', monthKey);
    log('Keepalive commit done for', monthKey);
  } catch (e) {
    warn('Keepalive commit failed (non-fatal):', e.message);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = process.env.DRY_RUN === '1';
  const fireIdx = args.indexOf('--fire');
  const rearmIdx = args.indexOf('--rearm');
  const manual = fireIdx >= 0 ? { mode: 'fire', key: args[fireIdx + 1] }
    : rearmIdx >= 0 ? { mode: 'rearm', key: args[rearmIdx + 1] } : null;

  const { dateStr, minutes: nowMin } = localNow();

  // Manual modes: no state, no times — just send one ChangeReport.
  if (manual) {
    const prayer = PRAYERS.find((p) => p.key.toLowerCase() === String(manual.key || '').toLowerCase());
    if (!prayer) fail(`Unknown prayer "${manual.key}". Use Fajr, Dhuhr, Asr, Maghrib or Isha.`);
    if (dryRun) { log(`DRY RUN: would send ${manual.mode === 'fire' ? 'DETECTED' : 'NOT_DETECTED'} for ${prayer.endpointId}.`); return; }
    const token = await ensureAccessToken();
    if (!token) fail('No access token — the skill is not linked yet, or Secrets are not set.');
    const status = await sendChangeReport(token, prayer.endpointId, manual.mode === 'fire' ? 'DETECTED' : 'NOT_DETECTED');
    if (status === 202) { log(`Manual ${manual.mode} sent for ${prayer.endpointId} (202).`); return; }
    fail(`Manual ${manual.mode} rejected by the event gateway (HTTP ${status}).`);
  }

  // Normal run: compute today's times with the skill's own chain.
  let times;
  try {
    times = await getPrayerTimes({ ...LOCATION, dateStr });
  } catch (e) {
    fail('Could not compute prayer times: ' + e.message);
  }
  const adhan = times.adhan || {};
  log(`Date ${dateStr} (${TIMEZONE}), now ${String(Math.floor(nowMin / 60)).padStart(2, '0')}:${String(nowMin % 60).padStart(2, '0')}, tier=${times.tier}` +
    (times.sourceLabel ? `, source=${times.sourceLabel}` : '') +
    `. Times: ${PRAYERS.map((p) => `${p.key} ${adhan[p.key] || '?'}`).join(', ')}`);
  if (dryRun) {
    for (const p of PRAYERS) {
      const t = timeToMinutes(adhan[p.key]);
      if (!Number.isFinite(t)) { log(`DRY RUN: ${p.key} — no time.`); continue; }
      const inWindow = nowMin >= t && nowMin < t + FIRE_WINDOW_MIN;
      log(`DRY RUN: ${p.key} at ${adhan[p.key]} — ${inWindow ? 'WOULD FIRE now' : 'not in window'}.`);
    }
    return;
  }

  // Nothing to send without a token — but that is "not linked yet",
  // not a crash: log clearly and exit 0.
  const token = await ensureAccessToken();
  if (!token) return;

  const state = await loadState(dateStr);
  let changed = false;

  async function send(endpointId, detectionState, allowRetry) {
    let status = await sendChangeReport(token, endpointId, detectionState);
    if (status === 401 && allowRetry) {
      warn('Event gateway returned 401 — refreshing token once and retrying.');
      const fresh = await ensureAccessToken();
      if (fresh && fresh !== token) status = await sendChangeReport(fresh, endpointId, detectionState);
    }
    return status;
  }

  for (const p of PRAYERS) {
    const t = timeToMinutes(adhan[p.key]);
    if (!Number.isFinite(t)) continue;
    // Fire: inside the window and not fired today.
    if (!state.fired[p.key] && nowMin >= t && nowMin < t + FIRE_WINDOW_MIN) {
      const status = await send(p.endpointId, 'DETECTED', true);
      if (status === 202) {
        state.fired[p.key] = true;
        state.sensors[p.endpointId] = 'DETECTED';
        state.detectedAt[p.endpointId] = Date.now();
        changed = true;
        log(`Fired ${p.key} (${adhan[p.key]}) — sensor ${p.endpointId} -> DETECTED.`);
      } else {
        fail(`ChangeReport for ${p.key} rejected (HTTP ${status}). Stopping — no spam.`);
      }
      continue;
    }
    // Missed window (a dropped GitHub run): say so plainly, once.
    if (!state.fired[p.key] && nowMin >= t + FIRE_WINDOW_MIN) {
      log(`Missed ${p.key} (${adhan[p.key]}) — outside the ${FIRE_WINDOW_MIN}-minute window.`);
      state.fired[p.key] = 'missed';
      changed = true;
    }
    // Re-arm: DETECTED for more than REARM_AFTER_MIN -> NOT_DETECTED.
    if (state.sensors[p.endpointId] === 'DETECTED' && state.detectedAt[p.endpointId]
      && Date.now() - state.detectedAt[p.endpointId] > REARM_AFTER_MIN * 60 * 1000) {
      const status = await send(p.endpointId, 'NOT_DETECTED', true);
      if (status === 202) {
        state.sensors[p.endpointId] = 'NOT_DETECTED';
        delete state.detectedAt[p.endpointId];
        changed = true;
        log(`Re-armed ${p.key} sensor -> NOT_DETECTED.`);
      } else {
        warn(`Re-arm for ${p.key} rejected (HTTP ${status}) — will retry next run.`);
      }
    }
  }

  if (changed) await saveState(state);
  await maybeKeepalive(dateStr);
  log('Run complete.');
}

main().catch((e) => fail(e.message));
