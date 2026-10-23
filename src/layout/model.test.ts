import { describe, expect, it } from "vitest";
import type { DesktopItem, Environment, Layout } from "../types";
import { DEFAULT_SETTINGS } from "../settings";
import { computeGrids, placementKey } from "./grid";
import {
  autoArrange,
  createFolderAt,
  dissolveFolder,
  emptyLayout,
  forgetHomes,
  importWindowsLayout,
  isInside,
  mergeIntoNewFolder,
  moveIntoFolder,
  moveToCell,
  moveToDesktop,
  normalizeLayout,
  normalizeLook,
  reconcile,
  setFolderLook,
  remapIds,
  clone,
} from "./model";

const env: Environment = {
  monitors: [
    {
      id: "M1",
      primary: true,
      bounds: { x: 0, y: 0, width: 1000, height: 640 },
      work: { x: 0, y: 0, width: 1000, height: 600 },
      scale: 1,
    },
  ],
  windowOrigin: { x: 0, y: 0 },
  scaleFactor: 1,
  desktopDir: "C:\\Users\\u\\Desktop",
  publicDesktopDir: "C:\\Users\\Public\\Desktop",
  isDev: true,
};
const grids = computeGrids(env, DEFAULT_SETTINGS);
const g = grids.M1;

const item = (name: string): DesktopItem => ({
  id: `c:\\users\\u\\desktop\\${name.toLowerCase()}`,
  kind: "file",
  path: `C:\\Users\\u\\Desktop\\${name}`,
  parsingName: `C:\\Users\\u\\Desktop\\${name}`,
  name,
  ext: ".lnk",
  isShortcut: true,
  isPublic: false,
  modified: 0,
  size: 0,
  iconVersion: "1",
});

const A = item("A.lnk");
const B = item("B.lnk");
const C = item("C.lnk");
const D = item("D.lnk");
const items = [A, B, C, D];

function allPlacedOnce(l: Layout, ids: string[]) {
  const seen = new Map<string, number>();
  for (const id of Object.keys(l.placements)) seen.set(id, (seen.get(id) ?? 0) + 1);
  for (const f of Object.values(l.folders)) for (const c of f.children) seen.set(c, (seen.get(c) ?? 0) + 1);
  for (const id of ids) expect(seen.get(id), id).toBe(1);
  const cells = Object.values(l.placements).map(placementKey);
  expect(new Set(cells).size).toBe(cells.length);
}

describe("grid", () => {
  it("fits cells into the work area", () => {
    expect(g.cols).toBe(Math.floor((1000 - 6) / DEFAULT_SETTINGS.grid.cellWidth));
    expect(g.rows).toBeGreaterThan(3);
  });
});

describe("reconcile", () => {
  it("places new items column-major from the top-left", () => {
    const l = reconcile(emptyLayout(), items, grids);
    expect(l.placements[A.id]).toEqual({ m: "M1", p: 0, c: 0, r: 0 });
    expect(l.placements[B.id]).toEqual({ m: "M1", p: 0, c: 0, r: 1 });
    allPlacedOnce(l, items.map((i) => i.id));
  });

  it("repairs collisions and out-of-grid cells", () => {
    const l0 = emptyLayout();
    l0.placements[A.id] = { m: "M1", p: 0, c: 2, r: 2 };
    l0.placements[B.id] = { m: "M1", p: 0, c: 2, r: 2 };
    l0.placements[C.id] = { m: "M1", p: 0, c: 99, r: 99 };
    l0.placements[D.id] = { m: "GONE", p: 0, c: 0, r: 0 };
    const l = reconcile(l0, items, grids);
    allPlacedOnce(l, items.map((i) => i.id));
    for (const pl of Object.values(l.placements)) {
      expect(pl.m).toBe("M1");
      expect(pl.c).toBeLessThan(g.cols);
      expect(pl.r).toBeLessThan(g.rows);
    }
  });

  it("remembers where a vanished file was and restores it", () => {
    let l = reconcile(emptyLayout(), items, grids);
    l = moveToCell(l, grids, [C.id], C.id, { m: "M1", p: 0, c: 4, r: 3 });
    const gone = reconcile(l, [A, B, D], grids);
    expect(gone.placements[C.id]).toBeUndefined();
    expect(gone.remembered[C.id]?.placement).toEqual({ m: "M1", p: 0, c: 4, r: 3 });
    const back = reconcile(gone, items, grids);
    expect(back.placements[C.id]).toEqual({ m: "M1", p: 0, c: 4, r: 3 });
    expect(back.remembered[C.id]).toBeUndefined();
  });

  it("remembers folder membership too", () => {
    let l = reconcile(emptyLayout(), items, grids);
    const r = mergeIntoNewFolder(l, A.id, [B.id, C.id], "F", null)!;
    l = r.layout;
    const gone = reconcile(l, [A, C, D], grids);
    expect(gone.folders[r.folderId].children).toEqual([A.id, C.id]);
    const back = reconcile(gone, items, grids);
    expect(back.folders[r.folderId].children).toEqual([A.id, B.id, C.id]);
  });

  it("breaks folder cycles and places orphans", () => {
    const l0 = emptyLayout();
    l0.folders["v:1"] = { id: "v:1", name: "1", color: null, children: ["v:2", A.id] };
    l0.folders["v:2"] = { id: "v:2", name: "2", color: null, children: ["v:1", B.id] };
    const l = reconcile(l0, items, grids);
    allPlacedOnce(l, [...items.map((i) => i.id), "v:1", "v:2"]);
  });
});

