/**
 * PE Element-Etiketten – Cloudflare Worker
 * Sichere Brücke zwischen index.html, Firebase (Firestore/Auth) und Dropbox.
 *
 * - Der Dropbox-Schlüssel (Refresh-Token) liegt nur hier als Secret, nie im Browser.
 * - Büro: Firebase-ID-Token (E-Mail-Anmeldung) + Rolle `buero` in `rollen/{uid}` (gelesen mit dem Service-Konto).
 * - Baustelle (QR-Code): KEINE Firebase-Anmeldung. Die Etikette trägt einen zufälligen Zugangsschlüssel
 *   (#k=…, `zugaenge/{schluessel}` = {elementId}). Damit liefert der Worker genau dieses eine Element, seine
 *   Pläne und Fotos. Schreiben (montiert, Fotos) nur mit Monteur-Sitzung (nach PIN, HMAC-signiert).
 * - Dateipfade sind auf plaene/… und fotos/… begrenzt, Dateien werden nie überschrieben.
 *
 * Secrets:  DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN,
 *           FIREBASE_SERVICE_ACCOUNT (JSON), MONTEUR_PIN
 * Vars:     FIREBASE_PROJECT_ID, ALLOWED_ORIGINS (Komma-Liste)
 * Optional: KV-Binding `KV` (PIN-Sperre über alle Instanzen)
 */

const MAX_PLAN = 50 * 1024 * 1024;   // 50 MB
const MAX_FOTO = 10 * 1024 * 1024;   // 10 MB
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

// Speicher pro Worker-Instanz (überlebt mehrere Anfragen, nicht garantiert)
const MEM = { jwks: null, jwksExp: 0, dbx: null, dbxP: null, sa: null, saP: null, rate: new Map(), pin: new Map() };

export class HttpError extends Error {
  constructor(status, code, msg) { super(msg || code); this.status = status; this.code = code; }
}

/* ---------------------------------------------------------------- Einstieg */
export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env, ctx || { waitUntil() {} });
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('Fehler', err && err.stack || err);
      return json({ fehler: err instanceof HttpError ? err.code : 'intern', text: err instanceof HttpError ? err.message : 'Interner Fehler' }, status, cors);
    }
  }
};

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const erlaubt = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Monteur, X-Von',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Disposition',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (origin && erlaubt.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
}

