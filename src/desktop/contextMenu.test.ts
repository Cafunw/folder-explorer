import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: { itemContextMenu: vi.fn().mockResolvedValue(undefined), classicMenu: vi.fn().mockResolvedValue(null) },
  state: {
    selection: new Set<string>(),
    itemMap: new Map<string, { id: string; path: string; parsingName: string }>(),
    layout: { folders: {}, headings: {} },
  },
}));

vi.mock("../api", () => ({ api: mocks.api }));
vi.mock("./Jiggle", () => ({ enterJiggle: vi.fn() }));
vi.mock("./live", () => ({ liveItem: vi.fn() }));
vi.mock("./locks", () => ({ lockedOnPath: vi.fn(), requestUnlock: vi.fn() }));
vi.mock("./registry", () => ({ rectOf: vi.fn() }));
vi.mock("./sounds", () => ({ playSound: vi.fn() }));
vi.mock("./store", () => ({
  useDesk: { getState: () => mocks.state, setState: (next: object) => Object.assign(mocks.state, next) },
  baseName: vi.fn(), commit: vi.fn(), displayName: vi.fn(), expectNewItem: vi.fn(),
  recordOpen: vi.fn(), redo: vi.fn(), refreshItems: vi.fn(), saveSettings: vi.fn(),
  toast: vi.fn(), undo: vi.fn(),
}));

import { showItemMenu } from "./actions";

describe("desktop icon context menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.selection = new Set();
    mocks.state.itemMap = new Map([
      ["a", { id: "a", path: "C:\\Users\\u\\Desktop\\a.txt", parsingName: "C:\\Users\\u\\Desktop\\a.txt" }],
      ["b", { id: "b", path: "C:\\Users\\Public\\Desktop\\b.lnk", parsingName: "C:\\Users\\Public\\Desktop\\b.lnk" }],
    ]);
  });

  it("opens Explorer's default menu instead of directly opening Show more options", async () => {
    await showItemMenu("a", [-1200, 200]);
    expect(mocks.api.itemContextMenu).toHaveBeenCalledWith(["C:\\Users\\u\\Desktop\\a.txt"], [-1200, 200]);
    expect(mocks.api.classicMenu).not.toHaveBeenCalled();
  });

  it("preserves multi-selection across user and public desktop items with clicked item first", async () => {
    mocks.state.selection = new Set(["a", "b"]);
    await showItemMenu("b");
    expect(mocks.api.itemContextMenu).toHaveBeenCalledWith([
      "C:\\Users\\Public\\Desktop\\b.lnk", "C:\\Users\\u\\Desktop\\a.txt",
    ], null);
    expect(mocks.api.classicMenu).not.toHaveBeenCalled();
  });
});
