// A move into a real folder records only what Windows really moved, under the name it got.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n";
import { emptyLayout } from "../layout/model";
import type { Layout } from "../types";
import type { FileOp } from "./store";

const mocks = vi.hoisted(() => ({
  api: { moveIntoFolder: vi.fn() },
  commit: vi.fn(),
  toast: vi.fn(),
  state: {} as Record<string, unknown>,
}));

vi.mock("../api", () => ({ api: mocks.api }));
vi.mock("./actions", () => ({
  closePanel: vi.fn(), currentPanelFolder: vi.fn(), deleteIds: vi.fn(), openFolder: vi.fn(),
  panelBack: vi.fn(), panelEnter: vi.fn(),
}));
vi.mock("./interaction", () => ({
  dropKindOf: vi.fn(), dropOnApp: vi.fn(), notePlainClick: vi.fn(), realDirOf: vi.fn(),
  resetPlainClick: vi.fn(), warmDropKinds: vi.fn(),
}));
vi.mock("./Jiggle", () => ({ jiggling: vi.fn(), takeLongPress: vi.fn() }));
vi.mock("./locks", () => ({ lockedOnPath: vi.fn() }));
vi.mock("./registry", () => ({ fenceBodies: new Map(), flyFrom: vi.fn(), iconEls: new Map(), panelGrid: {} }));
vi.mock("./sounds", () => ({ playSound: vi.fn() }));
vi.mock("./store", () => ({
  useDesk: { getState: () => mocks.state, setState: (next: object) => Object.assign(mocks.state, next) },
  commit: mocks.commit, refreshItems: vi.fn(), replaceLayout: vi.fn(), setPage: vi.fn(), toast: mocks.toast,
}));

import { moveToDir } from "./dnd";

describe("moving desktop items into a real folder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.itemMap = new Map([
      ["a", { id: "a", kind: "file", path: "C:\\Users\\u\\Desktop\\a.txt" }],
      ["b", { id: "b", kind: "file", path: "C:\\Users\\u\\Desktop\\b.txt" }],
    ]);
    const l = emptyLayout();
    l.placements.a = { m: "M1", p: 0, c: 0, r: 0 };
    l.placements.b = { m: "M1", p: 0, c: 0, r: 1 };
    mocks.state.layout = l;
  });

  it("records only the moved file, under the name Windows gave it", async () => {
    // a: "Keep both" renamed it; b: "Skip" left it on the desktop
    mocks.api.moveIntoFolder.mockResolvedValue(["D:\\Docs\\a (2).txt", null]);
    expect(await moveToDir(["a", "b"], "D:\\Docs")).toBe(true);

    const [layout, op] = mocks.commit.mock.calls[0] as [Layout, FileOp];
    expect(op).toEqual({ kind: "move", moves: [{ from: "C:\\Users\\u\\Desktop\\a.txt", to: "D:\\Docs\\a (2).txt" }] });
    expect(layout.placements.a).toBeUndefined();
    expect(layout.placements.b).toEqual({ m: "M1", p: 0, c: 0, r: 1 });
    expect(mocks.toast).toHaveBeenCalledWith(t.moved);
  });

  it("fails without an undo step when nothing moved", async () => {
    mocks.api.moveIntoFolder.mockResolvedValue([null, null]);
    expect(await moveToDir(["a", "b"], "D:\\Docs")).toBe(false);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(t.operationFailed);
  });
});