// Secrets ohne Zeilenumbruch am Ende (beim Einfügen im Terminal passiert das leicht)
const SECRETS = ['DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'DROPBOX_REFRESH_TOKEN', 'MONTEUR_PIN'];
function sauber(env) {
  const e = { ...env };
  for (const k of SECRETS) if (typeof e[k] === 'string') e[k] = e[k].trim();
  return e;
}

async function route(request, envRoh, ctx) {
  const env = sauber(envRoh);
  const url = new URL(request.url);
  const teile = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  const m = request.method;
  if (teile[0] !== 'api') throw new HttpError(404, 'nicht-gefunden');
  const was = teile[1];

  if (was === 'health' && m === 'GET') return health(env);

  // Baustelle: Zugang per Etiketten-Schlüssel, ohne Firebase-Anmeldung
  if (was === 'scan') {
    const ip = request.headers.get('CF-Connecting-IP') || 'unbekannt';
    rateLimit('ip:' + ip, 300);
    const unter = teile[2] || '';
    if (unter === 'pin' && m === 'POST') return scanPin(request, env, ip);
    const z = await zugang(env, url.searchParams.get('k'));
    if (!unter && m === 'GET') return scanLesen(request, env, z);
    if (unter === 'datei' && m === 'GET') return scanDatei(env, ctx, z, url.searchParams);
    if (unter === 'montiert' && m === 'POST') { await mussMonteur(request, env); return scanMontiert(request, env, z); }
    if (unter === 'foto' && m === 'POST') { await mussMonteur(request, env); return scanFotoHoch(request, env, z); }
    if (unter === 'foto' && m === 'DELETE') { await mussMonteur(request, env); return scanFotoWeg(env, z, url.searchParams.get('id')); }
    throw new HttpError(404, 'nicht-gefunden');
  }

  // Büro: Firebase-Anmeldung mit Rolle «buero»
  const user = await authUser(request, env);
  rateLimit(user.uid, 1200);

  if (was === 'me' && m === 'GET') return json({ uid: user.uid, anonym: user.anonym, rolle: await rolleVon(env, user.uid) });
  if (was === 'datei') {
    const d = dateiPfad(url.searchParams.get('pfad'));
    await mussRolle(env, user, ['buero']);
    if (m === 'POST') return dateiUpload(request, env, user, d);
    if (m === 'GET') return dateiDownload(env, ctx, d);
    if (m === 'DELETE') return dateiLoeschen(env, user, d);
  }
  throw new HttpError(404, 'nicht-gefunden');
}

/* ---------------------------------------------------------------- Health */
async function health(env) {
  return json({
    ok: true,
    dropbox: !!(env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET && env.DROPBOX_REFRESH_TOKEN),
    firebase: !!env.FIREBASE_SERVICE_ACCOUNT,
    pin: !!env.MONTEUR_PIN,
    kv: !!env.KV,
    projekt: env.FIREBASE_PROJECT_ID || null
  });
}

/* ---------------------------------------------------------------- Dateien
   Der Pfad kommt vom Browser, ist aber streng begrenzt:
     plaene/{objektId}/{dateiId}.pdf        nur Büro darf schreiben/löschen
     fotos/{elementId}/{dateiId}.{jpg|…}    Monteur und Büro
   Über diese Endpunkte nur Büro. Die Baustelle liest und schreibt über /api/scan (siehe unten).
   Bestehende Dateien werden nie überschrieben (Dropbox-Modus "add" ohne Umbenennen). */
const SEG = '[A-Za-z0-9_.-]{1,120}';
const PFAD_RE = new RegExp(`^(plaene|fotos)/(${SEG})/([A-Za-z0-9_-]{1,80})\\.(pdf|jpg|jpeg|png|webp|heic|heif)$`);
const TYP_VON_EXT = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
const FOTO_TYPEN = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

function dateiPfad(roh) {
  const p = String(roh || '');
  const m = PFAD_RE.exec(p);
  if (!m || p.includes('..')) throw new HttpError(400, 'pfad-ungueltig', 'Ungültiger Dateipfad');
  const art = m[1], ext = m[4].toLowerCase();
  if (art === 'plaene' && ext !== 'pdf') throw new HttpError(400, 'pfad-ungueltig', 'Pläne müssen PDF sein');
  if (art === 'fotos' && ext === 'pdf') throw new HttpError(400, 'pfad-ungueltig', 'Fotos dürfen kein PDF sein');
  return { pfad: p, dbx: '/' + p, art, ext, typ: TYP_VON_EXT[ext], name: p.split('/').pop() };
}

async function dateiUpload(request, env, user, d) {
  if (d.art === 'fotos') {
    const typ = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (!FOTO_TYPEN.has(typ)) throw new HttpError(415, 'falscher-typ', 'Nur JPEG, PNG, WebP oder HEIC');
  }
  const r = await dbxUploadStream(env, request, d.dbx, d.art === 'plaene' ? MAX_PLAN : MAX_FOTO, d.art === 'plaene' ? magicPdf : null);
  return json({ id: 'dbx:' + d.pfad, size: r.size, rev: r.rev });
}

async function dateiDownload(env, ctx, d) {
  const cacheKey = new Request('https://cache.pe-etiketten.intern/' + encodeURIComponent(d.pfad));
  const cache = edgeCache();
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return mitDateiname(hit, d.name, d.typ);
  }
  const r = await dbxDownload(env, d.dbx);
  const len = r.headers.get('Content-Length');
  const kopf = { 'Content-Type': d.typ, ...(len ? { 'Content-Length': len } : {}) };
  if (cache) {
    // Dateien ändern sich nie (kein Überschreiben), darum lange im Cloudflare-Cache halten
    const [x, y] = r.body.tee();
    ctx.waitUntil(cache.put(cacheKey, new Response(y, { headers: { ...kopf, 'Cache-Control': 'public, max-age=2592000' } })).catch(() => {}));
    return mitDateiname(new Response(x, { headers: kopf }), d.name, d.typ);
  }
  return mitDateiname(new Response(r.body, { headers: kopf }), d.name, d.typ);
}

