import { beforeAll, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  renameItem: vi.fn().mockResolvedValue(""),
  listDesktopItems: vi.fn().mockResolvedValue([]),
  saveLayout: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../api", () => ({ api }));
vi.mock("./sounds", () => ({ playSound: vi.fn() }));

import { recordFileOpOnly, redo, undo } from "./store";

// toasts and saves use window timers; the store's module-level matchMedia check needs window unset at import
beforeAll(() => vi.stubGlobal("window", globalThis));

it("undo/redo of a rename replays the exact recorded file names", async () => {
  recordFileOpOnly({ kind: "rename", from: "C:\\D\\Chrome.lnk", to: "C:\\D\\Browser.lnk" });
  await undo();
  expect(api.renameItem).toHaveBeenLastCalledWith("C:\\D\\Browser.lnk", "Chrome.lnk", true);
  await redo();
  expect(api.renameItem).toHaveBeenLastCalledWith("C:\\D\\Chrome.lnk", "Browser.lnk", true);
  expect(api.renameItem).toHaveBeenCalledTimes(2);
});
