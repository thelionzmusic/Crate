// Performance view: stacked waveforms, decks and mixer, driven by engine/engine.js.
// Uses the page's shared helpers (h, icon, api, safe, toast, S, gainFor, rgbOf, column, PHRASE, PAD, camelotColor, artBg).
import { Engine, DECK_IDS, LOOP_SIZES, RANGES } from "./engine/engine.js";

const engine = new Engine();
const P = {
  active: false, focus: "A", zoom: 8, widgets: [], lanes: [], decks: new Map(),
  prefs: Object.assign({ decks: 2, device: "", headphones: "off", mixing: "internal", latency: "low", lock: true }, read("perf")),
};
function read(k) { try { return JSON.parse(localStorage.getItem(k) || "{}"); } catch { return {}; } }
function savePrefs() { try { localStorage.setItem("perf", JSON.stringify(P.prefs)); } catch { /* storage off */ } }
const deckIds = () => DECK_IDS.slice(0, P.prefs.decks);
const SVGNS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}) => { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
const DECK_HUE = { A: "#4cc9f0", B: "#ff9f1c", C: "#c77dff", D: "#52e08f" };
const fmt = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r.toFixed(1).padStart(4, "0")}`; };
const fmtLoop = (b) => b >= 1 ? String(b) : `1/${Math.round(1 / b)}`;

// ---------- controls: every widget reads and writes through get/set, so hardware can share them later
function live(el, sync) { P.widgets.push({ el, sync }); return el; }
function drag(el, onMove, { axis = "y", reset, skip } = {}) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (skip && e.target.closest(skip))) return; e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add("held");
    let last = axis === "y" ? e.clientY : e.clientX;
    const move = (ev) => { const v = axis === "y" ? ev.clientY : ev.clientX; onMove(v - last, ev); last = v; };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.classList.remove("held"); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
  });
  if (reset) el.addEventListener("dblclick", reset);
}
// rotary knob: drag up/down, wheel, double-click resets. bipolar knobs light from the centre
function knob(label, get, set, { def = 0.5, bipolar = true, help = "", size = 34, kill } = {}) {
  const r = 13, c = 2 * Math.PI * r, arcLen = c * 0.75;
  const s = svg("svg", { viewBox: "0 0 34 34", width: size, height: size, class: "knob-svg" });
  const track = svg("circle", { cx: 17, cy: 17, r, class: "kt", "stroke-dasharray": `${arcLen} ${c}`, transform: "rotate(135 17 17)" });
  const val = svg("circle", { cx: 17, cy: 17, r, class: "kv" });
  const cap = svg("circle", { cx: 17, cy: 17, r: 9.5, class: "kc" });
  const tick = svg("line", { x1: 17, y1: 17, x2: 17, y2: 9, class: "kp" });
  s.append(track, val, cap, tick);
  const el = h("div", { class: "knob", "data-help": `<b>${label}</b>  ${help || "Drag up or down. Double-click to reset"}` }, s, h("span", {}, label));
  let shown = null;
  live(el, () => {
    const v = get(); if (v === shown) return; shown = v;
    const from = bipolar ? 0.5 : 0, a = Math.min(from, v), b = Math.max(from, v);
    val.setAttribute("stroke-dasharray", `${(b - a) * arcLen} ${c}`); val.setAttribute("transform", `rotate(${135 + a * 270} 17 17)`);
    tick.setAttribute("transform", `rotate(${-135 + v * 270} 17 17)`);
    el.classList.toggle("off", !!kill && v < 0.02);
  });
  drag(el, (dy, ev) => set(get() - dy * (ev.shiftKey ? 0.0015 : 0.006)), { reset: () => set(def), skip: kill ? "span" : null });
  el.addEventListener("wheel", (e) => { e.preventDefault(); set(get() - Math.sign(e.deltaY) * 0.02); }, { passive: false });
  if (kill) el.querySelector("span").addEventListener("click", () => set(get() < 0.02 ? def : 0));
  return el;
}
// fader: vertical or horizontal; invert for CDJ-style tempo (down = faster)
function fader(get, set, { axis = "y", def = 0, help = "", cls = "", invert = false, centre = false } = {}) {
  const capEl = h("i", { class: "cap" }), el = h("div", { class: `fader ${axis} ${cls}`, "data-help": help }, h("b", { class: "groove" }), centre ? h("b", { class: "detent" }) : null, capEl);
  let shown = null;
  live(el, () => {
    const v = get(); if (v === shown) return; shown = v;
    const k = invert ? 1 - v : v; capEl.style[axis === "y" ? "top" : "left"] = `${(axis === "y" ? 1 - k : k) * 100}%`;
  });
  drag(el, (d, ev) => {
    const len = axis === "y" ? el.clientHeight : el.clientWidth, sign = axis === "y" ? -1 : 1;
    set(get() + (invert ? -1 : 1) * sign * d / len * (ev.shiftKey ? 0.15 : 1));
  }, { axis, reset: () => set(def) });
  el.addEventListener("wheel", (e) => { e.preventDefault(); set(get() - Math.sign(e.deltaY) * 0.01 * (invert ? -1 : 1) * (axis === "y" ? 1 : -1)); }, { passive: false });
  return el;
}
function btn(label, onDown, { cls = "", help = "", onUp, on } = {}) {
  const el = h("button", { class: `pbtn ${cls}`, "data-help": help }, label);
  el.addEventListener("pointerdown", (e) => { if (e.button === 0) { el.setPointerCapture(e.pointerId); onDown(e); } });
  if (onUp) el.addEventListener("pointerup", (e) => onUp(e));
  if (on) { let shown = null; live(el, () => { const v = on(); if (v !== shown) { shown = v; el.classList.toggle("on", !!v); el.classList.toggle("blink", v === "blink"); } }); }
  return el;
}
function text(fn, cls = "") { const el = h("span", { class: cls }); let shown = null; live(el, () => { const v = fn(); if (v !== shown) { shown = v; el.textContent = v; } }); return el; }

// ---------- a deck panel
function deckPanel(id) {
  const d = engine.deck(id), ch = engine.channel(id), hue = DECK_HUE[id];
  const ov = h("canvas", { class: "dov", "data-help": "<b>Overview</b>  Click or drag to move through the track" });
  const head = h("div", { class: "dhead" });
  const renderHead = () => {
    const t = d.t;
    head.replaceChildren(
      h("span", { class: "dletter", style: `--h:${hue}` }, id),
      h("span", { class: "dart", style: t ? artBg(t) : "" }),
      h("div", { class: "dtitle" }, h("b", {}, t ? t.title : d.loading ? "Loading..." : "Empty"), h("span", {}, t ? t.artist || "" : "Drag a track here, or select one and press Shift+" + (id === "A" || id === "C" ? "Left" : "Right"))),
      t && t.camelot ? h("span", { class: "key", style: `--kc:${camelotColor(t.camelot)}` }, t.camelot) : null);
  };
  const pitch = () => { const p = (d.baseRate - 1) * 100; return `${p >= 0 ? "+" : "-"}${Math.abs(p).toFixed(2)}%`; };
  const readout = h("div", { class: "dread" },
    h("div", {}, text(() => d.loaded && d.grid.ok ? d.bpm.toFixed(2) : "--.--", "big"), h("small", {}, "BPM")),
    h("div", {}, text(() => d.loaded ? pitch() : "", "mid"), text(() => `±${Math.round(d.range * 100)}%`, "tiny")),
    h("div", { class: "rt" }, text(() => d.loaded ? "-" + fmt(d.duration - d.time()) : "-:--.-", "big"), h("small", {}, text(() => d.loaded ? fmt(d.time()) : ""))));
  const loopSize = text(() => fmtLoop(d.loopBeats), "lsz");
  const transport = h("div", { class: "trans" },
    btn("CUE", () => d.cueDown(), { cls: "round cue", onUp: () => d.cueUp(), on: () => d.loaded && !d.playing && Math.abs(d.time(false) - d.cueAt) > 0.01 ? "blink" : d.previewing, help: "<b>Cue</b>  Playing: back to the cue point. Stopped: set the cue here, hold to preview  C" }),
    btn(icon("i-play", "i fill"), () => d.togglePlay(), { cls: "round play", on: () => d.playing && !d.previewing, help: "<b>Play / pause</b>  Space" }),
    h("div", { class: "tcol" },
      btn("SYNC", () => d.setSync(!d.sync), { on: () => d.sync, help: "<b>Sync</b>  Match the leading deck's tempo and stay locked to its beat  S" }),
      btn("LEAD", () => engine.makeLeader(d), { on: () => engine.leaderId === id && d.loaded, help: "<b>Lead</b>  Make this the deck the others sync to" })),
    h("div", { class: "tcol" },
      btn("KEY", () => d.setKeylock(!d.keylock), { on: () => d.keylock, help: "<b>Key lock</b>  Change tempo without changing pitch" }),
      btn(h("span", {}, "±", text(() => Math.round(d.range * 100))), () => { d.range = RANGES[(RANGES.indexOf(d.range) + 1) % RANGES.length]; d.applyRate(); }, { help: "<b>Tempo range</b>  6, 10, 16 or 50%" })),
    h("div", { class: "loops" },
      h("div", { class: "lrow" },
        btn("½", () => d.loopResize(0.5), { cls: "sq", help: "<b>Halve loop</b>  [" }),
        btn(loopSize, () => d.loopToggle(), { cls: "lp", on: () => !!d.loop, help: "<b>Loop</b>  Loop this many beats from the last beat. Press again to exit  L" }),
        btn("2×", () => d.loopResize(2), { cls: "sq", help: "<b>Double loop</b>  ]" })),
      h("div", { class: "lrow" },
        btn("◀", () => d.beatJump(-d.loopBeats), { cls: "sq", help: "<b>Beat jump back</b>  By the loop size  ←" }),
        btn("RELOOP", () => d.reloop(), { cls: "rl", help: "<b>Reloop</b>  Back into the last loop" }),
        btn("▶", () => d.beatJump(d.loopBeats), { cls: "sq", help: "<b>Beat jump forward</b>  →" }))));
  const pads = h("div", { class: "hpads" }, ...Array.from({ length: 8 }, (_, k) => {
    const slot = k + 1, letter = "ABCDEFGH"[k], el = btn(letter, (e) => d.hotCue(slot, e.shiftKey), { help: `<b>Hot cue ${letter}</b>  Jump, or set one at the playhead. Shift-click deletes  ${slot}` });
    let shown = null;
    live(el, () => {
      const c = d.cues.find((x) => x.slot === slot), key = c ? `${c.color}|${c.name}|${c.end_ms}` : "";
      if (key === shown) return; shown = key;
      el.classList.toggle("set", !!c); el.classList.toggle("loop", !!c && c.end_ms > c.start_ms); el.style.setProperty("--c", c ? c.color || PAD[k] : "transparent");
      el.dataset.help = `<b>Hot cue ${letter}${c && c.name ? `: ${c.name}` : ""}</b>  ${c ? (c.end_ms > c.start_ms ? "Starts a loop. " : "Jumps here. ") + "Shift-click deletes" : "Sets a cue at the playhead"}  ${slot}`;
    });
    return el;
  }));
  const tempo = fader(() => (d.tempo + 1) / 2, (v) => d.setTempo(v * 2 - 1), { def: 0.5, invert: true, centre: true, cls: "tempo", help: "<b>Tempo</b>  Down is faster, like a CDJ. Double-click to reset. Shift for fine" });
  const nudge = h("div", { class: "nudge" },
    btn("+", () => { d.nudge = 0.04; d.applyRate(); }, { cls: "sq", onUp: () => { d.nudge = 0; d.applyRate(); }, help: "<b>Nudge faster</b>  Hold to push the track ahead" }),
    btn("−", () => { d.nudge = -0.04; d.applyRate(); }, { cls: "sq", onUp: () => { d.nudge = 0; d.applyRate(); }, help: "<b>Nudge slower</b>  Hold to hold the track back" }));
  const el = h("section", { class: "pdeck glass" + (P.focus === id ? " focus" : ""), "data-deck": id, style: `--h:${hue}` },
    h("div", { class: "dmain" }, head, readout, ov, transport, pads), h("div", { class: "dside" }, tempo, nudge));
  el.addEventListener("pointerdown", () => setFocus(id), true);
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drop"); });
  el.addEventListener("dragleave", () => el.classList.remove("drop"));
  el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("drop"); const ids = JSON.parse(e.dataTransfer.getData("text/crate-ids") || "[]"); if (ids[0]) loadTo(id, ids[0], e.shiftKey); });
  // overview: drawn once per track, then the playhead on top
  let ovImg = null, ovFor = null;
  const seekAt = (x) => { if (d.loaded) d.seek(Math.min(1, Math.max(0, x / ov.clientWidth)) * d.duration); };
  ov.addEventListener("pointerdown", (e) => { ov.setPointerCapture(e.pointerId); seekAt(e.offsetX); ov.onpointermove = (ev) => seekAt(ev.offsetX); ov.onpointerup = () => { ov.onpointermove = null; }; });
  P.decks.set(id, {
    el, renderHead,
    draw() {
      const W = Math.round(ov.clientWidth * devicePixelRatio), H = Math.round(ov.clientHeight * devicePixelRatio);
      if (!W || !H) return;
      if (ov.width !== W || ov.height !== H) { ov.width = W; ov.height = H; ovFor = null; }
      const c = ov.getContext("2d"); c.clearRect(0, 0, W, H);
      if (!d.loaded) return;
      if (ovFor !== d.t.id) {
        const off = new OffscreenCanvas(W, H), w = d.wave, n = w.length / 3;
        paint(off.getContext("2d"), W, H, (x) => { const a = Math.floor(x * n / W); return column(w, a, Math.max(a + 1, Math.floor((x + 1) * n / W))); }, "rgb");
        ovImg = off; ovFor = d.t.id;
      }
      c.drawImage(ovImg, 0, 0);
      const D = d.duration, x = d.time() / D * W, dpr = devicePixelRatio;
      c.save(); c.globalCompositeOperation = "source-atop"; c.fillStyle = "rgba(6,7,10,.6)"; c.fillRect(0, 0, x, H); c.restore();
      if (d.loop) { c.fillStyle = "rgba(255,165,58,.28)"; c.fillRect(d.loop[0] / D * W, 0, Math.max(dpr, (d.loop[1] - d.loop[0]) / D * W), H); }
      for (const q of d.cues) { c.fillStyle = q.slot ? (q.color || PAD[q.slot - 1]) : "#ff6a5e"; c.fillRect(q.start_ms / 1000 / D * W, 0, dpr * 1.5, q.slot ? H : H * 0.4); }
      c.fillStyle = "#fff"; c.shadowColor = hue; c.shadowBlur = 6 * dpr; c.fillRect(x - dpr, 0, 2 * dpr, H); c.shadowBlur = 0;
    },
  });
  renderHead();
  return el;
}

// ---------- mixer
function vu(level) {
  const c = h("canvas", { class: "vu" }); let peak = 0, hold = 0;
  live(c, () => {
    const W = c.width = Math.round(c.clientWidth * devicePixelRatio), H = c.height = Math.round(c.clientHeight * devicePixelRatio); if (!W || !H) return;
    const v = level(), db = v > 0 ? 20 * Math.log10(v) : -90, k = Math.max(0, Math.min(1, (db + 36) / 36));
    if (k >= peak) { peak = k; hold = 40; } else if (--hold < 0) peak = Math.max(0, peak - 0.015);
    const g = c.getContext("2d"), n = 18, seg = H / n;
    for (let i = 0; i < n; i++) {
      const on = (i + 1) / n <= k + 1e-6 || Math.abs((i + 0.5) / n - peak) < 0.5 / n, f = i / n;
      g.fillStyle = on ? (f > 0.88 ? "#ff5b4f" : f > 0.7 ? "#ffb13b" : "#4ee08a") : "rgba(255,255,255,.07)";
      g.fillRect(0, H - (i + 1) * seg + 1, W, seg - 2);
    }
  });
  return c;
}
function strip(id) {
  const ch = engine.channel(id), d = engine.deck(id), v = ch.v, set = (k) => (x) => ch.set(k, x);
  const eq = (k, label) => knob(label, () => v[k], set(k), { kill: true, size: 26, help: "Drag. Click the label to kill the band" });
  return h("div", { class: "strip", style: `--h:${DECK_HUE[id]}` },
    h("div", { class: "shead" }, h("span", { class: "sletter" }, id), text(() => d.loaded ? `auto ${ch.auto >= 0 ? "+" : ""}${ch.auto.toFixed(1)}` : "", "auto")),
    h("div", { class: "krow" },
      knob("TRIM", () => v.trim, set("trim"), { size: 30, help: "Gain on top of Crate's auto level, ±12 dB" }),
      knob("FILTER", () => v.filter, set("filter"), { size: 30, help: "Left: low-pass. Right: high-pass. Double-click to open" })),
    h("div", { class: "krow three" }, eq("high", "HI"), eq("mid", "MID"), eq("low", "LOW")),
    btn(h("span", {}, icon("i-phones", "i sm"), "CUE"), () => ch.set("cue", v.cue ? 0 : 1), { cls: "pfl", on: () => v.cue > 0, help: "<b>Headphone cue</b>  Hear this channel in your headphones" }),
    h("div", { class: "fwrap" }, vu(() => ch.level()), fader(() => v.fader, set("fader"), { def: 1, help: "<b>Channel fader</b>" })));
}
function mixer() {
  const m = engine.mix, set = (k) => (x) => engine.set(k, x);
  return h("section", { class: "pmixer glass" },
    h("div", { class: "strips" }, ...deckIds().map(strip)),
    h("div", { class: "mfoot" },
      knob("CUE MIX", () => m.phonesMix, set("phonesMix"), { def: 0.3, bipolar: false, size: 28, help: "Left: cued channels. Right: master" }),
      knob("PHONES", () => m.phonesVol, set("phonesVol"), { def: 0.8, bipolar: false, size: 28, help: "Headphone volume" }),
      h("div", { class: "xfwrap" }, fader(() => m.xfader, set("xfader"), { axis: "x", def: 0.5, centre: true, cls: "xf", help: "<b>Crossfader</b>  A and C left, B and D right" })),
      knob("MASTER", () => m.master, set("master"), { def: 0.8, bipolar: false, size: 28, help: "Master volume. A limiter stops it ever clipping" }),
      vu(() => engine.masterLevel())));
}

// ---------- stacked waveforms
const laneBuf = new WeakMap();
function drawLane(cv, d) {
  const dpr = devicePixelRatio, W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
  if (!W || !H) return;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; laneBuf.delete(cv); }
  const g = cv.getContext("2d");
  let buf = laneBuf.get(cv); if (!buf) { buf = g.createImageData(W, H); laneBuf.set(cv, buf); }
  const px = new Uint32Array(buf.data.buffer); px.fill(0);
  if (!d.loaded) { g.putImageData(buf, 0, 0); return; }
  const w = d.wave, cols = w.length / 3, fps = cols / d.duration, now = d.time(), rate = Math.max(0.05, d.rate), pps = W / P.zoom, mid = H / 2;
  const at = (x) => (now + (x - W / 2) / pps * rate) * fps;
  for (let x = 0; x < W; x++) {
    const a = Math.floor(at(x)), b = Math.max(a + 1, Math.floor(at(x + 1)));
    if (b <= 0 || a >= cols) continue;
    const [l, m, hh] = column(w, a, b), top = Math.max(l, m, hh); if (!top) continue;
    const amp = Math.pow(top / 255, 0.85) * (mid - 2 * dpr), col = rgbOf(l, m, hh, top);
    for (let y = Math.max(0, Math.round(mid - amp)), y1 = Math.min(H, Math.round(mid + amp)); y < y1; y++) px[y * W + x] = col;
  }
  g.putImageData(buf, 0, 0);
  // played side, beat grid, loop, cues, playhead
  g.save(); g.globalCompositeOperation = "source-atop"; g.fillStyle = "rgba(6,7,10,.42)"; g.fillRect(0, 0, W / 2, H); g.restore();
  const xOf = (s) => W / 2 + (s - now) / rate * pps;
  if (d.grid.ok) {
    const gr = d.grid, i0 = Math.ceil(gr.index(now - P.zoom * rate / 2)), i1 = Math.floor(gr.index(now + P.zoom * rate / 2));
    for (let i = i0; i <= i1; i++) {
      const x = Math.round(xOf(gr.time(i))), bar = gr.isDownbeat(i);
      g.fillStyle = bar ? "rgba(255,255,255,.55)" : "rgba(255,255,255,.16)"; g.fillRect(x, 0, bar ? 1.5 * dpr : dpr, bar ? H : H * 0.18); if (!bar) g.fillRect(x, H - H * 0.18, dpr, H * 0.18);
    }
  }
  if (d.loop) { const a = xOf(d.loop[0]), b = xOf(d.loop[1]); g.fillStyle = "rgba(255,165,58,.16)"; g.fillRect(a, 0, b - a, H); g.fillStyle = "#ffa53a"; g.fillRect(a, 0, 2 * dpr, H); g.fillRect(b - 2 * dpr, 0, 2 * dpr, H); }
  g.font = `700 ${10 * dpr}px ${getComputedStyle(document.body).fontFamily}`; g.textBaseline = "middle";
  for (const q of d.cues) {
    const x = xOf(q.start_ms / 1000); if (x < -40 * dpr || x > W) continue;
    const col = q.slot ? q.color || PAD[q.slot - 1] : "#ff6a5e"; g.fillStyle = col; g.fillRect(x, 0, 1.5 * dpr, H);
    if (q.slot) {
      const lbl = "ABCDEFGH"[q.slot - 1] + (q.name ? `  ${q.name}` : ""), tw = g.measureText(lbl).width + 9 * dpr;
      if (q.end_ms > q.start_ms) { g.globalAlpha = 0.14; g.fillRect(x, 0, (q.end_ms - q.start_ms) / 1000 / rate * pps, H); g.globalAlpha = 1; }
      const y = q.end_ms > q.start_ms ? H - 16 * dpr : 2 * dpr;  // loop labels sit at the bottom, so a cue on the same beat stays readable
      g.beginPath(); g.roundRect(x, y, tw, 14 * dpr, 3 * dpr); g.fill(); g.fillStyle = "rgba(0,0,0,.85)"; g.fillText(lbl, x + 4.5 * dpr, y + 7 * dpr);
    }
  }
  g.save(); g.shadowColor = DECK_HUE[d.id]; g.shadowBlur = 12 * dpr; g.fillStyle = "#fff"; g.fillRect(W / 2 - dpr, 0, 2 * dpr, H); g.restore();
}
function lanes() {
  P.lanes = deckIds().map((id) => {
    const d = engine.deck(id), cv = h("canvas", {}), el = h("div", { class: "lane", style: `--h:${DECK_HUE[id]}` }, h("span", { class: "ltag" }, id), cv);
    // drag the waveform to scrub when paused, or nudge when playing
    drag(cv, (dx) => { if (!d.loaded) return; const s = -dx * devicePixelRatio / (cv.width / P.zoom) * d.rate; d.seek(d.time(false) + s); }, { axis: "x" });
    el.addEventListener("dragover", (e) => e.preventDefault());
    el.addEventListener("drop", (e) => { e.preventDefault(); const ids = JSON.parse(e.dataTransfer.getData("text/crate-ids") || "[]"); if (ids[0]) loadTo(id, ids[0], e.shiftKey); });
    return { cv, d, el };
  });
  return h("section", { class: "plances glass", "data-help": "<b>Waveforms</b>  Drag to scrub. Zoom with + and −" },
    ...P.lanes.map((l) => l.el),
    h("div", { class: "lzoom" }, h("button", { class: "btn sm icon ghost", "aria-label": "Zoom in", onclick: () => { P.zoom = Math.max(2, P.zoom / 1.5); } }, "+"),
      h("button", { class: "btn sm icon ghost", "aria-label": "Zoom out", onclick: () => { P.zoom = Math.min(32, P.zoom * 1.5); } }, "−")));
}

// ---------- layout
function render() {
  P.widgets = []; P.decks.clear();
  const ids = deckIds(), four = ids.length === 4;
  const decks = h("div", { class: "pdecks" + (four ? " four" : "") },
    h("div", { class: "pside" }, deckPanel("A"), four ? deckPanel("C") : null),
    mixer(),
    h("div", { class: "pside" }, deckPanel("B"), four ? deckPanel("D") : null));
  $("#perform").replaceChildren(lanes(), decks);
  document.querySelector(".app").classList.toggle("four", four);
}
function setFocus(id) { if (P.focus === id) return; P.focus = id; for (const [k, v] of P.decks) v.el.classList.toggle("focus", k === id); }

let raf = 0;
function loop() {
  raf = requestAnimationFrame(loop);
  for (const w of P.widgets) w.sync();
  for (const l of P.lanes) drawLane(l.cv, l.d);
  for (const v of P.decks.values()) v.draw();
}

// ---------- loading from the library
async function loadTo(id, trackId, force = false) {
  if (!deckIds().includes(id)) return;
  try {
    const t = await api(`track/${trackId}`), row = S.byId.get(trackId), g = row && gainFor(row);
    t.autoGainDb = g ? g.db : 0;
    await engine.load(id, t, { force: force || !P.prefs.lock });
  } catch (e) { toast(e.message, 5000); }
}

// ---------- public: switching modes, settings
async function enter() {
  if (P.active) return;
  P.active = true; document.querySelector(".app").classList.add("perf");
  const libAudio = $("#audio"); if (libAudio && !libAudio.paused) libAudio.pause();
  try { await engine.start({ latency: P.prefs.latency === "safe" ? "safe" : "low" }); await engine.route(P.prefs); }
  catch (e) { toast(`Audio couldn't start: ${e.message}`, 7000); }
  if (engine.ctx && engine.ctx.state === "suspended") engine.ctx.resume();
  render(); cancelAnimationFrame(raf); loop();
}
function leave() { P.active = false; document.querySelector(".app").classList.remove("perf", "four"); cancelAnimationFrame(raf); }
engine.on((kind, x) => { if (kind === "deck") { const v = P.decks.get(x.id); if (v) v.renderHead(); } else if (kind === "error") toast(x, 6000); });

