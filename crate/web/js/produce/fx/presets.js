// Presets: a few starting points per effect and a hundred per instrument, plus your own, kept
// on this computer.
// A preset holds only the settings that differ from the device's defaults.
import { pref, setPref } from "../../core/prefs.js";
import { FM_PRESETS } from "../instruments/fm-presets.js";

export const FACTORY = {
  eq: {
    "Low cut 30 Hz": { on1: true },
    "Clear the mud": { g3: -3.5, f3: 320, q3: 1.1 },
    "Presence": { g5: 2.5, f5: 3200, q5: 0.8 },
    "Air": { g7: 3, f7: 11000 },
    "Telephone": { on1: true, f1: 400, on8: true, f8: 3200, g4: 4, f4: 1400 },
  },
  filter: {
    "Slow sweep": { lfo: 0.55, sync: true, div: 11, freq: 900, res: 2 },
    "Wobble 1/8": { lfo: 0.7, sync: true, div: 3, freq: 380, res: 4.5, drive: 6 },
    "High-pass build": { type: 1, freq: 300, res: 2.5 },
  },
  comp: {
    "Gentle glue": { threshold: -18, ratio: 2, attack: 30, release: 200, knee: 12, makeup: 2 },
    "Drum smash": { threshold: -30, ratio: 10, attack: 1, release: 60, knee: 0, makeup: 9, mix: 0.45 },
    "Vocal": { threshold: -24, ratio: 3.5, attack: 5, release: 120, rms: 1, makeup: 5 },
    "Bass control": { threshold: -20, ratio: 6, attack: 15, release: 80, makeup: 4 },
  },
  gate: {
    "Tight drums": { threshold: -30, hold: 5, release: 40 },
    "Gentle": { threshold: -45, floor: -18, release: 250 },
  },
  limiter: {
    "Master, -1 dB": { ceiling: -1 },
    "Loud": { gain: 6, ceiling: -0.3, release: 80 },
  },
  sat: {
    "Warm": { type: 2, drive: 4 },
    "Crunch": { type: 1, drive: 14, out: -6 },
    "Wavefold": { type: 3, drive: 10, mix: 0.6 },
  },
  redux: {
    "8-bit": { bits: 8, down: 4 },
    "Radio": { bits: 6, down: 8, mix: 0.6 },
  },
  delay: {
    "Dub 3/16": { div: 4, fb: 0.6, pp: true, lo: 300, hi: 3000 },
    "Slapback": { sync: false, time: 95, fb: 0.1, mix: 0.3 },
    "Quarter echo": { div: 6, fb: 0.35 },
  },
  reverb: {
    "Room": { size: 0.25, decay: 0.8, pre: 5 },
    "Hall": { size: 0.8, decay: 3.5, pre: 25 },
    "Long tail": { size: 1, decay: 9, damp: 4000 },
    "Dark plate": { size: 0.4, decay: 1.8, damp: 3000, pre: 0.5 },
  },
  chorus: {
    "Flanger": { delay: 1.5, fb: 0.6, depth: 0.8, rate: 0.2 },
    "Wide chorus": { delay: 12, depth: 0.5, rate: 0.4 },
  },
  phaser: { "Slow": { rate: 0.15, depth: 0.8 } },
  utility: { "Mono": { mono: true }, "Wide": { width: 1.5 } },
  fm: FM_PRESETS,  // by kind: Plucks, Leads, ...
};

export const userPresets = (type) => pref("fxPresets", {})[type] || {};
export function saveUser(type, name, params) {
  const all = pref("fxPresets", {});
  (all[type] ||= {})[name] = { ...params };
  setPref("fxPresets", all);
}
export function deleteUser(type, name) {
  const all = pref("fxPresets", {});
  if (all[type]) { delete all[type][name]; setPref("fxPresets", all); }
}
