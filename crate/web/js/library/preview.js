// The Library's preview deck: the loaded track, its cues and grid, the inspector and pads.
// Drawing lives in previewview.js; this module owns state and actions and announces
// changes with the "preview" event.
import { $, h, icon, mount } from "../core/dom.js";
import { api, safe, toast } from "../core/api.js";
import { emit, on } from "../core/bus.js";
import { confirmSheet } from "../core/ui.js";
import { setPref } from "../core/prefs.js";
import { COLORS, PAD, PAD_LETTERS, artBg, camelotColor, energyBar, fmtChip, fmtTempos, fmtTime, tempoTitle } from "../core/format.js";
import { S, gainFor } from "../state.js";
import { storeSheet } from "../sheets/store.js";

export const audio = $("#audio");
export const deck = { id: null, t: null, wave: null, cues: [], phrases: [], vocals: [], beats: null, zoom: 10, version: 0 };
const changed = () => { deck.version++; emit("preview"); };

export const pos = () => audio.currentTime || 0;
export const dur = () => audio.duration || (deck.t && deck.t.duration) || 1;
const period = () => (deck.t && deck.t.bpm ? 60 / deck.t.bpm : 0);
export const quantised = () => $("#quant").classList.contains("on");

// [time s, beat index] for every beat between left and right
export function beatTimes(left, right) {
  const t = deck.t; if (!t || !t.bpm) return [];
  if (deck.beats && deck.beats.length) return deck.beats.map((ms, i) => [ms / 1000, i]).filter(([s]) => s >= left && s <= right);
  const p = 60 / t.bpm, t0 = (t.first_beat_ms || 0) / 1000, out = [];
  for (let i = Math.max(0, Math.ceil((left - t0) / p)); t0 + i * p <= right; i++) out.push([t0 + i * p, i]);
  return out;
}
export function snap(s) {
  if (!quantised() || !deck.t?.bpm) return s;
  const near = beatTimes(s - 1, s + 1);
  return near.length ? near.reduce((a, b) => (Math.abs(b[0] - s) < Math.abs(a[0] - s) ? b : a))[0] : s;
}

// ---- loading
function setTrack(t) { deck.t = t; deck.cues = t.cues || []; deck.phrases = t.phrases || []; deck.vocals = t.vocals || []; deck.beats = t.beats || null; }
export const load = safe(async (id) => {
  const [t, buf] = await Promise.all([api(`track/${id}`), fetch(`/api/wave/${id}`).then((r) => r.arrayBuffer())]);
  deck.id = id; setTrack(t); deck.wave = new Uint8Array(buf); setPref("deck", id);
  audio.src = `/api/audio/${id}`; audio.load();
  $("#detail").classList.remove("off");
  renderAll(); changed();
});
async function reload() { if (!deck.id) return; setTrack({ ...deck.t, ...(await api(`track/${deck.id}`)) }); renderAll(); changed(); }
function renderAll() { renderInsp(); renderPads(); updateReadouts(); }

// ---- edits: optimistic locally, saved after a short pause
let saveTimer = null;
function save(fields) {
  const id = deck.id; Object.assign(deck.t, fields); const row = S.byId.get(id); if (row) Object.assign(row, fields);
  renderInsp(); updateReadouts(); changed();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(safe(async () => {
    const t = await api("track", { id, fields }); if (deck.id !== id) return;
    setTrack({ ...deck.t, ...t }); const r = S.byId.get(id); if (r) Object.assign(r, { key: t.key, camelot: t.camelot, variable: t.variable, tempos: t.tempos });
    renderAll(); changed();
  }), 250);
}
const saveCues = safe(async () => { const id = deck.id, r = await api("cues", { id, cues: deck.cues }); if (deck.id === id) { deck.cues = r.cues; renderPads(); changed(); } });

