// Nachbildung von Firebase Auth für lokale Tests (pro Browser-Tab, sessionStorage). Nur für Tests.
const KEY = 'mock-auth-user';
const subs = new Set();
function mkUser(u) {
  if (!u) return null;
  return { uid: u.uid, email: u.email || null, isAnonymous: !!u.anon,
    async getIdToken() { const r = await fetch(`/mock/token?uid=${encodeURIComponent(u.uid)}&anon=${u.anon ? 1 : 0}`); return r.text(); } };
}
export const __auth = { currentUser: mkUser(JSON.parse(sessionStorage.getItem(KEY) || 'null')) };
function setze(u) { sessionStorage.setItem(KEY, JSON.stringify(u)); __auth.currentUser = mkUser(u); subs.forEach(cb => cb(__auth.currentUser)); }
export const getAuth = () => __auth;
export function onAuthStateChanged(auth, cb) { subs.add(cb); setTimeout(() => cb(__auth.currentUser), 50); return () => subs.delete(cb); }
export async function signInAnonymously() {
  await new Promise(r => setTimeout(r, 100));
  setze({ uid: 'anon_' + Math.random().toString(36).slice(2, 10), anon: true });
  return { user: __auth.currentUser };
}
export async function signInWithEmailAndPassword(auth, email, pw) {
  const r = await fetch('/mock/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, pw }) });
  if (!r.ok) { const e = new Error('auth'); e.code = 'auth/invalid-credential'; throw e; }
  setze(await r.json()); return { user: __auth.currentUser };
}
export async function signOut() { setze(null); }
export async function sendPasswordResetEmail() {}