async function dateiLoeschen(env, user, d) {
  await dbxDelete(env, d.dbx);
  const cache = edgeCache();
  if (cache) await cache.delete(new Request('https://cache.pe-etiketten.intern/' + encodeURIComponent(d.pfad))).catch(() => {});
  return json({ ok: true });
}

const PIN_MAX = 5, PIN_FENSTER = 15 * 60;
async function pinZaehler(env, k) {
  if (env.KV) return Number(await env.KV.get('pin:' + k)) || 0;
  const e = MEM.pin.get(k); return e && e.bis > Date.now() ? e.n : 0;
}
async function pinSperre(env, keys) {
  for (const k of keys) if (await pinZaehler(env, k) >= PIN_MAX) throw new HttpError(429, 'zu-viele-versuche', 'Zu viele Versuche, bitte 15 Minuten warten');
}
async function pinFehlversuch(env, keys) {
  for (const k of keys) {
    const n = (await pinZaehler(env, k)) + 1;
    if (env.KV) await env.KV.put('pin:' + k, String(n), { expirationTtl: PIN_FENSTER });
    else MEM.pin.set(k, { n, bis: Date.now() + PIN_FENSTER * 1000 });
  }
}

/* ---------------------------------------------------------------- Baustelle (QR-Code mit Schlüssel) */
const SCHLUESSEL_RE = /^[A-Za-z0-9]{16,64}$/;
async function zugang(env, k) {
  if (!SCHLUESSEL_RE.test(k || '')) throw new HttpError(404, 'etikette-unbekannt', 'Etikette unbekannt');
  const z = await fsGet(env, 'zugaenge', k);
  if (!z || !z.elementId) throw new HttpError(404, 'etikette-unbekannt', 'Etikette unbekannt');
  const el = await fsGet(env, 'elemente', z.elementId);
  if (!el || el.zugang !== k) throw new HttpError(404, 'etikette-unbekannt', 'Etikette unbekannt');
  // Aufbewahrung: Nach Ablauf (Standard 28 Tage ab Anlegen, «Behalten» verlängert) ist der QR-Code gesperrt,
  // auch wenn das Büro die Daten noch nicht gelöscht hat.
  const [obj, set] = await Promise.all([el.objektId ? fsGet(env, 'objekte', el.objektId) : null, fsGet(env, 'settings', 'app')]);
  if (abgelaufen(obj, set)) throw new HttpError(410, 'abgelaufen', 'Dieser QR-Code ist abgelaufen');
  return { k, el, id: z.elementId, obj, set };
}
export function aufbewahrTage(set) { const n = parseInt(set && set.aufbewahrungTage, 10); return Number.isFinite(n) && n >= 0 ? n : 28; }
export function abgelaufen(obj, set, jetzt = Date.now()) {
  if (!obj) return false;
  const bis = obj.behaltenBis ? Number(obj.behaltenBis) : (aufbewahrTage(set) && obj.created ? Number(obj.created) + aufbewahrTage(set) * 864e5 : null);
  return bis != null && jetzt > bis;
}
const nur = (o, felder) => { const r = {}; for (const f of felder) if (o && o[f] !== undefined && o[f] !== null) r[f] = o[f]; return r; };

async function scanLesen(request, env, z) {
  const el = z.el;
  const { obj, set } = z;
  const [mp, dp] = await Promise.all([
    el.montagePlanId ? fsGet(env, 'plaene', el.montagePlanId) : null,
    el.detailPlanId ? fsGet(env, 'plaene', el.detailPlanId) : null
  ]);
  const planInfo = p => p ? { name: p.name || 'Plan.pdf', size: p.size || 0, url: p.url || '', datei: !!p.fileId, bereit: p.fertig !== false && String(p.fileId || '').startsWith('dbx:') } : null;
  return json({
    element: { id: z.id, ...nur(el, ['pos', 'bezeichnung', 'gewerk', 'geschoss', 'lieferdatum', 'auftragNr', 'barcode', 'status', 'montiert', 'objektId']),
      fotos: (el.fotos || []).filter(f => f && f.id).map(f => nur(f, ['id', 'ts', 'von'])) },
    objekt: nur(obj, ['name', 'kunde', 'strasse', 'plzOrt', 'auftragNr', 'lieferdatum']),
    plaene: { montage: planInfo(mp), detail: planInfo(dp) },
    logo: set && set.logo ? set.logo : '',
    monteur: await istMonteur(request, env)
  });
}

