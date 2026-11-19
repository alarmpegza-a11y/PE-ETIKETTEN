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
  if (url.startsWith('https://firestore.googleapis.com/') && !url.endsWith(':commit')) {
    assert.equal(hdr.get('Authorization'), 'Bearer sa-token');
    const m = /documents\/([^/]+)\/([^/?]+)/.exec(url); const key = m[1] + '/' + decodeURIComponent(m[2]);
    if (method === 'GET') { const d = FS.get(key); return d ? Response.json({ name: key, fields: zuFs(d).mapValue.fields }) : new Response('{}', { status: 404 }); }
    const { vonFs } = await import('../src/index.js');
    if (method === 'PATCH') {
      const q = new URL(url).searchParams; const maske = q.getAll('updateMask.fieldPaths');
      if (q.get('currentDocument.exists') === 'true' && !FS.has(key)) return new Response('{}', { status: 404 });
      const neu = vonFs({ mapValue: { fields: JSON.parse(init.body).fields } });
      if (maske.length) { const alt = { ...(FS.get(key) || {}) }; for (const f of maske) { if (f in neu) alt[f] = neu[f]; else delete alt[f]; } FS.set(key, alt); }
      else FS.set(key, neu);
      return Response.json({});
    }
  }
  if (url.startsWith('https://firestore.googleapis.com/') && url.endsWith(':commit')) {
    const { vonFs } = await import('../src/index.js');
    for (const w of JSON.parse(init.body).writes) {
      const key = w.transform.document.split('/documents/')[1];
      if (!FS.has(key)) return new Response('{}', { status: 404 });
      const d = { ...FS.get(key) };
      for (const t of w.transform.fieldTransforms) { const arr = [...(d[t.fieldPath] || [])]; for (const v of t.appendMissingElements.values) { const x = vonFs(v); if (!arr.some(y => JSON.stringify(y) === JSON.stringify(x))) arr.push(x); } d[t.fieldPath] = arr; }
      FS.set(key, d);
    }
    return Response.json({});
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



const K = 'Ab3dEf6hIj9kLm2nOp5q';            // gültiger Etiketten-Schlüssel
const TAG = 864e5;
function scanDaten({ alterTage = 1, behaltenBis = null, tage } = {}) {
  fsDoc('objekte', 'obj1', { name: 'Feldblumenweg', kunde: 'Sada AG', created: Date.now() - alterTage * TAG, ...(behaltenBis ? { behaltenBis } : {}) });
  if (tage != null) fsDoc('settings', 'app', { aufbewahrungTage: tage });
  fsDoc('plaene', 'p1', { objektId: 'obj1', art: 'montage', name: 'Montage Zürich.pdf', fileId: 'dbx:plaene/obj1/p1.pdf', size: PDF.length, fertig: true });
  fsDoc('plaene', 'p2', { objektId: 'obj1', art: 'detail', name: 'Detail alt.pdf', fileId: 'altfirestore1', fertig: true });
  fsDoc('elemente', 'el1', { objektId: 'obj1', pos: 'NZ 41.03', bezeichnung: 'Dusche', zugang: K, montagePlanId: 'p1', detailPlanId: 'p2', status: 'geliefert', fotos: [], intern: 'geheim' });
  fsDoc('zugaenge', K, { elementId: 'el1' });
  DBX.set('/plaene/obj1/p1.pdf', PDF);
}
const scan = (pfad, o = {}) => call('/api/scan' + pfad, o);
async function sitzung() { const r = await scan('/pin', { method: 'POST', body: JSON.stringify({ pin: '482913' }), headers: { 'Content-Type': 'application/json' } }); return (await r.json()).sitzung; }

test('health ohne Anmeldung', async () => {
  const r = await call('/api/health'); assert.equal(r.status, 200);
  const d = await r.json(); assert.equal(d.dropbox, true); assert.equal(d.firebase, true);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('CORS: fremde Seite bekommt keinen Allow-Origin', async () => {
  const r = await worker.fetch(new Request('https://w.test/api/health', { headers: { Origin: 'https://boese.example' } }), env());
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
});

test('Büro-Dateien: ohne, falsches, fremdes, abgelaufenes Token abgewiesen', async () => {
  const p = 'plaene/a_26-0412/p1.pdf';
  assert.equal((await dat(p)).status, 401);
  assert.equal((await dat(p, { tok: 'abc.def.ghi' })).status, 401);
  assert.equal((await dat(p, { tok: await token('x', { key: fremdKey.privateKey }) })).status, 401);
  assert.equal((await dat(p, { tok: await token('x', { aud: 'anderes-projekt' }) })).status, 401);
  assert.equal((await dat(p, { tok: await token('x', { exp: -120 }) })).status, 401);
});

test('Büro-Dateien: nur Rolle Büro darf lesen, schreiben, löschen', async () => {
  const p = 'plaene/a_26-0412/mwm7abc12.pdf';
  assert.equal((await hoch(await token('anon1', { anonym: true }), p)).status, 403);
  assert.equal((await hoch(await token('mont1'), p)).status, 403, 'alte Rolle «monteur» gilt nicht mehr');
  const r = await hoch(await token('buero1'), p);
  assert.equal(r.status, 200); assert.equal((await r.json()).id, 'dbx:' + p);
  assert.equal((await dat(p, { tok: await token('anon1', { anonym: true }) })).status, 403, 'Anonyme dürfen nicht lesen');
  const g = await dat(p, { tok: await token('buero1') });
  assert.equal(g.status, 200); assert.deepEqual(new Uint8Array(await g.arrayBuffer()), PDF);
  assert.equal((await dat(p, { method: 'DELETE', tok: await token('anon1', { anonym: true }) })).status, 403);
  assert.equal((await dat(p, { method: 'DELETE', tok: await token('buero1') })).status, 200);
  assert.equal(DBX.size, 0);
});

test('Plan-Upload: kein PDF, zu gross, nie überschreiben, Pfad-Tricks', async () => {
  const t = await token('buero1');
  assert.equal((await hoch(t, 'plaene/obj1/x1.pdf', new TextEncoder().encode('<html>'))).status, 415);
  assert.equal((await dat('plaene/obj1/x1.pdf', { method: 'POST', tok: t, body: PDF, headers: { 'Content-Length': String(60 * 1048576) } })).status, 413);
  assert.equal((await hoch(t, 'plaene/obj1/x1.pdf')).status, 200);
  assert.equal((await hoch(t, 'plaene/obj1/x1.pdf', new TextEncoder().encode('%PDF-1.4 anders'))).status, 409);
  for (const p of ['geheim/x/y.pdf', 'plaene/../fotos/x.pdf', 'plaene/a/b/c.pdf', 'plaene/a/x.jpg', 'fotos/a/x.pdf', '/plaene/a/x.pdf', 'plaene/a/x'])
    assert.equal((await hoch(t, p)).status, 400, p);
});

test('Scan: mit Schlüssel genau ein Element, ohne interne Felder', async () => {
  scanDaten();
  const r = await scan('?k=' + K);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.element.pos, 'NZ 41.03'); assert.equal(d.objekt.kunde, 'Sada AG');
  assert.equal(d.element.intern, undefined); assert.equal(d.element.zugang, undefined, 'Schlüssel nicht zurückgeben');
  assert.equal(d.plaene.montage.bereit, true); assert.equal(d.plaene.detail.bereit, false);
  assert.equal(d.monteur, false);
});

test('Scan: falscher, zu kurzer oder fehlender Schlüssel abgewiesen', async () => {
  scanDaten();
  assert.equal((await scan('')).status, 404);
  assert.equal((await scan('?k=abc')).status, 404);
  assert.equal((await scan('?k=Ab3dEf6hIj9kLm2nOp5X')).status, 404);
  assert.equal((await scan('?k=' + K + '%2F..')).status, 404);
  // Schlüssel im Verzeichnis, aber nicht (mehr) beim Element: abgewiesen
  fsDoc('elemente', 'el1', { ...FS.get('elemente/el1'), zugang: 'NeuerSchluessel12345' });
  assert.equal((await scan('?k=' + K)).status, 404);
});

test('Scan: nach Ablauf der Aufbewahrung gesperrt (Standard 28 Tage, Behalten verlängert)', async () => {
  scanDaten({ alterTage: 27 }); assert.equal((await scan('?k=' + K)).status, 200);
  scanDaten({ alterTage: 29 }); assert.equal((await scan('?k=' + K)).status, 410);
  assert.equal((await scan('/datei?k=' + K + '&art=montage')).status, 410, 'auch Pläne gesperrt');
  scanDaten({ alterTage: 29, behaltenBis: Date.now() + 5 * TAG }); assert.equal((await scan('?k=' + K)).status, 200);
  scanDaten({ alterTage: 29, tage: 60 }); assert.equal((await scan('?k=' + K)).status, 200, 'Einstellung 60 Tage');
  scanDaten({ alterTage: 400, tage: 0 }); assert.equal((await scan('?k=' + K)).status, 200, '0 = nie');
});

test('Scan: Pläne nur des eigenen Elements, alte Dateien melden 409', async () => {
  scanDaten();
  const r = await scan('/datei?k=' + K + '&art=montage');
  assert.equal(r.status, 200); assert.deepEqual(new Uint8Array(await r.arrayBuffer()), PDF);
  assert.match(r.headers.get('Content-Disposition'), /Z%C3%BCrich/);
  assert.equal((await scan('/datei?k=' + K + '&art=detail')).status, 409);
  assert.equal((await scan('/datei?k=' + K + '&art=produktion')).status, 400);
  assert.equal((await scan('/datei?k=' + K + '&foto=dbx:plaene/obj1/p1.pdf')).status, 404, 'fremde Datei über Foto-Weg');
});

test('Scan: ohne PIN kein Schreiben; PIN falsch, Sperre, richtig', async () => {
  scanDaten();
  assert.equal((await scan('/montiert?k=' + K, { method: 'POST', body: JSON.stringify({ von: 'X' }) })).status, 403);
  assert.equal((await scan('/montiert?k=' + K, { method: 'POST', body: JSON.stringify({ von: 'X' }), headers: { 'X-Monteur': 'm1.9999999999.gefaelschtgefaelschtgefaelscht' } })).status, 403);
  const pin = p => scan('/pin', { method: 'POST', body: JSON.stringify({ pin: p }) });
  assert.equal((await pin('000000')).status, 403);
  const s = await sitzung(); assert.match(s, /^m1\.\d+\./);
  for (let i = 0; i < 4; i++) await pin('111111');
  assert.equal((await pin('482913')).status, 429, 'nach 5 Fehlversuchen gesperrt');
});

test('Scan: Monteur meldet montiert, nimmt zurück, nur erlaubte Felder', async () => {
  scanDaten();
  const s = await sitzung(); const h = { 'X-Monteur': s, 'Content-Type': 'application/json' };
  let r = await scan('/montiert?k=' + K, { method: 'POST', headers: h, body: JSON.stringify({ von: 'Max Muster', status: 'egal', bezeichnung: 'gehackt' }) });
  assert.equal(r.status, 200);
  let e = FS.get('elemente/el1'); assert.equal(e.status, 'montiert'); assert.equal(e.montiert.von, 'Max Muster'); assert.equal(e.bezeichnung, 'Dusche');
  r = await scan('/montiert?k=' + K, { method: 'POST', headers: h, body: JSON.stringify({ zurueck: true }) });
  e = FS.get('elemente/el1'); assert.equal(e.status, 'geliefert'); assert.equal(e.montiert, null);
  assert.equal((await scan('/montiert?k=' + K, { method: 'POST', headers: h, body: JSON.stringify({ von: '' }) })).status, 400);
});

test('Scan: Monteur lädt Foto hoch, alle sehen es, Monteur löscht es', async () => {
  scanDaten();
  const s = await sitzung();
  assert.equal((await scan('/foto?k=' + K, { method: 'POST', body: JSON, headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '10' } })).status, 403);
  assert.equal((await scan('/foto?k=' + K, { method: 'POST', body: JPG, headers: { 'X-Monteur': s, 'Content-Type': 'text/html', 'Content-Length': String(JPG.length) } })).status, 415);
  const r = await scan('/foto?k=' + K, { method: 'POST', body: JPG, headers: { 'X-Monteur': s, 'Content-Type': 'image/jpeg', 'Content-Length': String(JPG.length), 'X-Von': encodeURIComponent('Jürg') } });
  assert.equal(r.status, 200);
  const f = (await r.json()).foto;
  assert.match(f.id, /^dbx:fotos\/el1\/[a-z0-9]+\.jpg$/); assert.equal(f.von, 'Jürg');
  assert.equal(FS.get('elemente/el1').fotos.length, 1);
  const g = await scan('/datei?k=' + K + '&foto=' + encodeURIComponent(f.id));
  assert.equal(g.status, 200); assert.deepEqual(new Uint8Array(await g.arrayBuffer()), JPG);
  assert.equal((await scan('/foto?k=' + K + '&id=' + encodeURIComponent(f.id), { method: 'DELETE' })).status, 403);
  assert.equal((await scan('/foto?k=' + K + '&id=' + encodeURIComponent(f.id), { method: 'DELETE', headers: { 'X-Monteur': s } })).status, 200);
  assert.equal(FS.get('elemente/el1').fotos.length, 0); assert.equal(DBX.has(f.id.slice(4)), false);
});

test('Sitzung: PIN-Wechsel macht alte Sitzungen ungültig', async () => {
  scanDaten();
  const s = await sitzung();
  const e2 = { ...env(), MONTEUR_PIN: '999111' };
  const r = await worker.fetch(new Request('https://w.test/api/scan/montiert?k=' + K, { method: 'POST', body: JSON.stringify({ von: 'X' }), headers: { 'X-Monteur': s } }), e2, { waitUntil() {} });
  assert.equal(r.status, 403);
});

test('me liefert Rolle (nur Büro oder extern)', async () => {
  assert.equal((await (await call('/api/me', { tok: await token('buero1') })).json()).rolle, 'buero');
  assert.equal((await (await call('/api/me', { tok: await token('mont1') })).json()).rolle, 'extern');
});

test('Hilfsfunktionen', () => {
  assert.equal(__test.headerJson({ path: '/ä' }), '{"path":"/' + '\\' + 'u00e4"}');
  assert.equal(__test.dateiPfad('plaene/a_26-0412.X/p1.pdf').dbx, '/plaene/a_26-0412.X/p1.pdf');
  assert.equal(__test.abgelaufen({ created: Date.now() - 30 * TAG }, {}), true);
  assert.equal(__test.abgelaufen({ created: Date.now() - 3 * TAG }, {}), false);
});
