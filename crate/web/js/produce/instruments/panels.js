// Instrument panels in the device chain. Crate Additive's leads with its drawbars, then the
// organ's switches and rotary, then the harmonic layer with its spectrum. Crate FM's runs left to right as Serum's and Logic's
// do: the operators (one at a time, A to D on tabs), the algorithm that routes them, the
// filter, the envelopes, the LFOs, the modulation matrix, and the voice. Tabs are stored on
// the device, so it reopens as it was left; controls follow the tab without being rebuilt.
import { h, icon } from "../../core/dom.js";
import { menu } from "../../core/ui.js";
import { text } from "../../perform/controls.js";
import { edit, save, setParam, touch } from "../set.js";
import { surface } from "../fx/views.js";
import { valueOf } from "../fx/params.js";
import { DRAWBARS, SCANNER } from "./additive.js";
import { ALGOS, HEARD, ROUTES, SOURCES, TARGETS } from "./fm.js";

const OPS = ["a", "b", "c", "d"];
const KNOB = 28;
const INK = { line: "#ff9f0a", dim: "rgba(255,255,255,.14)", grid: "rgba(255,255,255,.06)", text: "#8d8d93", box: "#1c1c20" };

// a section: a title (or tabs) over its controls
const section = (cls, top, ...body) => h("div", { class: `fs ${cls}` }, h("div", { class: "fs-top" }, top), h("div", { class: "fs-body" }, ...body));
function tabs(W, d, key, list, def) {
  return h("div", { class: "fs-tabs" }, ...list.map(([v, label]) => {
    const b = h("button", { class: "fs-tab", onclick: () => { d[key] = v; save(); } }, label);
    W.add(b, () => b.classList.toggle("on", (d[key] ?? def) === v));
    return b;
  }));
}

export const PANELS = { fm: fmPanel, add: addPanel };

