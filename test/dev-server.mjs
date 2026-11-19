// Lokaler Testserver: index.html + nachgebildetes Firebase (mit Firestore-Regeln) + nachgebildetes Dropbox
// + der ECHTE Worker-Code (worker/src/index.js). Nur für Tests.
//
// Start:  node test/dev-server.mjs            -> http://localhost:8788/            (mit Worker/Dropbox)
//                                              http://localhost:8788/alt.html    (ohne Worker, Dateien in Firestore)
// Optionen: ALT_REGELN=1 (alte, offene Firestore-Regeln nachbilden)
// Testkonto Büro: buero@test.ch / test1234     Monteur-PIN: 123456   (Baustelle: #k=<Schlüssel>, ohne Anmeldung)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { vonFs, __test } from '../worker/src/index.js';

const PORT = Number(process.env.PORT || 8788);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = `http://localhost:${PORT}`;
const PID = 'etikette-fa8d1';
const ALT = process.env.ALT_REGELN === '1';

/* ---------- Schlüssel ---------- */
const gen = () => crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const idKey = await gen(), saKey = await gen();
const pubJwk = { ...(await crypto.subtle.exportKey('jwk', idKey.publicKey)), kid: 'test1', alg: 'RS256', use: 'sig' };
const saPem = '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(await crypto.subtle.exportKey('pkcs8', saKey.privateKey)).toString('base64') + '\n-----END PRIVATE KEY-----\n';
const b64u = x => Buffer.from(x).toString('base64url');
async function idToken(uid, anon) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'test1', typ: 'JWT' }));
  const c = b64u(JSON.stringify({ iss: 'https://securetoken.google.com/' + PID, aud: PID, sub: uid, user_id: uid, iat: now, exp: now + 3600, firebase: { sign_in_provider: anon ? 'anonymous' : 'password' } }));
  const s = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', idKey.privateKey, new TextEncoder().encode(h + '.' + c));
  return h + '.' + c + '.' + b64u(new Uint8Array(s));
}
async function uidAus(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); if (!m) return null;
  try { const c = await import('../worker/src/index.js').then(w => w.verifyIdToken(m[1], ENV)); return c.sub; } catch (e) { return null; }
}

/* ---------- Datenbank + Regeln ---------- */
const DB = new Map();
const USERS = { 'buero@test.ch': { pw: 'test1234', uid: 'buero1' } };
DB.set('rollen/buero1', { rolle: 'buero' });
const DBX = new Map();
const sse = new Set();
const melde = p => { for (const r of sse) r.write(`data: ${JSON.stringify({ path: p })}\n\n`); };

function rolle(uid) { const r = uid && DB.get('rollen/' + uid); return r && r.rolle === 'buero' ? 'buero' : 'extern'; }
// Bildet firestore.rules nach: nur Büro (anonyme Anmeldung gibt es nicht mehr)
function erlaubt(art, pfad, uid) {
  if (!uid) return false;
  const [coll, id] = pfad.split('/');
  if (ALT) return ['objekte', 'plaene', 'elemente', 'settings', 'dateien'].includes(coll);
  if (coll === 'rollen') return art === 'get' && id === uid;
  if (['objekte', 'plaene', 'elemente', 'settings', 'zugaenge', 'dateien'].includes(coll)) return rolle(uid) === 'buero' && !String(uid).startsWith('anon_');
  return false;
}
function anwenden(alt, data, merge) {
  const o = merge ? structuredClone(alt || {}) : {};
  for (const [k, v] of Object.entries(data)) {
    if (v && v.__op === 'delete') delete o[k];
    else if (v && v.__op === 'arrayUnion') { const a = [...(o[k] || [])]; for (const x of v.v) if (!a.some(y => JSON.stringify(y) === JSON.stringify(x))) a.push(x); o[k] = a; }
    else if (v && v.__op === 'arrayRemove') o[k] = (o[k] || []).filter(y => !v.v.some(x => JSON.stringify(x) === JSON.stringify(y)));
    else o[k] = v;
  }
  return o;
}

