'use strict';
/* Minimal fetch() polyfill for Lambda runtimes without a global fetch
   (Node.js < 18). The Alexa-hosted Lambda for this skill runs a runtime
   with no global fetch (proven by CloudWatch: "ReferenceError: fetch
   is not defined"), so this installs one built on node:http/https.
   It supports exactly what this skill uses: GET/POST, headers, a
   string body, an AbortSignal, and res.ok / res.status / res.text() /
   res.json(). It is a no-op when a native fetch already exists. */
if (typeof fetch === 'undefined') {
  const http = require('http');
  const https = require('https');
  globalThis.fetch = function fetchPolyfill(url, options) {
    options = options || {};
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (e) {
        reject(e);
        return;
      }
      const lib = parsed.protocol === 'http:' ? http : https;
      const req = lib.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: options.headers || {}
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          // Headers with a fetch-compatible .get(name) (case-insensitive).
          const headerMap = {};
          for (const [k, v] of Object.entries(res.headers || {})) headerMap[String(k).toLowerCase()] = v;
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: { get: (name) => headerMap[String(name).toLowerCase()] ?? null },
            text: () => Promise.resolve(buf.toString('utf8')),
            json: () => Promise.resolve(JSON.parse(buf.toString('utf8')))
          });
        });
      });
      req.on('error', reject);
      if (options.signal) {
        if (options.signal.aborted) {
          req.destroy(new Error('AbortError'));
          return;
        }
        options.signal.addEventListener('abort', () => req.destroy(new Error('AbortError')), { once: true });
      }
      if (options.body) req.write(options.body);
      req.end();
    });
  };
}
module.exports = {};
