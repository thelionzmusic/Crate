// The Performance layout: stacked lanes on top, decks either side of the mixer.
import { $, h, icon, mount, sizeOf, watchSize } from "../core/dom.js";
import { artBg, camelotColor, cueColor, PAD, PAD_LETTERS } from "../core/format.js";
import { overview, tempoMarks } from "../core/wave.js";
import { DECK_IDS, RANGES } from "../engine/engine.js";
import { Widgets, clockText, drag, fader, knob, pbtn, text, vu } from "./controls.js";
import { Lane } from "./lanes.js";
import { FxUnits } from "./fxunits.js";
import { prefs } from "./settings.js";

export const DECK_HUE = { A: "#3d9df3", B: "#ff9f0a", C: "#bf5af2", D: "#30d158" };
const clock = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`; };
const loopLabel = (b) => (b >= 1 ? String(b) : `1/${Math.round(1 / b)}`);
const idsFrom = (e) => JSON.parse(e.dataTransfer.getData("text/crate-ids") || "[]");

// whole-track overview under each deck's readout
// under a deck's BPM: the next tempo change coming up, if the track has one
function nextTempo(d) {
  const tp = d.loaded && d.grid.tempos, now = tp ? d.time(false) : 0, next = tp && tp.find((x) => x.s > now);
  if (!next) return "BPM";
  const bars = Math.ceil((d.grid.index(next.s) - d.grid.index(now)) / 4);
  return `→ ${next.bpm % 1 ? next.bpm.toFixed(1) : next.bpm} in ${bars} bar${bars === 1 ? "" : "s"}`;
}

class DeckOverview {
  constructor(canvas, deck, hue) { this.cv = watchSize(canvas); this.d = deck; this.hue = hue; this.img = null; this.for = null; this.last = ""; }
  draw() {
    const cv = this.cv, d = this.d, dpr = devicePixelRatio, [cw, ch] = sizeOf(cv), W = Math.round(cw * dpr), H = Math.round(ch * dpr);
    if (!W || !H) return;
    const now = d.loaded ? d.time() : 0, sig = `${W}|${H}|${d.version}|${(now * W / (d.duration || 1)).toFixed(1)}`;
    if (sig === this.last) return;
    this.last = sig;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; this.for = null; }
    const g = cv.getContext("2d"); g.clearRect(0, 0, W, H);
    if (!d.loaded) return;
    if (this.for !== d.t.id) { this.img = overview(d.wave, W, H); this.for = d.t.id; }
    g.drawImage(this.img, 0, 0);
    const D = d.duration, x = now / D * W;
    g.save(); g.globalCompositeOperation = "source-atop"; g.fillStyle = "rgba(6,7,10,.6)"; g.fillRect(0, 0, x, H); g.restore();
    if (d.loop) { g.fillStyle = "rgba(255,165,58,.28)"; g.fillRect(d.loop[0] / D * W, 0, Math.max(dpr, (d.loop[1] - d.loop[0]) / D * W), H); }
    for (const q of d.cues) { g.fillStyle = cueColor(q); g.fillRect(q.start_ms / 1000 / D * W, 0, dpr * 1.5, q.slot ? H : H * 0.4); }
    tempoMarks(g, d.t.tempos, D, W, H, this.font ||= getComputedStyle(document.body).fontFamily);
    g.fillStyle = "#fff"; g.fillRect(x - dpr, 0, 2 * dpr, H);
  }
}

export class View {
  constructor(engine, { onLoad }) {
    this.e = engine; this.onLoad = onLoad;
    this.W = new Widgets(); this.lanes = []; this.overviews = []; this.heads = new Map(); this.panels = new Map();
    this.zoom = 8; this.focus = "A"; this.raf = 0; this.fxu = new FxUnits(engine);
    engine.on((kind, d) => { if (kind === "deck") this.heads.get(d.id)?.(); });
  }

  render(count) {
    this.W.clear(); this.lanes = []; this.overviews = []; this.heads.clear(); this.panels.clear();
    const ids = DECK_IDS.slice(0, count), four = count === 4;
    if (!ids.includes(this.focus)) this.focus = "A";
    this.waves = prefs.waves || "decks";
    $("#perform").classList.toggle("nolanes", this.waves === "decks");  // the decks take the lanes' room
    mount($("#perform"), this.waves === "decks" ? null : this.lanesPanel(ids), this.fxu.render(), h("div", { class: "pdecks" + (four ? " four" : "") + (this.waves === "stacked" ? "" : " screens") },
      h("div", { class: "pside" }, this.deckPanel("A"), four ? this.deckPanel("C") : null),
      this.mixer(ids),
      h("div", { class: "pside" }, this.deckPanel("B"), four ? this.deckPanel("D") : null)));
    document.querySelector(".app").classList.toggle("four", four);
  }

  start() { cancelAnimationFrame(this.raf); const loop = () => { this.raf = requestAnimationFrame(loop); this.frame(); }; loop(); }
  stop() { cancelAnimationFrame(this.raf); }
  frame() {
    this.W.sync(); this.fxu.sync();
    for (const l of this.lanes) l.draw(this.zoom);
    for (const o of this.overviews) o.draw();
  }

  zoomBy(f) { this.zoom = Math.min(32, Math.max(2, this.zoom * f)); }

  setFocus(id) {
    if (this.focus === id) return;
    this.focus = id;
    for (const [k, el] of this.panels) el.classList.toggle("focus", k === id);
  }

  // ---- lanes
  lanesPanel(ids) {
    const lanes = ids.map((id) => {
      const d = this.e.deck(id), cv = h("canvas"), lane = new Lane(cv, d, DECK_HUE[id]);
      // drag the waveform to scrub
      drag(cv, (dx) => { if (d.loaded) d.seek(d.time(false) - dx / (sizeOf(cv)[0] / this.zoom) * d.rate); }, { axis: "x" });
      this.lanes.push(lane);
      return h("div", { class: "lane", style: `--h:${DECK_HUE[id]}`, ondragover: (e) => e.preventDefault(), ondrop: (e) => { e.preventDefault(); const t = idsFrom(e)[0]; if (t) this.onLoad(id, t, e.shiftKey); } },
        h("span", { class: "ltag" }, id), cv);
    });
    const zoom = (f) => () => this.zoomBy(f);
    return h("section", { class: "plances", "data-help": "<b>Waveforms</b>  Drag to scrub. Zoom with + and −" }, ...lanes,
      h("div", { class: "lzoom" }, h("button", { class: "btn sm icon", "aria-label": "Zoom in", "data-help": "<b>Zoom in</b>", onclick: zoom(1 / 1.5) }, "+"), h("button", { class: "btn sm icon", "aria-label": "Zoom out", "data-help": "<b>Zoom out</b>", onclick: zoom(1.5) }, "−")));
  }

  // ---- a deck
  deckPanel(id) {
    const e = this.e, d = e.deck(id), W = this.W, hue = DECK_HUE[id], B = (...a) => pbtn(W, ...a), T = (...a) => text(W, ...a);
    const head = h("div", { class: "dhead" });
    const renderHead = () => {
      const t = d.t;
      mount(head, h("span", { class: "dletter", style: `--h:${hue}` }, id), h("span", { class: "dart", style: t ? artBg(t) : "" }),
        h("div", { class: "dtitle" }, h("b", {}, t ? t.title : d.loading ? "Loading..." : "Empty"), h("span", {}, t ? t.artist || "" : `Drag a track here, or select one and press Shift+${id === "A" || id === "C" ? "Left" : "Right"}`)),
        t && t.camelot ? h("span", { class: "key", style: `--kc:${camelotColor(t.camelot)}` }, t.camelot) : null);
    };
    this.heads.set(id, renderHead); renderHead();
    const pitch = () => { const p = (d.baseRate - 1) * 100; return `${p >= 0 ? "+" : "-"}${Math.abs(p).toFixed(2)}%`; };
    const readout = h("div", { class: "dread" },
      h("div", {}, T(() => (d.loaded && d.grid.ok ? d.bpm.toFixed(2) : "--.--"), "big"), T(() => nextTempo(d), "tiny")),
      h("div", {}, T(() => (d.loaded ? pitch() : ""), "mid"), T(() => `±${Math.round(d.range * 100)}%`, "tiny")),
      h("div", { class: "rt" }, clockText(W, () => (d.loaded ? `-${clock(d.duration - d.time())}` : "-:--.-"), "big"), clockText(W, () => (d.loaded ? clock(d.time()) : ""), "small")));
    const ov = h("canvas", { class: "dov", "data-help": "<b>Overview</b>  Click or drag to move through the track" });
    const seekAt = (x) => { if (d.loaded) d.seek(Math.min(1, Math.max(0, x / sizeOf(ov)[0])) * d.duration); };
    ov.addEventListener("pointerdown", (ev) => { ov.setPointerCapture(ev.pointerId); seekAt(ev.offsetX); ov.onpointermove = (m) => seekAt(m.offsetX); ov.onpointerup = () => { ov.onpointermove = null; }; });
    this.overviews.push(new DeckOverview(ov, d, hue));
    // The deck's screen, CDJ style: the scrolling waveform (beat grid, cues, loop, playhead in
    // the middle) over a thin strip of the whole track. Drag to scrub, scroll to zoom.
    let screen = ov;
    if (this.waves !== "stacked") {
      const cv = h("canvas", { class: "dwave", "data-help": "<b>Waveform</b>  Drag to scrub. Scroll to zoom in and out" });
      drag(cv, (dx) => { if (d.loaded) d.seek(d.time(false) - dx / (sizeOf(cv)[0] / this.zoom) * d.rate); }, { axis: "x" });
      cv.addEventListener("wheel", (ev) => { ev.preventDefault(); this.zoomBy(ev.deltaY > 0 ? 1.25 : 0.8); }, { passive: false });
      this.lanes.push(new Lane(cv, d, hue));
      screen = h("div", { class: "dscreen" }, cv, ov);
    }

    const transport = h("div", { class: "trans" },
      B("CUE", () => d.cueDown(), { cls: "round cue", onUp: () => d.cueUp(), on: () => (d.loaded && !d.playing && Math.abs(d.time(false) - d.cueAt) > 0.01 ? "blink" : d.previewing), help: "<b>Cue</b>  Playing: back to the cue point. Stopped: set the cue here, hold to preview  C" }),
      B(icon("i-play", "i fill"), () => d.togglePlay(), { cls: "round play", on: () => d.playing && !d.previewing, help: "<b>Play / pause</b>  Space" }),
      h("div", { class: "tcol" },
        B("SYNC", () => d.setSync(!d.sync), { on: () => d.sync, help: "<b>Sync</b>  Match the leading deck's tempo and stay locked to its beat  S" }),
        B("LEAD", () => e.makeLeader(d), { on: () => e.leaderId === id && d.loaded, help: "<b>Lead</b>  Make this the deck the others sync to" })),
      h("div", { class: "tcol" },
        B("KEY", () => d.setKeylock(!d.keylock), { on: () => d.keylock, help: "<b>Key lock</b>  Change tempo without changing pitch" }),
        B(h("span", {}, "±", T(() => Math.round(d.range * 100))), () => { d.range = RANGES[(RANGES.indexOf(d.range) + 1) % RANGES.length]; d.applyRate(); }, { help: "<b>Tempo range</b>  6, 10, 16 or 50%" })),
      h("div", { class: "loops" },
        h("div", { class: "lrow" },
          B("½", () => d.loopResize(0.5), { cls: "sq", help: "<b>Halve loop</b>  [" }),
          B(T(() => loopLabel(d.loopBeats), "lsz"), () => d.loopToggle(), { cls: "lp", on: () => !!d.loop, help: "<b>Loop</b>  Loop this many beats from the last beat. Press again to exit  L" }),
          B("2×", () => d.loopResize(2), { cls: "sq", help: "<b>Double loop</b>  ]" })),
        h("div", { class: "lrow" },
          B("◀", () => d.beatJump(-d.loopBeats), { cls: "sq", help: "<b>Beat jump back</b>  By the loop size  ←" }),
          B("RELOOP", () => d.reloop(), { cls: "rl", help: "<b>Reloop</b>  Back into the last loop" }),
          B("▶", () => d.beatJump(d.loopBeats), { cls: "sq", help: "<b>Beat jump forward</b>  →" }))));

    const pads = h("div", { class: "hpads" }, ...Array.from({ length: 8 }, (_, k) => {
      const slot = k + 1, L = PAD_LETTERS[k], el = B(L, (ev) => d.hotCue(slot, ev.shiftKey));
      let shown = null;
      W.add(el, () => {
        const c = d.cues.find((x) => x.slot === slot), key = c ? `${c.color}|${c.name}|${c.end_ms}` : "";
        if (key === shown) return; shown = key;
        const loop = !!c && c.end_ms > c.start_ms;
        el.classList.toggle("set", !!c); el.classList.toggle("loop", loop); el.style.setProperty("--c", c ? c.color || PAD[k] : "transparent");
        el.dataset.help = `<b>Hot cue ${L}${c && c.name ? `: ${c.name}` : ""}</b>  ${c ? `${loop ? "Starts a loop" : "Jumps here"}. Shift-click deletes` : "Sets a cue at the playhead"}  ${slot}`;
      });
      return el;
    }));
    const tempo = fader(W, () => (d.tempo + 1) / 2, (v) => d.setTempo(v * 2 - 1), { def: 0.5, invert: true, centre: true, cls: "tempo", help: "<b>Tempo</b>  Down is faster, like a CDJ. Double-click to reset. Shift for fine" });
    const bend = (label, amount, help) => B(label, () => { d.nudge = amount; d.applyRate(); }, { cls: "sq", help, onUp: () => { d.nudge = 0; d.applyRate(); } });
    const nudge = h("div", { class: "nudge" }, bend("+", 0.04, "<b>Nudge faster</b>  Hold to push the track ahead"), bend("−", -0.04, "<b>Nudge slower</b>  Hold to hold the track back"));

    const el = h("section", { class: "pdeck" + (this.focus === id ? " focus" : ""), "data-deck": id, style: `--h:${hue}` },
      h("div", { class: "dmain" }, head, readout, screen, transport, pads), h("div", { class: "dside" }, tempo, nudge));
    el.addEventListener("pointerdown", () => this.setFocus(id), true);
    el.addEventListener("dragover", (ev) => { ev.preventDefault(); el.classList.add("drop"); });
    el.addEventListener("dragleave", () => el.classList.remove("drop"));
    el.addEventListener("drop", (ev) => { ev.preventDefault(); el.classList.remove("drop"); const t = idsFrom(ev)[0]; if (t) this.onLoad(id, t, ev.shiftKey); });
    this.panels.set(id, el);
    return el;
  }

  // ---- mixer
  strip(id) {
    const ch = this.e.channel(id), d = this.e.deck(id), v = ch.v, W = this.W, set = (k) => (x) => ch.set(k, x);
    const eq = (k, label) => knob(W, label, () => v[k], set(k), { kill: true, size: 30, help: "Drag. Click the label to kill the band" });
    return h("div", { class: "strip", style: `--h:${DECK_HUE[id]}` },
      h("div", { class: "shead" }, h("span", { class: "sletter" }, id), text(W, () => (d.loaded ? `auto ${ch.auto >= 0 ? "+" : ""}${ch.auto.toFixed(1)}` : ""), "auto")),
      h("div", { class: "krow" },
        knob(W, "TRIM", () => v.trim, set("trim"), { size: 34, help: "Gain on top of Crate's auto level, ±12 dB" }),
        knob(W, "FILTER", () => v.filter, set("filter"), { size: 34, help: "Left: low-pass. Right: high-pass. Double-click to open" })),
      h("div", { class: "krow three" }, eq("high", "HI"), eq("mid", "MID"), eq("low", "LOW")),
      h("div", { class: "srow" },
        pbtn(W, icon("i-phones", "i sm"), () => ch.set("cue", v.cue ? 0 : 1), { cls: "pfl", on: () => v.cue > 0, help: "<b>Headphone cue</b>  Hear this channel in your headphones" }),
        ...this.fxu.assign(W, id)),
      h("div", { class: "fwrap" }, vu(W, () => ch.meter.peak()), fader(W, () => v.fader, set("fader"), { def: 1, help: "<b>Channel fader</b>" })));
  }
  mixer(ids) {
    const e = this.e, m = e.mix, W = this.W, set = (k) => (x) => e.set(k, x);
    return h("section", { class: "pmixer" },
      h("div", { class: "strips" }, ...ids.map((id) => this.strip(id))),
      h("div", { class: "mfoot" },
        knob(W, "CUE MIX", () => m.phonesMix, set("phonesMix"), { def: 0.3, bipolar: false, size: 28, help: "Left: cued channels. Right: master" }),
        knob(W, "PHONES", () => m.phonesVol, set("phonesVol"), { def: 0.8, bipolar: false, size: 28, help: "Headphone volume" }),
        h("div", { class: "xfwrap" }, fader(W, () => m.xfader, set("xfader"), { axis: "x", def: 0.5, centre: true, cls: "xf", help: "<b>Crossfader</b>  A and C left, B and D right" })),
        knob(W, "MASTER", () => m.master, set("master"), { def: 0.8, bipolar: false, size: 28, help: "Master volume. A limiter stops it ever clipping" }),
        vu(W, () => e.masterLevel())));
  }
}
