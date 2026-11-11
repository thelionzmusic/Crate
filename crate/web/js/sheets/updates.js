// Updates: Crate checks GitHub at launch and every few hours; a new version shows as one
// button in the top bar that downloads, installs and restarts. Installing from a .zip still works.
import { $ } from "../core/dom.js";
import { api, safe, toast } from "../core/api.js";
import { emit, on } from "../core/bus.js";
import { S } from "../state.js";

const RECHECK_MS = 6 * 3600 * 1000;
const FLAG = "crate-updating-from";  // survives the reload, to confirm the update landed

export const installLatest = safe(async () => {
  const u = S.state.update, btn = $("#updateBtn");
  if (!u) return;
  btn.disabled = true; btn.textContent = `Updating to ${u.version}…`;
  try { await api("update/fetch", {}); } catch (e) { btn.disabled = false; show(); throw e; }
  waitForRestart(S.state.version, u.version);
});

// "Check for updates" in Settings: resolves to a sentence for the person
export async function checkNow() {
  const r = await api("update/check", {});
  setUpdate(r.update);
  return r.update ? `Crate ${r.update.version} is available` : `You're up to date: Crate ${r.current}`;
}

async function installFile(file) {
  if (!file || !/\.zip$/i.test(file.name)) return toast("Updates are .zip files.");
  const before = S.state.version; toast(`Installing ${file.name}`, 3000);
  const r = await fetch("/api/update", { method: "POST", body: await file.arrayBuffer() }), j = await r.json();
  if (!r.ok) return toast(j.error || "The update couldn't be installed.", 8000);
  return waitForRestart(before, j.version);
}
export const chooseFile = () => $("#updateFile").click();

function waitForRestart(before, version) {
  try { sessionStorage.setItem(FLAG, before); } catch { /* the confirmation is a nicety */ }
  toast(`Updating${version ? ` to ${version}` : ""}. Crate restarts in a moment.`, 15000);
  const start = Date.now();
  const wait = async () => {
    try { const st = await api("state"); if (st.version !== before || Date.now() - start > 8000) return location.reload(); } catch { /* still restarting */ }
    if (Date.now() - start < 60000) setTimeout(wait, 700); else toast("Crate didn't come back. Open it again from the shortcut.", 15000);
    return undefined;
  };
  setTimeout(wait, 1500);
}

function setUpdate(u) {
  S.state.update = u || null;
  show(); emit("state");
}

function show() {
  const u = S.state.update, btn = $("#updateBtn");
  btn.hidden = !u;
  if (!u) return;
  btn.disabled = false;
  btn.textContent = `Update to ${u.version}`;
  const notes = (u.notes || "").split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
  btn.dataset.help = `<b>Crate ${u.version}</b>  ${notes ? `${notes}. ` : ""}Downloads, installs and restarts Crate. Your library stays as it is`;
}

export function init() {
  $("#updateBtn").addEventListener("click", installLatest);
  on("state", show);  // a fresh state from the server carries its own latest check
  show();
  // the launch check may finish after the page loads, so ask again once settled, then every few hours
  const quiet = () => api("update/check", {}).then((r) => setUpdate(r.update)).catch(() => { /* offline: try later */ });
  setTimeout(quiet, 4000);
  setInterval(quiet, RECHECK_MS);
  let from = null;
  try { from = sessionStorage.getItem(FLAG); sessionStorage.removeItem(FLAG); } catch { /* no storage */ }
  if (from && from !== S.state.version) toast(`Updated to Crate ${S.state.version}`, 6000);
  $("#updateFile").addEventListener("change", (e) => { installFile(e.target.files[0]); e.target.value = ""; });
  addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
  addEventListener("drop", (e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); installFile(e.dataTransfer.files[0]); });
}
