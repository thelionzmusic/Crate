// The two effect units above the decks: on, effect, beat length, dry/wet and two parameters.
// Each unit re-renders itself when its effect changes, so knob labels always match.
import { h } from "../core/dom.js";
import { menu } from "../core/ui.js";
import { BEATS, EFFECTS, FX_ORDER } from "../engine/fx.js";
import { Widgets, knob, pbtn, text } from "./controls.js";

const beatLabel = (b) => (b >= 1 ? String(b) : b === 0.75 ? "3/4" : `1/${Math.round(1 / b)}`);

export class FxUnits {
  constructor(engine) { this.e = engine; this.units = [new Widgets(), new Widgets()]; this.els = []; this.shown = []; }
  // follow the engine, so an effect changed from anywhere (menu, hardware) redraws its unit
  sync() { this.units.forEach((W, i) => { if (this.els[i] && this.shown[i] !== this.e.fx[i].type) this.rerender(i); W.sync(); }); }

  render() {
    this.els = [0, 1].map((i) => this.unit(i));
    return h("section", { class: "fxbar" }, ...this.els);
  }

  unit(i) {
    const e = this.e, u = e.fx[i], def = EFFECTS[u.type], W = this.units[i];
    W.clear(); this.shown[i] = u.type;
    const set = (k) => (v) => e.setFx(i, { [k]: v });
    const pick = (ev) => menu(ev, FX_ORDER.map((k) => ({ label: EFFECTS[k].label, icon: k === u.type ? "i-chev" : null, run: () => e.setFx(i, { type: k }) })));
    const step = (dir) => () => { const k = BEATS.indexOf(u.beats); e.setFx(i, { beats: BEATS[Math.max(0, Math.min(BEATS.length - 1, k + dir))] }); };
    const el = h("div", { class: "fxunit", style: `--h:${i ? "#64d2ff" : "#ff9f0a"}` },
      h("span", { class: "fxtag" }, `FX ${i + 1}`),
      pbtn(W, "ON", () => e.setFx(i, { on: !u.on }), { cls: "fxon", on: () => u.on, help: `<b>FX ${i + 1}</b>  Switch the effect on for the decks assigned to this unit` }),
      h("button", { class: "fxpick", onclick: pick, "data-help": "<b>Effect</b>  Choose what this unit does" }, def.label, h("span", { class: "caret" }, "▾")),
      def.beats != null
        ? h("div", { class: "fxbeats", "data-help": "<b>Length</b>  In beats, locked to the track's tempo" },
          pbtn(W, "◀", step(-1), { cls: "sq" }), text(W, () => beatLabel(u.beats), "fxlen"), pbtn(W, "▶", step(1), { cls: "sq" }))
        : h("div", { class: "fxbeats blank" }),
      h("div", { class: "fxknobs" },
        knob(W, "DRY/WET", () => u.mix, set("mix"), { bipolar: false, size: 30, def: 0.5, help: def.kind === "send" ? "How loud the effect is. The dry signal stays full" : "Blend from dry to fully effected" }),
        knob(W, def.p1.toUpperCase(), () => u.p1, set("p1"), { bipolar: false, size: 30, help: def.p1 }),
        knob(W, def.p2.toUpperCase(), () => u.p2, set("p2"), { bipolar: false, size: 30, help: def.p2 })));
    return el;
  }
  rerender(i) { const fresh = this.unit(i); this.els[i].replaceWith(fresh); this.els[i] = fresh; }

  // the FX 1 / FX 2 buttons for a mixer channel, placed in the strip's button row
  assign(W, id) {
    const e = this.e;
    return [0, 1].map((i) => pbtn(W, `FX${i + 1}`, () => e.assignFx(i, id, !e.fx[i].decks.has(id)),
      { cls: i ? "fx2" : "fx1", on: () => e.fx[i].decks.has(id), help: `<b>FX ${i + 1}</b>  Send this deck through effect unit ${i + 1}` }));
  }
}