function fmPanel(W, o, d, def, control) {
  const v = (k) => valueOf(def.byKey[k], d.params);
  const op = () => d.op ?? "a", env = () => d.env ?? "amp", lfo = () => d.lfo ?? 1;
  const at = (k) => () => def.byKey[k];
  const opP = (s) => () => def.byKey[`${op()}${s}`];
  const envP = (s) => () => def.byKey[`${env() === "mod" ? "m" : "a"}${s}`];
  const lfoP = (s) => () => def.byKey[`l${lfo()}${s}`];
  const c = (pf) => control(pf, KNOB);
  const when = (el, fn) => { W.add(el, () => el.classList.toggle("gone", !fn())); return el; };

  // ---- operators
  const opTabs = h("div", { class: "fs-tabs" }, ...OPS.map((x, i) => {
    const b = h("button", { class: "fs-tab op", onclick: () => { d.op = x; save(); } }, x.toUpperCase(), h("i", { class: "fs-lvl" }));
    W.add(b, () => {
      b.classList.toggle("on", op() === x);
      b.classList.toggle("heard", HEARD[v("algo")].includes(i));
      b.lastChild.style.transform = `scaleY(${v(`${x}level`)})`;
    });
    return b;
  }));
  const wave = surface(W, "fs-wave", () => `${op()}|${v(`${op()}wave`)}|${v(`${op()}fb`)}`, (g, w, hh) => drawWave(g, w, hh, v(`${op()}wave`)));
  const operators = section("fs-ops", opTabs,
    h("div", { class: "fs-col" }, wave, c(opP("wave"))),
    h("div", { class: "fs-grid c5" }, ...["ratio", "fine", "level", "fb", "vel", "att", "dec", "sus", "rel"].map((s) => c(opP(s)))));

  // ---- algorithm: click for the list, scroll to step through
  const algo = surface(W, "fs-algo", () => `${v("algo")}|${OPS.map((x) => v(`${x}level`) > 0).join()}|${OPS.map((x) => v(`${x}fb`) > 0).join()}`,
    (g, w, hh) => drawAlgo(g, w, hh, v("algo"), OPS.map((x) => v(`${x}level`) > 0), OPS.map((x) => v(`${x}fb`) > 0)));
  const setAlgo = (i) => edit(() => setParam(o, d, def.byKey.algo, (i + ALGOS.length) % ALGOS.length));
  algo.dataset.help = "<b>Algorithm</b>  How the operators modulate each other. Click to choose, scroll to step through";
  algo.addEventListener("click", (e) => menu(e, ALGOS.map((n, i) => ({ label: n, icon: i === v("algo") ? "i-check" : null, run: () => setAlgo(i) }))));
  algo.addEventListener("wheel", (e) => { e.preventDefault(); setAlgo(v("algo") + Math.sign(e.deltaY)); }, { passive: false });
  const routing = section("fs-route", h("span", { class: "fs-title" }, text(W, () => ALGOS[v("algo")])),
    algo, h("div", { class: "fs-grid c3" }, c(at("fm")), c(at("sub")), c(at("noise"))));

  // ---- filter
  const filter = section("fs-filter", h("span", { class: "fs-title" }, "Filter"),
    h("div", { class: "fs-grid c4" }, c(at("ftype")), c(at("cutoff")), c(at("res")), c(at("drive")), c(at("fenv")), c(at("fkey")), c(at("fvel"))));

  // ---- envelopes
  const shape = surface(W, "fs-env", () => `${env()}|${["a", "d", "s", "r"].map((s) => valueOf(envP(s)(), d.params)).join()}`,
    (g, w, hh) => { const k = env() === "mod" ? "m" : "a"; drawEnv(g, w, hh, v(`${k}a`), v(`${k}d`), v(`${k}s`), v(`${k}r`)); });
  const envs = section("fs-envs", tabs(W, d, "env", [["amp", "Amp"], ["mod", "Mod"]], "amp"),
    shape, h("div", { class: "fs-grid c4" }, c(envP("a")), c(envP("d")), c(envP("s")), c(envP("r"))));

  // ---- LFOs: a rate in Hz, or synced to the beat
  const lshape = surface(W, "fs-lfo", () => `${lfo()}|${v(`l${lfo()}shape`)}`, (g, w, hh) => drawLfo(g, w, hh, v(`l${lfo()}shape`)));
  const lfos = section("fs-lfos", tabs(W, d, "lfo", [[1, "LFO 1"], [2, "LFO 2"]], 1),
    lshape, h("div", { class: "fs-grid c3" }, c(lfoP("shape")),
      when(c(lfoP("rate")), () => !v(`l${lfo()}sync`)), when(c(lfoP("div")), () => !!v(`l${lfo()}sync`)),
      c(lfoP("sync")), c(lfoP("trig"))));

  // ---- the matrix: six rows of source → target, amount
  const matrix = section("fs-matrix", h("span", { class: "fs-title" }, "Modulation"),
    h("div", { class: "fs-rows" }, ...[1, 2, 3, 4, 5, 6].map((i) => slot(W, o, d, def, i))));

  // ---- voice and output
  const voice = section("fs-voice", h("span", { class: "fs-title" }, "Voice"),
    h("div", { class: "fs-grid c6" }, ...["oct", "semi", "uni", "detune", "spread", "mono", "glide", "vel", "macro", "dist", "level"].map((k) => c(at(k)))));

  return [operators, routing, filter, envs, lfos, matrix, voice];
}

// a matrix row: two pickers and a bipolar amount you drag across
function slot(W, o, d, def, i) {
  const P = (k) => def.byKey[`m${i}${k}`], get = (k) => valueOf(P(k), d.params);
  const pick = (k, list) => {
    const b = h("button", { class: "fs-pick", onclick: (e) => menu(e, list.map((n, j) => ({ label: n, icon: j === get(k) ? "i-check" : null, run: () => edit(() => setParam(o, d, P(k), j)) }))) },
      text(W, () => list[get(k)]), icon("i-chev", "i xs"));
    return b;
  };
  const bar = h("div", { class: "fs-amt", "data-help": "<b>Amount</b>  Drag left or right. Double-click for none" }, h("i"));
  W.add(bar, () => { const a = get("amt"); bar.firstChild.style.cssText = `left:${50 + Math.min(0, a) * 50}%;width:${Math.abs(a) * 50}%`; bar.classList.toggle("off", !get("src")); });
  bar.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    const r = bar.getBoundingClientRect(), set = (ev) => { touch(); setParam(o, d, P("amt"), Math.round(Math.max(-1, Math.min(1, ((ev.clientX - r.left) / r.width) * 2 - 1)) * 100) / 100); };
    bar.setPointerCapture(e.pointerId); set(e);
    const up = () => { bar.removeEventListener("pointermove", set); bar.removeEventListener("pointerup", up); };
    bar.addEventListener("pointermove", set); bar.addEventListener("pointerup", up);
  });
  bar.addEventListener("dblclick", () => edit(() => setParam(o, d, P("amt"), 0)));
  const val = text(W, () => { const a = get("amt"); return `${a > 0 ? "+" : ""}${Math.round(a * 100)}`; }, "fs-amtv");
  return h("div", { class: "fs-slot" }, pick("src", SOURCES), pick("dst", TARGETS), bar, val);
}

