// Edit mode: the × on a real file asks before the Recycle Bin; a group goes at once (undoable);
// the long press only arms when `behavior.longPressEdit` is on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyLayout } from "../layout/model";
import { DEFAULT_SETTINGS, normalizeSettings } from "../settings";

const mocks = vi.hoisted(() => ({
  api: { recycle: vi.fn() },
  commit: vi.fn(),
  state: {} as Record<string, unknown>,
}));

vi.mock("../api", () => ({ api: mocks.api }));
vi.mock("./dnd", () => ({ isDragging: () => false }));
vi.mock("./live", () => ({ liveItem: vi.fn() }));
vi.mock("./locks", () => ({ lockedOnPath: vi.fn(), requestUnlock: vi.fn() }));
vi.mock("./registry", () => ({ rectOf: vi.fn() }));
vi.mock("./sounds", () => ({ playSound: vi.fn() }));
vi.mock("./store", () => ({
  useDesk: { getState: () => mocks.state, setState: (next: object) => Object.assign(mocks.state, next) },
  baseName: vi.fn(), commit: mocks.commit, displayName: vi.fn(), expectNewItem: vi.fn(),
  recordOpen: vi.fn(), redo: vi.fn(), reducedMotion: vi.fn(), refreshItems: vi.fn(), saveSettings: vi.fn(),
  toast: vi.fn(), undo: vi.fn(), undoEntry: vi.fn(), useAnimation: vi.fn(),
}));

import { deleteIds } from "./actions";
import { armLongPress, removeByBadge } from "./Jiggle";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.recycle.mockResolvedValue(undefined);
  const layout = emptyLayout();
  layout.placements.a = { m: "M1", p: 0, c: 0, r: 0 };
  layout.placements["v:g"] = { m: "M1", p: 0, c: 1, r: 0 };
  layout.folders["v:g"] = { id: "v:g", name: "G", color: null, children: [] };
  Object.assign(mocks.state, {
    layout,
    grids: {},
    itemMap: new Map([["a", { id: "a", kind: "file", path: "C:\\Users\\u\\Desktop\\a.txt" }]]),
    selection: new Set(),
    dialog: null,
    settings: DEFAULT_SETTINGS,
  });
});

describe("the edit-mode remove badge", () => {
  it("asks before sending a file to the Recycle Bin", async () => {
    removeByBadge("a");
    expect(mocks.state.dialog).toEqual({ kind: "confirmRecycle", ids: ["a"] });
    expect(mocks.api.recycle).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();

    await deleteIds((mocks.state.dialog as { ids: string[] }).ids); // what the confirm's "Sil" runs
    expect(mocks.api.recycle).toHaveBeenCalledWith(["C:\\Users\\u\\Desktop\\a.txt"]);
  });

  it("dissolves a virtual group without asking", async () => {
    removeByBadge("v:g");
    await vi.waitFor(() => expect(mocks.commit).toHaveBeenCalled());
    expect(mocks.state.dialog).toBeNull();
    expect(mocks.api.recycle).not.toHaveBeenCalled();
    expect(mocks.commit.mock.calls[0][0].folders["v:g"]).toBeUndefined();
  });
});

describe("the long press", () => {
  const press = { button: 0, pointerId: 1, clientX: 0, clientY: 0 } as React.PointerEvent;
  const win = { setTimeout: vi.fn(), clearTimeout: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  beforeEach(() => vi.stubGlobal("window", win));
  afterEach(() => vi.unstubAllGlobals());

  it("arms by default", () => {
    armLongPress(press, "a");
    expect(win.setTimeout).toHaveBeenCalled();
  });

  it("stays on for saved settings without it, and keeps an explicit off", () => {
    expect(normalizeSettings({ behavior: {} }).behavior.longPressEdit).toBe(true);
    expect(normalizeSettings({ behavior: { longPressEdit: false } }).behavior.longPressEdit).toBe(false);
  });

  it("does not arm when the setting is off", () => {
    mocks.state.settings = { ...DEFAULT_SETTINGS, behavior: { ...DEFAULT_SETTINGS.behavior, longPressEdit: false } };
    armLongPress(press, "a");
    expect(win.setTimeout).not.toHaveBeenCalled();
    expect(win.addEventListener).not.toHaveBeenCalled();
  });
});
