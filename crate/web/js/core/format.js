// Shared vocabulary: colours, formatting, and the small visual atoms used across views.
import { h } from "./dom.js";

export const COLORS = [null, "#f06ba8", "#ef4444", "#f59e0b", "#facc15", "#4ade80", "#2dd4bf", "#3b82f6", "#a855f7"];
export const PAD = ["#3ddc84", "#ff9f1c", "#ff4d6d", "#4cc9f0", "#c77dff", "#ffd60a", "#f15bb5", "#7bdff2"];
export const PHRASE = { Intro: "#2fae6c", Verse: "#22a8a3", Build: "#cf9d1c", Drop: "#e0453f", Breakdown: "#3f73e0", Outro: "#9157d8" };
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
  return `background-image:radial-gradient(circle at 30% 25%, hsl(${hu} 80% 68% / .9), transparent 60%), linear-gradient(140deg, hsl(${hu} 62% 42%), hsl(${(hu + 50) % 360} 70% 22%))`;
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
