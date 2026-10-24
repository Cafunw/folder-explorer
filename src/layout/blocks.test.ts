import { describe, expect, it } from "vitest";
import type { Layout } from "../types";
import {
  blockNear,
  createFenceAt,
  createHeadingNear,
  FENCE_INSET,
  FENCE_PAD_X,
  FENCE_PAD_Y,
  FENCE_TITLE,
  fenceContentHeight,
  fenceGeometry,
  fenceHit,
  fenceOf,
  fenceSlotXY,
  freeRun,
  isBlock,
  isFence,
  setCollapsed,
  slotAt,
  snapMove,
  snapResize,
} from "./blocks";
import { coveredKeys, type GridInfo, type GridMap } from "./grid";
import { emptyLayout, moveToCell, normalizeLayout, occupancy } from "./model";

const g: GridInfo = {
  monitorId: "M",
  primary: true,
  left: 0,
  top: 0,
  width: 1000,
  height: 600,
  workLeft: 0,
  workTop: 0,
  workWidth: 1000,
  workHeight: 600,
  originX: 0,
  originY: 0,
  cols: 10,
  rows: 6,
  cellW: 100,
  cellH: 100,
  iconSize: 48,
};
const grids: GridMap = { M: g };

function withFence(): Layout {
  const l = emptyLayout();
  l.folders["v:f"] = { id: "v:f", name: "F", color: null, children: ["a", "b"], display: "fence" };
  l.placements["v:f"] = { m: "M", p: 0, c: 2, r: 1, w: 3, h: 2 };
  l.placements.x = { m: "M", p: 0, c: 0, r: 0 };
  return l;
}

describe("fence geometry", () => {
  it("covers its cells minus the inset, one children column per cell", () => {
    const geo = fenceGeometry(g, { m: "M", p: 0, c: 2, r: 1, w: 3, h: 2 });
    expect(geo.x).toBe(200 + FENCE_INSET);
    expect(geo.y).toBe(100 + FENCE_INSET);
    expect(geo.w).toBe(300 - FENCE_INSET * 2);
    expect(geo.h).toBe(200 - FENCE_INSET * 2);
    expect(geo.bodyY).toBe(geo.y + FENCE_TITLE);
    expect(geo.bodyH).toBe(geo.h - FENCE_TITLE);
    expect(geo.cols).toBe(3);
    expect(geo.cellW * geo.cols).toBeCloseTo(geo.w - FENCE_PAD_X * 2);
  });

  it("a collapsed fence is only its title bar", () => {
    const geo = fenceGeometry(g, { m: "M", p: 0, c: 0, r: 0, w: 2, h: 2 }, true);
    expect(geo.h).toBe(FENCE_TITLE);
    expect(geo.bodyH).toBe(0);
  });

  it("lays children out row by row and sizes the scroll content", () => {
    const geo = fenceGeometry(g, { m: "M", p: 0, c: 0, r: 0, w: 3, h: 2 });
    expect(fenceSlotXY(geo, 0)).toEqual({ x: FENCE_PAD_X, y: FENCE_PAD_Y });
    expect(fenceSlotXY(geo, 4)).toEqual({ x: FENCE_PAD_X + geo.cellW, y: FENCE_PAD_Y + geo.cellH });
    expect(fenceContentHeight(geo, 7)).toBe(3 * geo.cellH + FENCE_PAD_Y * 2);
    expect(fenceContentHeight(geo, 0)).toBe(FENCE_PAD_Y * 2);
  });
});

