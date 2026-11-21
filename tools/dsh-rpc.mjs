// Call a DSH host's Connection RPC over its /api transport.
//
// WHY THIS EXISTS: the desktop app's workspace registry is owned by the app's
// SessionController, not by the session store on disk. Writing session files under
// the workspace path is not enough -- the session only appears in the UI when the
// app itself records it against a workspace. The app exposes that through its
// /api Connection RPC, which is how its own renderer talks to it.
//
// Wire format, read from the shipped dsh-client-connection implementation:
//
//   POST /api/<namespace>/<method>
//   body: { type: "client-request", rpcId: "<string>", method: "<ns>/<method>", payload: <any> }
//   200:  { type: "server-response", rpcId, result: { ok: true, value } | { ok: false, error } }
//
// Every request needs the browser-session cookie, which the host verifies with a
// secret persisted in the credentials file (see dsh-auth.mjs for the format).
//
// Usage:
//   node dsh-rpc.mjs <dshHome> <authority> <namespace/method> [jsonPayload]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

const [dshHome, authority, endpoint, payloadArg] = process.argv.slice(2);
if (!dshHome || !authority || !endpoint) {
  console.error('usage: node dsh-rpc.mjs <dshHome> <authority> <namespace/method> [jsonPayload]');
  process.exit(2);
}

const b64u = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

function cookieFor(home, auth) {
  const text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
  const m = text.match(/client-connection\/browser-session:\s*\n\s+kind:\s*grant\s*\n\s+payload:\s*\n\s+version:\s*\d+\s*\n\s+secret:\s*(\S+)/);
  if (!m) throw new Error('no browser-session secret in ' + home);
  const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  const now = Date.now();
  const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority: auth, issuedAt: now, expiresAt: now + 7 * 86400000 }), 'utf8'));
  const sig = crypto.createHmac('sha256', secret).update(body).digest();
  const name = 'dsh-auth-' + b64u(crypto.createHash('sha256').update(auth).digest());
  return name + '=v1.' + body + '.' + b64u(sig);
}

const cookie = cookieFor(dshHome, authority);

// Accept either inline JSON or an @file reference. Quoting a JSON object through a
// shell is fragile enough that the file form is the documented way to pass anything
// with nested structure.
function readPayload(arg) {
  if (!arg) return {};
  if (arg.startsWith('@')) return JSON.parse(fs.readFileSync(arg.slice(1), 'utf8'));
  return JSON.parse(arg);
}
const [host, port] = authority.split(':');
const body = JSON.stringify({
  type: 'client-request',
  rpcId: 'fleet-' + crypto.randomUUID(),
  method: endpoint,
  // The host demands exactly one plain-object `args` field. Passing the payload
  // through a caller-supplied JSON string is also a constant source of quoting
  // damage on the way in (PowerShell eats bare double quotes), so a file is
  // preferred whenever the payload is not trivial.
  payload: { args: readPayload(payloadArg) },
});

// The RPC endpoint is namespaced under /api by endpointFromPath, so the URL path
// and the envelope's method field must agree.
const req = http.request({
  host: host === 'localhost' ? '127.0.0.1' : host,
  port: Number(port),
  path: '/api/' + endpoint,
  method: 'POST',
  headers: {
    Host: authority,
    Cookie: cookie,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  },
}, (res) => {
  let data = '';
  res.on('data', (d) => { data += d.toString('utf8'); });
  res.on('end', () => {
    if (res.statusCode !== 200) {
      console.log(JSON.stringify({ httpStatus: res.statusCode, body: data.slice(0, 1500) }, null, 2));
      process.exit(1);
    }
    try {
      const parsed = JSON.parse(data);
      console.log(JSON.stringify(parsed, null, 2));
      if (parsed.result && parsed.result.ok === false) process.exit(1);
    } catch {
      console.log(data.slice(0, 2000));
    }
  });
});
req.on('error', (e) => { console.error('request failed: ' + e.message); process.exit(1); });
req.setTimeout(30000, () => req.destroy(new Error('timeout')));
req.write(body);
req.end();