describe("folders", () => {
  const base = () => reconcile(emptyLayout(), items, grids);

  it("merging puts the new folder where the target was", () => {
    const l = base();
    const where = l.placements[B.id];
    const r = mergeIntoNewFolder(l, B.id, [A.id], "Yeni klasör", null)!;
    expect(r.layout.placements[r.folderId]).toEqual(where);
    expect(r.layout.folders[r.folderId].children).toEqual([B.id, A.id]);
    expect(r.layout.placements[A.id]).toBeUndefined();
    allPlacedOnce(r.layout, [...items.map((i) => i.id), r.folderId]);
  });

  it("supports unlimited nesting and refuses cycles", () => {
    let l = base();
    const outer = mergeIntoNewFolder(l, A.id, [B.id], "outer", null)!;
    l = outer.layout;
    const inner = mergeIntoNewFolder(l, B.id, [C.id], "inner", null)!;
    l = inner.layout;
    expect(l.folders[outer.folderId].children).toContain(inner.folderId);
    expect(isInside(l, inner.folderId, outer.folderId)).toBe(true);
    // outer into inner would be a cycle
    expect(moveIntoFolder(l, [outer.folderId], inner.folderId)).toBe(l);
    const deeper = createFolderAt(l, grids, { folderId: inner.folderId }, "deep", null, [D.id]);
    expect(deeper.layout.folders[inner.folderId].children).toContain(deeper.folderId);
    allPlacedOnce(deeper.layout, [...items.map((i) => i.id), outer.folderId, inner.folderId, deeper.folderId]);
  });

  it("reorders inside a folder using the post-removal index", () => {
    let l = base();
    const r = mergeIntoNewFolder(l, A.id, [B.id, C.id, D.id], "F", null)!;
    l = r.layout; // [A, B, C, D]
    l = moveIntoFolder(l, [A.id], r.folderId, 2); // [B, C, A, D]
    expect(l.folders[r.folderId].children).toEqual([B.id, C.id, A.id, D.id]);
  });

  it("dissolving moves children to the folder's place", () => {
    let l = base();
    const r = mergeIntoNewFolder(l, A.id, [B.id], "F", null)!;
    l = dissolveFolder(r.layout, grids, r.folderId);
    expect(l.folders[r.folderId]).toBeUndefined();
    expect(l.placements[A.id]).toEqual({ m: "M1", p: 0, c: 0, r: 0 });
    allPlacedOnce(l, items.map((i) => i.id));
  });

  it("taking items out of a folder puts them back on the desktop", () => {
    let l = base();
    const r = mergeIntoNewFolder(l, A.id, [B.id], "F", null)!;
    l = moveToDesktop(r.layout, grids, [B.id], r.layout.placements[r.folderId]);
    expect(l.folders[r.folderId].children).toEqual([A.id]);
    allPlacedOnce(l, [...items.map((i) => i.id), r.folderId]);
  });
});