// ---- transport and cues
export function togglePlay() { if (deck.t) audio.paused ? audio.play() : audio.pause(); }
export function seek(s) { if (deck.t) audio.currentTime = Math.max(0, Math.min(dur(), s)); }
export function hotCue(slot, del) {
  if (!deck.t) return;
  const c = deck.cues.find((x) => x.slot === slot);
  if (del) { if (c) { deck.cues = deck.cues.filter((x) => x !== c); saveCues(); } return; }
  if (c) { seek(c.start_ms / 1000); if (audio.paused) audio.play(); return; }
  deck.cues.push({ slot, start_ms: Math.round(snap(pos()) * 1000), end_ms: -1, color: PAD[slot - 1], name: "" }); saveCues();
}
export function deleteCue(c) { deck.cues = deck.cues.filter((x) => x !== c); saveCues(); }
function memoryCue() {
  if (!deck.t) return;
  const at = Math.round(snap(pos()) * 1000);
  if (deck.cues.some((c) => !c.slot && Math.abs(c.start_ms - at) < 20)) return;
  deck.cues.push({ slot: 0, start_ms: at, end_ms: -1, color: null, name: "" }); saveCues();
}
function cueButton() {
  if (!deck.t) return;
  const mem = deck.cues.filter((c) => !c.slot).sort((a, b) => a.start_ms - b.start_ms);
  audio.pause(); seek(mem.length ? mem[0].start_ms / 1000 : (deck.t.first_beat_ms || 0) / 1000);
}

// ---- grid
function downbeatHere() {
  const t = deck.t; if (!t?.bpm) return;
  const near = beatTimes(pos() - 1, pos() + 1); if (!near.length) return;
  const [s, i] = near.reduce((a, b) => (Math.abs(b[0] - pos()) < Math.abs(a[0] - pos()) ? b : a));
  if (deck.beats) { save({ downbeat: ((i % 4) + 4) % 4 }); return; }
  const p = 60 / t.bpm, t0 = ((s % p) + p) % p;
  save({ first_beat_ms: Math.round(t0 * 100000) / 100, downbeat: ((Math.round((s - t0) / p) % 4) + 4) % 4 });
}
function nudge(ms) {
  const t = deck.t; if (!t?.bpm) return;
  let t0 = (t.first_beat_ms || 0) + ms, db = t.downbeat || 0; const p = 60000 / t.bpm;
  if (!deck.beats) { if (t0 < 0) { t0 += p; db = (db + 3) % 4; } else if (t0 >= p) { t0 -= p; db = (db + 1) % 4; } }
  else deck.beats = deck.beats.map((b) => b + ms);
  save({ first_beat_ms: Math.round(t0 * 100) / 100, downbeat: db });
}
function setBpm(v) { if (v > 40 && v < 300) save({ bpm: Math.round(v * 100) / 100 }); else updateReadouts(); }
const autoCuesNow = safe(async () => {
  if (!deck.t) return;
  if (deck.cues.some((c) => !c.auto) && !await confirmSheet("Replace this track's cues?", "Smart cues put the same job on the same pad in every track: A mix in, B build, C drop, D breakdown, E second build, F second drop, G mix out, H an 8-beat intro loop. Markers go on every section and where vocals come in. Your own cues on this track will be removed.", "Replace cues")) return;
  setTrack({ ...deck.t, ...(await api("autocues", { id: deck.id })) }); renderPads(); changed();
  toast(`Placed ${deck.cues.filter((c) => c.slot).length} hot cues and ${deck.cues.filter((c) => !c.slot).length} markers`);
});
export async function redoCues(ids) {
  const r = await api("autocues", { ids });
  if (ids.length === 1 && deck.id === ids[0]) { setTrack({ ...deck.t, ...r }); renderPads(); changed(); }
}

