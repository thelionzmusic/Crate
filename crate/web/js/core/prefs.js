// Per-machine preferences in localStorage. Storage can be blocked, so every access is guarded.
// Older versions stored some values as bare strings, which read back as-is.

export function pref(key, fallback) {
  let v;
  try { v = localStorage.getItem(key); } catch { return fallback; }
  if (v == null || v === "") return fallback;
  try { return JSON.parse(v); } catch { return v; }
}

export function setPref(key, value) {
  try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage off */ }
}
