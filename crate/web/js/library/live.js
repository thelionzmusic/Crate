// Live: what the CDJs are doing right now, over Pro DJ Link, and the set as it's played.
// Every track that plays on air for 30 seconds lands in History, with its play counted.
import { h, mount } from "../core/dom.js";
import { api, toast } from "../core/api.js";
import { S } from "../state.js";
import { camelotColor, plural } from "../core/format.js";
import { nextRows } from "../sheets/next.js";

let timer = null, nextFor = null, nextBox = null;
const here = () => S.view.kind === "live";
const clock = (s) => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const name = (x) => (x.info ? `${x.info.artist ? `${x.info.artist} - ` : ""}${x.info.title}` : `Track ${x.track}, not in this library`);

// "00:00:00 Artist - Title" lines, timed from the first track: what SoundCloud and YouTube want
export const tracklist = (log) => log.map((e) => `${clock(e.started - log[0].started)} ${name(e)}`).join("\n");

function deckCard(d) {
  const tags = [d.playing ? "Playing" : "Paused", d.on_air ? "On air" : null, d.master ? "Master" : null].filter(Boolean);
  return h("div", { class: "card deck-live" + (d.playing && d.on_air ? " hot" : "") },
    h("div", { class: "top" }, h("strong", {}, `Deck ${d.number}`), d.slot !== "none" ? h("span", { class: "t3" }, d.slot) : null, h("div", { class: "spacer" }),
      ...tags.map((t) => h("span", { class: "tag" }, t))),
    h("div", { class: "now" }, d.track ? name(d) : h("span", { class: "t3" }, "Nothing loaded")),
    h("div", { class: "meta" }, d.bpm ? h("span", { class: "t2" }, `${(d.bpm * (1 + d.pitch / 100)).toFixed(1)} BPM`) : null,
      d.bpm ? h("span", { class: "t3" }, `${d.pitch > 0 ? "+" : ""}${d.pitch.toFixed(2)}%`) : null,
      d.info?.camelot ? h("span", { class: "key", style: `--kc:${camelotColor(d.info.camelot)}` }, d.info.camelot) : null));
}

export async function renderLive(panel) {
  clearTimeout(timer);
  if (!here()) return;
  let r;
  try { r = await api("live"); } catch { r = { running: false, decks: [], log: [], devices: [] }; }
  if (!here()) return;
  const sub = r.error ? r.error : !r.running ? "Turn on Follow the CDJs in Settings" : r.devices.length
    ? `${plural(r.devices.filter((d) => d.number < 7).length, "player")}${r.mixer ? " and a mixer" : ""} on the link. Crate is player ${r.number}`
    : "Listening for players. Connect this computer to the same switch or router as the CDJs";
  const copy = h("button", { class: "btn sm", disabled: !r.log.length, onclick: async () => {
    try { await navigator.clipboard.writeText(tracklist(r.log)); toast("Tracklist copied"); } catch { toast("Couldn't reach the clipboard"); }
  } }, "Copy tracklist");
  mount(panel, h("div", { class: "listhead" }, h("h2", {}, "Live"), h("span", { class: "sub" }, sub), h("div", { class: "spacer" }), copy),
    h("div", { class: "pane dl" },
      r.decks.length ? h("div", { class: "decks-live" }, ...r.decks.map(deckCard)) : null,
      h("div", { class: "card" }, h("div", { class: "row" }, h("strong", {}, "This set"), h("span", { class: "t3" },
        r.log.length ? `${plural(r.log.length, "track")}, saved to History as they play` : "Tracks appear here once they've played on air for 30 seconds")),
        ...r.log.map((e) => h("div", { class: "row setline" }, h("span", { class: "t3 mono" }, clock(e.started - r.log[0].started)),
          h("span", {}, name(e)), h("div", { class: "spacer" }), h("span", { class: "t3" }, `Deck ${e.deck}`))))));
  // what to play after the deck that's on air (the master if several are), refreshed when it changes
  const lead = r.decks.filter((d) => d.info && d.playing && d.on_air).sort((a, b) => b.master - a.master)[0];
  if (lead && lead.track !== nextFor) {
    nextFor = lead.track;
    nextBox = h("div", { class: "card" }, h("div", { class: "row" }, h("strong", {}, `Up next after ${lead.info.title}`)),
      h("div", { class: "group nextlist" }, ...await nextRows(lead.track, 8)));
  }
  if (lead && nextBox) panel.querySelector(".pane").append(nextBox);
  timer = setTimeout(() => renderLive(panel), r.running ? 1000 : 4000);
}