describe("hit testing inside a fence", () => {
  const geo = fenceGeometry(g, { m: "M", p: 0, c: 2, r: 1, w: 3, h: 2 });

  it("title bar vs body, in children-grid coordinates with scrolling", () => {
    expect(fenceHit(geo, 250, geo.y + 5).part).toBe("title");
    const hit = fenceHit(geo, geo.x + FENCE_PAD_X + 10, geo.bodyY + FENCE_PAD_Y + 20, 40);
    expect(hit).toEqual({ part: "body", bx: 10, by: 60 });
    expect(fenceHit(fenceGeometry(g, { m: "M", p: 0, c: 2, r: 1, w: 3, h: 2 }, true), 250, 250).part).toBe("title");
  });

  it("slots: clamped to the columns, never past the end", () => {
    expect(slotAt(150, 20, 3, 100, 100, 5)).toEqual({ col: 1, row: 0, slot: 1 });
    expect(slotAt(350, 120, 3, 100, 100, 5)).toEqual({ col: 2, row: 1, slot: 5 });
    expect(slotAt(-20, -5, 3, 100, 100, 5)).toEqual({ col: 0, row: 0, slot: 0 });
    expect(slotAt(50, 900, 3, 100, 100, 5).slot).toBe(5);
    expect(slotAt(50, 50, 3, 100, 100, 0).slot).toBe(0);
  });
});

describe("fence queries", () => {
  it("knows fences, blocks and the fence of a child", () => {
    const l = withFence();
    l.headings["h:1"] = { id: "h:1", text: "T", style: "title", align: "left" };
    l.placements["h:1"] = { m: "M", p: 0, c: 0, r: 5, w: 3 };
    l.folders["v:g"] = { id: "v:g", name: "G", color: null, children: ["c"] };
    l.placements["v:g"] = { m: "M", p: 0, c: 9, r: 0 };
    expect(isFence(l, "v:f")).toBe(true);
    expect(isFence(l, "v:g")).toBe(false);
    expect(isBlock(l, "h:1")).toBe(true);
    expect(isBlock(l, "x")).toBe(false);
    expect(fenceOf(l, "a")).toBe("v:f");
    expect(fenceOf(l, "c")).toBeNull();
    expect(fenceOf(l, "x")).toBeNull();
  });

  it("collapsing is stored on the group and survives normalizing", () => {
    const l = setCollapsed(withFence(), "v:f", true);
    expect(l.folders["v:f"].collapsed).toBe(true);
    expect(normalizeLayout(JSON.parse(JSON.stringify(l))).folders["v:f"].collapsed).toBe(true);
    const open = setCollapsed(l, "v:f", false);
    expect("collapsed" in open.folders["v:f"]).toBe(false);
    expect(setCollapsed(open, "v:f", false)).toBe(open);
  });
});

