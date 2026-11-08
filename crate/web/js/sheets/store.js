// Store search: buy the track, or a better copy of one with problems.
import { h, icon } from "../core/dom.js";
import { api, safe } from "../core/api.js";
import { sheet } from "../core/ui.js";

export async function storeSheet(t) {
  const links = await api(`links?artist=${encodeURIComponent(t.artist || "")}&title=${encodeURIComponent(t.title || "")}`);
  return sheet({
    title: t.issues && t.issues.length ? "Find a better copy" : "Search the stores", text: `${t.artist ? `${t.artist} - ` : ""}${t.title}`,
    body: h("div", { class: "group" }, ...(t.issues || []).map((i) => h("div", { class: "gr t2" }, i)),
      h("div", { class: "gr", style: "gap:6px;flex-wrap:wrap" }, ...Object.entries(links).map(([s, url]) => h("button", { class: "btn", onclick: safe(() => api("open", { url })) }, icon("i-store"), s)))),
    actions: [{ left: "Purchases in Downloads are imported automatically" }, { label: "Done", result: true, default: true }],
  });
}