// ---- readouts, inspector, pads
function updateReadouts() {
  const t = deck.t; if (!t) return;
  $("#rBpm").value = t.bpm ? (t.tempos ? fmtTempos(t.tempos, "→") : t.variable ? "Variable" : t.bpm.toFixed(2)) : "–";
  $("#rBpm").title = t.tempos ? `${tempoTitle(t.tempos)}. Type one tempo to replace them with a steady grid` : "";
  const kc = camelotColor(t.camelot);
  $("#rKey").textContent = t.camelot || t.key || "–"; $("#rKey").style.color = kc;
  mount($("#rEnergy"), String(t.energy || "–"), energyBar(t.energy));
}
function renderInsp() {
  const t = deck.t, el = $("#insp");
  if (!t) {
    mount(el, h("div", { class: "head" }, h("div", { class: "art", style: "background:rgba(255,255,255,.06)" }, icon("i-note")),
      h("div", {}, h("div", { class: "title" }, "No track loaded"), h("div", { class: "sub", style: "white-space:normal" }, "Double-click a track, or select it and press Enter"))));
    return;
  }
  const g = gainFor(S.byId.get(t.id) || t), q = t.quality || {};
  mount(el,
    h("div", { class: "head" }, h("div", { class: "art", style: artBg(t) }, t.has_art ? null : icon("i-note")),
      h("div", { style: "min-width:0" }, h("div", { class: "title", title: t.title }, t.title), h("div", { class: "sub" }, [t.artist, t.label].filter(Boolean).join("  /  ") || " "),
        h("div", { class: "chips" }, fmtChip(t), t.tempos ? h("span", { class: "chip tempo", title: tempoTitle(t.tempos) }, `Tempo change ${fmtTempos(t.tempos)}`) : t.variable ? h("span", { class: "chip" }, "Live tempo") : null, t.plays ? h("span", { class: "chip" }, `Played ${t.plays}×`) : null))),
    t.issues && t.issues.length ? h("div", { class: "issues" }, ...t.issues.map((i) => h("div", {}, i)),
      h("div", {}, h("button", { class: "btn sm", onclick: () => storeSheet(t) }, icon("i-store", "i sm"), "Find a better copy"))) : null,
    h("div", { class: "facts" },
      h("span", {}, "Grid"), h("div", { class: "row" },
        h("button", { class: "btn sm", "data-help": "<b>Set 1.1</b>  Make the beat under the playhead bar 1, beat 1  D", onclick: downbeatHere }, "Set 1.1"),
        h("div", { class: "seg" }, h("button", { class: "btn sm icon", "aria-label": "Nudge earlier", "data-help": "<b>Nudge earlier</b>  2 ms  [  (Shift: 10 ms)", onclick: () => nudge(-2) }, "‹"),
          h("button", { class: "btn sm icon", "aria-label": "Nudge later", "data-help": "<b>Nudge later</b>  2 ms  ]", onclick: () => nudge(2) }, "›")),
        h("div", { class: "seg" }, h("button", { class: "btn sm", "data-help": "<b>Half tempo</b>", onclick: () => setBpm(t.bpm / 2) }, "½"), h("button", { class: "btn sm", "data-help": "<b>Double tempo</b>", onclick: () => setBpm(t.bpm * 2) }, "2×"))),
      h("span", {}, "Level"), h("div", { class: "t2", "data-help": g && g.cap ? "<b>Held at the ceiling</b>  This track can't be raised all the way without passing -1 dBTP, so it gets less boost. Nothing is ever limited or distorted" : "<b>Export level</b>  Plain gain on the copy that goes on the stick" },
        g ? `${g.db > 0 ? "+" : ""}${g.db.toFixed(1)} dB on export${g.cap ? ", peak-safe" : ""}` : "–"),
      h("span", {}, "Sound"), h("div", { class: "t2" }, `${(t.sample_rate / 1000).toFixed(1)} kHz, ${t.bit_depth ? `${t.bit_depth}-bit` : `${t.bitrate || ""} kbps`}`),
      q.bandwidth_hz ? h("span", {}, "Top end") : null,
      q.bandwidth_hz ? h("div", { class: "t2", "data-help": "<b>Top end</b>  The highest frequency with real content. Around 16 kHz or below usually means a low-quality MP3 underneath" }, `${(q.bandwidth_hz / 1000).toFixed(1)} kHz`) : null,
      h("span", {}, "Vocals"), h("div", { class: "t2" }, deck.vocals.length ? `${deck.vocals.length} passage${deck.vocals.length > 1 ? "s" : ""}` : "None found"),
      h("span", {}, "Rating"), h("div", { class: "stars", onclick: (e) => { const n = +e.target.dataset.n; if (n) save({ rating: t.rating === n ? 0 : n }); } },
        ...[1, 2, 3, 4, 5].map((n) => (n <= (t.rating || 0) ? h("b", { "data-n": n }, "★") : h("span", { "data-n": n }, "☆")))),
      h("span", {}, "Colour"), h("div", { class: "swatches", onclick: (e) => { const c = e.target.dataset.c; if (c != null) save({ color: +c }); } },
        ...COLORS.map((c, i) => h("i", { class: (t.color || 0) === i ? "on" : "", "data-c": i, style: c ? `background:${c}` : "background:repeating-linear-gradient(135deg,#3a3b41 0 3px,#24252a 3px 6px)" }))),
      h("span", {}, "Cues"), h("div", { class: "row" }, h("button", { class: "btn sm", "data-help": "<b>Smart cues</b>  Replace this track's cues with Crate's performance layout", onclick: autoCuesNow }, "Smart cues"))));
}
function renderPads() {
  mount($("#pads"), ...Array.from({ length: 8 }, (_, k) => {
    const s = k + 1, c = deck.cues.find((x) => x.slot === s), L = PAD_LETTERS[k];
    return h("button", { class: "btn" + (c ? " set" : ""), style: c ? `--c:${c.color || PAD[k]}` : "",
      "data-help": c ? `<b>Hot cue ${L}</b>  ${c.name ? `${c.name}, ` : ""}${fmtTime(c.start_ms / 1000)}. Click to jump  ${s}   Shift-click to delete` : `<b>Hot cue ${L}</b>  Click to set at the playhead  ${s}`,
      onclick: (e) => hotCue(s, e.shiftKey) }, L);
  }));
}

