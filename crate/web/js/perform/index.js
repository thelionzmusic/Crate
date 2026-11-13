// Perform mode: starts the engine on first use, shows the decks, loads tracks onto them,
// and handles the keyboard while it's active.
import { api, toast } from "../core/api.js";
import { S, gainFor } from "../state.js";
import { mode, DECK_LETTERS } from "../mode.js";
import { Engine } from "../engine/engine.js";
import { View } from "./view.js";
import { onPrefs, prefs, setMeasuredLatency, setStatusSource } from "./settings.js";

export const engine = new Engine();
const view = new View(engine, { onLoad: (id, track, force) => loadTo(id, track, force) });
mode.decks = prefs.decks;

export async function loadTo(deckId, trackId, force = false) {
  if (!DECK_LETTERS.slice(0, prefs.decks).includes(deckId)) return;
  try {
    const t = await api(`track/${trackId}`), g = gainFor(S.byId.get(trackId));
    t.autoGainDb = g ? g.db : 0;   // decks start at Crate's levelled loudness
    await engine.load(deckId, t, { force: force || !prefs.lock });
  } catch (e) { toast(e.message, 5000); }
}
export const loadFocused = (trackId, force) => loadTo(view.focus, trackId, force);

export async function enter() {
  try {
    const first = !engine.backend;
    await engine.start(prefs);
    if (!first) await engine.route(prefs);
    await engine.backend.resume();
    setMeasuredLatency(engine.latency);
  } catch (e) { toast(`Audio couldn't start: ${e.message}`, 7000); }
  view.render(prefs.decks); view.start();
}
export function leave() { view.stop(); document.querySelector(".app").classList.remove("four"); }

onPrefs(async (changes) => {
  mode.decks = prefs.decks;
  if ("engine" in changes && engine.backend && engine.backend.kind !== (changes.engine === "native" ? "native" : "web")) {
    // the other engine starts fresh: reopen Crate's window on Perform, unless a deck is on air
    if (engine.decks.some((d) => d.playing)) toast("Stop the decks, then switch engines", 6000);
    else location.reload();
    return;
  }
  if (engine.backend) { await engine.route(prefs); setMeasuredLatency(engine.latency); }
  if (("decks" in changes || "waves" in changes) && mode.perform) view.render(prefs.decks);
});
engine.on((kind, msg) => { if (kind === "error") toast(msg, 6000); });
setStatusSource(() => engine.backend?.status());

// keyboard for the focused deck; returns true when the key was used
export function key(e) {
  const d = engine.decks.length ? engine.deck(view.focus) : null;
  if (!d) return false;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (/^[1-8]$/.test(k)) { d.hotCue(+k, e.shiftKey); return true; }
  switch (k) {
    case " ": d.togglePlay(); return true;
    case "c": if (!e.repeat) d.cueDown(); return true;
    case "l": d.loopToggle(); return true;
    case "[": d.loopResize(0.5); return true;
    case "]": d.loopResize(2); return true;
    case "ArrowLeft": d.beatJump(-d.loopBeats); return true;
    case "ArrowRight": d.beatJump(d.loopBeats); return true;
    case "s": d.setSync(!d.sync); return true;
    case "Tab": { const ids = DECK_LETTERS.slice(0, prefs.decks); view.setFocus(ids[(ids.indexOf(view.focus) + 1) % ids.length]); return true; }
    default: return false;
  }
}
export function keyUp(e) { if (e.key.toLowerCase() === "c" && engine.decks.length) engine.deck(view.focus).cueUp(); }
