// Updates: the status-bar note, one-click install, and installing from a .zip.
import { $, h, mount } from "../core/dom.js";
import { api, safe, toast } from "../core/api.js";
import { on } from "../core/bus.js";
import { S } from "../state.js";

export const installLatest = safe(async () => { toast("Downloading the update"); const before = S.state.version; await api("update/fetch", {}); waitForRestart(before); });

async function installFile(file) {
  if (!file || !/\.zip$/i.test(file.name)) return toast("Updates are .zip files.");
  const before = S.state.version; toast(`Installing ${file.name}`, 3000);
  const r = await fetch("/api/update", { method: "POST", body: await file.arrayBuffer() }), j = await r.json();
  if (!r.ok) return toast(j.error || "The update couldn't be installed.", 8000);
  return waitForRestart(before, j.version);
}
export const chooseFile = () => $("#updateFile").click();

function waitForRestart(before, version) {
  toast(`Updating${version ? ` to ${version}` : ""}. Crate restarts in a moment.`, 15000);
  const start = Date.now();
  const wait = async () => {
    try { const st = await api("state"); if (st.version !== before || Date.now() - start > 8000) return location.reload(); } catch { /* still restarting */ }
    if (Date.now() - start < 60000) setTimeout(wait, 700); else toast("Crate didn't come back. Open it again from the shortcut.", 15000);
    return undefined;
  };
  setTimeout(wait, 1500);
}

export function init() {
  on("state", () => {
    const u = S.state.update, n = $("#updateNote"); n.hidden = !u;
    if (u) mount(n, h("button", { class: "btn sm ghost", style: "color:var(--accent)", onclick: installLatest }, `Crate ${u.version} is ready. Install`));
  });
  $("#updateFile").addEventListener("change", (e) => { installFile(e.target.files[0]); e.target.value = ""; });
  addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
  addEventListener("drop", (e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); installFile(e.dataTransfer.files[0]); });
}
