// What each synth's editor shows, in Serum's arrangement: the sound's sources across the top as
// cards (oscillators, organ, grains, drum layers), the shaping and modulation beneath (filter,
// envelopes you drag, LFOs, voicing). Cards are built from the same parameters and controls as
// the device chain's panels, so both always agree.
import { h, icon } from "../../core/dom.js";
import { menu } from "../../core/ui.js";
import { text } from "../../perform/controls.js";
import { edit, save, setParam, touch } from "../set.js";
import { surface } from "../fx/views.js";
import { fromNorm, toNorm, valueOf } from "../fx/params.js";
import { DRAWBARS } from "./additive.js";
import { SAMPLE, SOURCES as GRAIN_SOURCES } from "./granular.js";
import { ALGOS, HEARD } from "./fm.js";
import { COLOURS, drawAlgo, drawDrum, drawEnv, drawLfo, drawPartials, drawWave, drawbars, drumTypes, envPoints, grainDrop, grainSources, grainView, rotarySpeed, scannerRow, slot } from "./panels.js";

const K = 32;  // knob size in the editors

// ---- the pieces a page is made of
// a card: its title bar (a light, the name, anything on the right), then its body
function card(title, body, { cls = "", led = null, right = null, colour = null } = {}) {
  return h("section", { class: `sx-card ${cls}`, style: colour ? `--k:${colour}` : null },
    h("header", { class: "sx-ch" }, led, typeof title === "string" ? h("span", { class: "sx-cn" }, title) : title, right),
    h("div", { class: "sx-cb" }, ...[body].flat()));
}
const led = (W, on) => { const el = h("i", { class: "sx-led" }); W.add(el, () => el.classList.toggle("on", !!on())); return el; };
const knobs = (cols, list) => h("div", { class: `sx-knobs c${cols}` }, ...list);

function tabs(W, d, key, list, def) {
  return h("div", { class: "sx-tabs" }, ...list.map(([v, label]) => {
    const b = h("button", { class: "sx-tab", onclick: () => { d[key] = v; save(); } }, label);
    W.add(b, () => b.classList.toggle("on", (d[key] ?? def) === v));
    return b;
  }));
}

// a context for one device's page: values, parameters, controls
export function kit(W, o, d, def, control) {
  const p = (k) => def.byKey[k], v = (k) => valueOf(p(k), d.params);
  return { W, o, d, def, p, v, c: (k, size = K) => control(typeof k === "function" ? k : () => p(k), size), cs: (...ks) => ks.map((k) => control(() => p(k), K)) };
}

// an envelope you drag: the peak sets the attack, the knee the decay (across) and sustain (up and
// down), the end the release. keys() gives its four parameter keys, which may follow a tab.
function envGraph(x, keys, colour) {
  const { W, o, d, p, v } = x;
  const vals = () => keys().map(v);
  const c = surface(W, "sx-env", () => `${keys().join()}|${vals().join()}`, (g, w, hh) => {
    const pt = drawEnv(g, w, hh, ...vals(), colour);
    g.fillStyle = "#fff";
    for (const [px, py] of [[pt.x1, pt.top], [pt.x2, pt.ys], [pt.x4, pt.bot]]) { g.beginPath(); g.arc(px, py, 3.5, 0, 2 * Math.PI); g.fill(); }
  });
  c.dataset.help = "<b>Envelope</b>  Drag the points: the peak for attack, the knee for decay and sustain, the end for release";
  c.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    const r = c.getBoundingClientRect(), w = c.clientWidth, hh = c.clientHeight, sx = w / r.width, sy = hh / r.height;
    const [a, dc, s, rl] = vals(), pt = envPoints(w, hh, a, dc, s, rl), lx = (e.clientX - r.left) * sx, ly = (e.clientY - r.top) * sy;
    const nodes = [[pt.x1, pt.top], [pt.x2, pt.ys], [pt.x4, pt.bot]].map(([nx, ny]) => Math.hypot(nx - lx, ny - ly));
    const which = nodes.indexOf(Math.min(...nodes));
    if (nodes[which] > 16) return;
    e.preventDefault(); c.setPointerCapture(e.pointerId);
    let px = e.clientX, py = e.clientY;
    const nudge = (i, dn) => { const q = p(keys()[i]); setParam(o, d, q, fromNorm(q, toNorm(q, v(keys()[i])) + dn)); };
    const move = (ev) => {
      const dx = (ev.clientX - px) * sx / w, dy = (ev.clientY - py) * sy / (pt.bot - pt.top), fine = ev.shiftKey ? 0.2 : 1;
      px = ev.clientX; py = ev.clientY; touch();
      if (which === 0) nudge(0, dx * 1.4 * fine);
      if (which === 1) { nudge(1, dx * 1.4 * fine); nudge(2, -dy * fine); }
      if (which === 2) nudge(3, dx * 1.4 * fine);
    };
    const up = () => { c.removeEventListener("pointermove", move); c.removeEventListener("pointerup", up); };
    c.addEventListener("pointermove", move); c.addEventListener("pointerup", up);
  });
  return c;
}