async function scanDatei(env, ctx, z, q) {
  let fileId = '', name = '';
  const art = q.get('art'), foto = q.get('foto');
  if (art === 'montage' || art === 'detail') {
    const pid = z.el[art + 'PlanId'];
    const p = pid ? await fsGet(env, 'plaene', pid) : null;
    if (!p || !p.fileId) throw new HttpError(404, 'plan-fehlt', 'Kein Plan');
    fileId = p.fileId; name = p.name || 'Plan.pdf';
  } else if (foto) {
    const f = (z.el.fotos || []).find(x => x && x.id === foto);
    if (!f) throw new HttpError(404, 'foto-fehlt', 'Foto nicht gefunden');
    fileId = f.id;
  } else throw new HttpError(400, 'ungueltig');
  if (!String(fileId).startsWith('dbx:')) throw new HttpError(409, 'noch-nicht-uebertragen', 'Die Datei wird gerade nach Dropbox übertragen. Bitte später nochmals versuchen.');
  const d = dateiPfad(fileId.slice(4));
  const res = await dateiDownload(env, ctx, d);
  return name ? mitDateiname(res, name, d.typ) : res;
}

// Monteur-Sitzung: «m1.<ablauf>.<signatur>», HMAC mit einem Schlüssel aus PIN und Dropbox-Secret.
// Ändert das Büro den PIN (Secret MONTEUR_PIN), sind alle bisherigen Sitzungen automatisch ungültig.
const SITZUNG_TAGE = 365;
async function sitzungsSchluessel(env) {
  if (!env.MONTEUR_PIN || !env.DROPBOX_APP_SECRET) throw new HttpError(503, 'pin-nicht-eingerichtet');
  const roh = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pe-sitzung|' + env.MONTEUR_PIN + '|' + env.DROPBOX_APP_SECRET));
  return crypto.subtle.importKey('raw', roh, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function sitzungErstellen(env) {
  const ablauf = Math.floor(Date.now() / 1000) + SITZUNG_TAGE * 86400;
  const daten = 'm1.' + ablauf;
  const sig = await crypto.subtle.sign('HMAC', await sitzungsSchluessel(env), new TextEncoder().encode(daten));
  return daten + '.' + b64url(new Uint8Array(sig));
}
async function istMonteur(request, env) {
  const t = request.headers.get('X-Monteur') || '';
  const m = /^m1\.(\d{9,12})\.([A-Za-z0-9_-]{20,100})$/.exec(t);
  if (!m || Number(m[1]) < Date.now() / 1000) return false;
  try { return await crypto.subtle.verify('HMAC', await sitzungsSchluessel(env), b64urlBytes(m[2]), new TextEncoder().encode('m1.' + m[1])); }
  catch (e) { return false; }
}
async function mussMonteur(request, env) {
  if (!await istMonteur(request, env)) throw new HttpError(403, 'monteur-pin-noetig', 'Bitte zuerst mit dem Monteur-PIN freischalten');
}

async function scanPin(request, env, ip) {
  if (!env.MONTEUR_PIN) throw new HttpError(503, 'pin-nicht-eingerichtet');
  await pinSperre(env, ['ip:' + ip]);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const ok = await gleich(String(body.pin || ''), String(env.MONTEUR_PIN));
  if (!ok) { await pinFehlversuch(env, ['ip:' + ip]); throw new HttpError(403, 'pin-falsch', 'PIN falsch'); }
  return json({ sitzung: await sitzungErstellen(env) });
}

async function scanMontiert(request, env, z) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const von = String(body.von || '').trim().slice(0, 80);
  if (body.zurueck) { await fsUpdate(env, 'elemente', z.id, { status: 'geliefert', montiert: null }); return json({ ok: true, status: 'geliefert', montiert: null }); }
  if (!von) throw new HttpError(400, 'name-fehlt', 'Bitte Namen eintragen');
  const montiert = { am: Date.now(), von };
  await fsUpdate(env, 'elemente', z.id, { status: 'montiert', montiert });
  return json({ ok: true, status: 'montiert', montiert });
}

const EXT_VON_TYP = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };
async function scanFotoHoch(request, env, z) {
  const typ = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!EXT_VON_TYP[typ]) throw new HttpError(415, 'falscher-typ', 'Nur JPEG, PNG, WebP oder HEIC');
  const zufall = Array.from(crypto.getRandomValues(new Uint8Array(10)), b => (b % 36).toString(36)).join('');
  const d = dateiPfad(`fotos/${z.id}/${Date.now().toString(36)}${zufall}.${EXT_VON_TYP[typ]}`);
  await dbxUploadStream(env, request, d.dbx, MAX_FOTO, null);
  let von = ''; try { von = decodeURIComponent(request.headers.get('X-Von') || ''); } catch (e) {}
  const eintrag = { id: 'dbx:' + d.pfad, ts: Date.now(), von: von.trim().slice(0, 80) };
  await fsArrayAnhaengen(env, 'elemente', z.id, 'fotos', eintrag);
  return json({ ok: true, foto: eintrag });
}

