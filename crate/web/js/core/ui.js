// Interface primitives: sheets (in place of browser dialogs), menus, settings rows,
// splitters, and the status-bar help that explains whatever you hover.
import { $, h, icon } from "./dom.js";
import { pref, setPref } from "./prefs.js";

export function sheet({ title, text, body, actions, width }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const close = (v) => { scrim.remove(); removeEventListener("keydown", onKey, true); prev?.focus?.(); resolve(v); };
    const run = async (a) => { const v = a.value ? await a.value() : a.result; if (v !== undefined) close(v); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close(null); }
      if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") { const d = actions.find((a) => a.default); if (d) { e.preventDefault(); e.stopPropagation(); run(d); } }
    };
    const scrim = h("div", { class: "scrim", onpointerdown: (e) => e.target === scrim && close(null) },
      h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title, style: width ? `width:min(${width}px,94vw)` : "" },
        h("header", {}, h("h1", {}, title), text ? h("p", {}, text) : null),
        body ? h("div", { class: "body" }, body) : null,
        h("footer", {}, ...actions.map((a) => (a.left ? h("span", { class: "left" }, a.left)
          : h("button", { class: "btn" + (a.default ? " primary" : "") + (a.danger ? " danger" : ""), onclick: () => run(a) }, a.label))))));
    document.body.append(scrim); addEventListener("keydown", onKey, true);
    setTimeout(() => (scrim.querySelector("input,select,textarea") || scrim.querySelector(".btn.primary"))?.focus(), 30);
  });
}

export const confirmSheet = (title, text, label = "OK", danger = false) =>
  sheet({ title, text, actions: [{ label: "Cancel", result: false }, { label, result: true, default: true, danger }] });

export function askSheet(title, value = "", text = "") {
  const input = h("input", { class: "field", value, style: "width:100%" });
  setTimeout(() => input.select(), 40);
  return sheet({ title, text, body: input, actions: [{ label: "Cancel", result: null }, { label: "OK", default: true, value: () => input.value.trim() || null }] });
}

export const isSheetOpen = () => !!$(".scrim");

// context menu at the pointer; items are {label, icon, kbd, danger, run}, "-" or null
export function menu(e, items) {
  $(".menu")?.remove();
  const m = h("div", { class: "menu", role: "menu", style: `left:${e.clientX}px;top:${e.clientY}px` },
    ...items.filter(Boolean).map((it) => (it === "-" ? h("hr") : h("div", { role: "menuitem", class: it.danger ? "danger" : "", onclick: () => { m.remove(); it.run(); } },
      it.icon ? icon(it.icon, "i sm") : h("span", { style: "width:14px" }), it.label, it.kbd ? h("span", { class: "kbd" }, it.kbd) : null))));
  document.body.append(m);
  const r = m.getBoundingClientRect();
  if (r.bottom > innerHeight) m.style.top = `${innerHeight - r.height - 6}px`;
  if (r.right > innerWidth) m.style.left = `${innerWidth - r.width - 6}px`;
  setTimeout(() => addEventListener("pointerdown", function off(ev) { if (!m.contains(ev.target)) { m.remove(); removeEventListener("pointerdown", off); } }), 0);
}

// settings rows
export const gr = (title, hint, control) => h("div", { class: "gr" }, h("div", { class: "lbl" }, title, hint ? h("small", {}, hint) : null), control);
export const sw = (id, checked, onchange) => h("input", { type: "checkbox", class: "switch", id, checked, onchange });

// A drag handle that resizes the panel below it by setting a CSS variable on <html>.
// The size is remembered; double-click restores the default.
export function splitter(el, { cssVar, store, target, min, reserve, onResize }) {
  const root = document.documentElement;
  const set = (px) => root.style.setProperty(cssVar, `${Math.round(Math.max(min, Math.min(innerHeight - reserve, px)))}px`);
  const saved = +pref(store, 0); if (saved) set(saved);
  el.addEventListener("pointerdown", (e) => {
    el.setPointerCapture(e.pointerId); el.classList.add("drag");
    const y0 = e.clientY, h0 = target().offsetHeight;
    const move = (ev) => { set(h0 - (ev.clientY - y0)); onResize(); };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.classList.remove("drag"); setPref(store, target().offsetHeight); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
  });
  el.addEventListener("dblclick", () => { setPref(store, null); root.style.removeProperty(cssVar); onResize(); });
}

// Info View: whatever is under the pointer explains itself in the status bar
export function initHelp() {
  const info = $("#info"), idle = "Hover anything to see what it does.";
  info.textContent = idle;
  let last = null;
  addEventListener("pointerover", (e) => {
    const el = e.target.closest("[data-help]"), html = el ? el.dataset.help : idle;
    if (html !== last) { last = html; info.innerHTML = html; }
  });
}
