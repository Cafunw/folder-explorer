// Undo / redo wait for the Recycle Bin; what happens meanwhile, and what a toast's "Geri al" undoes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // the bits of `window` store.ts touches, in a node test run
  (globalThis as { window?: unknown }).window = {
    setTimeout, clearTimeout, matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  };
  const ok = () => Promise.resolve(undefined);
  return {
    api: {
      listDesktopItems: vi.fn(() => Promise.resolve([])), restoreFromRecycle: vi.fn(ok),
      saveLayout: vi.fn(ok), saveSettings: vi.fn(ok), mirrorSelection: vi.fn(ok), raiseDesktop: vi.fn(ok),
    },
  };
});
vi.mock("../api", () => ({ api: mocks.api }));
vi.mock("./sounds", () => ({ playSound: vi.fn() }));

import { t } from "../i18n";
import { emptyLayout } from "../layout/model";
import { DEFAULT_SETTINGS } from "../settings";
import type { Layout } from "../types";

type Store = typeof import("./store");
let s: Store; // a fresh module per test: the undo / redo stacks live in it

const layout = (b: [number, number], withA = true): Layout => {
  const l = emptyLayout();
  if (withA) l.placements.a = { m: "M1", p: 0, c: 0, r: 0 };
  l.placements.b = { m: "M1", p: 0, c: b[0], r: b[1] };
  return l;
};
const state = () => s.useDesk.getState();
const lastToast = () => state().toasts.at(-1)?.text;

/** Deletes `a` (recorded with its Recycle Bin operation) and returns that history entry. */
const deleteA = () => s.commit(layout([0, 1], false), { kind: "recycle", paths: ["C:\\a.txt"] });
/** Holds the next restore from the Recycle Bin until `release` / `fail` is called. */
function holdRestore() {
  const h = { release: () => {}, fail: () => {} };
  mocks.api.restoreFromRecycle.mockReturnValueOnce(
    new Promise<undefined>((done, no) => {
      h.release = () => done(undefined);
      h.fail = () => no(new Error("busy"));
    }),
  );
  return h;
}

describe("undo history", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    s = await import("./store");
    s.useDesk.setState({ settings: DEFAULT_SETTINGS, grids: {}, layout: layout([0, 1]), toasts: [] });
  });

  it("keeps a move made while an undo waits for the Recycle Bin, and the history in step", async () => {
    deleteA();
    const restore = holdRestore();
    const undoing = s.undo();
    s.commit(layout([5, 5], false)); // meanwhile the user drags b
    restore.release();
    await undoing;

    expect(mocks.api.restoreFromRecycle).toHaveBeenCalledWith(["C:\\a.txt"]);
    expect(state().layout.placements.b).toMatchObject({ c: 5, r: 5 }); // the drag stays
    expect(state().canRedo).toBe(false); // the drag is newer than the undo
    await s.undo(); // undoes the drag, not the delete again
    expect(state().layout.placements.b).toMatchObject({ c: 0, r: 1 });
    expect(mocks.api.restoreFromRecycle).toHaveBeenCalledTimes(1);
    expect(state().canUndo).toBe(false);
  });

  it("keeps the entry when restoring fails, so it can be tried again", async () => {
    deleteA();
    const restore = holdRestore();
    const undoing = s.undo();
    restore.fail();
    await undoing;

    expect(lastToast()).toBe(t.operationFailed);
    expect(state().layout.placements.a).toBeUndefined();
    expect(mocks.api.listDesktopItems).toHaveBeenCalled(); // the screen follows the files
    expect(state().canUndo).toBe(true);
    expect(state().canRedo).toBe(false);

    await s.undo();
    expect(state().layout.placements.a).toBeDefined();
    expect(state().canRedo).toBe(true);
  });

  it("a toast's undo only undoes its own entry", async () => {
    const entry = deleteA();
    s.toast("deleted", { label: t.undo, run: () => s.undoEntry(entry) });
    const run = state().toasts.at(-1)!.action!.run;
    s.commit(layout([5, 5], false)); // a drag after the delete

    await run();
    expect(mocks.api.restoreFromRecycle).not.toHaveBeenCalled();
    expect(state().layout.placements.b).toMatchObject({ c: 5, r: 5 });
    expect(lastToast()).toBe(t.undoLaterFirst);

    await s.undo(); // the drag
    await run(); // now the delete is on top
    expect(mocks.api.restoreFromRecycle).toHaveBeenCalledWith(["C:\\a.txt"]);
    expect(state().layout.placements.a).toBeDefined();
  });
});
