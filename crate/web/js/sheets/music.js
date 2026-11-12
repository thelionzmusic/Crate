// Bringing music in: watched folders and rekordbox imports.
import { h } from "../core/dom.js";
import { api, safe, toast } from "../core/api.js";
import { askSheet, gr, sheet } from "../core/ui.js";
import { pollSoon } from "../jobs.js";

export const addFolder = safe(async () => {
  let r = await api("folders", {});
  if (r.cancelled) { const path = await askSheet("Add a music folder", "", "Type or paste the folder's full path."); if (!path) return; r = await api("folders", { path }); }
  toast(`Scanning ${r.path}`); pollSoon();
});

// Two ways in: the USB stick you already play from (nothing to set up in rekordbox), or an
// exported collection XML (everything, including tracks that aren't on a stick).
export const importRekordbox = safe(async () => {
  const sticks = (await api("drives")).filter((d) => d.library);
  const pick = await sheet({ title: "Import from rekordbox", width: 580,
    text: "Brings in your tracks with rekordbox's beat grids, hot cues, memory cues, loops, colours, ratings, play counts and playlists. Crate's analysis never overwrites those grids.",
    body: (close) => h("div", { class: "group" },
      ...sticks.map((d) => gr(`USB stick ${d.label} (${d.path})`, "Tracks you already have are matched. The rest are copied to Music\\Crate\\From rekordbox",
        h("button", { class: "btn sm primary", onclick: () => close(d.path) }, "Import"))),
      sticks.length ? null : gr("USB stick", "Plug in a stick you exported from rekordbox, then open this again", h("span", { class: "t3" }, "None plugged in")),
      gr("rekordbox.xml", "Your whole collection. In rekordbox: File > Export Collection in xml format",
        h("button", { class: "btn sm", onclick: () => close("xml") }, "Choose file"))),
    actions: [{ label: "Cancel", result: null }] });
  if (!pick) return;
  if (pick === "xml") return importXml();
  await api("import/stick", { path: pick });
  toast("Importing your rekordbox stick. Progress is in the status bar"); pollSoon();
});

export const importXml = safe(async () => {
  let r = await api("import/rekordbox", {});
  if (r.cancelled) {
    const path = await askSheet("Import from rekordbox", "", "In rekordbox choose File > Export Collection in xml format, then paste that file's path here.");
    if (!path) return; r = await api("import/rekordbox", { path });
  }
  toast("Importing your rekordbox collection with its grids, cues and playlists"); pollSoon();
});
