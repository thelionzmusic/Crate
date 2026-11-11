// Library views that aren't track lists: duplicates and the wishlist.
import { h, icon, mount } from "../core/dom.js";
import { api, safe } from "../core/api.js";
import { emit } from "../core/bus.js";
import { confirmSheet } from "../core/ui.js";
import { S, loadNodes, loadTracks } from "../state.js";
import { pollSoon } from "../jobs.js";
import { searchFor } from "./downloads.js";

const head = (title, sub, ...actions) => h("div", { class: "listhead" }, h("h2", {}, title), h("span", { class: "sub" }, sub), h("div", { class: "spacer" }), ...actions);
const blank = (strong, p) => h("div", { class: "empty", style: "position:static;padding:60px" }, h("strong", {}, strong), h("p", {}, p));

export function scanDuplicates() { S.dupes = null; api("duplicates", {}).then(pollSoon); }

export function renderDupes(panel) {
  const pane = h("div", { class: "pane" });
  if (!S.dupes) pane.append(blank("Listening for duplicates", "Crate compares every recording by sound, so different formats and tags still match."));
  else if (!S.dupes.length) pane.append(blank("No duplicates", "Every recording is in your library once."));
  for (const g of S.dupes || []) {
    let keep = g.keep;
    const rows = g.tracks.map((id) => S.byId.get(id)).filter(Boolean);
    pane.append(h("div", { class: "card" }, ...rows.map((t) => h("label", { class: "row" },
      h("input", { type: "radio", name: `g${g.keep}`, checked: t.id === g.keep, onchange: () => { keep = t.id; } }),
      h("div", { class: "grow" }, h("div", {}, t.title), h("div", { class: "t3" }, t.path)),
      h("span", { class: "tag" }, `${(t.codec || "").toUpperCase()} ${t.bitrate} kbps`),
      t.issues && t.issues.length ? h("span", { class: "tag bad", title: t.issues.join("\n") }, "issues") : h("span", { class: "tag good" }, "clean"))),
    h("div", { class: "row", style: "justify-content:flex-end" }, h("button", { class: "btn sm", onclick: safe(async () => {
      const drop = g.tracks.filter((id) => id !== keep);
      if (!await confirmSheet("Keep one copy?", `The other ${drop.length} leave the library and their playlists. Files stay on your drive.`, "Keep this copy")) return;
      await api("remove", { ids: drop }); S.dupes = S.dupes.filter((x) => x !== g); await loadTracks(); await loadNodes();
    }) }, "Keep the ticked copy"))));
  }
  mount(panel, head("Duplicates", "The same recording more than once. The best copy is ticked",
    h("button", { class: "btn sm", onclick: () => { scanDuplicates(); emit("view"); } }, "Scan again")), pane);
}

export async function renderWish(panel) {
  S.wishlist = await api("wishlist");
  const artist = h("input", { class: "field", placeholder: "Artist", style: "width:200px" }), title = h("input", { class: "field", placeholder: "Track", style: "flex:1" });
  const add = safe(async () => { if (!artist.value && !title.value) return; await api("wish", { artist: artist.value, title: title.value }); emit("view"); });
  title.onkeydown = artist.onkeydown = (e) => e.key === "Enter" && add();
  mount(panel, head("Wishlist", "Tracks to buy, with one-click store search"), h("div", { class: "pane" },
    h("div", { class: "card" }, h("div", { class: "row" }, artist, title, h("button", { class: "btn primary sm", onclick: add }, "Add"))),
    S.wishlist.length ? h("div", { class: "card" }, ...S.wishlist.map((w) => h("div", { class: "row" },
      h("div", { class: "grow" }, h("div", {}, w.title || "Untitled"), h("div", { class: "t3" }, [w.artist, w.added].filter(Boolean).join(", "))),
      ...Object.entries(w.links).map(([store, url]) => h("button", { class: "btn sm", onclick: safe(() => api("open", { url })) }, store)),
      S.settings?.labs_soulseek === "1" ? h("button", { class: "btn sm", onclick: () => searchFor([w.artist, w.title].filter(Boolean).join(" ")) }, "Soulseek") : null,
      h("button", { class: "btn sm icon ghost", "aria-label": "Remove", onclick: safe(async () => { await api("wish", { remove: w.id }); emit("view"); }) }, icon("i-x", "i sm")))))
      : h("p", { class: "t3", style: "margin:4px 2px" }, "Anything you buy lands in your library by itself: Crate watches your Downloads folder and analyses new tracks as they arrive.")));
}