describe("moving on the desktop", () => {
  it("swaps with a displaced occupant", () => {
    const l = reconcile(emptyLayout(), items, grids);
    const from = l.placements[A.id];
    const to = l.placements[B.id];
    const n = moveToCell(l, grids, [A.id], A.id, to, { id: B.id, to: from });
    expect(n.placements[A.id]).toEqual(to);
    expect(n.placements[B.id]).toEqual(from);
  });

  it("keeps relative offsets for multi-selection", () => {
    const l = reconcile(emptyLayout(), items, grids); // A r0, B r1
    const n = moveToCell(l, grids, [A.id, B.id], A.id, { m: "M1", p: 0, c: 5, r: 2 });
    expect(n.placements[A.id]).toEqual({ m: "M1", p: 0, c: 5, r: 2 });
    expect(n.placements[B.id]).toEqual({ m: "M1", p: 0, c: 5, r: 3 });
  });

  it("auto-arrange removes gaps", () => {
    let l = reconcile(emptyLayout(), items, grids);
    l = moveToCell(l, grids, [D.id], D.id, { m: "M1", p: 0, c: 6, r: 4 });
    const n = autoArrange(l, grids);
    const cells = Object.values(n.placements).map((p) => `${p.c},${p.r}`).sort();
    expect(cells).toEqual(["0,0", "0,1", "0,2", "0,3"]);
  });

  it("follows renames", () => {
    const l = reconcile(emptyLayout(), items, grids);
    const n = remapIds(l, new Map([[A.id, "c:\\users\\u\\desktop\\z.lnk"]]));
    expect(n.placements["c:\\users\\u\\desktop\\z.lnk"]).toEqual(l.placements[A.id]);
    expect(n.placements[A.id]).toBeUndefined();
  });
});

describe("windows import", () => {
  it("maps Windows icon positions to cells", () => {
    const l = importWindowsLayout(
      emptyLayout(),
      {
        spacing: { x: g.cellW, y: g.cellH },
        items: [
          { id: A.id, x: 2, y: 2 },
          { id: B.id, x: 2 + g.cellW * 3, y: 2 + g.cellH * 2 },
        ],
      },
      env,
      grids,
      items,
    );
    expect(l.placements[A.id]).toEqual({ m: "M1", p: 0, c: 0, r: 0 });
    expect(l.placements[B.id]).toEqual({ m: "M1", p: 0, c: 3, r: 2 });
    expect(l.importedFromWindows).toBe(true);
  });
});

