import type { Environment, Placement, Settings } from "../types";

/** Per-monitor grid geometry. All values are CSS px. */
export type GridInfo = {
  monitorId: string;
  primary: boolean;
  /** monitor surface position/size inside the desktop window */
  left: number;
  top: number;
  width: number;
  height: number;
  /** work area relative to the monitor surface */
  workLeft: number;
  workTop: number;
  workWidth: number;
  workHeight: number;
  /** first cell top-left relative to the monitor surface */
  originX: number;
  originY: number;
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  iconSize: number;
};

export type GridMap = Record<string, GridInfo>;

export const GRID_PAD = 3;
export const ICON_TOP = 5;

export function computeGrids(env: Environment, s: Settings): GridMap {
  const scale = env.scaleFactor || 1;
  const out: GridMap = {};
  for (const m of env.monitors) {
    const left = (m.bounds.x - env.windowOrigin.x) / scale;
    const top = (m.bounds.y - env.windowOrigin.y) / scale;
    const width = m.bounds.width / scale;
    const height = m.bounds.height / scale;
    const workLeft = (m.work.x - m.bounds.x) / scale;
    const workTop = (m.work.y - m.bounds.y) / scale;
    const workWidth = m.work.width / scale;
    const workHeight = m.work.height / scale;
    const cellW = s.grid.cellWidth;
    const cellH = s.grid.cellHeight;
    const cols = Math.max(1, Math.floor((workWidth - GRID_PAD * 2) / cellW));
    const rows = Math.max(1, Math.floor((workHeight - GRID_PAD * 2) / cellH));
    out[m.id] = {
      monitorId: m.id,
      primary: m.primary,
      left,
      top,
      width,
      height,
      workLeft,
      workTop,
      workWidth,
      workHeight,
      originX: workLeft + GRID_PAD,
      originY: workTop + GRID_PAD,
      cols,
      rows,
      cellW,
      cellH,
      iconSize: s.grid.iconSize,
    };
  }
  return out;
}

export function primaryGrid(grids: GridMap): GridInfo {
  const all = Object.values(grids);
  return all.find((g) => g.primary) ?? all[0];
}

export function orderedGrids(grids: GridMap): GridInfo[] {
  return Object.values(grids).sort((a, b) =>
    a.primary === b.primary ? a.left - b.left || a.top - b.top : a.primary ? -1 : 1,
  );
}

export function cellXY(g: GridInfo, c: number, r: number) {
  return { x: g.originX + c * g.cellW, y: g.originY + r * g.cellH };
}

/** The icon image rectangle inside a cell, relative to the monitor surface. */
export function iconBox(g: GridInfo, c: number, r: number) {
  const { x, y } = cellXY(g, c, r);
  return { x: x + (g.cellW - g.iconSize) / 2, y: y + ICON_TOP, w: g.iconSize, h: g.iconSize };
}

/** Grid that contains a window-space point (or the nearest one). */
export function gridAt(grids: GridMap, x: number, y: number): GridInfo | null {
  let best: GridInfo | null = null;
  let bestD = Infinity;
  for (const g of Object.values(grids)) {
    const dx = x < g.left ? g.left - x : x > g.left + g.width ? x - (g.left + g.width) : 0;
    const dy = y < g.top ? g.top - y : y > g.top + g.height ? y - (g.top + g.height) : 0;
    const d = dx + dy;
    if (d === 0) return g;
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  return best;
}

/** Cell under a point given relative to the monitor surface (clamped into the grid). */
export function cellAt(g: GridInfo, lx: number, ly: number) {
  const c = Math.floor((lx - g.originX) / g.cellW);
  const r = Math.floor((ly - g.originY) / g.cellH);
  return {
    c: Math.min(g.cols - 1, Math.max(0, c)),
    r: Math.min(g.rows - 1, Math.max(0, r)),
  };
}

export const cellKey = (m: string, p: number, c: number, r: number) => `${m}|${p}|${c}|${r}`;
export const placementKey = (pl: Placement) => cellKey(pl.m, pl.p, pl.c, pl.r);

export function inBounds(g: GridInfo, c: number, r: number) {
  return c >= 0 && r >= 0 && c < g.cols && r < g.rows;
}

/** Column-major (Windows) order index. */
export const orderIndex = (g: GridInfo, c: number, r: number) => c * g.rows + r;
export const fromOrderIndex = (g: GridInfo, i: number) => ({ c: Math.floor(i / g.rows), r: i % g.rows });