// ---- keyboard (Library mode); returns true when the key was used
export function key(e) {
  const digit = /^Digit([1-8])$/.exec(e.code || "");
  if (e.key === " " && deck.t) { togglePlay(); return true; }
  if (digit) { hotCue(+digit[1], e.shiftKey); return true; }
  switch (e.key) {
    case "m": memoryCue(); return true;
    case "q": $("#quant").classList.toggle("on"); return true;
    case "d": downbeatHere(); return true;
    case "[": nudge(-2); return true;
    case "]": nudge(2); return true;
    case "{": nudge(-10); return true;
    case "}": nudge(10); return true;
    case "ArrowLeft": if (!deck.t) return false; seek(pos() - (period() || 0.5) * (e.shiftKey ? 16 : 1)); return true;
    case "ArrowRight": if (!deck.t) return false; seek(pos() + (period() || 0.5) * (e.shiftKey ? 16 : 1)); return true;
    default: return false;
  }
}

export function init() {
  $("#play").onclick = togglePlay;
  audio.onplay = audio.onpause = () => { mount($("#play"), icon(audio.paused ? "i-play" : "i-pause", "i fill")); $("#play").classList.toggle("on", !audio.paused); emit("preview"); };
  audio.onerror = () => deck.t && toast("This file can't be previewed here, but it still exports.");
  $("#cueBtn").onclick = cueButton; $("#memBtn").onclick = memoryCue;
  $("#rBpm").addEventListener("change", (e) => setBpm(parseFloat(e.target.value)));
  $("#rBpm").addEventListener("focus", (e) => e.target.select());
  for (const id of ["#quant", "#metro"]) $(id).onclick = (e) => e.currentTarget.classList.toggle("on");
  on("job", reload);
  on("tracks", () => { if (deck.t) renderInsp(); });
  renderInsp(); renderPads();
}