async function scanFotoWeg(env, z, id) {
  const f = (z.el.fotos || []).find(x => x && x.id === id);
  if (!f) return json({ ok: true });
  await fsUpdate(env, 'elemente', z.id, { fotos: (z.el.fotos || []).filter(x => x && x.id !== id) });
  if (String(id).startsWith('dbx:')) await dbxDelete(env, dateiPfad(id.slice(4)).dbx);
  return json({ ok: true });
}

/* ---------------------------------------------------------------- Rollen */
async function rolleVon(env, uid) {
  const r = await fsGet(env, 'rollen', uid);
  return r && r.rolle === 'buero' ? 'buero' : 'extern';
}
async function mussRolle(env, user, erlaubt) {
  const r = await rolleVon(env, user.uid);
  if (!erlaubt.includes(r)) throw new HttpError(403, 'keine-berechtigung', 'Keine Berechtigung');
  return r;
}

function rateLimit(key, proMinute) {
  const jetzt = Date.now();
  let e = MEM.rate.get(key);
  if (!e || e.start < jetzt - 60000) { e = { start: jetzt, n: 0 }; MEM.rate.set(key, e); }
  if (++e.n > proMinute) throw new HttpError(429, 'zu-viele-anfragen');
  if (MEM.rate.size > 5000) for (const [k, v] of MEM.rate) if (v.start < jetzt - 60000) MEM.rate.delete(k);
}

/* ---------------------------------------------------------------- Firebase-ID-Token prüfen */
async function authUser(request, env) {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
  if (!m) throw new HttpError(401, 'nicht-angemeldet');
  const claims = await verifyIdToken(m[1].trim(), env);
  return { uid: claims.sub, anonym: claims.firebase && claims.firebase.sign_in_provider === 'anonymous', claims };
}

async function jwks(env, kid) {
  if (!MEM.jwks || MEM.jwksExp < Date.now() || (kid && !MEM.jwks[kid])) {
    const r = await fetch(env.__JWKS_URL || JWKS_URL);
    if (!r.ok) throw new HttpError(503, 'schluessel-nicht-ladbar');
    const d = await r.json();
    const max = /max-age=(\d+)/.exec(r.headers.get('Cache-Control') || '');
    MEM.jwks = Object.fromEntries((d.keys || []).map(k => [k.kid, k]));
    MEM.jwksExp = Date.now() + (max ? Number(max[1]) : 3600) * 1000;
  }
  return MEM.jwks[kid];
}

