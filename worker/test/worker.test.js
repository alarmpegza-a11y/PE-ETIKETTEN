// Tests für den Worker ohne echte Dienste: Dropbox, Firestore und Google werden nachgebildet.
// Start: cd worker && node --test test/
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { __test } from '../src/index.js';

const PID = 'etikette-fa8d1';
const ORIGIN = 'https://alarmpegza-a11y.github.io';

/* ---------- Schlüssel ---------- */
const b64url = u => Buffer.from(u).toString('base64url');
const idKey = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const fremdKey = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const saKey = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pubJwk = { ...(await crypto.subtle.exportKey('jwk', idKey.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const saPem = '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(await crypto.subtle.exportKey('pkcs8', saKey.privateKey)).toString('base64') + '\n-----END PRIVATE KEY-----\n';

async function token(uid, { anonym = false, key = idKey.privateKey, aud = PID, exp = 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const c = b64url(JSON.stringify({ iss: 'https://securetoken.google.com/' + aud, aud, sub: uid, iat: now - 10, exp: now + exp, firebase: { sign_in_provider: anonym ? 'anonymous' : 'password' } }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(h + '.' + c));
  return h + '.' + c + '.' + b64url(new Uint8Array(sig));
}

/* ---------- Nachgebildete Dienste ---------- */
let FS, DBX, calls;
const zuFs = __test.zuFs;
function fsDoc(coll, id, obj) { FS.set(coll + '/' + id, obj); }

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  const hdr = new Headers(init.headers || {});
  calls.push({ url, method });
  if (url === 'https://jwks.test') return Response.json({ keys: [pubJwk] }, { headers: { 'Cache-Control': 'max-age=3600' } });
  if (url === 'https://oauth2.googleapis.com/token') {
    const p = new URLSearchParams(init.body);
    const [h, c, s] = p.get('assertion').split('.');
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', saKey.publicKey, Buffer.from(s, 'base64url'), new TextEncoder().encode(h + '.' + c));
    return ok ? Response.json({ access_token: 'sa-token', expires_in: 3600 }) : new Response('bad', { status: 400 });
  }
  if (url.startsWith('https://firestore.googleapis.com/')) {
    assert.equal(hdr.get('Authorization'), 'Bearer sa-token');
    const m = /documents\/([^/]+)\/([^/?]+)/.exec(url); const key = m[1] + '/' + decodeURIComponent(m[2]);
    if (method === 'GET') { const d = FS.get(key); return d ? Response.json({ name: key, fields: zuFs(d).mapValue.fields }) : new Response('{}', { status: 404 }); }
    if (method === 'PATCH') { const body = JSON.parse(init.body); const { vonFs } = await import('../src/index.js'); FS.set(key, vonFs({ mapValue: { fields: body.fields } })); return Response.json({}); }
  }
  if (url === 'https://api.dropboxapi.com/oauth2/token') return Response.json({ access_token: 'dbx-token', expires_in: 14400 });
  if (url.startsWith('https://content.dropboxapi.com/2/files/upload')) {
    assert.equal(hdr.get('Authorization'), 'Bearer dbx-token');
    const raw = hdr.get('Dropbox-API-Arg'); assert.ok(/^[\x20-\x7e]*$/.test(raw), 'Header muss ASCII sein');
    const arg = JSON.parse(raw); const buf = new Uint8Array(await new Response(init.body).arrayBuffer());
    if (arg.mode === 'add' && !arg.autorename && DBX.has(arg.path.toLowerCase())) return new Response('{"error_summary":"path/conflict/file/"}', { status: 409 });
    DBX.set(arg.path.toLowerCase(), buf);
    return Response.json({ path_display: arg.path, rev: 'r' + DBX.size, size: buf.length });
  }
  if (url.startsWith('https://content.dropboxapi.com/2/files/download')) {
    const arg = JSON.parse(hdr.get('Dropbox-API-Arg')); const d = DBX.get(arg.path.toLowerCase());
    return d ? new Response(d, { headers: { 'Content-Length': String(d.length) } }) : new Response('{"error_summary":"path/not_found/"}', { status: 409 });
  }
  if (url.startsWith('https://api.dropboxapi.com/2/files/delete_v2')) {
    const p = JSON.parse(init.body).path.toLowerCase();
    if (!DBX.delete(p)) return new Response('{"error_summary":"path_lookup/not_found/"}', { status: 409 });
    return Response.json({});
  }
  throw new Error('Unerwarteter Aufruf ' + method + ' ' + url);
};

const env = () => ({
  FIREBASE_PROJECT_ID: PID, ALLOWED_ORIGINS: ORIGIN + ',http://localhost:8788', __JWKS_URL: 'https://jwks.test',
  DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's', DROPBOX_REFRESH_TOKEN: 'r', MONTEUR_PIN: '482913',
  FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sa@test', private_key: saPem, token_uri: 'https://oauth2.googleapis.com/token' })
});
const call = (path, { method = 'GET', tok, headers = {}, body } = {}) => worker.fetch(new Request('https://w.test' + path, {
  method, body, duplex: 'half', headers: { Origin: ORIGIN, ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...headers }
}), env(), { waitUntil() {} });

const PDF = new TextEncoder().encode('%PDF-1.4\n' + 'x'.repeat(5000) + '\n%%EOF');

beforeEach(() => {
  FS = new Map(); DBX = new Map(); calls = [];
  Object.assign(__test.MEM, { dbx: null, sa: null, rate: new Map(), pin: new Map() });
  fsDoc('rollen', 'buero1', { rolle: 'buero' });
  fsDoc('rollen', 'mont1', { rolle: 'monteur' });
  fsDoc('objekte', 'obj1', { name: 'Feldblumenweg' });
  fsDoc('elemente', 'el1', { objektId: 'obj1', pos: 'NZ 41.03', fotos: [] });
});

const dat = (pfad, o = {}) => call('/api/datei?pfad=' + encodeURIComponent(pfad), o);
const hoch = (tok, pfad, body = PDF, typ = 'application/pdf') => dat(pfad, { method: 'POST', tok, body, headers: { 'Content-Type': typ, 'Content-Length': String(body.length) } });
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);


test('health ohne Anmeldung', async () => {
  const r = await call('/api/health'); assert.equal(r.status, 200);
  const d = await r.json(); assert.equal(d.dropbox, true); assert.equal(d.firebase, true);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('CORS: fremde Seite bekommt keinen Allow-Origin', async () => {
  const r = await worker.fetch(new Request('https://w.test/api/health', { headers: { Origin: 'https://boese.example' } }), env());
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
});

test('ohne Token, falsches Token, fremder Schlüssel, falsches Projekt, abgelaufen: abgewiesen', async () => {
  const p = 'plaene/a_26-0412/p1.pdf';
  assert.equal((await dat(p)).status, 401);
  assert.equal((await dat(p, { tok: 'abc.def.ghi' })).status, 401);
  assert.equal((await dat(p, { tok: await token('x', { key: fremdKey.privateKey }) })).status, 401);
  assert.equal((await dat(p, { tok: await token('x', { aud: 'anderes-projekt' }) })).status, 401);
  assert.equal((await dat(p, { tok: await token('x', { exp: -120 }) })).status, 401);
});

test('Büro lädt Plan hoch, Extern lädt ihn herunter', async () => {
  const p = 'plaene/a_26-0412/mwm7abc12.pdf';
  const r = await hoch(await token('buero1'), p);
  assert.equal(r.status, 200, await r.clone().text());
  const d = await r.json();
  assert.equal(d.id, 'dbx:' + p); assert.equal(d.size, PDF.length);
  assert.ok(DBX.has('/' + p.toLowerCase()));
  const g = await dat(p, { tok: await token('anon1', { anonym: true }) });
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('Content-Type'), 'application/pdf');
  assert.match(g.headers.get('Content-Disposition'), /mwm7abc12\.pdf/);
  assert.deepEqual(new Uint8Array(await g.arrayBuffer()), PDF);
});

test('Plan-Upload: Monteur und Extern nicht, kein PDF, zu gross, nie überschreiben', async () => {
  const p = 'plaene/obj1/x1.pdf';
  assert.equal((await hoch(await token('mont1'), p)).status, 403);
  assert.equal((await hoch(await token('anon1', { anonym: true }), p)).status, 403);
  assert.equal((await hoch(await token('buero1'), p, new TextEncoder().encode('<html>boese</html>'))).status, 415);
  const gross = await dat(p, { method: 'POST', tok: await token('buero1'), body: PDF, headers: { 'Content-Length': String(60 * 1048576) } });
  assert.equal(gross.status, 413);
  assert.equal(DBX.size, 0);
  assert.equal((await hoch(await token('buero1'), p)).status, 200);
  const zweit = await hoch(await token('buero1'), p, new TextEncoder().encode('%PDF-1.4 anders'));
  assert.equal(zweit.status, 409, 'bestehende Datei wird nicht überschrieben');
  assert.deepEqual(DBX.get('/' + p), PDF);
});

test('Pfade: nur plaene/ und fotos/, keine Tricks', async () => {
  const t = await token('buero1');
  for (const p of ['geheim/x/y.pdf', 'plaene/../fotos/x.pdf', 'plaene/a/b/c.pdf', 'plaene/a/x.jpg', 'fotos/a/x.pdf', '/plaene/a/x.pdf', 'plaene/a/x.pdf.exe', 'plaene/a/x', 'plaene/../x.pdf', 'plaene/a/..pdf'])
    assert.equal((await hoch(t, p)).status, 400, p);
  assert.equal((await dat('plaene/a/x.pdf', { tok: t, method: 'PUT' })).status, 404);
});

test('Download: fehlende Datei 404', async () => {
  assert.equal((await dat('plaene/obj1/gibtsnicht.pdf', { tok: await token('anon1', { anonym: true }) })).status, 404);
});

test('Plan löschen: nur Büro, doppelt ok', async () => {
  const p = 'plaene/obj1/l1.pdf';
  await hoch(await token('buero1'), p);
  assert.equal((await dat(p, { method: 'DELETE', tok: await token('mont1') })).status, 403);
  assert.equal((await dat(p, { method: 'DELETE', tok: await token('anon1', { anonym: true }) })).status, 403);
  assert.equal(DBX.size, 1);
  assert.equal((await dat(p, { method: 'DELETE', tok: await token('buero1') })).status, 200);
  assert.equal(DBX.size, 0);
  assert.equal((await dat(p, { method: 'DELETE', tok: await token('buero1') })).status, 200);
});

test('Fotos: Monteur lädt hoch und löscht, Extern nicht, falscher Typ abgewiesen', async () => {
  const p = 'fotos/ba_2026102735/f1.jpg';
  assert.equal((await hoch(await token('anon1', { anonym: true }), p, JPG, 'image/jpeg')).status, 403);
  assert.equal((await hoch(await token('mont1'), p, JPG, 'text/html')).status, 415);
  assert.equal((await hoch(await token('mont1'), p, JPG, 'image/jpeg')).status, 200);
  const g = await dat(p, { tok: await token('anon1', { anonym: true }) });
  assert.equal(g.status, 200); assert.equal(g.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual(new Uint8Array(await g.arrayBuffer()), JPG);
  assert.equal((await dat(p, { method: 'DELETE', tok: await token('anon1', { anonym: true }) })).status, 403);
  assert.equal((await dat(p, { method: 'DELETE', tok: await token('mont1') })).status, 200);
  assert.equal(DBX.size, 0);
});

test('Monteur-PIN: falsch, gesperrt nach 5 Versuchen, richtig setzt Rolle', async () => {
  const t = await token('anon2', { anonym: true });
  const pin = p => call('/api/monteur-pin', { method: 'POST', tok: t, body: JSON.stringify({ pin: p }), headers: { 'Content-Type': 'application/json' } });
  assert.equal((await pin('000000')).status, 403);
  const t3 = await token('anon3', { anonym: true });
  const ok = await call('/api/monteur-pin', { method: 'POST', tok: t3, body: JSON.stringify({ pin: '482913' }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(ok.status, 200); assert.equal((await ok.json()).rolle, 'monteur');
  assert.equal(FS.get('rollen/anon3').rolle, 'monteur');
  for (let i = 0; i < 4; i++) await pin('111111');
  assert.equal((await pin('482913')).status, 429, 'nach 5 Fehlversuchen gesperrt, auch mit richtigem PIN');
  assert.equal(FS.get('rollen/anon2'), undefined);
});

test('PIN stuft Büro nicht herunter', async () => {
  const r = await call('/api/monteur-pin', { method: 'POST', tok: await token('buero1'), body: JSON.stringify({ pin: '482913' }) });
  assert.equal((await r.json()).rolle, 'buero');
  assert.equal(FS.get('rollen/buero1').rolle, 'buero');
});

test('me liefert Rolle', async () => {
  assert.equal((await (await call('/api/me', { tok: await token('mont1') })).json()).rolle, 'monteur');
  assert.equal((await (await call('/api/me', { tok: await token('wer', { anonym: true }) })).json()).rolle, 'extern');
});

test('Hilfsfunktionen', () => {
  assert.equal(__test.headerJson({ path: '/ä' }), '{"path":"/' + '\\' + 'u00e4"}');
  assert.equal(__test.dateiPfad('plaene/a_26-0412.X/p1.pdf').dbx, '/plaene/a_26-0412.X/p1.pdf');
  assert.equal(__test.dateiPfad('fotos/ba_1/f.jpg').typ, 'image/jpeg');
});
