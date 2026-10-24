// Fences (groups shown as an always-open box over w × h cells) and headings / dividers on the
// desktop grid: geometry, hit testing and placement. Pure; every operation returns a new layout.

import type { Heading, Layout, Placement } from "../types";
import { cellKey, cellXY, primaryGrid, type GridInfo, type GridMap } from "./grid";
import {
  canPlace,
  createFolderAt,
  createHeadingAt,
  DEFAULT_FENCE_SIZE,
  isFolderId,
  isHeadingId,
  nearestFree,
  occupancy,
  resizeSpan,
  spanOf,
  withSpan,
} from "./model";

/** The box sits this far inside its cells. */
export const FENCE_INSET = 4;
export const FENCE_TITLE = 28;
/** Padding of the children grid inside the body. */
export const FENCE_PAD_X = 4;
export const FENCE_PAD_Y = 2;

/** Sizes a new fence tries, largest first. */
export const FENCE_SIZES = [DEFAULT_FENCE_SIZE, { w: 2, h: 2 }, { w: 2, h: 1 }];
export const HEADING_WIDTH = 3;
export const DIVIDER_MAX_WIDTH = 6;

/** A group with display "fence" that sits on the desktop. */
export const isFence = (l: Layout, id: string) =>
  isFolderId(id) && l.folders[id]?.display === "fence" && !!l.placements[id];

/** Fences and headings: drawn as blocks over their cells, moved / resized by their own handles. */
export const isBlock = (l: Layout, id: string) => (isHeadingId(id) && !!l.headings[id]) || isFence(l, id);

/** The fence `id` is a direct child of, else null. */
export function fenceOf(l: Layout, id: string): string | null {
  for (const f of Object.values(l.folders)) {
    if (f.children.includes(id)) return isFence(l, f.id) ? f.id : null;
  }
  return null;
}

// ---------------------------------------------------------------- geometry

export type FenceGeometry = {
  /** the box, relative to the monitor surface */
  x: number;
  y: number;
  w: number;
  h: number;
  /** top of the body (below the title bar), relative to the monitor surface */
  bodyY: number;
  bodyH: number;
  /** the children grid */
  cols: number;
  cellW: number;
  cellH: number;
};

export function fenceGeometry(g: GridInfo, pl: Placement, collapsed = false): FenceGeometry {
  const span = spanOf(pl);
  const { x, y } = cellXY(g, pl.c, pl.r);
  const w = span.w * g.cellW - FENCE_INSET * 2;
  const full = span.h * g.cellH - FENCE_INSET * 2;
  const h = collapsed ? Math.min(full, FENCE_TITLE) : full;
  const inner = Math.max(1, w - FENCE_PAD_X * 2);
  const cols = Math.max(1, Math.round(inner / g.cellW));
  return {
    x: x + FENCE_INSET,
    y: y + FENCE_INSET,
    w,
    h,
    bodyY: y + FENCE_INSET + FENCE_TITLE,
    bodyH: Math.max(0, h - FENCE_TITLE),
    cols,
    cellW: inner / cols,
    cellH: g.cellH,
  };
}

/** Height of a fence's children grid with `count` children. */
export const fenceContentHeight = (geo: FenceGeometry, count: number) =>
  Math.ceil(count / geo.cols) * geo.cellH + FENCE_PAD_Y * 2;

/** Top-left of child slot `i`, relative to the children grid (scrolling included). */
export const fenceSlotXY = (geo: FenceGeometry, i: number) => ({
  x: FENCE_PAD_X + (i % geo.cols) * geo.cellW,
  y: FENCE_PAD_Y + Math.floor(i / geo.cols) * geo.cellH,
});

/**
 * The slot under a point of a children grid of `count` items plus one free slot; `bx` / `by` are
 * measured from the grid's first cell (scrolling included).
 */
export function slotAt(bx: number, by: number, cols: number, cellW: number, cellH: number, count: number) {
  const col = Math.min(cols - 1, Math.max(0, Math.floor(bx / cellW)));
  const row = Math.max(0, Math.floor(by / cellH));
  return { col, row, slot: Math.min(Math.max(0, count), row * cols + col) };
}

/**
 * Where a point (relative to the monitor surface) falls in a fence: the title bar (also the margin
 * around the box and a collapsed body) or the body, with the point in children-grid coordinates.
 */
export function fenceHit(geo: FenceGeometry, lx: number, ly: number, scrollTop = 0) {
  const body = geo.bodyH > 0 && ly >= geo.bodyY;
  return {
    part: body ? ("body" as const) : ("title" as const),
    bx: lx - geo.x - FENCE_PAD_X,
    by: ly - geo.bodyY - FENCE_PAD_Y + scrollTop,
  };
}

// ---------------------------------------------------------------- placement

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Where a new block goes for a click on `cell`: the first of `sizes` that fits with the clicked
 * cell inside it (the cell as its top-left corner first, else shifted left / up), else the
 * nearest free spot for the first size.
 */
