// The piano roll: a MIDI clip's notes, opened by double-clicking the clip. Keys down the left,
// bars along the top (drag the loop's end there), notes on the grid, velocity along the bottom.
//
//   Double-click, or click in Draw mode (B): a note, which you can drag out to length
//   Drag a note to move it, its ends to resize; Ctrl-drag copies; Alt drags off the grid
//   Drag on empty grid to select a box; Ctrl and Shift add to the selection
//   Arrows move (Shift: an octave or a bar), Ctrl+D duplicates, Ctrl+U quantises, Delete removes
//   Ctrl+scroll zooms, Shift+scroll moves along; the keys play what they are
import { h, mount, sizeOf, watchSize } from "../core/dom.js";
import { studio } from "./engine.js";
import { NOTE_NAMES, P, checkpoint, clipAt, edit, inKey, redraw, save } from "./set.js";

const KEYS = 46, RULER = 18, VEL = 46, ROW = 11, BAR = 4, EDGE = 5;
const GRIDS = [["1/4", 1], ["1/8", 1 / 2], ["1/8T", 1 / 3], ["1/16", 1 / 4], ["1/16T", 1 / 6], ["1/32", 1 / 8]];
const black = (p) => [1, 3, 6, 8, 10].includes(p % 12);
const noteName = (p) => `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 2}`;  // Ableton's octaves: middle C is C3

// view and editing state, kept across openings
const R = { zoom: 40, x: 0, y: 0, grid: 1 / 4, draw: false, fold: false, len: 1 / 4, sel: new Set(), clipboard: null, ver: 0, at: null, focus: false, box: null, canvas: null };

const open = () => clipAt(P.open);
// the roll has the keys from a click in it until a click elsewhere; it's rebuilt on every edit, so
// this can't be the canvas's own focus
addEventListener("pointerdown", (e) => { R.focus = !!e.target.closest?.(".pd-clip"); }, true);
const changed = () => { R.ver++; };
const snap = (b, step = R.grid) => Math.round(b / step) * step;
const snapDown = (b, step = R.grid) => Math.floor(b / step + 1e-9) * step;

// ---- the rows: every pitch, or folded to the pitches in use
function rows(c) {
  if (!R.fold || !c.notes.length) return null;
  return [...new Set(c.notes.map((n) => n.p))].sort((a, b) => b - a);
}
const pitchAt = (c, y) => { const r = Math.floor((y - RULER + R.y) / ROW), f = rows(c); return f ? f[Math.max(0, Math.min(f.length - 1, r))] : Math.max(0, Math.min(127, 127 - r)); };
const yOf = (c, p) => { const f = rows(c), r = f ? f.indexOf(p) : 127 - p; return RULER + r * ROW - R.y; };
const xOf = (b) => KEYS + (b - R.x) * R.zoom;
const beatAt = (x) => R.x + (x - KEYS) / R.zoom;
const rowCount = (c) => rows(c)?.length ?? 128;

