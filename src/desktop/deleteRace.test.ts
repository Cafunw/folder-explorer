// Deleting waits for the Recycle Bin; a move made meanwhile must survive it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyLayout } from "../layout/model";
import type { Layout } from "../types";

const mocks = vi.hoisted(() => ({
  api: { recycle: vi.fn() },
  commit: vi.fn(),
  state: {} as Record<string, unknown>,
}));

vi.mock("../api", () => ({ api: mocks.api }));
vi.mock("./Jiggle", () => ({ enterJiggle: vi.fn() }));
vi.mock("./live", () => ({ liveItem: vi.fn() }));
vi.mock("./locks", () => ({ lockedOnPath: vi.fn(), requestUnlock: vi.fn() }));
vi.mock("./registry", () => ({ rectOf: vi.fn() }));
vi.mock("./sounds", () => ({ playSound: vi.fn() }));
vi.mock("./store", () => ({
  useDesk: { getState: () => mocks.state, setState: (next: object) => Object.assign(mocks.state, next) },
  baseName: vi.fn(), commit: mocks.commit, displayName: vi.fn(), expectNewItem: vi.fn(),
  recordOpen: vi.fn(), redo: vi.fn(), refreshItems: vi.fn(), saveSettings: vi.fn(),
  toast: vi.fn(), undo: vi.fn(),
}));

import { deleteIds } from "./actions";

function layoutWithB(c: number, r: number): Layout {
  const l = emptyLayout();
  l.placements.a = { m: "M1", p: 0, c: 0, r: 0 };
  l.placements.b = { m: "M1", p: 0, c, r };
  return l;
}

describe("deleting while something else changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.itemMap = new Map([
      ["a", { id: "a", kind: "file", path: "C:\\Users\\u\\Desktop\\a.txt" }],
      ["b", { id: "b", kind: "file", path: "C:\\Users\\u\\Desktop\\b.txt" }],
    ]);
    mocks.state.grids = {};
  });

  it("keeps a move made while the Recycle Bin was busy", async () => {
    let finish!: () => void;
    mocks.api.recycle.mockReturnValue(new Promise<void>((done) => (finish = done)));
    mocks.state.layout = layoutWithB(0, 1);
    mocks.state.selection = new Set(["a"]);

    const deleting = deleteIds(["a"]);
    // meanwhile the user moves b and selects it
    mocks.state.layout = layoutWithB(5, 5);
    mocks.state.selection = new Set(["b"]);
    finish();
    await deleting;

    const committed = mocks.commit.mock.calls[0][0] as Layout;
    expect(committed.placements.a).toBeUndefined();
    expect(committed.placements.b).toMatchObject({ c: 5, r: 5 });
    expect(mocks.state.selection).toEqual(new Set(["b"]));
  });
});
