// Talking to Crate's local server, and reporting failures.
import { h, $ } from "./dom.js";

export async function api(path, body) {
  const r = await fetch(`/api/${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

export function toast(msg, ms = 4200) {
  $(".toast")?.remove();
  const t = h("div", { class: "toast", role: "status" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

// wrap an action so any error becomes a toast instead of an unhandled rejection
export const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, 7000); } };