// an envelope card: tabs for each envelope the synth has, the graph, its four knobs
function envCard(x, list) {
  const { W, d, c } = x, which = () => list.find(([t]) => t === (d.env ?? list[0][0])) || list[0];
  const keys = () => which()[2];
  const head = list.length > 1 ? tabs(W, d, "env", list.map(([t, label]) => [t, label]), list[0][0]) : h("span", { class: "sx-cn" }, list[0][1]);
  return card(head, [envGraph(x, keys, COLOURS.cyan), knobs(4, [0, 1, 2, 3].map((i) => c(() => x.p(keys()[i]))))], { cls: "sx-envs" });
}

// an LFO card: its shape drawn, then its controls (keys() may follow a tab)
function lfoCard(x, head, shapeKey, controls) {
  const { W, v } = x;
  const view = surface(W, "sx-lfo", () => `${shapeKey()}|${v(shapeKey())}`, (g, w, hh) => drawLfo(g, w, hh, v(shapeKey()), COLOURS.violet));
  return card(head, [view, controls], { cls: "sx-lfos" });
}

// a filter's response, from the same biquads the engines use for their filter types
const FILTER_KIND = ["off", "lp", "lp2", "hp", "bp", "notch"];
function response(kind, fc, q, f) {
  if (kind === "off") return 1;
  const fs = 48000, w0 = 2 * Math.PI * Math.min(fc, 20000) / fs, cs = Math.cos(w0), al = Math.sin(w0) / (2 * q);
  const t = kind === "lp2" ? "lp" : kind;
  const b = { lp: [(1 - cs) / 2, 1 - cs, (1 - cs) / 2], hp: [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2], bp: [al, 0, -al], notch: [1, -2 * cs, 1] }[t], a = [1 + al, -2 * cs, 1 - al];
  const w = 2 * Math.PI * f / fs, re = (k) => k[0] + k[1] * Math.cos(w) + k[2] * Math.cos(2 * w), im = (k) => -(k[1] * Math.sin(w) + k[2] * Math.sin(2 * w));
  const m = Math.hypot(re(b), im(b)) / Math.hypot(re(a), im(a));
  return kind === "lp2" ? m * m : m;
}
function filterCard(x, keys) {
  const { W, v } = x;
  const view = surface(W, "sx-filt", () => ["ftype", "cutoff", "res"].map(v).join(), (g, w, hh) => {
    const kind = FILTER_KIND[v("ftype")], q = 0.6 + v("res") * 9, top = 6, bot = hh - 4, pts = [];
    g.fillStyle = "rgba(255,255,255,.06)";
    for (const f of [100, 1000, 10000]) g.fillRect(Math.round(Math.log(f / 20) / Math.log(1000) * w), 0, 1, hh);
    for (let i = 0; i <= w; i += 2) {
      const f = 20 * 1000 ** (i / w), db = 20 * Math.log10(Math.max(1e-6, response(kind, v("cutoff"), q, f)));
      pts.push([i, top + (1 - (Math.max(-36, Math.min(18, db)) + 36) / 54) * (bot - top)]);
    }
    g.strokeStyle = COLOURS.cyan; g.lineWidth = 1.6; g.shadowColor = COLOURS.cyan; g.shadowBlur = 8; g.beginPath();
    pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.stroke();
  });
  view.dataset.help = "<b>Filter</b>  Its response: cutoff across, resonance as the peak";
  return card("Filter", [view, knobs(4, x.cs(...keys))], { cls: "sx-filter", led: led(W, () => v("ftype") > 0) });
}