export function renderRoll(el, W) {
  const at = open();
  if (!at) return mount(el, h("div", { class: "pr-none" }, "Double-click a MIDI clip to edit its notes"));
  const { clip: c, track: t } = at;
  if (JSON.stringify(P.open) !== R.at) { R.at = JSON.stringify(P.open); R.sel = new Set(); R.fit = true; }
  for (const n of R.sel) if (!c.notes.includes(n)) R.sel.delete(n);  // undo replaced them
  const canvas = R.canvas ||= wire(watchSize(h("canvas", { class: "pr-canvas", "data-help": "<b>Piano roll</b>  Double-click to add a note, drag to move, drag an end to resize. B: draw mode. Ctrl+scroll zooms" })));
  const btn = (label, on, run, help) => {
    const b = h("button", { class: "pbtn", "data-help": help, onclick: () => { run(); changed(); } }, label);
    W.add(b, () => b.classList.toggle("on", !!on()));
    return b;
  };
  const lenText = h("span", { class: "pr-len" });
  W.add(lenText, () => { const v = `${c.beats / BAR >= 1 ? `${+(c.beats / BAR).toFixed(2)} bar${c.beats === BAR ? "" : "s"}` : `${c.beats} beat${c.beats === 1 ? "" : "s"}`}`; if (lenText.textContent !== v) lenText.textContent = v; });
  mount(el,
    h("div", { class: "pr-side", style: `--c:${t.colour}` },
      h("div", { class: "pr-name" }, c.name),
      h("div", { class: "pr-row" }, btn("Loop", () => c.loop, () => edit(() => { c.loop = !c.loop; }), "<b>Loop</b>  Off: the clip plays once")),
      h("div", { class: "pr-row" },
        h("button", { class: "pbtn pr-step", "data-help": "<b>Halve</b> the clip's length", onclick: () => edit(() => { c.beats = Math.max(1, c.beats / 2); }) }, "/2"),
        lenText,
        h("button", { class: "pbtn pr-step", "data-help": "<b>Double</b> the clip's length, copying its notes into the new half", onclick: () => edit(() => doubleClip(c)) }, "×2")),
      h("label", { class: "pr-row pr-grid" }, "Grid",
        h("select", { "aria-label": "Grid", onchange: (e) => { R.grid = +e.target.value; changed(); } },
          ...GRIDS.map(([n, v]) => h("option", { value: v, selected: Math.abs(v - R.grid) < 1e-9 }, n)))),
      h("div", { class: "pr-row" },
        btn("Draw", () => R.draw, () => { R.draw = !R.draw; }, "<b>Draw</b>  Click places notes  B"),
        btn("Fold", () => R.fold, () => { R.fold = !R.fold; R.y = 0; }, "<b>Fold</b>  Only the rows with notes")),
      h("div", { class: "pr-row" },
        h("button", { class: "pbtn", "data-help": "<b>Quantise</b>  The selected notes (or all) onto the grid  Ctrl+U", onclick: () => quantise(c) }, "Quantise")),
      h("div", { class: "pr-fill" }),
      h("button", { class: "pbtn pr-back", "data-help": "<b>Devices</b>  Back to the track's devices  Shift+Tab", onclick: () => { P.detail = "devices"; redraw(); } }, "Devices")),
    canvas);
  drawn = "";
  W.add(canvas, () => draw(canvas, c, t));
}

// ---- editing
function doubleClip(c) {
  const copies = c.notes.filter((n) => n.s < c.beats).map((n) => ({ ...n, s: n.s + c.beats }));
  c.notes.push(...copies); c.beats *= 2;
}
function quantise(c) {
  const list = R.sel.size ? [...R.sel] : c.notes;
  if (!list.length) return;
  edit(() => { for (const n of list) n.s = Math.max(0, snap(n.s)); });
}
function remove(c, list) { const gone = new Set(list); c.notes = c.notes.filter((n) => !gone.has(n)); R.sel = new Set(); }
// how far a copy of these notes goes along: their span, rounded up to a bar (a beat, or the grid, when they're shorter)
function span(list) {
  const w = Math.max(...list.map((n) => n.s + n.l)) - Math.min(...list.map((n) => n.s)), unit = w > 2 ? BAR : w > 0.5 ? 1 : R.grid;
  return Math.max(unit, Math.ceil(w / unit - 1e-9) * unit);
}
function paste(c, list, shift) {
  const made = list.map((n) => ({ ...n, s: n.s + shift }));
  c.notes.push(...made); R.sel = new Set(made);
  return made;
}

// a key's sound, through the track's instrument
const play = (t, p, v = 100) => studio.audition(t, p, v / 127, 0.4);

// what's under a point: a note and which part of it
function noteAt(c, x, y) {
  if (y < RULER || x < KEYS) return null;
  const p = pitchAt(c, y), b = beatAt(x);
  for (let i = c.notes.length - 1; i >= 0; i--) {
    const n = c.notes[i];
    if (n.p !== p || b < n.s || b > n.s + n.l) continue;
    const x0 = xOf(n.s), x1 = xOf(n.s + n.l), w = x1 - x0;
    return { n, part: x1 - x < Math.min(EDGE, w / 3) ? "end" : x - x0 < Math.min(EDGE, w / 4) ? "start" : "body" };
  }
  return null;
}

