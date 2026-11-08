// Bringing music in: watched folders and rekordbox imports.
import { api, safe, toast } from "../core/api.js";
import { askSheet } from "../core/ui.js";
import { pollSoon } from "../jobs.js";

export const addFolder = safe(async () => {
  let r = await api("folders", {});
  if (r.cancelled) { const path = await askSheet("Add a music folder", "", "Type or paste the folder's full path."); if (!path) return; r = await api("folders", { path }); }
  toast(`Scanning ${r.path}`); pollSoon();
});

export const importRekordbox = safe(async () => {
  let r = await api("import/rekordbox", {});
  if (r.cancelled) {
    const path = await askSheet("Import from rekordbox", "", "In rekordbox choose File > Export Collection in xml format, then paste that file's path here.");
    if (!path) return; r = await api("import/rekordbox", { path });
  }
  toast("Importing your rekordbox collection with its grids, cues and playlists"); pollSoon();
});
