// Undo for library edits (Ctrl+Z): each change records how to put things back.
import { toast } from "./api.js";

const steps = [], MAX = 50;

export function did(label, back) { steps.push({ label, back }); if (steps.length > MAX) steps.shift(); }

export async function undo() {
  const s = steps.pop();
  if (!s) return toast("Nothing to undo");
  try { await s.back(); toast(`Undid: ${s.label}`); } catch (e) { toast(`Couldn't undo ${s.label}: ${e.message}`); }
}
