// What Production needs from the Perform tab: its engine (started if it isn't yet), and the
// lead deck whose tempo and beat the production transport follows.
import { engine } from "../perform/index.js";
import { prefs } from "../perform/settings.js";

export const PERFORM = {
  async engine() { await engine.start(prefs); await engine.backend.resume(); return engine; },
  leader() { return engine.backend ? engine.leader() : null; },
};