// One canvas, kept across edits (rebuilding it mid-click would lose the click); each event
// works on whichever clip is open then.
function wire(cv) {
  const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.addEventListener("pointerdown", (e) => {
    const at = open();
    if (e.button !== 0 || !at) return;
    const { clip: c, track: t } = at;
    const [x, y] = local(e), [, hh] = sizeOf(cv);
    cv.setPointerCapture(e.pointerId);
    if (y < RULER) return dragLoopEnd(cv, c, x);
    if (y > hh - VEL) return dragVelocity(cv, c, x, y);
    if (x < KEYS) return glide(cv, c, t, y);
    const got = noteAt(c, x, y), extend = e.ctrlKey || e.metaKey || e.shiftKey, twice = double(x, y);
    if (got && twice && !R.draw) { edit(() => remove(c, R.sel.has(got.n) ? [...R.sel] : [got.n])); return; }
    if (got) {
      if (extend && !(e.ctrlKey && R.sel.has(got.n))) { if (R.sel.has(got.n)) R.sel.delete(got.n); else R.sel.add(got.n); }
      else if (!R.sel.has(got.n)) R.sel = new Set([got.n]);
      changed();
      return dragNotes(cv, c, t, got.n, got.part, x, y);
    }
    if (R.draw || twice) {  // a new note, then dragging sets its length
      const n = { p: pitchAt(c, y), s: Math.max(0, snapDown(beatAt(x))), l: R.len, v: 100 };
      checkpoint(); c.notes.push(n); R.sel = new Set([n]); play(t, n.p); changed();
      return dragNotes(cv, c, t, n, "end", x, y, true);
    }
    if (!extend) R.sel = new Set();
    marquee(cv, c, x, y, new Set(R.sel));
    changed();
  });
  cv.addEventListener("pointermove", (e) => {
    const c = open()?.clip;
    if (e.buttons || !c) return;
    const [x, y] = local(e), got = noteAt(c, x, y), [, hh] = sizeOf(cv);
    cv.style.cursor = y < RULER && Math.abs(x - xOf(c.beats)) < 6 ? "ew-resize" : got?.part === "end" || got?.part === "start" ? "ew-resize" : got ? "grab" : x < KEYS ? "pointer" : y > hh - VEL ? "ns-resize" : R.draw ? "crosshair" : "";
  });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const [x] = local(e);
    if (e.ctrlKey || e.metaKey) { const b = beatAt(x); R.zoom = Math.min(400, Math.max(4, R.zoom * Math.exp(-e.deltaY * 0.0015))); R.x = Math.max(0, b - (x - KEYS) / R.zoom); }
    else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) R.x = Math.max(0, R.x + (e.deltaX || e.deltaY) / R.zoom);
    else R.y += e.deltaY;
    changed();
  }, { passive: false });
  return cv;
}

// a second press soon after the first, near it: pointer events carry no click count
let last = { t: 0, x: 0, y: 0 };
function double(x, y) {
  const now = performance.now(), yes = now - last.t < 400 && Math.abs(x - last.x) + Math.abs(y - last.y) < 6;
  last = yes ? { t: 0, x, y } : { t: now, x, y };
  return yes;
}