async function outputs() {
  // device names need one microphone permission in Chromium; ask only when the list is unlabeled
  let list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput");
  if (list.length && !list[0].label) {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput"); } catch { /* names stay generic */ }
  }
  return list.map((d, i) => ({ id: d.deviceId === "default" ? "" : d.deviceId, label: d.label || `Output ${i + 1}` }));
}
async function setPrefs(changes) {
  Object.assign(P.prefs, changes); savePrefs();
  if (engine.ctx) await engine.route(P.prefs);
  if ("decks" in changes && P.active) render();
}

window.Perf = {
  get active() { return P.active; }, enter, leave, loadTo, prefs: P.prefs, setPrefs, outputs, engine,
  loadFocused: (id, force) => loadTo(P.focus, id, force),
  channels: () => engine.outputs ? engine.outputs.channels : 2,
  maxChannels: () => engine.ctx ? engine.ctx.destination.maxChannelCount : 2,
  key(e) {  // keyboard in performance mode; returns true when handled
    const d = engine.deck(P.focus); if (!d) return false;
    const k = e.key;
    if (k === " ") { d.togglePlay(); return true; }
    if (k === "c" || k === "C") { if (!e.repeat) d.cueDown(); return true; }
    if (/^[1-8]$/.test(k)) { d.hotCue(+k, e.shiftKey); return true; }
    if (k === "l" || k === "L") { d.loopToggle(); return true; }
    if (k === "[") { d.loopResize(0.5); return true; }
    if (k === "]") { d.loopResize(2); return true; }
    if (k === "ArrowLeft" && !e.shiftKey) { d.beatJump(-d.loopBeats); return true; }
    if (k === "ArrowRight" && !e.shiftKey) { d.beatJump(d.loopBeats); return true; }
    if (k === "s" || k === "S") { d.setSync(!d.sync); return true; }
    if (k === "Tab") { const ids = deckIds(); setFocus(ids[(ids.indexOf(P.focus) + 1) % ids.length]); return true; }
    return false;
  },
  keyUp(e) { if (e.key === "c" || e.key === "C") { const d = engine.deck(P.focus); if (d) d.cueUp(); return true; } return false; },
};
window.dispatchEvent(new Event("perf-ready"));
