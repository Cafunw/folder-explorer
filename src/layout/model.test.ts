import { describe, expect, it } from "vitest";
import type { DesktopItem, Environment, Layout, MonitorInfo, Placement } from "../types";
import { DEFAULT_SETTINGS } from "../settings";
import { autoIconMm, cellMetrics, computeGrids, coveredKeys, placementKey, spanInBounds, type GridMap } from "./grid";
import {
  acceptsDrops,
  anchorToEdges,
  autoArrange,
  canPlace,
  createFolderAt,
  createHeadingAt,
  DEFAULT_FENCE_SIZE,
  dissolveFolder,
  emptyLayout,
  firstFree,
  forgetHomes,
  importWindowsLayout,
  isAnchored,
  isHeadingId,
  isInside,
  mergeIntoNewFolder,
  moveIntoFolder,
  moveToCell,
  moveToDesktop,
  nearestFree,
  normalizeLayout,
  normalizeLook,
  occupancy,
  reconcile,
  removeDeep,
  removeHeading,
  removeIds,
  resizeSpan,
  setFolderLook,
  setHeading,
  setHeadingText,
  sortMonitor,
  spanOf,
  remapIds,
  clone,
  updateFolder,
  USAGE_MAX,
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
  const manual = { ...DEFAULT_SETTINGS, grid: { ...DEFAULT_SETTINGS.grid, autoSize: false } };
  // 15.9" 1920x1200 laptop at 125 %
  const laptop: MonitorInfo = {
    id: "L",
    primary: true,
    bounds: { x: 0, y: 0, width: 1920, height: 1200 },
    work: { x: 0, y: 0, width: 1920, height: 1140 },
    scale: 1.25,
    sizeMm: { width: 344, height: 215 },
  };

  it("fits cells into the work area", () => {
    const min = cellMetrics(env.monitors[0], 1, DEFAULT_SETTINGS).cellW;
    expect(g.cols).toBe(Math.floor((1000 - 6) / min));
    expect(g.rows).toBeGreaterThan(3);
  });

  it("stretches the columns so the last one reaches the right edge", () => {
    expect(g.cellW).toBeGreaterThanOrEqual(cellMetrics(env.monitors[0], 1, DEFAULT_SETTINGS).cellW);
    expect(g.originX + g.cols * g.cellW).toBeCloseTo(g.workLeft + g.workWidth - 3);
  });

  it("uses the manual sizes when automatic size is off", () => {
    expect(cellMetrics(laptop, 1.25, manual)).toEqual({ iconSize: 48, cellW: 84, cellH: 96 });
  });

  it("sizes icons from the physical screen size", () => {
    // ~8.9 mm on a 16" panel = 50 physical px = 40 css px at 125 %
    expect(cellMetrics(laptop, 1.25, DEFAULT_SETTINGS)).toEqual({ iconSize: 40, cellW: 76, cellH: 88 });
    // same panel at 4K: same physical size, twice the pixels
    const sharp = { ...laptop, bounds: { ...laptop.bounds, width: 3840, height: 2400 }, scale: 2.5 };
    expect(cellMetrics(sharp, 2.5, DEFAULT_SETTINGS).iconSize).toBe(40);
  });

  it("follows Windows' scaling when the physical size is unknown, per monitor", () => {
    const noEdid = { ...laptop, sizeMm: null };
    expect(cellMetrics(noEdid, 1.25, DEFAULT_SETTINGS).iconSize).toBe(40);
    // a 150 % monitor next to a 125 % window: 40 logical px there = 48 css px of our window
    expect(cellMetrics({ ...noEdid, scale: 1.5 }, 1.25, DEFAULT_SETTINGS).iconSize).toBe(48);
  });

  it("grows icons with the screen, within limits", () => {
    expect(autoIconMm(13)).toBeLessThan(autoIconMm(16));
    expect(autoIconMm(16)).toBeLessThan(autoIconMm(24));
    expect(autoIconMm(6)).toBe(7.5);
    expect(autoIconMm(80)).toBe(13);
  });

  it("leaves room for the chosen label lines", () => {
    const three = { ...DEFAULT_SETTINGS, grid: { ...DEFAULT_SETTINGS.grid, labelLines: 3 as const } };
    const none = { ...DEFAULT_SETTINGS, grid: { ...DEFAULT_SETTINGS.grid, labels: false } };
    expect(cellMetrics(laptop, 1.25, three).cellH).toBeGreaterThan(88);
    expect(cellMetrics(laptop, 1.25, none).cellH).toBe(50);
  });

  it("scales icons for View ▸ Large / Small icons", () => {
    const at = (iconScale: number, autoSize = true) => ({ ...DEFAULT_SETTINGS, grid: { ...DEFAULT_SETTINGS.grid, iconScale, autoSize } });
    expect(cellMetrics(laptop, 1.25, at(2)).iconSize).toBe(80);
    expect(cellMetrics(laptop, 1.25, at(0.67)).iconSize).toBe(27);
    expect(cellMetrics(laptop, 1.25, at(0.67)).cellW).toBe(76);
    const big = cellMetrics(laptop, 1.25, at(2, false));
    expect(big.iconSize).toBe(96);
    expect(big.cellW).toBeGreaterThanOrEqual(126);
    expect(big.cellH).toBeGreaterThan(96);
    expect(cellMetrics(laptop, 1.25, at(0.67, false))).toEqual({ iconSize: 32, cellW: 84, cellH: 96 });
  });
});