// pointer drags: each records one undo step, taken when the drag first moves
function follow(cv, move, end) {
  const local = (ev) => { const r = cv.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  const mv = (ev) => { move(...local(ev), ev); changed(); };
  const up = (ev) => { cv.removeEventListener("pointermove", mv); cv.removeEventListener("pointerup", up); end?.(...local(ev), ev); changed(); };
  cv.addEventListener("pointermove", mv); cv.addEventListener("pointerup", up);
}

function dragNotes(cv, c, t, anchor, part, x0, y0, fresh = false) {
  let moved = fresh, list = [...R.sel], from = list.map((n) => ({ ...n })), copied = false;
  const a = list.indexOf(anchor), loose = (ev) => ev.altKey;
  follow(cv, (x, y, ev) => {
    if (!moved && Math.abs(x - x0) + Math.abs(y - y0) < 3) return;
    if (!moved) { moved = true; checkpoint(); }
    if (!copied && !fresh && part === "body" && (ev.ctrlKey || ev.metaKey)) {  // Ctrl-drag: move copies, leave the originals
      copied = true; list = paste(c, from, 0); anchor = list[a];
    }
    const step = loose(ev) ? 1 / 64 : R.grid, d = (x - x0) / R.zoom, o = from[a];
    if (part === "body") {
      const ds = Math.max(-Math.min(...from.map((n) => n.s)), (loose(ev) ? o.s + d : snap(o.s + d, step)) - o.s);
      const dp = pitchAt(c, y) - pitchAt(c, y0);
      const lo = Math.min(...from.map((n) => n.p)), hi = Math.max(...from.map((n) => n.p)), dpc = Math.max(-lo, Math.min(127 - hi, dp));
      if (anchor.p !== o.p + dpc) play(t, o.p + dpc, o.v);
      list.forEach((n, i) => { n.s = from[i].s + ds; n.p = from[i].p + dpc; });
    } else if (part === "end") {
      const dl = (loose(ev) ? o.s + o.l + d : snap(o.s + o.l + d, step)) - (o.s + o.l);
      list.forEach((n, i) => { n.l = Math.max(step, from[i].l + dl); });
      R.len = anchor.l;
    } else {
      const ds = (loose(ev) ? o.s + d : snap(o.s + d, step)) - o.s;
      list.forEach((n, i) => { const s = Math.max(0, Math.min(from[i].s + from[i].l - step, from[i].s + ds)); n.l = from[i].s + from[i].l - s; n.s = s; });
    }
  }, () => {
    if (moved) { save(); redraw(); } else if (!fresh) play(t, anchor.p, anchor.v);
  });
}

// a box over the grid selects what it touches
function marquee(cv, c, x0, y0, base) {
  follow(cv, (x, y) => {
    R.box = [Math.min(x, x0), Math.min(y, y0), Math.abs(x - x0), Math.abs(y - y0)];
    const b0 = beatAt(R.box[0]), b1 = beatAt(R.box[0] + R.box[2]), p0 = pitchAt(c, R.box[1] + R.box[3]), p1 = pitchAt(c, R.box[1]);
    R.sel = new Set(base);
    for (const n of c.notes) if (n.s < b1 && n.s + n.l > b0 && n.p >= p0 && n.p <= p1) R.sel.add(n);
  }, () => { R.box = null; });
}

// the loop's end, dragged in the ruler, a beat at a time
function dragLoopEnd(cv, c, x) {
  if (Math.abs(x - xOf(c.beats)) > 6) return;
  let moved = false;
  follow(cv, (mx) => {
    if (!moved) { moved = true; checkpoint(); }
    c.beats = Math.max(1, Math.round(beatAt(mx)));
  }, () => { if (moved) { save(); redraw(); } });
}

// velocity: drag a note's stem up or down; selected notes move together
function dragVelocity(cv, c, x, y0) {
  const hit = c.notes.filter((n) => Math.abs(xOf(n.s) - x) < 4);
  if (!hit.length) return;
  const n0 = hit.find((n) => R.sel.has(n)) || hit[0], list = R.sel.has(n0) ? [...R.sel] : [n0], from = list.map((n) => n.v);
  let moved = false;
  follow(cv, (_, y) => {
    if (!moved) { moved = true; checkpoint(); }
    const d = Math.round((y0 - y) * 127 / (VEL - 8));
    list.forEach((n, i) => { n.v = Math.max(1, Math.min(127, from[i] + d)); });
  }, () => { if (moved) { save(); redraw(); } });
}

// the keyboard: press and slide to play
function glide(cv, c, t, y) {
  let last = pitchAt(c, y);
  play(t, last);
  follow(cv, (_, my) => { const p = pitchAt(c, my); if (p !== last) { last = p; play(t, p); } });
}

// ---- keys, while the roll has the focus; true when used
export function rollKey(e) {
  const at = open();
  if (!at || !R.focus || P.detail !== "clip") return false;
  const { clip: c, track: t } = at, k = e.key, ctrl = e.ctrlKey || e.metaKey, sel = [...R.sel];
  const nudge = (fn) => { if (sel.length) { edit(() => sel.forEach(fn)); play(t, sel[0].p, sel[0].v); } return true; };
  if (k === "Delete" || k === "Backspace") { if (sel.length) edit(() => remove(c, sel)); return true; }
  if (ctrl && k.toLowerCase() === "a") { R.sel = new Set(c.notes); changed(); return true; }
  if (ctrl && k.toLowerCase() === "d") { if (sel.length) edit(() => paste(c, sel, span(sel))); return true; }
  if (ctrl && k.toLowerCase() === "c") { if (sel.length) R.clipboard = sel.map((n) => ({ ...n })); return true; }
  if (ctrl && k.toLowerCase() === "x") { if (sel.length) { R.clipboard = sel.map((n) => ({ ...n })); edit(() => remove(c, sel)); } return true; }
  if (ctrl && k.toLowerCase() === "v") {
    if (R.clipboard) edit(() => { R.clipboard = paste(c, R.clipboard, span(R.clipboard)).map((n) => ({ ...n })); });  // each paste follows the last
    return true;
  }
  if (ctrl && k.toLowerCase() === "u") { quantise(c); return true; }
  if (ctrl) return false;
  if (k === "ArrowUp" || k === "ArrowDown") { const d = (k === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 12 : 1); return nudge((n) => { n.p = Math.max(0, Math.min(127, n.p + d)); }); }
  if (k === "ArrowLeft" || k === "ArrowRight") { const d = (k === "ArrowRight" ? 1 : -1) * (e.shiftKey ? BAR : R.grid); return nudge((n) => { n.s = Math.max(0, n.s + d); }); }
  if (k.toLowerCase() === "b") { R.draw = !R.draw; changed(); return true; }
  if (k === "Escape" && sel.length) { R.sel = new Set(); changed(); return true; }
  return false;
}

// ---- drawing, when anything changed
let drawn = "";
function draw(cv, c, t) {
  if (!cv.isConnected) return;
  const [w, hh] = sizeOf(cv);
  if (!w || !hh) return;
  if (R.fit) {  // a newly opened clip: all of it across, its notes (or middle C) in the middle
    R.fit = false;
    R.zoom = Math.max(8, (w - KEYS - 12) / c.beats); R.x = 0;
    const ps = c.notes.map((n) => n.p), mid = ps.length ? (Math.min(...ps) + Math.max(...ps)) / 2 : 60;
    R.y = (127 - mid) * ROW - (hh - RULER - VEL) / 2;
  }
  R.y = Math.max(0, Math.min(rowCount(c) * ROW - (hh - RULER - VEL), R.y));
  const head = playhead(c, t);
  const sig = `${w}|${hh}|${R.ver}|${R.x}|${R.y}|${R.zoom}|${c.beats}|${c.notes.length}|${head?.toFixed(3)}|${t.colour}|${P.set.tracks.length}`;
  if (sig === drawn) return;
  drawn = sig;
  const dpr = devicePixelRatio;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const gridBottom = hh - VEL, f = rows(c), key = P.set.key;
  g.fillStyle = "#0a0b1a"; g.fillRect(0, 0, w, hh);
  // rows
  g.save(); g.beginPath(); g.rect(KEYS, RULER, w - KEYS, gridBottom - RULER); g.clip();
  const first = Math.floor(R.y / ROW), last = Math.min(rowCount(c) - 1, Math.ceil((R.y + gridBottom - RULER) / ROW));
  for (let r = first; r <= last; r++) {
    const p = f ? f[r] : 127 - r, y = RULER + r * ROW - R.y;
    g.fillStyle = !key ? (black(p) ? "#0f1027" : "#15173a") : !inKey(p) ? "#0b0c1d" : (p - key.root) % 12 === 0 ? "#1f2150" : "#17193e"; g.fillRect(KEYS, y, w - KEYS, ROW);
    if (p % 12 === 0 || f) { g.fillStyle = "#23264f"; g.fillRect(KEYS, y + ROW - 1, w - KEYS, 1); }
  }
  // beats and bars; past the loop's end, dimmed
  const step = R.grid * R.zoom >= 7 ? R.grid : R.zoom >= 7 ? 1 : BAR;
  for (let b = Math.floor(R.x / step) * step; xOf(b) < w; b += step) {
    const x = Math.round(xOf(b)) + 0.5, bar = Math.abs(b / BAR - Math.round(b / BAR)) < 1e-6, beat = Math.abs(b - Math.round(b)) < 1e-6;
    g.fillStyle = bar ? "#34376a" : beat ? "#25284f" : "#1b1d42"; g.fillRect(x - 0.5, RULER, 1, gridBottom - RULER);
  }
  const end = xOf(c.beats);
  if (end < w) { g.fillStyle = "rgba(0,0,0,.45)"; g.fillRect(Math.max(KEYS, end), RULER, w, gridBottom - RULER); }
  // notes
  for (const n of c.notes) {
    const x = xOf(n.s), nw = Math.max(2, n.l * R.zoom), y = yOf(c, n.p);
    if (x > w || x + nw < KEYS || y + ROW < RULER || y > gridBottom) continue;
    const on = R.sel.has(n);
    g.globalAlpha = n.s >= c.beats ? 0.35 : 0.55 + 0.45 * n.v / 127;
    g.fillStyle = on ? "#f2f2f4" : t.colour; g.fillRect(x + 0.5, y + 1, nw - 1, ROW - 2);
    g.globalAlpha = 1;
    g.fillStyle = on ? t.colour : "rgba(0,0,0,.45)"; g.fillRect(x + 0.5, y + 1, 1, ROW - 2);
    if (nw > 34 && ROW >= 10) { g.fillStyle = on ? "#111" : "rgba(0,0,0,.7)"; g.font = "600 8px Bahnschrift, 'Segoe UI', sans-serif"; g.textBaseline = "middle"; g.fillText(noteName(n.p), x + 4, y + ROW / 2); }
  }
  if (R.box) { g.strokeStyle = "rgba(255,255,255,.7)"; g.lineWidth = 1; g.strokeRect(R.box[0] + 0.5, R.box[1] + 0.5, R.box[2], R.box[3]); g.fillStyle = "rgba(255,255,255,.06)"; g.fillRect(...R.box); }
  if (head != null) { const x = Math.round(xOf(head)); g.fillStyle = "#c4b0ff"; g.fillRect(x, RULER, 1, gridBottom - RULER); }
  g.restore();
  // the keyboard
  g.save(); g.beginPath(); g.rect(0, RULER, KEYS, gridBottom - RULER); g.clip();
  g.font = "600 8px Bahnschrift, 'Segoe UI', sans-serif"; g.textBaseline = "middle";
  for (let r = first; r <= last; r++) {
    const p = f ? f[r] : 127 - r, y = RULER + r * ROW - R.y, k = black(p);
    g.fillStyle = k ? "#1a1b38" : "#cfcde4"; g.fillRect(0, y, KEYS - 1, ROW - 1);
    if (p % 12 === 0 || f) { g.fillStyle = k ? "#9a97c0" : "#2a2850"; g.fillText(noteName(p), 4, y + ROW / 2); }
  }
  g.restore();
  // the ruler, with the loop's end
  g.fillStyle = "#0d0e22"; g.fillRect(0, 0, w, RULER);
  g.font = "500 9px Bahnschrift, 'Segoe UI', sans-serif"; g.textBaseline = "middle";
  const every = R.zoom * BAR < 30 ? 4 : 1;
  for (let bar = Math.floor(R.x / BAR); xOf(bar * BAR) < w; bar++) {
    if (bar % every) continue;
    const x = Math.round(xOf(bar * BAR)) + 0.5;
    if (x < KEYS) continue;
    g.fillStyle = "#3b3d70"; g.fillRect(x - 0.5, RULER - 6, 1, 6);
    g.fillStyle = "#8e8ab8"; g.fillText(String(bar + 1), x + 3, RULER / 2);
  }
  if (end >= KEYS && end < w) { g.fillStyle = t.colour; g.beginPath(); g.moveTo(end, RULER); g.lineTo(end - 7, RULER - 7); g.lineTo(end, RULER - 7); g.fill(); g.fillRect(end - 1, 0, 2, RULER); }
  g.fillStyle = "#05060f"; g.fillRect(0, RULER - 1, w, 1);
  // velocity
  g.fillStyle = "#0d0e22"; g.fillRect(0, gridBottom, w, VEL);
  g.fillStyle = "#05060f"; g.fillRect(0, gridBottom, w, 1);
  g.fillStyle = "#5c5888"; g.fillText("Vel", 6, gridBottom + 10);
  for (const n of c.notes) {
    const x = Math.round(xOf(n.s)), vh = (VEL - 8) * n.v / 127;
    if (x < KEYS || x > w) continue;
    g.fillStyle = R.sel.has(n) ? "#f2f2f4" : t.colour;
    g.fillRect(x, hh - 3 - vh, 1, vh); g.fillRect(x - 1, hh - 3 - vh, 4, 2);
  }
}

// where in the clip it's playing: in its slot, or on the timeline
function playhead(c, t) {
  const st = studio.state(t);
  if (st.playing === c) { const b = studio.beatNow() - st.start; return c.loop ? ((b % c.beats) + c.beats) % c.beats : b; }
  const at = open();
  if (at?.item && studio.song) {
    const b = studio.songBeat() - at.item.start;
    if (b >= 0 && b < at.item.length) return c.loop ? b % c.beats : b;
  }
  return null;
}
