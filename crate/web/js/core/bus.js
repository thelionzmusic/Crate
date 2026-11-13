// A tiny event bus, so modules react to changes without calling into each other.
//
// Events:
//   state     settings, folders, version (loadState)
//   tracks    the track table changed
//   nodes     playlists changed
//   thumbs    list waveforms arrived
//   view      the library view, sort or query changed
//   preview   the library's preview deck loaded or edited a track
//   open      a track was chosen to play: { id, force }
//   job       a background job finished: the job snapshot

const subs = new Map();

export function on(name, fn) {
  if (!subs.has(name)) subs.set(name, new Set());
  subs.get(name).add(fn);
  return () => subs.get(name).delete(fn);
}

export function emit(name, data) {
  if (held && BACKGROUND.has(name)) { later.set(name, data); return; }
  for (const fn of subs.get(name) || []) fn(data);
}

// Refreshes that arrive on their own (a job updating tracks, waveforms landing) wait while a
// mouse button is down. Redrawing a list or sidebar between press and release removes the
// very button being clicked, and the click is lost: that's what made some buttons need two.
const BACKGROUND = new Set(["tracks", "nodes", "thumbs", "job"]);
const later = new Map();
let held = false;
const release = () => {
  if (!held) return;
  held = false;
  const due = [...later]; later.clear();
  for (const [name, data] of due) emit(name, data);
};
let stuck = 0;
addEventListener("pointerdown", () => { held = true; clearTimeout(stuck); stuck = setTimeout(release, 8000); }, true);  // a release outside the window is never seen
for (const ev of ["pointerup", "pointercancel", "dragend", "blur"]) addEventListener(ev, () => setTimeout(release, 0), true);