describe("temporary screen changes (games changing resolution, monitor off)", () => {
  // the same monitor at a smaller resolution: fewer columns and rows
  const small: Environment = {
    ...env,
    monitors: [
      {
        ...env.monitors[0],
        bounds: { x: 0, y: 0, width: 400, height: 340 },
        work: { x: 0, y: 0, width: 400, height: 300 },
      },
    ],
  };
  const smallGrids = computeGrids(small, DEFAULT_SETTINGS);
  const otherMonitor: Environment = { ...env, monitors: [{ ...env.monitors[0], id: "M2" }] };
  const otherGrids = computeGrids(otherMonitor, DEFAULT_SETTINGS);

  // A at the far right, B at the bottom, C top-left, D middle
  const spread = () => {
    let l = reconcile(emptyLayout(), items, grids);
    l = moveToCell(l, grids, [A.id], A.id, { m: "M1", p: 0, c: g.cols - 1, r: 0 });
    l = moveToCell(l, grids, [B.id], B.id, { m: "M1", p: 0, c: 2, r: g.rows - 1 });
    l = moveToCell(l, grids, [D.id], D.id, { m: "M1", p: 0, c: 6, r: 3 });
    return l;
  };

  it("puts every icon back exactly where it was when the screen returns", () => {
    const original = spread();
    const shrunk = reconcile(original, items, smallGrids);
    for (const pl of Object.values(shrunk.placements)) {
      expect(pl.c).toBeLessThan(smallGrids.M1.cols);
      expect(pl.r).toBeLessThan(smallGrids.M1.rows);
    }
    allPlacedOnce(shrunk, items.map((i) => i.id));
    expect(Object.keys(shrunk.home).sort()).toEqual([A.id, B.id, D.id].sort());

    const back = reconcile(shrunk, items, grids);
    expect(back.placements).toEqual(original.placements);
    expect(back.home).toEqual({});
  });

  it("survives several changes in a row and a save/load in between", () => {
    const original = spread();
    let l = reconcile(original, items, smallGrids);
    l = normalizeLayout(JSON.parse(JSON.stringify(l)));
    l = reconcile(l, items, smallGrids);
    l = reconcile(l, items, otherGrids);
    l = reconcile(l, items, grids);
    expect(l.placements).toEqual(original.placements);
    expect(l.home).toEqual({});
  });

  it("brings icons back when a missing monitor returns", () => {
    const original = spread();
    const moved = reconcile(original, items, otherGrids);
    for (const pl of Object.values(moved.placements)) expect(pl.m).toBe("M2");
    const back = reconcile(moved, items, grids);
    expect(back.placements).toEqual(original.placements);
  });

  it("keeps the user's choice when they moved a pushed icon meanwhile", () => {
    const original = spread();
    const shrunk = reconcile(original, items, smallGrids);
    const target = { m: "M1", p: 0, c: 1, r: 1 };
    const userMoved = forgetHomes(shrunk, moveToCell(shrunk, smallGrids, [A.id], A.id, target));
    expect(userMoved.home[A.id]).toBeUndefined();
    expect(userMoved.home[B.id]).toBeDefined();
    const back = reconcile(userMoved, items, grids);
    expect(back.placements[A.id]).toEqual(target);
    expect(back.placements[B.id]).toEqual(original.placements[B.id]);
  });

  it("stays put without overlapping if its home cell got taken", () => {
    const original = spread();
    const shrunk = reconcile(original, items, smallGrids);
    // something else now sits in A's home cell
    const taken = clone(shrunk);
    taken.placements[C.id] = { ...original.placements[A.id] };
    delete taken.home[C.id];
    const back = reconcile(taken, items, grids);
    allPlacedOnce(back, items.map((i) => i.id));
    expect(back.placements[C.id]).toEqual(original.placements[A.id]);
    expect(back.home[A.id]).toBeDefined();
  });

  it("forgets homes of icons put into folders and follows renames", () => {
    const shrunk = reconcile(spread(), items, smallGrids);
    const r = mergeIntoNewFolder(shrunk, C.id, [A.id], "F", null)!;
    const inFolder = reconcile(forgetHomes(shrunk, r.layout), items, smallGrids);
    expect(inFolder.home[A.id]).toBeUndefined();
    const newId = "c:\\users\\u\\desktop\\b2.lnk";
    const renamed = remapIds(shrunk, new Map([[B.id, newId]]));
    expect(renamed.home[newId]).toEqual(shrunk.home[B.id]);
  });
});

describe("per-folder look", () => {
  it("keeps only valid overrides and clamps them", () => {
    expect(normalizeLook({ opacity: 0, blur: 99, radius: -1, preview: 4, panelStyle: "android", junk: 1 })).toEqual({
      opacity: 0,
      blur: 40,
      radius: 0,
      panelStyle: "android",
    });
    expect(normalizeLook({})).toBeUndefined();
    expect(normalizeLook("x")).toBeUndefined();
  });

  it("is stored per folder, survives save/load and can be cleared", () => {
    let l = reconcile(emptyLayout(), items, grids);
    const r = mergeIntoNewFolder(l, A.id, [B.id], "F", null)!;
    l = setFolderLook(r.layout, r.folderId, { opacity: 0, preview: 2 });
    const loaded = normalizeLayout(JSON.parse(JSON.stringify(l)));
    expect(loaded.folders[r.folderId].look).toEqual({ opacity: 0, preview: 2 });
    const cleared = setFolderLook(loaded, r.folderId, {});
    expect(cleared.folders[r.folderId].look).toBeUndefined();
  });
});