describe("creating fences and headings", () => {
  it("a fence takes the default size with the clicked cell as its corner", () => {
    const r = createFenceAt(emptyLayout(), grids, { m: "M", p: 0, c: 4, r: 2 }, "Kutu", null);
    expect(r.layout.folders[r.folderId]).toMatchObject({ display: "fence", children: [], name: "Kutu" });
    expect(r.layout.placements[r.folderId]).toEqual({ m: "M", p: 0, c: 4, r: 2, w: 3, h: 2 });
  });

  it("shifts left / up to stay on the grid, then shrinks, then goes to the nearest free spot", () => {
    const edge = createFenceAt(emptyLayout(), grids, { m: "M", p: 0, c: 9, r: 5 }, "K", null);
    expect(edge.layout.placements[edge.folderId]).toEqual({ m: "M", p: 0, c: 7, r: 4, w: 3, h: 2 });

    const l = emptyLayout();
    // a column of icons at c = 3 leaves only two free columns right of c = 1
    for (let r = 0; r < 6; r++) l.placements[`i${r}`] = { m: "M", p: 0, c: 3, r };
    for (let r = 0; r < 6; r++) l.placements[`j${r}`] = { m: "M", p: 0, c: 0, r };
    const small = blockNear(occupancy(l), grids, { m: "M", p: 0, c: 1, r: 0 }, [
      { w: 3, h: 2 },
      { w: 2, h: 2 },
    ]);
    expect(small).toEqual({ m: "M", p: 0, c: 1, r: 0, w: 2, h: 2 });

    const taken = blockNear(occupancy(l), grids, { m: "M", p: 0, c: 3, r: 0 }, [{ w: 3, h: 2 }]);
    expect(taken).toMatchObject({ w: 3, h: 2 });
    const occ = occupancy(l);
    expect(coveredKeys(taken).some((k) => occ.has(k))).toBe(false);
  });

  it("headings are 3 cells wide, dividers take the free run up to 6", () => {
    const l = emptyLayout();
    l.placements.x = { m: "M", p: 0, c: 6, r: 0 };
    expect(freeRun(occupancy(l), g, { m: "M", p: 0, c: 1, r: 0 }, 9)).toBe(5);
    expect(freeRun(occupancy(l), g, { m: "M", p: 0, c: 6, r: 0 }, 9)).toBe(0);

    const h = createHeadingNear(l, grids, { m: "M", p: 0, c: 1, r: 0 }, "title");
    expect(h.layout.headings[h.headingId]).toEqual({ id: h.headingId, text: "", style: "title", align: "left" });
    expect(h.layout.placements[h.headingId]).toEqual({ m: "M", p: 0, c: 1, r: 0, w: 3 });

    const d = createHeadingNear(l, grids, { m: "M", p: 0, c: 0, r: 1 }, "divider");
    expect(d.layout.placements[d.headingId]).toEqual({ m: "M", p: 0, c: 0, r: 1, w: 6 });

    const short = createHeadingNear(l, grids, { m: "M", p: 0, c: 4, r: 0 }, "divider");
    expect(short.layout.placements[short.headingId]).toEqual({ m: "M", p: 0, c: 4, r: 0, w: 2 });

    const moved = createHeadingNear(l, grids, { m: "M", p: 0, c: 6, r: 0 }, "title");
    const pl = moved.layout.placements[moved.headingId];
    expect(pl.w).toBe(3);
    expect(pl.c + 3 <= 6 || pl.c > 6 || pl.r !== 0).toBe(true);
  });

  it("underline is kept only when on", () => {
    const l = normalizeLayout({
      headings: { "h:1": { text: "A", style: "title", align: "center", underline: true }, "h:2": { underline: "yes" } },
      placements: { "h:1": { m: "M", p: 0, c: 0, r: 0 }, "h:2": { m: "M", p: 0, c: 1, r: 0 } },
    });
    expect(l.headings["h:1"].underline).toBe(true);
    expect("underline" in l.headings["h:2"]).toBe(false);
  });
});

describe("moving and resizing blocks", () => {
  it("snaps the held corner to the nearest cell and keeps the block on the grid", () => {
    const l = withFence();
    expect(snapMove(l, grids, "v:f", g, 0, 640, 260)).toEqual({ m: "M", p: 0, c: 6, r: 3, w: 3, h: 2 });
    expect(snapMove(l, grids, "v:f", g, 0, 990, 590)).toEqual({ m: "M", p: 0, c: 7, r: 4, w: 3, h: 2 });
    expect(snapMove(l, grids, "v:f", g, 1, -50, -50)).toEqual({ m: "M", p: 1, c: 0, r: 0, w: 3, h: 2 });
  });

  it("over taken cells it shows where the drop will really land", () => {
    const l = withFence();
    const to = snapMove(l, grids, "v:f", g, 0, 0, 0)!;
    expect(to).toMatchObject({ w: 3, h: 2 });
    expect(to.c === 0 && to.r === 0).toBe(false);
    const moved = moveToCell(l, grids, ["v:f"], "v:f", { m: to.m, p: to.p, c: to.c, r: to.r });
    expect(moved.placements["v:f"]).toEqual(to);
  });

  it("resizes by whole cells and refuses covering other entries", () => {
    const l = withFence();
    l.placements.y = { m: "M", p: 0, c: 6, r: 1 };
    // the handle (bottom-right corner) is dragged
    expect(snapResize(l, grids, "v:f", 200 + 4 * 100 - 30, 100 + 3 * 100 + 20)).toEqual({ w: 4, h: 3 });
    expect(snapResize(l, grids, "v:f", 200 + 5 * 100, 300)).toBeNull();
    expect(snapResize(l, grids, "v:f", 150, 50)).toEqual({ w: 1, h: 1 });
    expect(snapResize(l, grids, "v:f", 5000, 5000)).toBeNull();
    expect(snapResize(l, grids, "v:f", 500, 999, "x")).toEqual({ w: 3, h: 2 });
    expect(snapResize(l, grids, "nope", 0, 0)).toBeNull();
  });
});
