# Adhan scheduler — `scheduler/`

GitHub Actions job that runs every 5 minutes and fires the automatic
adhan. It computes **today's** prayer times with the skill's own chain
(`times.js` — ADAMS published → Awqaf published → labeled calculated)
and, at each prayer time, sends a `ChangeReport` to the Alexa Event
Gateway flipping that prayer's virtual motion sensor to `DETECTED`.
The sensor's routine then plays the adhan on the ONE named Echo.
Five–ten minutes later the sensor is re-armed (`NOT_DETECTED`) so
tomorrow's `DETECTED` is a state change again.

## Files

| File | What it is |
|---|---|
| `scheduler.js` | The polling script (modes: normal, `DRY_RUN=1`, `--fire <prayer>`, `--rearm <prayer>`) |
| `times.js` | **Copy** of the skill's `lambda/times.js` — sync rule in its header |
| `fetch-shim.js` | Copy of the skill's shim (no-op on Node 20; needed because `times.js` requires it) |
| `github.js` | GitHub REST helpers: Variables (state) + Secrets (tokens, sealed box) + keepalive commit |
| `package.json` | `tweetnacl` only (sealed-box encryption for Secret write-back) |

## Location

Fixed to the home area: Ashburn, VA (lat 39.009, lon -77.501 —
the same coordinates the skill falls back to), timezone
`America/New_York`. Override with `SCHED_LAT` / `SCHED_LON` /
`SCHED_TZ` if the household ever moves. Times come from the chain,
never hardcoded.

## Secrets (repo Settings → Secrets and variables → Actions)

Set by the user; never in chat or in a file:

| Secret | From |
|---|---|
| `ALEXA_CLIENT_ID` / `ALEXA_CLIENT_SECRET` | Skill → PERMISSIONS → "Alexa Skill Messaging" → SHOW |
| `LWA_ACCESS_TOKEN` / `LWA_REFRESH_TOKEN` | Written by the Smart Home Lambda at AcceptGrant time (auto-refreshed here) |
| `GH_PAT` | GitHub fine-grained PAT, repo scope on this repo |
| `AWQAF_API_KEY` | Optional — UAE tier only |

Until the skill is linked (AcceptGrant) the job logs "not linked yet"
and exits 0 — no failure emails before setup is done.

## Local test

```bash
npm install
DRY_RUN=1 node scheduler.js
```

Dry run computes today's real times and logs what WOULD fire. It
sends nothing and needs no secrets.
