import type { Environment, MonitorInfo, Placement, Settings } from "../types";

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

const LINE_HEIGHT = 1.28; // .tile-label line-height (font-size = settings.labels.size)
/** Narrower cells break labels mid-word (Windows' own spacing is ~75 px). */
const MIN_CELL_W = 76;

/** Icon and cell size on one monitor, in CSS px of the desktop window. `winIcon` = `Environment.windowsIconSize`. */
export function cellMetrics(m: MonitorInfo, scale: number, s: Settings, winIcon: number) {
  const k = s.grid.iconScale || 1;
  const label = s.grid.labels ? 7 + s.grid.labelLines * s.labels.size * LINE_HEIGHT : 0;
  if (!s.grid.autoSize) {
    if (k === 1) return { iconSize: s.grid.iconSize, cellW: s.grid.cellWidth, cellH: s.grid.cellHeight };
    const iconSize = Math.round(Math.min(256, Math.max(16, s.grid.iconSize * k)));
    return {
      iconSize,
      cellW: Math.max(s.grid.cellWidth, iconSize + 30),
      cellH: Math.max(s.grid.cellHeight, Math.round(ICON_TOP * 2 + iconSize + label)),
    };
  }
  // automatic = the size Windows' own desktop shows, at this monitor's scaling
  const iconSize = Math.round(Math.min(256, Math.max(16, ((winIcon * (m.scale || scale)) / scale) * k)));
  // bigger label text needs proportionally wider cells, else every word breaks
  const minW = s.grid.labels ? Math.round((MIN_CELL_W * s.labels.size) / 12) : MIN_CELL_W;
  return { iconSize, cellW: Math.max(iconSize + 30, MIN_CELL_W, minW), cellH: Math.round(ICON_TOP * 2 + iconSize + label) };
}

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
    const { iconSize, cellW: minCellW, cellH } = cellMetrics(m, scale, s, env.windowsIconSize);
    const cols = Math.max(1, Math.floor((workWidth - GRID_PAD * 2) / minCellW));
    // the leftover width is spread over the columns, so the last column reaches the right edge
    const cellW = Math.max(minCellW, (workWidth - GRID_PAD * 2) / cols);
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
      iconSize,
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

/** Keys of every cell an entry covers: w × h cells from its top-left cell (unset = 1 × 1). */
export function coveredKeys(pl: Placement): string[] {
  const w = pl.w ?? 1;
  const h = pl.h ?? 1;
  if (w === 1 && h === 1) return [placementKey(pl)];
  const out: string[] = [];
  for (let dc = 0; dc < w; dc++) for (let dr = 0; dr < h; dr++) out.push(cellKey(pl.m, pl.p, pl.c + dc, pl.r + dr));
  return out;
}

/** The whole w × h block lies inside the grid. */
export function spanInBounds(g: GridInfo, pl: Placement) {
  return pl.c >= 0 && pl.r >= 0 && pl.c + (pl.w ?? 1) <= g.cols && pl.r + (pl.h ?? 1) <= g.rows;
}

/** Column-major (Windows) order index. */
export const orderIndex = (g: GridInfo, c: number, r: number) => c * g.rows + r;
export const fromOrderIndex = (g: GridInfo, i: number) => ({ c: Math.floor(i / g.rows), r: i % g.rows });