// ---- displays
// a wavetable position as the synth makes it: the shapes' harmonic series, morphed
const SHAPE_PTS = 128;
const shapes = [0, 1, 2, 3, 4, 5].map((s) => {
  const out = new Float32Array(SHAPE_PTS);
  for (let n = 1; n <= 40; n++) {
    let a = 0, cos = 0;
    if (s === 0) a = n === 1 ? 1 : 0;
    else if (s === 1) a = n % 2 ? 8 / (Math.PI ** 2 * n * n) * (((n - 1) / 2) % 2 ? -1 : 1) : 0;
    else if (s === 2) a = 2 / Math.PI / n * (n % 2 ? 1 : -1);
    else if (s === 3) a = n % 2 ? 4 / Math.PI / n : 0;
    else if (s === 4) cos = 2 / (Math.PI * n) * Math.sin(Math.PI * n * 0.25);
    else a = 2 / Math.PI / n * (1 + 3 * Math.exp(-(((n - 10) / 4) ** 2)));
    for (let i = 0; i < SHAPE_PTS; i++) { const t = 2 * Math.PI * n * i / SHAPE_PTS; out[i] += a * Math.sin(t) + cos * Math.cos(t); }
  }
  const peak = Math.max(...out.map(Math.abs)) || 1;
  return out.map((x) => x / peak);
});
function drawWave(g, w, hh, pos) {
  const s0 = Math.floor(pos), s1 = Math.min(5, s0 + 1), f = pos - s0, mid = hh / 2;
  g.fillStyle = INK.grid; g.fillRect(0, mid, w, 1);
  g.strokeStyle = INK.line; g.lineWidth = 1.5; g.beginPath();
  for (let i = 0; i <= SHAPE_PTS; i++) {
    const k = i % SHAPE_PTS, y = shapes[s0][k] * (1 - f) + shapes[s1][k] * f;
    const x = i / SHAPE_PTS * w, py = mid - y * (mid - 4);
    if (i) g.lineTo(x, py); else g.moveTo(x, py);
  }
  g.stroke();
}

// operators by how far they are from the output: carriers along the bottom, their modulators above
function drawAlgo(g, w, hh, a, live, fb) {
  const routes = ROUTES[a], heard = HEARD[a], depth = [0, 0, 0, 0];
  for (let pass = 0; pass < 4; pass++) routes.forEach((mods, t) => mods.forEach((m) => { depth[m] = Math.max(depth[m], depth[t] + 1); }));
  const rows = Math.max(...depth) + 1, bw = 22, bh = Math.min(16, Math.floor((hh - 14) / rows) - 4), gapY = (hh - 14 - rows * bh) / rows;
  const byRow = Array.from({ length: rows }, (_, r) => [0, 1, 2, 3].filter((i) => depth[i] === r));
  const pos = [];
  byRow.forEach((ops, r) => ops.forEach((i, k) => { pos[i] = [w * (k + 1) / (ops.length + 1) - bw / 2, hh - 14 - (r + 1) * bh - r * gapY]; }));
  g.lineWidth = 1;
  routes.forEach((mods, t) => mods.forEach((m) => {
    g.strokeStyle = live[m] ? "#8d8d93" : INK.dim; g.beginPath();
    g.moveTo(pos[m][0] + bw / 2, pos[m][1] + bh); g.lineTo(pos[t][0] + bw / 2, pos[t][1]); g.stroke();
  }));
  g.fillStyle = INK.dim; g.fillRect(8, hh - 6, w - 16, 2);
  heard.forEach((i) => { g.strokeStyle = live[i] ? INK.line : INK.dim; g.beginPath(); g.moveTo(pos[i][0] + bw / 2, pos[i][1] + bh); g.lineTo(pos[i][0] + bw / 2, hh - 6); g.stroke(); });
  g.font = "600 10px Bahnschrift, 'Segoe UI', sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  pos.forEach(([x, y], i) => {
    g.fillStyle = INK.box; g.fillRect(x, y, bw, bh);
    g.strokeStyle = heard.includes(i) && live[i] ? INK.line : live[i] ? "#5a5a60" : "#2a2a2f"; g.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
    g.fillStyle = live[i] ? "#d6d6da" : "#4a4a50"; g.fillText("ABCD"[i], x + bw / 2, y + bh / 2 + 0.5);
    if (fb[i]) { g.strokeStyle = "#8d8d93"; g.beginPath(); g.arc(x + bw + 3, y + bh / 2, 4, -Math.PI / 2, Math.PI / 2); g.stroke(); }
  });
}

