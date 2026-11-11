'use strict';
/* GitHub REST helpers for the adhan scheduler.
   - Repo Variables: non-secret state (PRAYER_STATE, LWA_TOKEN_META).
     Variables are NOT a safe place for tokens — they are readable by
     anyone with repo read access. Tokens go in Secrets only.
   - Repo Secrets: LWA_ACCESS_TOKEN / LWA_REFRESH_TOKEN. Values are
     sealed with the repo's public key (libsodium sealed box, via
     tweetnacl) before PUT, per the GitHub API.
   - Contents API: the monthly keepalive commit.
   Auth: GH_PAT (a fine-grained PAT with repo scope on this repo).
   The workflow's default GITHUB_TOKEN cannot update secrets, which is
   why GH_PAT exists. No token value is ever logged. */

const nacl = require('tweetnacl');

const GITHUB_API = 'https://api.github.com';

function repo() {
  return process.env.GITHUB_REPO || 'mahmedsud16-stack/prayer-adhan-scheduler';
}

function pat() {
  const token = process.env.GH_PAT || '';
  if (!token) throw new Error('GH_PAT is not set — cannot read/write GitHub state');
  return token;
}

async function gh(method, path, body) {
  const res = await fetch(GITHUB_API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + pat(),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'prayer-adhan-scheduler/1.0',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON body */ }
  return { status: res.status, json };
}

async function getVariable(name) {
  const res = await gh('GET', `/repos/${repo()}/actions/variables/${name}`);
  if (res.status !== 200) return null;
  return res.json.value;
}

async function setVariable(name, value) {
  const existing = await gh('GET', `/repos/${repo()}/actions/variables/${name}`);
  let res;
  if (existing.status === 200) {
    res = await gh('PATCH', `/repos/${repo()}/actions/variables/${name}`, { value });
  } else {
    res = await gh('POST', `/repos/${repo()}/actions/variables`, { name, value });
  }
  if (res.status !== 201 && res.status !== 204) {
    throw new Error(`could not write variable ${name} (status ${res.status})`);
  }
}

async function setSecret(name, value) {
  const keyRes = await gh('GET', `/repos/${repo()}/actions/secrets/public-key`);
  if (keyRes.status !== 200) throw new Error('could not read repo public key (status ' + keyRes.status + ')');
  const publicKey = Buffer.from(keyRes.json.key, 'base64');
  const encrypted = nacl.box.seal(Buffer.from(value, 'utf8'), publicKey);
  const put = await gh('PUT', `/repos/${repo()}/actions/secrets/${name}`, {
    encrypted_value: Buffer.from(encrypted).toString('base64'),
    key_id: keyRes.json.key_id,
  });
  if (put.status !== 201 && put.status !== 204) {
    throw new Error(`could not write secret ${name} (status ${put.status})`);
  }
}

// Monthly keepalive: public-repo schedules auto-disable after 60 days
// without repository activity. A small commit on the 1st of each month
// keeps the schedule alive.
async function commitKeepalive(monthKey) {
  const path = '.github/keepalive.txt';
  const content = Buffer.from(`adhan-scheduler keepalive ${monthKey}\n`).toString('base64');
  const existing = await gh('GET', `/repos/${repo()}/contents/${path}`);
  const body = { message: `Keepalive ${monthKey}`, content };
  if (existing.status === 200 && existing.json && existing.json.sha) body.sha = existing.json.sha;
  const res = await gh('PUT', `/repos/${repo()}/contents/${path}`, body);
  if (res.status !== 201 && res.status !== 200) {
    throw new Error('keepalive commit failed (status ' + res.status + ')');
  }
}

module.exports = { getVariable, setVariable, setSecret, commitKeepalive, repo };
