// "Add to playlist": a menu of every playlist (with its folders), for any list of tracks.
// Used by the track list's right-click menu and the Downloads tab.
import { api, safe, toast } from "../core/api.js";
import { emit } from "../core/bus.js";
import { menu } from "../core/ui.js";
import { S, nodeById } from "../state.js";

const path = (n) => { const parts = []; for (let p = n; p; p = p.parent_id ? nodeById(p.parent_id) : null) parts.unshift(p.name); return parts.join(" / "); };

export const addToPlaylist = (ids) => ({ label: ids.length > 1 ? `Add ${ids.length} to playlist…` : "Add to playlist…", icon: "i-list", run: () => pick(ids) });

function pick(ids) {
  const lists = S.nodes.filter((n) => !n.is_folder && !n.rules).map((n) => ({ n, label: path(n) })).sort((a, b) => a.label.localeCompare(b.label));
  if (!lists.length) return toast("Make a playlist first: the + next to Playlists");
  const at = menuAt();
  return menu(at, lists.map(({ n, label }) => ({ label, icon: "i-list", run: safe(async () => {
    const have = new Set(n.tracks), add = ids.filter((id) => !have.has(id));
    if (add.length) { n.tracks = [...n.tracks, ...add]; await api("node/tracks", { id: n.id, tracks: n.tracks }); emit("nodes"); }
    toast(add.length ? `Added to ${n.name}` : `Already in ${n.name}`);
  }) })));
}

// the second menu opens where the first one was
let last = { clientX: 200, clientY: 200 };
addEventListener("contextmenu", (e) => { last = { clientX: e.clientX, clientY: e.clientY }; }, true);
const menuAt = () => last;
