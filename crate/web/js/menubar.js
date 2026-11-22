// The menu bar across every tab, as a Windows program has one: File, Edit, Create, View, Play,
// Library and Help. What doesn't apply on the tab you're on is greyed, not hidden, so nothing
// moves. Alt and a menu's letter opens it; once a menu is open, hovering another switches to it
// and the arrow keys walk across them. Every item calls the same thing its shortcut does.
import { h, mount } from "./core/dom.js";
import { api, toast } from "./core/api.js";
import { menu } from "./core/ui.js";
import { S } from "./state.js";
import { mode } from "./mode.js";

// `A` holds what the menus call, passed in by app.js: setMode, and each tab's commands
export function initMenubar(el, A) {
  const prod = () => mode.produce, lib = () => !mode.perform && !mode.produce, notProd = () => !mode.produce;
  const P = A.produce;
  // each item: [label, run, {kbd, when, checked}]; `when` false greys it out
  const MENUS = [
    ["File", () => [
      item("New set", P.newSet, { when: prod }),
      "-",
      item("Add music folder…", A.addFolder),
      item("Import from rekordbox…", A.importRekordbox),
      item("Import rekordbox XML…", A.importXml),
      item("Find moved files…", A.findMoved),
      "-",
      item("Export to USB…", A.openExport),
      "-",
      item("Settings…", A.openSettings),
      "-",
      item("Exit", quit),
    ]],
    ["Edit", () => [
      item("Undo", () => (prod() ? P.undo() : A.undo()), { kbd: "Ctrl+Z" }),
      item("Redo", P.redo, { kbd: "Ctrl+Y", when: prod }),
      "-",
      item("Duplicate", P.duplicate, { kbd: "Ctrl+D", when: prod }),
      item("Delete", P.remove, { kbd: "Del", when: prod }),
      "-",
      item("Select all", A.selectAll, { kbd: "Ctrl+A", when: notProd }),
      item("Find", () => (prod() ? P.find() : A.find()), { kbd: "Ctrl+F" }),
    ]],
    ["Create", () => [
      item("Audio track", P.audioTrack, { kbd: "Ctrl+T", when: prod }),
      item("MIDI track", P.midiTrack, { kbd: "Ctrl+Shift+T", when: prod }),
      item("Return track", P.returnTrack, { kbd: "Ctrl+Alt+T", when: prod }),
      item("Group selected tracks", P.group, { kbd: "Ctrl+G", when: prod }),
      item("Ungroup", P.ungroup, { kbd: "Ctrl+Shift+G", when: prod }),
      item("Scene", P.scene, { when: prod }),
      "-",
      item("Playlist", () => A.newNode(false), { kbd: "Ctrl+N", when: notProd }),
      item("Playlist folder", () => A.newNode(true), { when: notProd }),
      item("Saved search", A.saveSearch, { when: lib }),
    ]],
    ["View", () => [
      item("Library", () => A.setMode("library"), { kbd: "F5", checked: lib() }),
      item("Perform", () => A.setMode("perform"), { kbd: "F6", checked: mode.perform }),
      item("Produce", () => A.setMode("produce"), { kbd: "F7", checked: mode.produce }),
      "-",
      item("Clip view", () => P.view("clips"), { kbd: "Tab", when: prod, checked: prod() && P.viewing() === "clips" }),
      item("Timeline", () => P.view("timeline"), { kbd: "Tab", when: prod, checked: prod() && P.viewing() === "timeline" }),
      "-",
      item("Full screen", fullscreen, { kbd: "F11" }),
    ]],
    ["Play", () => [
      item(prod() ? "Play timeline" : "Play / pause", () => (prod() ? P.play() : A.playPreview()), { kbd: "Space", when: () => !mode.perform }),
      item("Stop everything", P.stop, { when: prod }),
      "-",
      item("Follow the decks' tempo", P.follow, { when: prod, checked: prod() && P.following() }),
    ]],
    ["Library", () => [
      item("Duplicates", () => A.go({ kind: "dupes" }), { when: notProd }),
      item("Recently played", () => A.go({ kind: "recent" }), { when: notProd }),
      item("Not played lately", () => A.go({ kind: "quiet" }), { when: notProd }),
    ]],
    ["Help", () => [
      item("Keyboard shortcuts", A.showKeys, { kbd: "?" }),
      "-",
      item("Check for updates", async () => toast(await A.checkUpdates())),
      item("Install an update from a file…", A.updateFromFile),
      item("Report a problem…", () => A.reportProblem()),
      "-",
      item("About Crate", () => toast(`Crate ${S.state?.version || ""}`)),
    ]],
  ];

  let open = null, closed = { name: null, at: 0 };
  const buttons = MENUS.map(([name, items], i) => {
    const b = h("button", { class: "mb-item", "aria-haspopup": "menu", onpointerdown: (e) => {
      if (e.button) return;
      e.preventDefault();
      if (closed.name === name && performance.now() - closed.at < 250) return;  // a click on the open menu's name closes it
      show(i);
    }, onpointerenter: () => { if (open !== null && open !== i) show(i); } },
    h("u", {}, name[0]), name.slice(1));
    return b;
  });
  function show(i) {
    const [name, items] = MENUS[i], r = buttons[i].getBoundingClientRect();
    open = i; buttons.forEach((b, k) => b.classList.toggle("on", k === i));
    menu({ clientX: r.left, clientY: r.bottom + 1 }, items(), {
      nav: (d) => show((i + d + MENUS.length) % MENUS.length),
      onClose: () => { if (open === i) { open = null; buttons[i].classList.remove("on"); closed = { name, at: performance.now() }; } },
    });
  }
  mount(el, ...buttons);
  // Alt + a menu's first letter opens it; holding Alt underlines the letters
  addEventListener("keyup", (e) => { if (e.key === "Alt") el.classList.remove("keys"); });
  addEventListener("blur", () => el.classList.remove("keys"));
  addEventListener("keydown", (e) => {
    if (e.key === "Alt") el.classList.add("keys");
    if (!e.altKey || e.ctrlKey || e.metaKey || e.key.length !== 1) return;
    const i = MENUS.findIndex(([name]) => name[0].toLowerCase() === e.key.toLowerCase());
    if (i >= 0) { e.preventDefault(); show(i); }
  });
}

function item(label, run, { kbd, when, checked } = {}) {
  return { label, kbd, checked, disabled: when ? !when() : false, run: () => Promise.resolve(run()).catch((e) => toast(e.message)) };
}

// the app window's own controls; in a browser tab, the browser's
async function quit() { if (!(await api("quit", {})).window) toast("Crate is running in a browser tab: close the tab to leave it"); }
export async function fullscreen() {
  const r = await api("fullscreen", {});
  if (!r.window) { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); }
}
