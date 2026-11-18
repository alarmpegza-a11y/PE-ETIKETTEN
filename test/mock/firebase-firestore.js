// Nachbildung von Firestore für lokale Tests. Daten liegen im Testserver (test/dev-server.mjs),
// der auch die Firestore-Regeln nachbildet. Nur für Tests, nie produktiv.
import { __auth } from './firebase-auth.js';

const DEL = { __op: 'delete' };
export const initializeFirestore = () => ({});
export const getFirestore = () => ({});
export const persistentLocalCache = () => ({});
export const persistentMultipleTabManager = () => ({});
export const collection = (fs, name) => ({ type: 'coll', path: name });
export const doc = (fs, ...p) => ({ type: 'doc', path: p.join('/'), id: p[p.length - 1] });
export const where = (field, op, value) => ({ field, op, value });
export const query = (coll, ...w) => ({ type: 'query', path: coll.path, where: w });
export const arrayUnion = (...v) => ({ __op: 'arrayUnion', v });
export const arrayRemove = (...v) => ({ __op: 'arrayRemove', v });
export const deleteField = () => DEL;
export class Bytes {
  constructor(u) { this._u = u; }
  static fromUint8Array(u) { return new Bytes(new Uint8Array(u)); }
  toUint8Array() { return this._u; }
  toJSON() { let s = ''; for (let i = 0; i < this._u.length; i += 0x8000) s += String.fromCharCode.apply(null, this._u.subarray(i, i + 0x8000)); return { __bytes: btoa(s) }; }
}
function wiederBytes(x) {
  if (Array.isArray(x)) return x.map(wiederBytes);
  if (x && typeof x === 'object') {
    if (typeof x.__bytes === 'string') { const b = atob(x.__bytes); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return new Bytes(u); }
    const o = {}; for (const [k, v] of Object.entries(x)) o[k] = wiederBytes(v); return o;
  }
  return x;
}

const meta = { fromCache: false, hasPendingWrites: false };
async function hdr() { const u = __auth.currentUser; return u ? { Authorization: 'Bearer ' + await u.getIdToken() } : {}; }
async function call(pfad, body) {
  const r = await fetch('/mock/db/' + pfad, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await hdr()) }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) { const e = new Error(d.code || 'fehler'); e.code = d.code || 'internal'; throw e; }
  return d;
}
const docSnap = (path, d) => ({ id: path.split('/').pop(), exists: () => !!d.exists, data: () => d.exists ? wiederBytes(structuredClone(d.data)) : undefined, metadata: meta });
const qSnap = (rows, alt) => {
  const docs = rows.map(r => ({ id: r.id, data: () => wiederBytes(structuredClone(r.data)) }));
  const sig = JSON.stringify(rows);
  return { docs, metadata: meta, docChanges: () => (alt === sig ? [] : docs.map(d => ({ type: 'modified', doc: d }))), __sig: sig };
};

export async function getDoc(ref) { return docSnap(ref.path, await call('get', { path: ref.path })); }
export async function getDocs(q) { return qSnap((await call('query', { path: q.path, where: q.where || [] })).rows); }
export function setDoc(ref, data, opt = {}) { return call('write', { op: 'set', path: ref.path, data, merge: !!opt.merge }).then(() => {}); }
export function updateDoc(ref, data) { return call('write', { op: 'update', path: ref.path, data }).then(() => {}); }
export function deleteDoc(ref) { return call('write', { op: 'delete', path: ref.path }).then(() => {}); }
export async function runTransaction(fs, fn) {
  const upd = [];
  const tx = { get: getDoc, update: (ref, data) => { upd.push([ref, data]); } };
  const r = await fn(tx);
  for (const [ref, data] of upd) await updateDoc(ref, data);
  return r;
}

// Live-Updates: Server meldet geänderte Pfade per Server-Sent Events
const LIS = new Set();
let es = null;
function events() {
  if (es) return;
  es = new EventSource('/mock/db/events');
  es.onmessage = ev => { const p = JSON.parse(ev.data).path; for (const l of LIS) l.check(p); };
}
export function onSnapshot(ref, a, b, c) {
  let next = a, err = b;
  if (typeof a === 'object' && a && !a.type) { next = b; err = c; }
  events();
  let alt = null, aktiv = true;
  const run = async () => {
    try {
      if (ref.type === 'doc') { const s = await getDoc(ref); const sig = JSON.stringify([s.exists(), s.data()]); if (aktiv && sig !== alt) { alt = sig; next(s); } }
      else { const s = await getDocs(ref); if (aktiv && s.__sig !== alt) { const prev = alt; alt = s.__sig; next(qSnap(JSON.parse(s.__sig), prev)); } }
    } catch (e) { if (aktiv && err) err(e); }
  };
  const l = { check: p => { const coll = ref.path.split('/')[0]; if (p === ref.path || p.split('/')[0] === coll || p.startsWith('rollen/')) run(); } };
  LIS.add(l); run();
  return () => { aktiv = false; LIS.delete(l); };
}