/* ---------- Worker-Umgebung ---------- */
const ENV = {
  FIREBASE_PROJECT_ID: PID, ALLOWED_ORIGINS: BASE, MONTEUR_PIN: '123456',
  DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's', DROPBOX_REFRESH_TOKEN: 'r',
  FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sa@test', private_key: saPem, token_uri: BASE + '/mock/oauth' }),
  __JWKS_URL: BASE + '/mock/jwks', __FIRESTORE_URL: BASE + '/mockfs', __DBX_API: BASE + '/dbx/oauth2/token', __DBX_CONTENT: BASE + '/dbx', __DBX_RPC: BASE + '/dbx'
};

/* ---------- HTTP ---------- */
const body = req => new Promise((res, rej) => { const c = []; req.on('data', x => c.push(x)); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej); });
const send = (res, status, obj, h = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...h }); res.end(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)); };

async function seite(datei, mitWorker) {
  let s = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  s = s.replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/(firebase-[a-z]+)\.js/g, '/test/mock/$1.js');
  // Immer den lokalen Worker verwenden (nie den echten), ohne Worker: leere Adresse
  s = s.replace(/const WORKER_URL='[^']*';/, mitWorker ? 'const WORKER_URL=location.origin;' : "const WORKER_URL='';");
  return s;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') return send(res, 200, await seite('index.html', true), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    if (p === '/alt.html') return send(res, 200, await seite('index.html', false), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    if (p.startsWith('/test/mock/')) return send(res, 200, await readFile(path.join(ROOT, p)), { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });

    // Auth
    if (p === '/mock/jwks') return send(res, 200, { keys: [pubJwk] }, { 'Cache-Control': 'max-age=3600' });
    if (p === '/mock/token') return send(res, 200, await idToken(url.searchParams.get('uid'), url.searchParams.get('anon') === '1'), { 'Content-Type': 'text/plain' });
    if (p === '/mock/login') { const d = JSON.parse(await body(req)); const u = USERS[d.email]; return u && u.pw === d.pw ? send(res, 200, { uid: u.uid, email: d.email }) : send(res, 400, { code: 'auth/invalid-credential' }); }
    if (p === '/mock/oauth') return send(res, 200, { access_token: 'sa-token', expires_in: 3600 });

    // Firestore (Client)
    if (p === '/mock/db/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' }); res.write(': ok\n\n'); sse.add(res); req.on('close', () => sse.delete(res)); return; }
    if (p.startsWith('/mock/db/')) {
      const uid = await uidAus(req); const d = JSON.parse(await body(req) || '{}');
      if (p === '/mock/db/get') { if (!erlaubt('get', d.path, uid)) return send(res, 403, { code: 'permission-denied' }); const x = DB.get(d.path); return send(res, 200, { exists: !!x, data: x || null }); }
      if (p === '/mock/db/query') {
        if (!erlaubt('list', d.path, uid)) return send(res, 403, { code: 'permission-denied' });
        const rows = [...DB.entries()].filter(([k]) => k.split('/').length === 2 && k.startsWith(d.path + '/'))
          .filter(([, v]) => d.where.every(w => w.op === '==' ? v[w.field] === w.value : true)).map(([k, v]) => ({ id: k.split('/')[1], data: v }));
        return send(res, 200, { rows });
      }
      if (p === '/mock/db/write') {
        const alt = DB.get(d.path);
        if (d.op === 'delete') { if (!erlaubt('delete', d.path, uid, null, alt)) return send(res, 403, { code: 'permission-denied' }); DB.delete(d.path); melde(d.path); return send(res, 200, {}); }
        if (d.op === 'update' && !alt) return send(res, 404, { code: 'not-found' });
        const neu = anwenden(alt, d.data, d.op === 'update' || d.merge);
        const art = alt ? 'update' : 'create';
        if (!erlaubt(art, d.path, uid, neu, alt || {})) return send(res, 403, { code: 'permission-denied' });
        DB.set(d.path, neu); melde(d.path); return send(res, 200, {});
      }
    }
    // Firestore REST (Worker, Service-Konto)
    if (p.startsWith('/mockfs/')) {
      const k = decodeURIComponent((p.split('/documents/')[1] || ''));
      if (req.method === 'GET') { const x = DB.get(k); return x ? send(res, 200, { name: k, fields: __test.zuFs(x).mapValue.fields }) : send(res, 404, {}); }
      if (req.method === 'PATCH') {
        const d = JSON.parse(await body(req)); const maske = url.searchParams.getAll('updateMask.fieldPaths');
        if (url.searchParams.get('currentDocument.exists') === 'true' && !DB.has(k)) return send(res, 404, {});
        const n = vonFs({ mapValue: { fields: d.fields } });
        if (maske.length) { const x = { ...(DB.get(k) || {}) }; for (const f of maske) { if (f in n) x[f] = n[f]; else delete x[f]; } DB.set(k, x); } else DB.set(k, n);
        melde(k); return send(res, 200, {});
      }
      if (req.method === 'POST' && p.endsWith(':commit')) {
        for (const w of JSON.parse(await body(req)).writes) {
          const key = w.transform.document.split('/documents/')[1];
          if (!DB.has(key)) return send(res, 404, {});
          const x = { ...DB.get(key) };
          for (const t of w.transform.fieldTransforms) { const arr = [...(x[t.fieldPath] || [])]; for (const v of t.appendMissingElements.values) arr.push(vonFs(v)); x[t.fieldPath] = arr; }
          DB.set(key, x); melde(key);
        }
        return send(res, 200, {});
      }
    }
    // Dropbox
    if (p === '/dbx/oauth2/token') return send(res, 200, { access_token: 'dbx-token', expires_in: 14400 });
    if (p === '/dbx/2/files/upload') {
      const arg = JSON.parse(req.headers['dropbox-api-arg'].replace(/\\u([0-9a-f]{4})/g, (_, x) => String.fromCharCode(parseInt(x, 16))));
      const b = await body(req); await new Promise(r => setTimeout(r, 300));
      DBX.set(arg.path.toLowerCase(), b);
      return send(res, 200, { path_display: arg.path, rev: 'rev' + Date.now().toString(36), size: b.length });
    }
    if (p === '/dbx/2/files/download') {
      const arg = JSON.parse(req.headers['dropbox-api-arg'].replace(/\\u([0-9a-f]{4})/g, (_, x) => String.fromCharCode(parseInt(x, 16))));
      const b = DBX.get(arg.path.toLowerCase());
      return b ? send(res, 200, b, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(b.length) }) : send(res, 409, { error_summary: 'path/not_found/' });
    }
    if (p === '/dbx/2/files/delete_v2') { const d = JSON.parse(await body(req)); return DBX.delete(d.path.toLowerCase()) ? send(res, 200, {}) : send(res, 409, { error_summary: 'path_lookup/not_found/' }); }

    // Zustand für Tests
    if (p === '/mock/state') return send(res, 200, { db: Object.fromEntries([...DB.entries()].filter(([k]) => !k.includes('/teile/')).map(([k, v]) => [k, k.startsWith('dateien/') ? { ...v } : v])), dropbox: [...DBX.entries()].map(([k, v]) => [k, v.length]) });

    // Worker
    if (p.startsWith('/api/')) {
      const r = await worker.fetch(new Request(BASE + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Readable.toWeb(req), duplex: 'half' }), ENV, { waitUntil() {} });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      if (r.body) for await (const c of r.body) res.write(c);
      return res.end();
    }
    send(res, 404, { fehler: 'nicht gefunden' });
  } catch (err) { console.error(err); send(res, 500, { fehler: String(err) }); }
}).listen(PORT, () => console.log(`Testserver: ${BASE}/  (alt: ${BASE}/alt.html)  Regeln: ${ALT ? 'ALT' : 'NEU'}`));