// ---- Crate FM: four operator cards and the filter; algorithm, envelopes, LFOs and voicing below
const OPS = ["a", "b", "c", "d"], WAVES = ["Sine", "Triangle", "Saw", "Square", "Pulse", "Vowel"];
function fmOsc(x) {
  const { W, o, d, def, v, c } = x;
  const op = (k, i) => {
    const heard = () => HEARD[v("algo")].includes(i), colour = () => (heard() ? COLOURS.violet : COLOURS.cyan);
    const wave = surface(W, "sx-wave", () => `${v(`${k}wave`)}|${heard()}`, (g, w, hh) => drawWave(g, w, hh, v(`${k}wave`), colour()));
    const sh = h("button", { class: "sx-pick", "data-help": "<b>Wave</b>  Click for a shape; the Wave knob morphs between them",
      onclick: (e) => menu(e, WAVES.map((n, j) => ({ label: n, icon: v(`${k}wave`) === j ? "i-check" : null, run: () => edit(() => setParam(o, d, def.byKey[`${k}wave`], j)) }))) },
    text(W, () => def.byKey[`${k}wave`].text(v(`${k}wave`))), icon("i-chev", "i xs"));
    const el = card(`OP ${k.toUpperCase()}`, [wave, knobs(5, x.cs(`${k}wave`, `${k}ratio`, `${k}fine`, `${k}level`, `${k}fb`)), knobs(5, x.cs(`${k}att`, `${k}dec`, `${k}sus`, `${k}rel`, `${k}vel`))],
      { cls: "sx-op", led: led(W, () => v(`${k}level`) > 0), right: sh });
    W.add(el, () => { const col = colour(); if (el.dataset.k !== col) { el.dataset.k = col; el.style.setProperty("--k", col); el.classList.toggle("heard", heard()); } });
    return el;
  };
  const algo = surface(W, "sx-algo", () => `${v("algo")}|${OPS.map((k) => v(`${k}level`) > 0 && v(`${k}fb`) > 0).join()}`,
    (g, w, hh) => drawAlgo(g, w, hh, v("algo"), OPS.map((k) => v(`${k}level`) > 0), OPS.map((k) => v(`${k}fb`) > 0)));
  algo.dataset.help = "<b>Algorithm</b>  How the operators modulate each other. Click to choose, scroll to step through";
  const setAlgo = (i) => edit(() => setParam(o, d, def.byKey.algo, (i + ALGOS.length) % ALGOS.length));
  algo.addEventListener("click", (e) => menu(e, ALGOS.map((n, i) => ({ label: n, icon: i === v("algo") ? "i-check" : null, run: () => setAlgo(i) }))));
  algo.addEventListener("wheel", (e) => { e.preventDefault(); setAlgo(v("algo") + Math.sign(e.deltaY)); }, { passive: false });
  const lfo = () => d.lfo ?? 1, lk = (s) => () => def.byKey[`l${lfo()}${s}`];
  const when = (el, fn) => { W.add(el, () => el.classList.toggle("gone", !fn())); return el; };
  return [
    h("div", { class: "sx-row top" }, ...OPS.map(op), filterCard(x, ["ftype", "cutoff", "res", "drive", "fenv", "fkey", "fvel"])),
    h("div", { class: "sx-row" },
      card(h("span", { class: "sx-cn" }, "Algorithm ", text(W, () => ALGOS[v("algo")], "sx-sub")), [algo, knobs(3, x.cs("fm", "sub", "noise"))], { cls: "sx-algo-card" }),
      envCard(x, [["amp", "Amp env", ["aa", "ad", "as", "ar"]], ["mod", "Mod env", ["ma", "md", "ms", "mr"]]]),
      lfoCard(x, tabs(W, d, "lfo", [[1, "LFO 1"], [2, "LFO 2"]], 1), () => `l${lfo()}shape`,
        knobs(5, [c(lk("shape")), when(c(lk("rate")), () => !v(`l${lfo()}sync`)), when(c(lk("div")), () => !!v(`l${lfo()}sync`)), c(lk("sync")), c(lk("trig"))])),
      card("Voicing", [knobs(4, x.cs("mono", "uni", "detune", "spread", "glide", "vel", "macro", "dist"))], { cls: "sx-voice" })),
  ];
}
function fmMatrix(x) {
  const { W, o, d, def } = x;
  return [h("div", { class: "sx-row" }, card("Mod matrix", [
    h("div", { class: "sx-mhead" }, h("span", {}, "Source"), h("span", {}, "Target"), h("span", {}, "Amount"), h("span", {})),
    h("div", { class: "sx-matrix" }, ...[1, 2, 3, 4, 5, 6].map((i) => slot(W, o, d, def, i)))], { cls: "sx-mx" }))];
}