describe("anchorToEdges", () => {
  const sized = (cols: number, rows: number): GridMap => ({ M1: { ...g, cols, rows } });
  const at = (c: number, r: number, p = 0): Placement => ({ m: "M1", p, c, r });
  const withPlacements = (pl: Record<string, Placement>): Layout => ({ ...emptyLayout(), placements: pl });

  it("keeps icons against the right and bottom edges when the grid grows", () => {
    const l = withPlacements({ left: at(0, 0), mid: at(4, 0), right: at(9, 0), bottom: at(0, 4), corner: at(9, 4) });
    const out = anchorToEdges(l, sized(10, 5), sized(12, 6));
    expect(out.placements.left).toEqual(at(0, 0));
    expect(out.placements.mid).toEqual(at(4, 0));
    expect(out.placements.right).toEqual(at(11, 0));
    expect(out.placements.bottom).toEqual(at(0, 5));
    expect(out.placements.corner).toEqual(at(11, 5));
  });

  it("moves a right-side block together and never splits a full row or column", () => {
    const row: Record<string, Placement> = {};
    for (let c = 0; c < 10; c++) row[`top${c}`] = at(c, 0);
    for (let r = 1; r < 5; r++) row[`col${r}`] = at(0, r); // column 0 is full
    row.blockA = at(7, 2);
    row.blockB = at(8, 2);
    row.blockC = at(9, 2);
    const out = anchorToEdges(withPlacements(row), sized(10, 5), sized(11, 6));
    for (let c = 0; c < 10; c++) expect(out.placements[`top${c}`]).toEqual(at(c, 0));
    for (let r = 1; r < 5; r++) expect(out.placements[`col${r}`]).toEqual(at(0, r));
    expect([out.placements.blockA.c, out.placements.blockB.c, out.placements.blockC.c]).toEqual([8, 9, 10]);
  });

  it("slides back into free cells when the grid shrinks, otherwise leaves it to reconcile", () => {
    const free = anchorToEdges(withPlacements({ a: at(0, 0), b: at(9, 0) }), sized(10, 5), sized(9, 5));
    expect(free.placements.b).toEqual(at(8, 0));
    const blocked = withPlacements({ a: at(6, 0), b: at(8, 0), c: at(9, 0) });
    // run [8, 9] would need cells 6..7 free for a shrink of 2; 6 is taken
    expect(anchorToEdges(blocked, sized(10, 5), sized(8, 5)).placements.b).toEqual(at(8, 0));
  });

  it("works per page and returns the same layout when nothing changes", () => {
    const l = withPlacements({ a: at(9, 0, 1) });
    expect(anchorToEdges(l, sized(10, 5), sized(10, 5))).toBe(l);
    expect(anchorToEdges(l, sized(10, 5), sized(12, 5)).placements.a).toEqual(at(11, 0, 1));
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

// ---------------------------------------------------------------- new schema: spans, headings, group kinds

const at = (c: number, r: number, w?: number, h?: number, p = 0): Placement => {
  const pl: Placement = { m: "M1", p, c, r };
  if (w && w > 1) pl.w = w;
  if (h && h > 1) pl.h = h;
  return pl;
};

function noOverlap(l: Layout, gm: GridMap = grids) {
  const keys = Object.values(l.placements).flatMap(coveredKeys);
  expect(new Set(keys).size).toBe(keys.length);
  for (const pl of Object.values(l.placements)) expect(spanInBounds(gm[pl.m], pl), JSON.stringify(pl)).toBe(true);
}

const FENCE = "v:fence";
/** A..D in column 0 (rows 0..3), a fence group at `pl` (default columns 2..4, rows 0..1). */
function withFence(pl: Placement = at(2, 0, 3, 2)): Layout {
  const l = reconcile(emptyLayout(), items, grids);
  l.folders[FENCE] = { id: FENCE, name: "Kutu", color: null, children: [], display: "fence" };
  l.placements[FENCE] = pl;
  return l;
}

describe("normalizing the new layout fields", () => {
  it("cleans group kinds, displays and their options", () => {
    const l = normalizeLayout({
      folders: {
        "v:s": {
          name: "S",
          color: null,
          children: ["a", "h:x", "v:s"],
          kind: "smart",
          display: "fence",
          rule: {
            all: false,
            conditions: [
              { field: "ext", value: ["PNG", "*.jpg", ".png", "", 4] },
              { field: "name", op: "contains", value: "  rapor " },
              { field: "type", value: "game" },
              { field: "age", op: "olderThan", days: 99999 },
              { field: "type", value: "nope" },
              { field: "name", op: "endsWith", value: "x" },
              { field: "name", op: "contains", value: "   " },
              null,
            ],
          },
          exclude: ["a", "a", 3, ""],
          source: "",
          limit: 99,
          tempDays: 0,
          added: { a: 1 },
          activeTab: "",
          lock: { method: "pin", hash: "h", salt: "s" },
        },
        "v:f": { name: "F", color: null, children: ["b"], kind: "frequent", limit: 0.4, source: "C:\\x" },
        "v:t": { name: "T", color: null, children: ["c", "d"], kind: "temp", tempDays: 400, added: { c: 5, d: "x", zz: 3 } },
        "v:g": { name: "G", color: null, children: [], kind: "group", display: "panel", lock: { method: "pin", hash: null, salt: null } },
        "v:h": { name: "H", color: null, children: [], lock: { method: "hello", hash: "h", salt: null }, activeTab: "v:x" },
        "v:x": { kind: "weird", display: "weird", rule: "x" },
        nope: { name: "not a group", children: [] },
      },
    });
    expect(l.folders["v:s"]).toEqual({
      id: "v:s",
      name: "S",
      color: null,
      children: ["a"],
      kind: "smart",
      display: "fence",
      rule: {
        all: false,
        conditions: [
          { field: "ext", value: [".png", ".jpg"] },
          { field: "name", op: "contains", value: "rapor" },
          { field: "type", value: "game" },
          { field: "age", op: "olderThan", days: 36500 },
        ],
      },
      exclude: ["a"],
      limit: 50,
      tempDays: 1,
      lock: { method: "pin", hash: "h", salt: "s" },
    });
    expect(l.folders["v:f"]).toEqual({ id: "v:f", name: "F", color: null, children: [], kind: "frequent", limit: 1, source: "C:\\x" });
    expect(l.folders["v:t"].tempDays).toBe(365);
    expect(l.folders["v:t"].added).toEqual({ c: 5 });
    expect(l.folders["v:g"]).toEqual({ id: "v:g", name: "G", color: null, children: [] });
    expect(l.folders["v:h"].lock).toEqual({ method: "hello", hash: null, salt: null });
    expect(l.folders["v:h"].activeTab).toBe("v:x");
    expect(l.folders["v:x"]).toEqual({ id: "v:x", name: "Klasör", color: null, children: [] });
    expect(l.folders.nope).toBeUndefined();
  });

  it("cleans the new look fields", () => {
    expect(
      normalizeLook({ borderWidth: 9, borderColor: "#fff", shadow: -1, gradient: true, glow: 0.5, openStyle: "flip" }),
    ).toEqual({ borderWidth: 4, borderColor: "#fff", shadow: 0, gradient: true, glow: 0.5, openStyle: "flip" });
    expect(normalizeLook({ borderColor: "", gradient: "yes", openStyle: "explode", glow: "x" })).toBeUndefined();
  });

  it("keeps spans only when larger than one cell, headings and valid usage", () => {
    const l = normalizeLayout({
      placements: {
        a: { m: "M1", p: 0, c: 0, r: 0, w: 1, h: 1 },
        b: { m: "M1", p: 0, c: 1, r: 0, w: 3, h: 2 },
        c: { m: "M1", p: 0, c: 4, r: 0, w: 2.5, h: 0 },
        "h:1": { m: "M1", p: 0, c: 5, r: 0, w: 2 },
        "h:gone": { m: "M1", p: 0, c: 6, r: 0 },
      },
      headings: {
        "h:1": { id: "h:other", text: "Oyunlar", style: "divider", align: "center" },
        "h:2": { text: 5, style: "x", align: "x" },
        bad: { text: "x" },
      },
      home: { b: { at: 1, placement: { m: "M1", p: 0, c: 9, r: 0, w: 3, h: 2 } } },
      usage: { a: { n: 3, last: 10 }, b: { n: 0, last: 1 }, c: { n: 2 }, d: "x", e: { n: 2.6, last: 4 } },
    });
    expect(l.placements.a).toEqual(at(0, 0));
    expect(l.placements.b).toEqual(at(1, 0, 3, 2));
    expect(l.placements.c).toEqual(at(4, 0));
    expect(l.placements["h:1"]).toEqual(at(5, 0, 2));
    expect(l.placements["h:gone"]).toBeUndefined();
    expect(l.home.b.placement).toEqual(at(9, 0, 3, 2));
    expect(l.headings).toEqual({
      "h:1": { id: "h:1", text: "Oyunlar", style: "divider", align: "center" },
      "h:2": { id: "h:2", text: "", style: "title", align: "left" },
    });
    expect(l.usage).toEqual({ a: { n: 3, last: 10 }, e: { n: 3, last: 4 } });
  });

  it("bounds usage to the most recently used entries", () => {
    const usage: Record<string, { n: number; last: number }> = {};
    for (let i = 0; i < USAGE_MAX + 100; i++) usage[`x${i}`] = { n: 1, last: i };
    const l = normalizeLayout({ usage });
    expect(Object.keys(l.usage)).toHaveLength(USAGE_MAX);
    expect(l.usage.x0).toBeUndefined();
    expect(l.usage[`x${USAGE_MAX + 99}`]).toBeDefined();
  });

  it("survives a save / load round trip unchanged", () => {
    const l = withFence();
    l.folders["v:t"] = { id: "v:t", name: "T", color: "#f00", children: [], kind: "temp", display: "stack", tempDays: 3 };
    l.placements["v:t"] = at(9, 0);
    l.headings["h:1"] = { id: "h:1", text: "Başlık", style: "title", align: "center" };
    l.placements["h:1"] = at(6, 3, 4);
    l.usage[A.id] = { n: 2, last: 5 };
    expect(normalizeLayout(JSON.parse(JSON.stringify(l)))).toEqual(l);
  });
});

describe("spans", () => {
  it("cover all their cells in the occupancy and free-cell search", () => {
    const l = withFence(at(0, 0, 3, 2));
    l.placements = { [FENCE]: at(0, 0, 3, 2) };
    const occ = occupancy(l);
    expect(occ.size).toBe(6);
    expect(occ.get(placementKey(at(2, 1)))).toBe(FENCE);
    expect(firstFree(occ, grids, "M1")).toEqual(at(0, 2));
    expect(firstFree(occ, grids, "M1", 0, 0, { w: 2, h: 2 })).toEqual(at(0, 2, 2, 2));
    expect(nearestFree(occ, grids, at(1, 1, 2, 2))).toEqual(at(1, 2, 2, 2));
    expect(canPlace(occ, grids, at(3, 0, 2, 2))).toBe(true);
    expect(canPlace(occ, grids, at(2, 1, 2, 2))).toBe(false);
    expect(canPlace(occ, grids, at(2, 1, 2, 2), FENCE)).toBe(true);
    expect(canPlace(occ, grids, at(g.cols - 1, 0, 2))).toBe(false);
  });

  it("an icon is never dropped onto the cells of a fence", () => {
    const l = withFence();
    const n = moveToCell(l, grids, [A.id], A.id, at(3, 1));
    expect(n.placements[FENCE]).toEqual(at(2, 0, 3, 2));
    expect(n.placements[A.id]).toEqual(at(3, 2));
    noOverlap(n);
  });

  it("a fence moves as a block and never covers icons", () => {
    const l = withFence();
    expect(moveToCell(l, grids, [FENCE], FENCE, at(6, 2)).placements[FENCE]).toEqual(at(6, 2, 3, 2));
    // (0, 0) would cover A and B: the nearest spot where the whole block fits
    const n = moveToCell(l, grids, [FENCE], FENCE, at(0, 0));
    expect(n.placements[FENCE]).toEqual(at(1, 0, 3, 2));
    noOverlap(n);
  });

  it("keeps offsets for a selection with a fence", () => {
    const n = moveToCell(withFence(), grids, [FENCE, A.id], FENCE, at(6, 2));
    expect(n.placements[FENCE]).toEqual(at(6, 2, 3, 2));
    expect(n.placements[A.id]).toEqual(at(4, 2));
    noOverlap(n);
  });

  it("displaces a fence only to a spot where its whole block fits", () => {
    const l = withFence();
    // the cell of A can't take a 3 x 2 block (B is below it): the fence stays, A goes next to it
    const blocked = moveToCell(l, grids, [A.id], A.id, at(2, 0), { id: FENCE, to: at(0, 0) });
    expect(blocked.placements[FENCE]).toEqual(at(2, 0, 3, 2));
    expect(blocked.placements[A.id]).toEqual(at(1, 0));
    noOverlap(blocked);
    const away = moveToCell(l, grids, [A.id], A.id, at(8, 4));
    const swapped = moveToCell(away, grids, [A.id], A.id, at(2, 0), { id: FENCE, to: at(8, 4) });
    expect(swapped.placements[FENCE]).toEqual(at(8, 4, 3, 2));
    expect(swapped.placements[A.id]).toEqual(at(2, 0));
    noOverlap(swapped);
  });

  it("resizes only into free cells inside the grid", () => {
    const l = withFence();
    expect(resizeSpan(l, grids, FENCE, 4, 2).placements[FENCE]).toEqual(at(2, 0, 4, 2));
    expect(resizeSpan(l, grids, FENCE, 1, 1).placements[FENCE]).toEqual(at(2, 0));
    expect(resizeSpan(l, grids, FENCE, 3, 2)).toBe(l);
    expect(resizeSpan(l, grids, FENCE, 99, 2)).toBe(l);
    expect(resizeSpan(l, grids, FENCE, 2.5, 2)).toBe(l);
    expect(resizeSpan(l, grids, "nope", 2, 2)).toBe(l);
    const blocked = moveToCell(l, grids, [A.id], A.id, at(5, 1));
    expect(resizeSpan(blocked, grids, FENCE, 4, 2)).toBe(blocked);
  });

  it("reconcile keeps the cells of a fence and moves icons out of them", () => {
    const l0 = emptyLayout();
    l0.folders[FENCE] = { id: FENCE, name: "Kutu", color: null, children: [], display: "fence" };
    l0.placements[A.id] = at(0, 0);
    l0.placements[FENCE] = at(0, 0, 2, 2);
    l0.placements[B.id] = at(1, 1);
    const l = reconcile(l0, items, grids);
    expect(l.placements[FENCE]).toEqual(at(0, 0, 2, 2));
    allPlacedOnce(l, [...items.map((i) => i.id), FENCE]);
    noOverlap(l);
  });

  const small: Environment = {
    ...env,
    monitors: [{ ...env.monitors[0], bounds: { x: 0, y: 0, width: 400, height: 340 }, work: { x: 0, y: 0, width: 400, height: 300 } }],
  };
  const smallGrids = computeGrids(small, DEFAULT_SETTINGS);

  it("a fence pushed off a smaller screen comes back to its exact block", () => {
    const original = withFence(at(8, 2, 4, 3));
    const shrunk = reconcile(original, items, smallGrids);
    noOverlap(shrunk, smallGrids);
    expect(shrunk.home[FENCE].placement).toEqual(at(8, 2, 4, 3));
    const back = reconcile(shrunk, items, grids);
    expect(back.placements).toEqual(original.placements);
    expect(back.home).toEqual({});
  });

  it("a fence larger than the screen is shown smaller and restored to its size", () => {
    const l0 = emptyLayout();
    l0.folders[FENCE] = { id: FENCE, name: "Kutu", color: null, children: [], display: "fence" };
    l0.placements[FENCE] = at(7, 4, 6, 2);
    const shrunk = reconcile(l0, [], smallGrids);
    expect(spanOf(shrunk.placements[FENCE])).toEqual({ w: smallGrids.M1.cols, h: 2 });
    noOverlap(shrunk, smallGrids);
    const back = reconcile(normalizeLayout(JSON.parse(JSON.stringify(shrunk))), [], grids);
    expect(back.placements[FENCE]).toEqual(at(7, 4, 6, 2));
  });

  it("an icon whose home is now covered by a fence stays where it is", () => {
    const original = reconcile(emptyLayout(), items, grids);
    original.placements[A.id] = at(g.cols - 1, 0);
    const shrunk = reconcile(original, items, smallGrids);
    expect(shrunk.home[A.id]).toBeDefined();
    const taken = clone(shrunk);
    taken.folders[FENCE] = { id: FENCE, name: "Kutu", color: null, children: [], display: "fence" };
    taken.placements[FENCE] = at(g.cols - 2, 0, 2, 2);
    const back = reconcile(taken, items, grids);
    expect(back.placements[FENCE]).toEqual(at(g.cols - 2, 0, 2, 2));
    expect(back.home[A.id]).toBeDefined();
    noOverlap(back);
  });

  it("auto-arrange and sorting flow icons around fences and headings", () => {
    const l = withFence(at(1, 0, 2, 2));
    l.headings["h:1"] = { id: "h:1", text: "", style: "divider", align: "left" };
    l.placements["h:1"] = at(0, 3);
    l.placements[D.id] = at(7, 5);
    l.placements[C.id] = at(6, 5);
    const arranged = autoArrange(l, grids);
    expect(arranged.placements[FENCE]).toEqual(at(1, 0, 2, 2));
    expect(arranged.placements["h:1"]).toEqual(at(0, 3));
    expect([A, B, C, D].map((i) => arranged.placements[i.id])).toEqual([at(0, 0), at(0, 1), at(0, 2), at(0, 4)]);
    noOverlap(arranged);
    const info = (id: string) => ({ name: id, ext: "", modified: 0, size: 0, group: 0 });
    const sorted = sortMonitor(l, grids, "M1", "name", info);
    expect(sorted.placements[FENCE]).toEqual(at(1, 0, 2, 2));
    expect(sorted.placements["h:1"]).toEqual(at(0, 3));
    expect([A, B, C, D].map((i) => sorted.placements[i.id])).toEqual([at(0, 0), at(0, 1), at(0, 2), at(0, 4)]);
    noOverlap(sorted);
  });

  it("isAnchored: headings, spans and fence groups", () => {
    const l = withFence(at(2, 0));
    l.headings["h:1"] = { id: "h:1", text: "", style: "title", align: "left" };
    expect(isAnchored(l, FENCE)).toBe(true);
    expect(isAnchored(l, "h:1")).toBe(true);
    expect(isAnchored(l, A.id)).toBe(false);
  });
});

describe("anchorToEdges with spans", () => {
  const sized = (cols: number, rows: number): GridMap => ({ M1: { ...g, cols, rows } });
  const withPlacements = (pl: Record<string, Placement>): Layout => ({ ...emptyLayout(), placements: pl });

  it("moves a fence at the right edge as a block", () => {
    const out = anchorToEdges(withPlacements({ f: at(8, 0, 2, 2), a: at(0, 0) }), sized(10, 5), sized(12, 5));
    expect(out.placements.f).toEqual(at(10, 0, 2, 2));
    expect(out.placements.a).toEqual(at(0, 0));
  });

  it("keeps a fence (and the runs of its rows) when one of its rows can't slide", () => {
    const pl: Record<string, Placement> = { f: at(8, 0, 2, 2), seven: at(7, 0) };
    for (let c = 0; c < 8; c++) pl[`full${c}`] = at(c, 1); // row 1 is full
    const l = withPlacements(pl);
    expect(anchorToEdges(l, sized(10, 5), sized(12, 5))).toBe(l);
  });

  it("slides a tall block down with the bottom edge", () => {
    const out = anchorToEdges(withPlacements({ f: at(0, 3, 2, 2) }), sized(10, 5), sized(10, 6));
    expect(out.placements.f).toEqual(at(0, 4, 2, 2));
  });

  it("slides a run with a fence in it together", () => {
    const out = anchorToEdges(
      withPlacements({ f: at(8, 0, 2, 2), six: at(6, 0), seven: at(7, 0), x: at(5, 2) }),
      sized(10, 5),
      sized(12, 5),
    );
    noOverlap(out, sized(12, 5));
    expect(out.placements.f).toEqual(at(10, 0, 2, 2));
    expect([out.placements.six.c, out.placements.seven.c]).toEqual([8, 9]);
  });
});

describe("headings", () => {
  it("are created at a cell, or the nearest spot where their block fits", () => {
    const base = reconcile(emptyLayout(), items, grids);
    const r = createHeadingAt(base, grids, { text: "Oyunlar" }, at(0, 0, 4));
    expect(isHeadingId(r.headingId)).toBe(true);
    expect(r.layout.headings[r.headingId]).toEqual({ id: r.headingId, text: "Oyunlar", style: "title", align: "left" });
    expect(r.layout.placements[r.headingId]).toEqual(at(1, 0, 4));
    const wide = createHeadingAt(base, grids, { style: "divider" }, at(0, 0, 50));
    expect(wide.layout.placements[wide.headingId]).toEqual(at(0, 4, g.cols));
    noOverlap(wide.layout);
  });

  it("live on the grid without a desktop item through reconcile", () => {
    const r = createHeadingAt(emptyLayout(), grids, { text: "x" }, at(5, 5, 2));
    const l0 = clone(r.layout);
    l0.placements["h:unknown"] = at(9, 0);
    l0.headings["h:lost"] = { id: "h:lost", text: "lost", style: "title", align: "left" };
    l0.folders["v:1"] = { id: "v:1", name: "1", color: null, children: [r.headingId, A.id] };
    l0.placements["v:1"] = at(3, 3);
    const l = reconcile(l0, items, grids);
    expect(l.placements[r.headingId]).toEqual(at(5, 5, 2));
    expect(l.placements["h:unknown"]).toBeUndefined();
    expect(l.remembered["h:unknown"]).toBeUndefined();
    expect(l.placements["h:lost"]).toBeDefined();
    expect(l.folders["v:1"].children).toEqual([A.id]);
    noOverlap(l);
  });

  it("are edited, moved and removed", () => {
    const r = createHeadingAt(emptyLayout(), grids, { text: "a" }, at(0, 0, 3));
    let l = setHeadingText(r.layout, r.headingId, "Çalışma");
    l = setHeading(l, r.headingId, { align: "center" });
    expect(l.headings[r.headingId]).toEqual({ id: r.headingId, text: "Çalışma", style: "title", align: "center" });
    expect(setHeadingText(l, "h:nope", "x")).toBe(l);
    l = moveToCell(l, grids, [r.headingId], r.headingId, at(4, 2));
    expect(l.placements[r.headingId]).toEqual(at(4, 2, 3));
    const gone = removeHeading(l, r.headingId);
    expect(gone.headings[r.headingId]).toBeUndefined();
    expect(gone.placements[r.headingId]).toBeUndefined();
    const deleted = removeIds(l, [r.headingId]);
    expect(deleted.headings[r.headingId]).toBeUndefined();
  });

  it("can't go into groups", () => {
    const base = reconcile(emptyLayout(), items, grids);
    const r = createHeadingAt(base, grids, {}, at(6, 0));
    const f = mergeIntoNewFolder(r.layout, A.id, [B.id], "F", null)!;
    expect(moveIntoFolder(f.layout, [r.headingId], f.folderId)).toBe(f.layout);
    expect(mergeIntoNewFolder(f.layout, r.headingId, [C.id], "G", null)).toBeNull();
    const made = createFolderAt(f.layout, grids, { placement: at(8, 0) }, "H", null, [r.headingId, C.id]);
    expect(made.layout.folders[made.folderId].children).toEqual([C.id]);
    expect(made.layout.placements[r.headingId]).toEqual(at(6, 0));
  });
});

describe("group options", () => {
  const group = (children: string[] = []) => {
    const l = reconcile(emptyLayout(), items, grids);
    for (const id of children) delete l.placements[id];
    l.folders["v:g"] = { id: "v:g", name: "G", color: null, children };
    l.placements["v:g"] = at(5, 0);
    return l;
  };

  it("a fence grows to its default size where it fits, and shrinks back", () => {
    const fence = updateFolder(group(), grids, "v:g", { display: "fence" });
    expect(fence.folders["v:g"].display).toBe("fence");
    expect(fence.placements["v:g"]).toEqual(at(5, 0, DEFAULT_FENCE_SIZE.w, DEFAULT_FENCE_SIZE.h));
    const panel = updateFolder(fence, grids, "v:g", { display: null });
    expect(panel.folders["v:g"].display).toBeUndefined();
    expect(panel.placements["v:g"]).toEqual(at(5, 0));
    const edge = group();
    edge.placements["v:g"] = at(g.cols - 2, 0);
    edge.placements[A.id] = at(g.cols - 1, 1);
    expect(updateFolder(edge, grids, "v:g", { display: "fence" }).placements["v:g"]).toEqual(at(g.cols - 2, 0, 2));
  });

  it("frequent and live groups hand their children back and refuse drops", () => {
    const l = updateFolder(group([A.id, B.id]), grids, "v:g", { kind: "frequent", limit: 0 });
    expect(l.folders["v:g"].children).toEqual([]);
    expect(l.folders["v:g"].limit).toBe(1);
    expect(l.placements[A.id]).toBeDefined();
    expect(l.placements[B.id]).toBeDefined();
    allPlacedOnce(l, [...items.map((i) => i.id), "v:g"]);
    noOverlap(l);
    expect(acceptsDrops(l.folders["v:g"])).toBe(false);
    expect(moveIntoFolder(l, [C.id], "v:g")).toBe(l);
    const live = updateFolder(group([A.id]), grids, "v:g", { kind: "live", source: "C:\\Users\\u\\Downloads" });
    expect(live.folders["v:g"].source).toBe("C:\\Users\\u\\Downloads");
    expect(live.folders["v:g"].children).toEqual([]);
    expect(acceptsDrops(live.folders["v:g"])).toBe(false);
  });

  it("a nested group turning frequent puts its children right after it", () => {
    let l = group([A.id]);
    l = createFolderAt(l, grids, { folderId: "v:g" }, "inner", null, [B.id]).layout;
    const inner = l.folders["v:g"].children[1];
    l = updateFolder(l, grids, inner, { kind: "frequent" });
    expect(l.folders["v:g"].children).toEqual([A.id, inner, B.id]);
  });

  it("a temp group starts the clock for its children; null clears options", () => {
    const l = updateFolder(group([A.id]), grids, "v:g", { kind: "temp", tempDays: 3 }, 1000);
    expect(l.folders["v:g"].added).toEqual({ [A.id]: 1000 });
    const back = updateFolder(l, grids, "v:g", { kind: null, tempDays: null });
    expect(back.folders["v:g"].kind).toBeUndefined();
    expect(back.folders["v:g"].added).toBeUndefined();
    expect(back.folders["v:g"].tempDays).toBeUndefined();
    expect(updateFolder(l, grids, "v:none", { kind: "temp" })).toBe(l);
  });

  it("dissolving a fence gives its first child the top-left cell of the fence", () => {
    const l = updateFolder(group([A.id, B.id]), grids, "v:g", { display: "fence" });
    const n = dissolveFolder(l, grids, "v:g");
    expect(n.placements[A.id]).toEqual(at(5, 0));
    noOverlap(n);
  });
});

describe("membership bookkeeping", () => {
  const setup = () => {
    const l = reconcile(emptyLayout(), items, grids);
    delete l.placements[A.id];
    delete l.placements[B.id];
    l.folders["v:s"] = {
      id: "v:s",
      name: "S",
      color: null,
      children: [A.id, B.id],
      kind: "smart",
      rule: { all: true, conditions: [{ field: "type", value: "shortcut" }] },
    };
    l.placements["v:s"] = at(4, 0);
    l.folders["v:t"] = { id: "v:t", name: "T", color: null, children: [], kind: "temp" };
    l.placements["v:t"] = at(5, 0);
    l.folders["v:o"] = { id: "v:o", name: "O", color: null, children: [] };
    l.placements["v:o"] = at(6, 0);
    return l;
  };

  it("taking an item out of a smart group excludes it; putting it back clears that", () => {
    const out = moveToCell(setup(), grids, [A.id], A.id, at(8, 0));
    expect(out.folders["v:s"].exclude).toEqual([A.id]);
    const desk = moveToDesktop(out, grids, [B.id]);
    expect(desk.folders["v:s"].exclude).toEqual([A.id, B.id]);
    const back = moveIntoFolder(desk, [A.id], "v:s");
    expect(back.folders["v:s"].exclude).toEqual([B.id]);
    const reorder = moveIntoFolder(setup(), [A.id], "v:s", 1);
    expect(reorder.folders["v:s"].exclude).toBeUndefined();
    const other = moveIntoFolder(setup(), [A.id], "v:o");
    expect(other.folders["v:s"].exclude).toEqual([A.id]);
  });

  it("temp groups note arrival and forget on leave", () => {
    const l = moveIntoFolder(setup(), [C.id, A.id], "v:t", undefined, 777);
    expect(l.folders["v:t"].added).toEqual({ [C.id]: 777, [A.id]: 777 });
    const out = moveToCell(l, grids, [C.id], C.id, at(9, 0));
    expect(out.folders["v:t"].added).toEqual({ [A.id]: 777 });
    const gone = removeIds(out, [A.id]);
    expect(gone.folders["v:t"].added).toBeUndefined();
  });

  it("renames and deletions keep usage, exclusions and arrival times consistent", () => {
    let l = moveToCell(setup(), grids, [A.id], A.id, at(8, 0));
    l = moveIntoFolder(l, [C.id], "v:t", undefined, 5);
    l = { ...l, usage: { [A.id]: { n: 2, last: 1 }, [C.id]: { n: 1, last: 2 } } };
    const a2 = "c:\\users\\u\\desktop\\a2.lnk";
    const c2 = "c:\\users\\u\\desktop\\c2.lnk";
    const r = remapIds(l, new Map([[A.id, a2], [C.id, c2]]));
    expect(r.folders["v:s"].exclude).toEqual([a2]);
    expect(r.folders["v:t"].added).toEqual({ [c2]: 5 });
    expect(r.usage).toEqual({ [a2]: { n: 2, last: 1 }, [c2]: { n: 1, last: 2 } });
    const d = removeIds(r, [a2]);
    expect(d.folders["v:s"].exclude).toBeUndefined();
    expect(d.usage[a2]).toBeUndefined();
    const deep = removeDeep(r, ["v:t"]);
    expect(deep.usage[c2]).toBeUndefined();
  });

  it("reconcile keeps arrival times and drops what no longer exists", () => {
    const l0 = setup();
    l0.folders["v:t"].children = [C.id];
    l0.folders["v:t"].added = { gone: 1 };
    delete l0.placements[C.id];
    l0.folders["v:s"].exclude = [D.id, "c:\\nowhere"];
    l0.usage = { [D.id]: { n: 1, last: 1 }, "c:\\nowhere": { n: 1, last: 1 } };
    const l = reconcile(l0, items, grids, undefined, 42);
    expect(l.folders["v:t"].added).toEqual({ [C.id]: 42 });
    expect(l.folders["v:s"].exclude).toEqual([D.id]);
    expect(Object.keys(l.usage)).toEqual([D.id]);
    // a vanished item keeps its exclusion and usage while it is remembered
    const gone = reconcile(l, [A, B, C], grids, undefined, 43);
    expect(gone.folders["v:s"].exclude).toEqual([D.id]);
    expect(gone.usage[D.id]).toBeDefined();
  });

  it("reconcile empties frequent groups onto the desktop", () => {
    const l0 = setup();
    l0.folders["v:o"].kind = "frequent";
    l0.folders["v:o"].children = [C.id];
    delete l0.placements[C.id];
    const l = reconcile(l0, items, grids);
    expect(l.folders["v:o"].children).toEqual([]);
    expect(l.placements[C.id]).toBeDefined();
  });
});
