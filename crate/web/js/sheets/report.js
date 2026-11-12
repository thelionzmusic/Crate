// Problem reports: page errors go to crate.log as they happen; a report opens a GitHub issue
// with the version, system and the end of the log filled in, for the person to read and send.
import { h } from "../core/dom.js";
import { api, safe } from "../core/api.js";
import { sheet } from "../core/ui.js";

let sent = 0;
const log = (message, where, stack) => {
  if (sent++ > 20) return;  // a loop of the same error shouldn't flood the log
  fetch("/api/jserror", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, where, stack }) }).catch(() => {});
};
export function catchErrors() {
  addEventListener("error", (e) => log(e.message, `${e.filename}:${e.lineno}`, e.error?.stack));
  addEventListener("unhandledrejection", (e) => log(String(e.reason?.message || e.reason), "promise", e.reason?.stack));
}

export const reportProblem = safe(async (crashed = false) => {
  const r = await api("report"), note = h("textarea", { class: "field", rows: 3, style: "width:100%", placeholder: "What were you doing when it happened?" });
  const go = await sheet({ title: crashed ? "Crate closed unexpectedly" : "Report a problem", width: 560,
    text: `${crashed ? "Last time Crate didn't close properly. " : ""}Sending a report opens a GitHub issue with your note, Crate ${r.version} on ${r.system}, and the end of Crate's log, so you can read it first. Your user name is taken out of file paths.`,
    body: note, actions: [{ label: "Not now", result: false }, { label: "Write the report", default: true, value: () => true }] });
  if (go) await api("report", { note: note.value });
});
