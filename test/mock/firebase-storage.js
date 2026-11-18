// Attrappe für Firebase Storage (im Test nicht benutzt)
export const getStorage = () => ({});
export const ref = (st, p) => ({ path: p });
export function uploadBytesResumable() { const t = { on(ev, a, rej) { setTimeout(() => rej(new Error('Storage im Test nicht verfügbar')), 10); } }; return t; }
export async function getBlob() { const e = new Error('nicht gefunden'); e.code = 'storage/object-not-found'; throw e; }
export async function deleteObject() {}
