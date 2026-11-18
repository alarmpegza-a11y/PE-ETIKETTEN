// Prüft den Worker in der echten Cloudflare-Laufzeit (workerd via `wrangler dev`) gegen die Testdienste.
// 1) node test/workerd-check.mjs vars      -> schreibt worker/.dev.vars (zeigt auf den Testserver)
// 2) node test/dev-server.mjs              (Port 8788)
// 3) cd worker && npx wrangler dev --port 8787
// 4) node test/workerd-check.mjs           -> führt die Prüfungen aus
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const T = 'http://localhost:8788', W = 'http://localhost:8787';
if (process.argv[2] === 'vars') {
  const k = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign']);
  const pem = '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(await crypto.subtle.exportKey('pkcs8', k.privateKey)).toString('base64') + '\n-----END PRIVATE KEY-----\n';
  const sa = JSON.stringify({ client_email: 'sa@test', private_key: pem, token_uri: T + '/mock/oauth' });
  writeFileSync(new URL('../worker/.dev.vars', import.meta.url), [
    'DROPBOX_APP_KEY=k', 'DROPBOX_APP_SECRET=s', 'DROPBOX_REFRESH_TOKEN=r', 'MONTEUR_PIN=123456',
    `FIREBASE_SERVICE_ACCOUNT='${sa}'`, `__JWKS_URL=${T}/mock/jwks`, `__FIRESTORE_URL=${T}/mockfs`,
    `__DBX_API=${T}/dbx/oauth2/token`, `__DBX_CONTENT=${T}/dbx`, `__DBX_RPC=${T}/dbx`, `ALLOWED_ORIGINS=${T}`
  ].join('\n') + '\n');
  console.log('worker/.dev.vars geschrieben'); process.exit(0);
}

const tok = (uid, anon = 0) => fetch(`${T}/mock/token?uid=${uid}&anon=${anon}`).then(r => r.text());
const buero = await tok('buero1'), extern = await tok('anonX', 1);
const P = 'plaene/a_26-0412/gross1.pdf';
const D = (pfad, o = {}) => fetch(W + '/api/datei?pfad=' + encodeURIComponent(pfad), o);

// 1) Grosses PDF (30 MB) als Strom hochladen
const gross = new Uint8Array(30 * 1048576); gross.set(new TextEncoder().encode('%PDF-1.7\n')); for (let i = 9; i < gross.length; i += 4096) gross[i] = i % 251;
let t = Date.now();
let r = await D(P, { method: 'POST', body: gross, headers: { Authorization: 'Bearer ' + buero, Origin: T, 'Content-Type': 'application/pdf' } });
const up = await r.json();
assert.equal(r.status, 200, JSON.stringify(up)); assert.equal(up.size, gross.length);
assert.equal(r.headers.get('access-control-allow-origin'), T);
console.log(`Upload 30 MB ok (${Date.now() - t} ms)`, up.id);

t = Date.now();
r = await D(P, { headers: { Authorization: 'Bearer ' + extern } });
assert.equal(r.status, 200);
const d = new Uint8Array(await r.arrayBuffer());
assert.equal(d.length, gross.length); assert.ok(d.every((x, i) => x === gross[i]), 'Inhalt gleich');
assert.equal(r.headers.get('content-length'), String(gross.length));
console.log(`Download 30 MB ok (${Date.now() - t} ms), Inhalt identisch`);

// 2) Kein PDF, Extern, ohne Token, zu gross
r = await D('plaene/a_26-0412/k.pdf', { method: 'POST', body: new TextEncoder().encode('<html>'), headers: { Authorization: 'Bearer ' + buero } });
assert.equal(r.status, 415); await r.text();
r = await D('plaene/a_26-0412/e.pdf', { method: 'POST', body: gross, headers: { Authorization: 'Bearer ' + extern } });
assert.equal(r.status, 403); await r.text();
r = await D(P); assert.equal(r.status, 401); await r.text();
const zuGross = new Uint8Array(51 * 1048576); zuGross.set(new TextEncoder().encode('%PDF-1.7\n'));
r = await D('plaene/a_26-0412/z.pdf', { method: 'POST', body: zuGross, headers: { Authorization: 'Bearer ' + buero } });
assert.equal(r.status, 413); await r.text();
console.log('Abweisungen ok (kein PDF 415, Extern 403, ohne Token 401, >50 MB 413)');

// 3) Health, PIN
r = await fetch(W + '/api/health'); console.log('Health', await r.json());
r = await fetch(W + '/api/monteur-pin', { method: 'POST', body: JSON.stringify({ pin: '123456' }), headers: { Authorization: 'Bearer ' + extern, 'Content-Type': 'application/json' } });
assert.equal((await r.json()).rolle, 'monteur'); console.log('PIN ok');
console.log('\nALLE PRÜFUNGEN IN WORKERD BESTANDEN');
