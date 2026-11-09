// Shared vocabulary: colours, formatting, and the small visual atoms used across views.
import { h } from "./dom.js";

export const COLORS = [null, "#f06ba8", "#ef4444", "#f59e0b", "#facc15", "#4ade80", "#2dd4bf", "#3b82f6", "#a855f7"];
export const PAD = ["#3ddc84", "#ff9f1c", "#ff4d6d", "#4cc9f0", "#c77dff", "#ffd60a", "#f15bb5", "#7bdff2"];
export const PHRASE = { Intro: "#3a9a62", Verse: "#2f8f8b", Build: "#b8902a", Drop: "#c8483f", Breakdown: "#4469c4", Outro: "#7d58b8" };
export const PAD_LETTERS = "ABCDEFGH";
const LOSSLESS = new Set(["pcm", "flac", "alac", "aiff"]);

export const fmtTime = (s) => { s = Math.max(0, s || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`; };
export const cueColor = (c) => (c.slot ? c.color || PAD[c.slot - 1] : "#ff6a5e");

export const camelotColor = (c) => {
  const m = /^(\d+)([AB])$/.exec(c || "");
  return m ? `hsl(${(+m[1] - 1) * 30 + 60} ${m[2] === "A" ? 60 : 68}% ${m[2] === "A" ? 62 : 73}%)` : "transparent";
};

// would b mix with a: compatible key and within 6% tempo (or half/double time)
export function mixesWith(a, b) {
  if (!a || !b || !a.camelot || !b.camelot || a.id === b.id) return false;
  const [, x, lx] = /^(\d+)([AB])$/.exec(a.camelot) || [], [, y, ly] = /^(\d+)([AB])$/.exec(b.camelot) || [];
  if (!x || !y) return false;
  const diff = (+x - +y + 12) % 12;
  if (!((lx === ly && (diff === 0 || diff === 1 || diff === 11)) || x === y)) return false;
  return !a.bpm || !b.bpm || [1, 2, 0.5].some((r) => Math.abs(b.bpm * r / a.bpm - 1) <= 0.06);
}

// artwork, or a colour tile generated from the artist and title
const hashHue = (s) => { let x = 0; for (const ch of s || "") x = (x * 31 + ch.charCodeAt(0)) | 0; return Math.abs(x) % 360; };
export function artBg(t) {
  if (t.has_art) return `background-image:url(/api/art/${t.id})`;
  const hu = hashHue(`${t.artist}${t.title}`);
  // a dark sleeve with a faint tint, so a list without artwork still reads calm
  return `background-image:radial-gradient(circle at 28% 22%, hsl(${hu} 40% 60% / .28), transparent 62%), linear-gradient(150deg, hsl(${hu} 22% 26%), hsl(${(hu + 40) % 360} 26% 13%))`;
}

export function fmtChip(t) {
  const ext = ((t.path || "").split(".").pop() || t.codec || "").toUpperCase();
  return h("span", { class: "fmt" + (LOSSLESS.has(t.codec) ? " ll" : "") }, ext === "AIF" ? "AIFF" : ext);
}

export function energyBar(e) {
  if (!e) return "";
  return h("span", { class: "energy", title: `Energy ${e}` }, ...Array.from({ length: 10 }, (_, i) => h("i",
    i < e ? { class: "on", style: `--ec:hsl(${190 - i * 21} 88% 60%);height:${6 + i * 0.7}px` } : { style: `height:${6 + i * 0.7}px` })));
}

// tracks that change tempo: "128 → 140", and where each change happens for tooltips
const bpmText = (b) => (b % 1 ? b.toFixed(1) : String(b));
export const fmtTempos = (tempos, sep = " → ") => tempos.map((x) => bpmText(x.bpm)).join(sep);
export const tempoTitle = (tempos) => "Tempo changes: " + tempos.map((x, i) => `${bpmText(x.bpm)} ${i ? `at ${fmtTime(x.ms / 1000)}` : "from the start"}`).join(", ");