export function blockNear(
  occ: Map<string, string>,
  grids: GridMap,
  cell: Placement,
  sizes: { w: number; h: number }[],
): Placement {
  const g = grids[cell.m] ?? primaryGrid(grids);
  for (const s of sizes) {
    const w = Math.min(s.w, g.cols);
    const h = Math.min(s.h, g.rows);
    for (let dc = 0; dc < w; dc++) {
      for (let dr = 0; dr < h; dr++) {
        const pl = withSpan({ m: g.monitorId, p: cell.p, c: cell.c - dc, r: cell.r - dr }, w, h);
        if (pl.c >= 0 && pl.r >= 0 && canPlace(occ, grids, pl)) return pl;
      }
    }
  }
  const first = sizes[0] ?? { w: 1, h: 1 };
  return nearestFree(occ, grids, withSpan({ ...cell, m: g.monitorId }, first.w, first.h));
}

/** Free cells on `pl`'s row from `pl` to the right (0 when `pl` is taken), at most `max`. */
export function freeRun(occ: Map<string, string>, g: GridInfo, pl: Placement, max: number) {
  let n = 0;
  while (n < max && pl.c + n < g.cols && !occ.has(cellKey(pl.m, pl.p, pl.c + n, pl.r))) n++;
  return n;
}

/** A new empty group shown as a fence near `cell` (see `blockNear`). */
export function createFenceAt(
  l0: Layout,
  grids: GridMap,
  cell: Placement,
  name: string,
  color: string | null,
): { layout: Layout; folderId: string } {
  const pl = blockNear(occupancy(l0), grids, cell, FENCE_SIZES);
  // the block is free, so the group's single cell lands on its top-left corner
  const r = createFolderAt(l0, grids, { placement: withSpan(pl) }, name, color);
  r.layout.folders[r.folderId] = { ...r.layout.folders[r.folderId], display: "fence" };
  r.layout.placements[r.folderId] = pl;
  return r;
}

/**
 * A new heading (3 cells wide where that fits) or divider (the free run to the right, up to 6
 * cells) at `cell`; a shorter one when less is free, the nearest free spot when the cell is taken.
 */
export function createHeadingNear(
  l0: Layout,
  grids: GridMap,
  cell: Placement,
  style: Heading["style"],
): { layout: Layout; headingId: string } {
  const g = grids[cell.m] ?? primaryGrid(grids);
  const at = { m: g.monitorId, p: cell.p, c: cell.c, r: cell.r };
  const max = Math.min(style === "divider" ? DIVIDER_MAX_WIDTH : HEADING_WIDTH, g.cols);
  const run = freeRun(occupancy(l0), g, at, max);
  return createHeadingAt(l0, grids, { style, text: "" }, withSpan(at, run || max, 1));
}

/**
 * Where a moved block lands when its top-left corner is held at (lx, ly) on monitor `g`'s
 * surface, page `page`: the nearest cell (kept on the grid), else the nearest spot where the whole
 * block fits — what `moveToCell` will do on the drop.
 */
export function snapMove(l: Layout, grids: GridMap, id: string, g: GridInfo, page: number, lx: number, ly: number): Placement | null {
  const pl = l.placements[id];
  if (!pl) return null;
  const { w, h } = spanOf(pl);
  const c = clamp(Math.round((lx - g.originX) / g.cellW), 0, Math.max(0, g.cols - w));
  const r = clamp(Math.round((ly - g.originY) / g.cellH), 0, Math.max(0, g.rows - h));
  const want = withSpan({ m: g.monitorId, p: page, c, r }, w, h);
  const occ = occupancy(l, new Set([id]));
  return canPlace(occ, grids, want) ? want : nearestFree(occ, grids, want);
}

/**
 * Size of a block whose bottom-right handle is dragged to (lx, ly) on its monitor's surface:
 * whole cells, at least 1 × 1, kept on the grid ("x": only the width changes). Null when the block
 * would cover another entry.
 */
export function snapResize(
  l: Layout,
  grids: GridMap,
  id: string,
  lx: number,
  ly: number,
  axis: "xy" | "x" = "xy",
): { w: number; h: number } | null {
  const pl = l.placements[id];
  const g = pl ? grids[pl.m] : undefined;
  if (!pl || !g) return null;
  const cur = spanOf(pl);
  const { x, y } = cellXY(g, pl.c, pl.r);
  const w = clamp(Math.round((lx - x) / g.cellW), 1, Math.max(1, g.cols - pl.c));
  const h = axis === "x" ? cur.h : clamp(Math.round((ly - y) / g.cellH), 1, Math.max(1, g.rows - pl.r));
  if (w === cur.w && h === cur.h) return cur;
  return resizeSpan(l, grids, id, w, h) !== l ? { w, h } : null;
}

/** Fold a fence to its title bar or open it again (its cells stay reserved). */
export function setCollapsed(l0: Layout, id: string, collapsed: boolean): Layout {
  const f = l0.folders[id];
  if (!f || !!f.collapsed === collapsed) return l0;
  const next = { ...f };
  if (collapsed) next.collapsed = true;
  else delete next.collapsed;
  return { ...l0, folders: { ...l0.folders, [id]: next } };
}
