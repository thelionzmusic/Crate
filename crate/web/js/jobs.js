// Background job progress in the status bar, and a toast when each job finishes.
import { $ } from "./core/dom.js";
import { api, toast } from "./core/api.js";
import { emit } from "./core/bus.js";
import { plural } from "./core/format.js";
import { S, loadTracks, reloadAll } from "./state.js";
import { showCheck } from "./sheets/check.js";

const QUIET = new Set(["Exporting", "Finding duplicates", "Updating smart cues", "Checking stick"]);  // jobs that don't change the track list as they go
let timer = null, lastReload = 0, seen = null;

function report(j) {
  const r = j.result;
  if (j.error) return toast(j.error, 8000);
  if (!r) return;
  switch (j.name) {
    case "Exporting": {
      const bad = (r.sticks || [r]).find((x) => x.check && !x.check.ok);
      if (bad) return showCheck({ ...bad.check, root: bad.root });
      const sessions = (r.sticks || []).reduce((s, x) => s + (x.history?.sessions || 0), 0), n = (r.sticks || [r]).length;
      return toast(`${r.tracks} tracks and ${r.playlists} playlists on ${n > 1 ? `${n} sticks` : "the stick"}${r.target_lufs != null ? `, levelled to ${r.target_lufs.toFixed(1)} LUFS` : ""}.`
        + `${sessions ? ` Saved ${plural(sessions, "history session")}.` : ""}${r.check ? " Checked: it reads back clean." : ""}${r.warnings.length ? `  ${r.warnings[0]}` : ""}`, 9000);
    }
    case "Analysing": return toast(`Analysed ${r.analysed} tracks in ${r.seconds}s${r.errors ? `, ${r.errors} couldn't be read` : ""}`);
    case "Importing downloads": return toast(`Imported ${plural(r.added, "new track")} from Downloads`);
    case "Importing rekordbox": return toast(`Imported ${r.tracks} tracks and ${r.playlists} playlists${r.found ? `, finding ${r.found} that had moved` : ""}${r.missing ? `. ${r.missing} files weren't found` : ""}`, 8000);
    case "Importing rekordbox stick": return toast(`Imported ${r.tracks} tracks and ${r.playlists} playlists: ${r.matched} you already had, ${r.copied} copied to ${r.dest}${r.missing ? `. ${r.missing} files weren't on the stick` : ""}`, 9000);
    case "Finding moved files": return toast(r.missing ? `Reconnected ${r.found} of ${r.missing} missing tracks` : "No tracks are missing");
    case "Importing play history": return toast(r.sessions ? `Saved ${plural(r.sessions, "history session")} to History` : "No new play history on that stick");
    case "Checking stick": return showCheck(r);
    case "Finding duplicates": S.dupes = r.groups; return undefined;
    default: return undefined;
  }
}

async function poll() {
  clearTimeout(timer);
  let j;
  try { j = await api("job"); } catch { timer = setTimeout(poll, 2000); return; }
  const active = !!(j.running || j.queued.length);
  $("#job").hidden = !active;
  $("#jobbar").style.width = `${(j.progress * 100).toFixed(1)}%`;
  $("#jobmsg").textContent = active ? `${j.name}, ${j.message}` : "";
  if (active && !QUIET.has(j.name) && Date.now() - lastReload > 2500) { lastReload = Date.now(); await loadTracks(); }
  // a job that finished since the last look, even one too quick to be seen running
  if (!active && seen !== null && j.seq > seen) { await reloadAll(); report(j); emit("job", j); }
  if (!active || seen === null) seen = j.seq;
  timer = setTimeout(poll, active ? 700 : 2500);
}

export const startPolling = () => poll();
export const pollSoon = () => { clearTimeout(timer); timer = setTimeout(poll, 150); };