// ---- Crate Additive: drawbars, organ and harmonics; envelope, LFO and output below
function addOsc(x) {
  const { W, o, d, def, v } = x;
  const reg = text(W, () => DRAWBARS.map((_, i) => Math.round(v(`db${i + 1}`))).join(""), "sx-sub");
  const spectrum = surface(W, "sx-spec", () => ["harm", "parts", "tilt", "odd", "stretch", "fpeak", "fgain", "fwidth", "damp"].map(v).join(), (g, w, hh) => drawPartials(g, w, hh, v));
  return [
    h("div", { class: "sx-row top" },
      card(h("span", { class: "sx-cn" }, "Drawbars ", reg), [drawbars(W, o, d, def), knobs(1, x.cs("organ"))], { cls: "sx-bars", led: led(W, () => v("organ") > 0) }),
      card("Organ", [knobs(4, x.cs("perc", "pslow", "psoft", "click")), h("div", { class: "sx-lab" }, "Vibrato & chorus"), scannerRow(W, o, d, def),
        h("div", { class: "sx-inline" }, ...x.cs("rotary"), rotarySpeed(W, o, d, def), ...x.cs("drive"))], { cls: "sx-organ" }),
      card("Harmonics", [spectrum, knobs(6, x.cs("harm", "parts", "tilt", "odd", "stretch", "hoct", "fpeak", "fgain", "fwidth", "damp", "spread", "vel"))], { cls: "sx-harm", led: led(W, () => v("harm") > 0) })),
    h("div", { class: "sx-row" },
      envCard(x, [["amp", "Amp env", ["aa", "ad", "as", "ar"]]]),
      card("LFO", [knobs(4, x.cs("lrate", "lvib", "ltrem", "ltilt"))], { cls: "sx-lfos" }),
      card("Output", [knobs(2, x.cs("spread", "level"))], { cls: "sx-voice" })),
  ];
}

// ---- Crate Grain: the source, grains and pitch; filter, envelopes, LFO and output below
function grainOsc(x) {
  const { W, o, d, def, v } = x;
  const name = text(W, () => (v("source") === SAMPLE ? d.sample?.name || "No sample" : GRAIN_SOURCES[v("source")]), "sx-sub");
  const source = card(h("span", { class: "sx-cn" }, "Source ", name), [grainView(W, d, def), grainSources(W, o, d, def)], { cls: "sx-gsrc" });
  const page = [
    h("div", { class: "sx-row top" }, source,
      card("Grains", [knobs(4, x.cs("pos", "spray", "scan", "root", "size", "density", "jitter", "shape"))], { cls: "sx-grains" }),
      card("Pitch", [knobs(3, x.cs("pitch", "prand", "jump", "rev", "pan"))], { cls: "sx-gpitch" })),
    h("div", { class: "sx-row" },
      filterCard(x, ["ftype", "cutoff", "res", "fenv"]),
      envCard(x, [["amp", "Amp env", ["aa", "ad", "as", "ar"]], ["mod", "Filter env", ["ma", "md", "ms", "mr"]]]),
      lfoCard(x, h("span", { class: "sx-cn" }, "LFO"), () => "lshape", knobs(3, x.cs("lrate", "lshape", "lpos", "lcut", "lsize", "lpitch"))),
      card("Output", [knobs(2, x.cs("vel", "level"))], { cls: "sx-voice" })),
  ];
  grainDrop(page, source, o, d, def);
  return page;
}

// ---- Crate Drum: the type and its shape, the body; click, noise, metal and output below
function drumOsc(x) {
  const { W, d, def, v } = x;
  const shape = surface(W, "sx-drum", () => def.params.map((q) => v(q.k)).join(), (g, w, hh) => drawDrum(g, w, hh, v));
  return [
    h("div", { class: "sx-row top" },
      card("Type", [drumTypes(W, d, def), shape], { cls: "sx-dtype" }),
      card("Body", [knobs(6, x.cs("tune", "key", "bwave", "bpitch", "bptime", "bpcurve", "battack", "bhold", "bdecay", "bcurve", "blevel", "bdrive"))], { cls: "sx-body", led: led(W, () => v("blevel") > 0) })),
    h("div", { class: "sx-row" },
      card("Click", [knobs(2, x.cs("click", "ctype", "cdecay", "ctone"))], { led: led(W, () => v("click") > 0) }),
      card("Noise", [knobs(4, x.cs("noise", "nfilter", "ncut", "nres", "nattack", "ndecay", "nclap", "nspace"))], { led: led(W, () => v("noise") > 0) }),
      card("Metal", [knobs(2, x.cs("metal", "mfreq", "mdecay", "mtone"))], { led: led(W, () => v("metal") > 0) }),
      card("Output", [knobs(4, x.cs("drive", "clip", "low", "high", "vel", "choke"))], { cls: "sx-voice" })),
  ];
}

// for each synth: its pages by tab, and what the keyboard bar carries
export const PAGES = {
  fm: { tabs: [["osc", "OSC", fmOsc], ["matrix", "MATRIX", fmMatrix]], foot: ["oct", "semi"] },
  add: { tabs: [["osc", "OSC", addOsc]], foot: ["vel"] },
  grain: { tabs: [["osc", "OSC", grainOsc]], foot: ["root", "pitch"] },
  drum: { tabs: [["osc", "OSC", drumOsc]], foot: ["tune", "key"] },
};
