// Every keyboard shortcut on one sheet (press ?).
import { h } from "../core/dom.js";
import { sheet } from "../core/ui.js";

const KEYS = [
  ["Everywhere", [["F5 / F6 / F7", "Library, Perform, Produce"], ["Ctrl F", "Search"], ["Ctrl N", "New playlist"], ["Ctrl Z", "Undo the last library edit"], ["?", "This list"]]],
  ["Track list", [["↑ ↓", "Move the selection"], ["Enter", "Load into the preview deck"], ["Delete", "Remove from playlist or library"], ["Ctrl A", "Select all"],
    ["Type a title", "Jump to it, once you've clicked the list"], ["Drag a column heading", "Reorder columns"]]],
  ["Preview deck", [["Space", "Play and pause"], ["1 to 8", "Hot cues A to H (Shift sets one)"], ["M", "Memory cue"], ["Q", "Quantise"], ["D", "Make this beat the downbeat"],
    ["[ ]", "Nudge the grid 2 ms ({ } for 10 ms)"], ["← →", "Back or forward a beat (Shift: 16 beats)"]]],
  ["Produce", [["Tab", "Clips or Timeline"], ["Space", "Play or stop"], ["Ctrl Z / Ctrl Shift Z", "Undo and redo"], ["Ctrl D", "Duplicate the clip"], ["Delete", "Remove the clip"]]],
];

export function showKeys() {
  sheet({ title: "Keyboard shortcuts", width: 560,
    body: KEYS.map(([area, keys]) => [h("div", { class: "glabel" }, area),
      h("div", { class: "group keys" }, ...keys.map(([k, what]) => h("div", { class: "gr" }, h("div", { class: "lbl" }, what), h("span", { class: "kbd" }, k))))]).flat(),
    actions: [{ label: "Done", default: true, result: true }] });
}