export async function verifyIdToken(token, env) {
  const p = token.split('.');
  if (p.length !== 3) throw new HttpError(401, 'token-ungueltig');
  let header, claims;
  try { header = JSON.parse(b64urlText(p[0])); claims = JSON.parse(b64urlText(p[1])); } catch (e) { throw new HttpError(401, 'token-ungueltig'); }
  if (header.alg !== 'RS256' || !header.kid) throw new HttpError(401, 'token-ungueltig');
  const jwk = await jwks(env, header.kid);
  if (!jwk) throw new HttpError(401, 'token-ungueltig');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(p[2]), new TextEncoder().encode(p[0] + '.' + p[1]));
  if (!ok) throw new HttpError(401, 'token-ungueltig');
  const pid = env.FIREBASE_PROJECT_ID, now = Math.floor(Date.now() / 1000);
  if (claims.aud !== pid || claims.iss !== 'https://securetoken.google.com/' + pid) throw new HttpError(401, 'token-falsches-projekt');
  if (!claims.sub || typeof claims.sub !== 'string' || claims.sub.length > 128) throw new HttpError(401, 'token-ungueltig');
  if (!(claims.exp > now - 30)) throw new HttpError(401, 'token-abgelaufen');
  if (claims.iat > now + 300) throw new HttpError(401, 'token-ungueltig');
  return claims;
}

/* ---------------------------------------------------------------- Firestore REST (Service-Konto) */
function serviceKonto(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new HttpError(503, 'firebase-nicht-eingerichtet');
  try { return typeof env.FIREBASE_SERVICE_ACCOUNT === 'string' ? JSON.parse(env.FIREBASE_SERVICE_ACCOUNT) : env.FIREBASE_SERVICE_ACCOUNT; }
  catch (e) { throw new HttpError(503, 'firebase-secret-ungueltig'); }
}

async function saToken(env) {
  if (MEM.sa && MEM.sa.exp > Date.now() + 120000) return MEM.sa.token;
  if (MEM.saP) return MEM.saP;
  MEM.saP = (async () => {
    const sa = serviceKonto(env);
    const now = Math.floor(Date.now() / 1000);
    const enc = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
    const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
    const pem = String(sa.private_key).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const key = await crypto.subtle.importKey('pkcs8', b64Bytes(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
    const r = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + b64url(new Uint8Array(sig)) })
    });
    if (!r.ok) { console.error('Service-Konto-Token', r.status, await r.text()); throw new HttpError(503, 'firebase-token-fehler'); }
    const d = await r.json();
    MEM.sa = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
    return MEM.sa.token;
  })();
  try { return await MEM.saP; } finally { MEM.saP = null; }
}

function fsUrl(env, coll, id) {
  return `${env.__FIRESTORE_URL || 'https://firestore.googleapis.com'}/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${coll}/${encodeURIComponent(id)}`;
}

export async function fsGet(env, coll, id) {
  const r = await fetch(fsUrl(env, coll, id), { headers: { Authorization: 'Bearer ' + await saToken(env) } });
  if (r.status === 404) return null;
  if (!r.ok) { console.error('Firestore get', coll, id, r.status, await r.text()); throw new HttpError(502, 'firestore-fehler'); }
  const d = await r.json();
  return { ...vonFs({ mapValue: { fields: d.fields || {} } }), __id: id };
}

function fsName(env, coll, id) { return `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${coll}/${id}`; }
// Felder eines bestehenden Dokuments ändern (legt nie ein neues an)
async function fsUpdate(env, coll, id, felder) {
  const maske = Object.keys(felder).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const r = await fetch(fsUrl(env, coll, id) + '?currentDocument.exists=true&' + maske, { method: 'PATCH', headers: { Authorization: 'Bearer ' + await saToken(env), 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: zuFs(felder).mapValue.fields }) });
  if (r.status === 404 || r.status === 400) throw new HttpError(404, 'element-fehlt', 'Element nicht mehr vorhanden');
  if (!r.ok) { console.error('Firestore update', coll, id, r.status, await r.text()); throw new HttpError(502, 'firestore-fehler'); }
}
// Wert an eine Liste anhängen (wie arrayUnion), ohne die übrige Liste zu lesen
async function fsArrayAnhaengen(env, coll, id, feld, wert) {
  const basis = `${env.__FIRESTORE_URL || 'https://firestore.googleapis.com'}/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:commit`;
  const r = await fetch(basis, { method: 'POST', headers: { Authorization: 'Bearer ' + await saToken(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: [{ transform: { document: fsName(env, coll, id), fieldTransforms: [{ fieldPath: feld, appendMissingElements: { values: [zuFs(wert)] } }] }, currentDocument: { exists: true } }] }) });
  if (!r.ok) { console.error('Firestore commit', coll, id, r.status, await r.text()); throw new HttpError(502, 'firestore-fehler'); }
}

