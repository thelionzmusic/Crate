// Small numeric helpers shared across the page.
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const amp = (db) => 10 ** (db / 20);  // decibels to a gain
