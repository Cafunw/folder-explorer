import { describe, expect, it } from "vitest";
import { closeStep, isDirty } from "./unsaved";

describe("unsaved changes in the customize dialogs", () => {
  const opened = { name: "Oyunlar", color: null, look: { opacity: 0.5, blur: 8 }, kinds: { kind: "group", rule: { all: true, rows: [] } } };

  it("an untouched draft is clean, whatever order its look keys ended up in", () => {
    expect(isDirty(opened, structuredClone(opened))).toBe(false);
    expect(isDirty(opened, { ...opened, look: { blur: 8, opacity: 0.5 } })).toBe(false);
  });

  it("any edit makes it dirty", () => {
    expect(isDirty(opened, { ...opened, name: "Oyun" })).toBe(true);
    expect(isDirty(opened, { ...opened, color: "#ff3b30" })).toBe(true);
    expect(isDirty(opened, { ...opened, look: { opacity: 0.5 } })).toBe(true);
    expect(isDirty(opened, { ...opened, kinds: { kind: "smart", rule: { all: true, rows: [] } } })).toBe(true);
  });

  it("backdrop / Esc closes a clean dialog and asks on a dirty one", () => {
    expect(closeStep(false, false, "request")).toBe("close");
    expect(closeStep(true, false, "request")).toBe("ask");
    expect(closeStep(true, true, "request")).toBe("stay"); // Esc again = Vazgeç
  });

  it("the bar: Kaydet saves, Kaydetme closes without saving, Vazgeç keeps editing", () => {
    expect(closeStep(true, true, "save")).toBe("save");
    expect(closeStep(true, true, "discard")).toBe("close");
    expect(closeStep(true, true, "stay")).toBe("stay");
  });
});