export function vonFs(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(vonFs);
  if ('mapValue' in v) { const o = {}; for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = vonFs(x); return o; }
  return null;
}
function zuFs(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === 'string') return { stringValue: x };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(zuFs) } };
  const f = {}; for (const [k, v] of Object.entries(x)) f[k] = zuFs(v); return { mapValue: { fields: f } };
}

/* ---------------------------------------------------------------- Dropbox */
async function dbxToken(env, neu = false) {
  if (!neu && MEM.dbx && MEM.dbx.exp > Date.now() + 5 * 60000) return MEM.dbx.token;
  if (MEM.dbxP) return MEM.dbxP;
  if (!env.DROPBOX_APP_KEY || !env.DROPBOX_APP_SECRET || !env.DROPBOX_REFRESH_TOKEN) throw new HttpError(503, 'dropbox-nicht-eingerichtet');
  MEM.dbxP = (async () => {
    const r = await fetch(env.__DBX_API || 'https://api.dropboxapi.com/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.DROPBOX_REFRESH_TOKEN, client_id: env.DROPBOX_APP_KEY, client_secret: env.DROPBOX_APP_SECRET })
    });
    if (!r.ok) { console.error('Dropbox-Token', r.status, await r.text()); throw new HttpError(503, 'dropbox-token-fehler'); }
    const d = await r.json();
    MEM.dbx = { token: d.access_token, exp: Date.now() + (d.expires_in || 14400) * 1000 };
    return MEM.dbx.token;
  })();
  try { return await MEM.dbxP; } finally { MEM.dbxP = null; }
}

const dbxContent = env => env.__DBX_CONTENT || 'https://content.dropboxapi.com';
const dbxApi = env => env.__DBX_RPC || 'https://api.dropboxapi.com';

// Dropbox-API-Arg muss im Header ASCII sein: Umlaute als \uXXXX
const headerJson = o => JSON.stringify(o).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

async function dbxUploadStream(env, request, pfad, max, magic) {
  const len = Number(request.headers.get('Content-Length'));
  if (!len) throw new HttpError(411, 'laenge-fehlt', 'Content-Length fehlt');
  if (len > max) throw new HttpError(413, 'zu-gross', `Datei zu gross (max. ${Math.round(max / 1048576)} MB)`);
  if (!request.body) throw new HttpError(400, 'leer');
  const token = await dbxToken(env);

  // Ersten Teil lesen (Magic-Bytes prüfen), danach unverändert durchreichen, ohne alles im Speicher zu halten
  const reader = request.body.getReader();
  let erst = new Uint8Array(0);
  while (erst.length < 8) {
    const { value, done } = await reader.read();
    if (done) break;
    const n = new Uint8Array(erst.length + value.length); n.set(erst); n.set(value, erst.length); erst = n;
  }
  if (magic && !magic(erst)) { reader.cancel().catch(() => {}); throw new HttpError(415, 'kein-pdf', 'Datei ist kein PDF'); }

  let body;
  if (typeof FixedLengthStream !== 'undefined') {
    const { readable, writable } = new FixedLengthStream(len);
    (async () => {
      const w = writable.getWriter();
      try { await w.write(erst); for (;;) { const { value, done } = await reader.read(); if (done) break; await w.write(value); } await w.close(); }
      catch (e) { w.abort(e).catch(() => {}); }
    })();
    body = readable;
  } else {
    // Node/Test: puffern
    const chunks = [erst]; let total = erst.length;
    for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); total += value.length; if (total > max) throw new HttpError(413, 'zu-gross'); }
    body = new Uint8Array(total); let o = 0; for (const c of chunks) { body.set(c, o); o += c.length; }
  }

  const r = await fetch(dbxContent(env) + '/2/files/upload', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'Content-Length': String(len), 'Dropbox-API-Arg': headerJson({ path: pfad, mode: 'add', autorename: false, mute: true, strict_conflict: true }) },
    body
  });
  if (r.status === 401) { MEM.dbx = null; throw new HttpError(503, 'dropbox-token-abgelaufen', 'Bitte erneut versuchen'); }
  if (r.status === 409) { const t = await r.text(); if (/conflict/.test(t)) throw new HttpError(409, 'existiert', 'Datei existiert bereits'); console.error('Dropbox upload 409', t); throw new HttpError(502, 'dropbox-upload-fehler', 'Upload zu Dropbox fehlgeschlagen'); }
  if (!r.ok) { console.error('Dropbox upload', r.status, await r.text()); throw new HttpError(502, 'dropbox-upload-fehler', 'Upload zu Dropbox fehlgeschlagen'); }
  const d = await r.json();
  if (Number(d.size) !== len) throw new HttpError(502, 'groesse-falsch', 'Upload unvollständig');
  return d;
}

