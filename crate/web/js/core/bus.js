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
  for (const fn of subs.get(name) || []) fn(data);
}