// attack, decay, sustain, release, each segment's width growing with its time
function drawEnv(g, w, hh, a, dcy, s, r) {
  const span = (t) => 0.15 + Math.sqrt(t / 10) * 0.85, total = span(a) + span(dcy) + 0.6 + span(r), k = (w - 4) / total, top = 4, bot = hh - 3;
  const x1 = 2 + span(a) * k, x2 = x1 + span(dcy) * k, x3 = x2 + 0.6 * k, x4 = x3 + span(r) * k, ys = bot - s * (bot - top);
  g.fillStyle = INK.grid; g.fillRect(0, bot, w, 1);
  g.strokeStyle = INK.line; g.lineWidth = 1.5; g.beginPath();
  g.moveTo(2, bot); g.lineTo(x1, top);
  for (let i = 1; i <= 16; i++) { const t = i / 16; g.lineTo(x1 + (x2 - x1) * t, ys + (top - ys) * Math.exp(-4.6 * t)); }
  g.lineTo(x3, ys);
  for (let i = 1; i <= 16; i++) { const t = i / 16; g.lineTo(x3 + (x4 - x3) * t, bot - (bot - ys) * Math.exp(-4.6 * t)); }
  g.stroke();
}

function drawLfo(g, w, hh, shape) {
  const mid = hh / 2, amp = mid - 4, steps = [0.3, -0.7, 0.9, -0.2, 0.5, -0.9, 0.1, 0.7];
  const at = (p) => [Math.sin(2 * Math.PI * p), 1 - 4 * Math.abs(p - 0.5), 1 - 2 * p, 2 * p - 1, p < 0.5 ? 1 : -1, steps[Math.floor(p * 8)]][shape];
  g.fillStyle = INK.grid; g.fillRect(0, mid, w, 1);
  g.strokeStyle = INK.line; g.lineWidth = 1.5; g.beginPath();
  for (let i = 0; i <= 2 * 96; i++) { const p = (i % 96) / 96, x = i / 192 * w, y = mid - at(p) * amp; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
  g.stroke();
}

// ---- Crate Additive
function addPanel(W, o, d, def, control) {
  const v = (k) => valueOf(def.byKey[k], d.params);
  const c = (k) => control(() => def.byKey[k], KNOB);
  const set = (k, x) => setParam(o, d, def.byKey[k], x);

  // drawbars: pulled down for more, as on the organ; drag, or click a step
  const bars = h("div", { class: "db-bars" }, ...DRAWBARS.map(([foot, colour], i) => {
    const k = `db${i + 1}`;
    const bar = h("div", { class: `db-bar ${colour}`, "data-help": `<b>${foot} drawbar</b>  Drag down for more, up for less. 0 is off, each step 3 dB` },
      h("div", { class: "db-rod" }, h("div", { class: "db-knob" }, String(v(k)))), h("span", { class: "db-foot" }, foot));
    const rod = bar.firstChild, knob = rod.firstChild;
    W.add(bar, () => { const x = Math.round(v(k)); if (knob.textContent !== String(x)) knob.textContent = String(x); rod.style.setProperty("--pos", x / 8); });
    bar.addEventListener("pointerdown", (e) => {
      if (e.button) return;
      const r = rod.getBoundingClientRect(), at = (ev) => Math.max(0, Math.min(8, Math.round((ev.clientY - r.top) / r.height * 8)));
      bar.setPointerCapture(e.pointerId); touch(); set(k, at(e));
      const move = (ev) => { const x = at(ev); if (x !== Math.round(v(k))) { touch(); set(k, x); } };
      const up = () => { bar.removeEventListener("pointermove", move); bar.removeEventListener("pointerup", up); };
      bar.addEventListener("pointermove", move); bar.addEventListener("pointerup", up);
    });
    return bar;
  }));
  const registration = text(W, () => DRAWBARS.map((_, i) => Math.round(v(`db${i + 1}`))).join(""), "db-reg");
  const drawbars = section("fs-bars", h("span", { class: "fs-title" }, "Drawbars ", registration), bars, h("div", { class: "fs-grid c1" }, c("organ")));

  // the scanner's six positions and off, as one row of switches
  const scanner = h("div", { class: "db-scan" }, ...SCANNER.map((n, i) => {
    const b = h("button", { class: "fs-tab", onclick: () => edit(() => set("vib", i)) }, n);
    W.add(b, () => b.classList.toggle("on", v("vib") === i));
    return b;
  }));
  const speed = h("button", { class: "db-speed", "data-help": "<b>Rotary speed</b>  Slow or fast; the horn and drum take their time to get there",
    onclick: () => edit(() => set("fast", !v("fast"))) }, text(W, () => (v("fast") ? "Fast" : "Slow")));
  W.add(speed, () => { speed.classList.toggle("on", !!v("fast")); speed.classList.toggle("dim", !v("rotary")); });
  const organ = section("fs-organ", h("span", { class: "fs-title" }, "Organ"),
    h("div", { class: "fs-col left" },
      h("div", { class: "fs-grid c4" }, c("perc"), c("pslow"), c("psoft"), c("click")),
      h("div", { class: "fs-lab" }, "Vibrato & chorus"), scanner),
    h("div", { class: "fs-col" }, c("rotary"), speed, c("drive")));

  // harmonics: what the partials are doing, from the same rules the synth uses
  const spectrum = surface(W, "fs-spec", () => ["harm", "parts", "tilt", "odd", "stretch", "fpeak", "fgain", "fwidth", "damp"].map(v).join(), (g, w, hh) => drawPartials(g, w, hh, v));
  const harmonics = section("fs-harm", h("span", { class: "fs-title" }, "Harmonics"), spectrum,
    h("div", { class: "fs-grid c6" }, ...["harm", "parts", "tilt", "odd", "stretch", "hoct", "fpeak", "fgain", "fwidth", "damp", "spread", "vel"].map(c)));
  const env = surface(W, "fs-env", () => ["aa", "ad", "as", "ar"].map(v).join(), (g, w, hh) => drawEnv(g, w, hh, v("aa"), v("ad"), v("as"), v("ar")));
  const envelope = section("fs-envs", h("span", { class: "fs-title" }, "Envelope"), env, h("div", { class: "fs-grid c4" }, ...["aa", "ad", "as", "ar"].map(c)));
  const lfo = section("fs-lfos", h("span", { class: "fs-title" }, "LFO and output"), h("div", { class: "fs-grid c3" }, ...["lrate", "lvib", "ltrem", "ltilt", "level"].map(c)));
  return [drawbars, organ, harmonics, envelope, lfo];
}

// partial levels as additive.hpp shapes them, at middle C, damping shown as the fade to the right
function drawPartials(g, w, hh, v) {
  const n = Math.round(v("parts")), base = 261.6, B = v("stretch") ** 2 * 0.01, bw = (w - 4) / 32, bot = hh - 3;
  g.fillStyle = INK.grid; g.fillRect(0, bot, w, 1);
  const amps = [];
  for (let k = 1; k <= n; k++) {
    const f = base * k * Math.sqrt(1 + B * k * k), x = Math.log2(f / v("fpeak")) / v("fwidth");
    let a = 2 ** (v("tilt") * Math.log2(k) / 6.0206) * 2 ** (v("fgain") * Math.exp(-x * x) / 6.0206);
    if (k > 1) a *= k % 2 === 0 ? 1 - Math.max(0, v("odd")) : 1 - Math.max(0, -v("odd"));
    amps.push(a);
  }
  const peak = Math.max(...amps, 1e-9);
  amps.forEach((a, i) => {
    const db = Math.max(-48, 20 * Math.log10(a / peak)), y = bot - (1 + db / 48) * (bot - 4);
    g.fillStyle = v("harm") > 0 ? INK.line : "#5a5a60"; g.globalAlpha = 1 - Math.min(0.85, v("damp") * i / 24);
    g.fillRect(2 + i * bw, y, Math.max(1, bw - 1.5), bot - y);
  });
  g.globalAlpha = 1;
}