async function dbxDownload(env, pfad, versuch = 0) {
  const r = await fetch(dbxContent(env) + '/2/files/download', {
    method: 'POST', headers: { Authorization: 'Bearer ' + await dbxToken(env, versuch > 0), 'Dropbox-API-Arg': headerJson({ path: pfad }) }
  });
  if (r.status === 401 && versuch === 0) { MEM.dbx = null; return dbxDownload(env, pfad, 1); }
  if (r.status === 409) { const t = await r.text(); if (/not_found/.test(t)) throw new HttpError(404, 'datei-fehlt-in-dropbox', 'Datei fehlt in Dropbox'); console.error('Dropbox download 409', t); throw new HttpError(502, 'dropbox-fehler'); }
  if (r.status === 429) throw new HttpError(503, 'dropbox-ausgelastet', 'Dropbox ausgelastet, bitte erneut versuchen');
  if (!r.ok) { console.error('Dropbox download', r.status, await r.text()); throw new HttpError(502, 'dropbox-fehler'); }
  return r;
}

async function dbxDelete(env, pfad, versuch = 0) {
  const r = await fetch(dbxApi(env) + '/2/files/delete_v2', {
    method: 'POST', headers: { Authorization: 'Bearer ' + await dbxToken(env, versuch > 0), 'Content-Type': 'application/json' }, body: JSON.stringify({ path: pfad })
  });
  if (r.status === 401 && versuch === 0) { MEM.dbx = null; return dbxDelete(env, pfad, 1); }
  if (r.status === 409) { const t = await r.text(); if (/not_found/.test(t)) return; console.error('Dropbox delete 409', t); throw new HttpError(502, 'dropbox-fehler'); }
  if (!r.ok) { console.error('Dropbox delete', r.status, await r.text()); throw new HttpError(502, 'dropbox-fehler'); }
}

/* ---------------------------------------------------------------- Helfer */
function edgeCache() { try { return typeof caches !== 'undefined' && caches.default ? caches.default : null; } catch (e) { return null; } }

function mitDateiname(res, name, typ) {
  const r = new Response(res.body, res);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  r.headers.set('Content-Type', typ);
  r.headers.set('Content-Disposition', `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  r.headers.set('Cache-Control', 'private, max-age=0');
  return r;
}

const magicPdf = u => u.length >= 5 && u[0] === 0x25 && u[1] === 0x50 && u[2] === 0x44 && u[3] === 0x46 && u[4] === 0x2d; // %PDF-


async function gleich(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y); let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0 && a.length > 0;
}

function b64url(u) { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64Bytes(s) { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
function b64urlBytes(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return b64Bytes(s); }
function b64urlText(s) { return new TextDecoder().decode(b64urlBytes(s)); }

export const __test = { MEM, headerJson, zuFs, dateiPfad, sitzungErstellen, abgelaufen };
