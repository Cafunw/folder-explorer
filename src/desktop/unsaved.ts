// Unsaved changes in the customize dialogs: a backdrop click or Esc asks before throwing a draft away.

// object keys sorted, so a look whose keys were reset and set again in another order still matches
const stable = (v: unknown) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x,
  );

/** Whether a dialog's draft differs from what the dialog was opened with. */
export const isDirty = (initial: unknown, draft: unknown) => stable(initial) !== stable(draft);

/** "request" = backdrop click / Esc; the rest are the inline bar's Kaydet / Kaydetme / Vazgeç. */
export type CloseEvent = "request" | "save" | "discard" | "stay";

/** What the dialog does: close, ask (show the bar), save (which closes), or stay open and hide the bar. */
export function closeStep(dirty: boolean, asking: boolean, ev: CloseEvent): "close" | "ask" | "save" | "stay" {
  if (ev === "save") return "save";
  if (ev === "discard") return "close";
  if (ev === "stay") return "stay";
  if (asking) return "stay"; // Esc while asked = Vazgeç, like Windows' own save prompts
  return dirty ? "ask" : "close";
}
