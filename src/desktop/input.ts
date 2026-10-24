// Pure helpers behind keyboard and mouse input on the desktop: arrow-key neighbours on the grid
// (spans count as one target), steps in a linear grid (panels, fences), double-click detection,
// the Ctrl+wheel zoom step and Explorer's copy / move rule for drops. No store, no DOM.

export type Dir = "left" | "right" | "up" | "down";

/** An entry's cells on one monitor page: top-left column / row and span. */
export type CellRect = { id: string; c: number; r: number; w: number; h: number };

const ARROWS: Record<string, Dir> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
export const arrowDir = (key: string): Dir | null => ARROWS[key] ?? null;

const lexLess = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

/**
 * The entry next to `from` in direction `dir`. Only entries wholly on that side count. Entries
 * that share a row (left / right) or column (up / down) with `from` win at any distance, the
 * nearest first; else the nearest by gap + 2 × offset. Ties: closest centre, then position.
 */
export function neighbour(entries: CellRect[], from: Omit<CellRect, "id"> & { id?: string }, dir: Dir): CellRect | null {
  const horiz = dir === "left" || dir === "right";
  const centre = horiz ? from.r + from.h / 2 : from.c + from.w / 2;
  let best: CellRect | null = null;
  let bestKey: number[] | null = null;
  for (const e of entries) {
    if (e.id === from.id) continue;
    const gap =
      dir === "right" ? e.c - (from.c + from.w)
      : dir === "left" ? from.c - (e.c + e.w)
      : dir === "down" ? e.r - (from.r + from.h)
      : from.r - (e.r + e.h);
    if (gap < 0) continue;
    const [a0, a1, b0, b1] = horiz ? [from.r, from.r + from.h, e.r, e.r + e.h] : [from.c, from.c + from.w, e.c, e.c + e.w];
    const overlap = b0 < a1 && a0 < b1;
    const off = overlap ? 0 : b0 >= a1 ? b0 - a1 + 1 : a0 - b1 + 1;
    const mid = horiz ? e.r + e.h / 2 : e.c + e.w / 2;
    const key = [overlap ? 0 : 1, gap + 2 * off, Math.abs(mid - centre), horiz ? e.r : e.c, horiz ? e.c : e.r];
    if (!bestKey || lexLess(key, bestKey)) {
      best = e;
      bestKey = key;
    }
  }
  return best;
}

/** Windows' desktop order (column by column): the first / last entry of a page. */
export function firstLast(entries: CellRect[], which: "first" | "last"): CellRect | null {
  if (!entries.length) return null;
  const sorted = [...entries].sort((a, b) => a.c - b.c || a.r - b.r);
  return which === "first" ? sorted[0] : sorted[sorted.length - 1];
}

/** Ids of the entries touching the box spanned by `a` and `b` (Shift+arrows on the desktop). */
export function rangeIds(entries: CellRect[], a: CellRect, b: CellRect): string[] {
  const c0 = Math.min(a.c, b.c);
  const r0 = Math.min(a.r, b.r);
  const c1 = Math.max(a.c + a.w, b.c + b.w);
  const r1 = Math.max(a.r + a.h, b.r + b.h);
  return entries.filter((e) => e.c < c1 && e.c + e.w > c0 && e.r < r1 && e.r + e.h > r0).map((e) => e.id);
}

/**
 * One step in a grid filled row by row (`n` items, `cols` per row): the new index, or null at the
 * edge. Down from the row above a shorter last row goes to the last item.
 */
export function gridStep(i: number, n: number, cols: number, dir: Dir): number | null {
  if (n <= 0 || cols <= 0) return null;
  const col = i % cols;
  const row = Math.floor(i / cols);
  const lastRow = Math.floor((n - 1) / cols);
  switch (dir) {
    case "left":
      return col > 0 ? i - 1 : null;
    case "right":
      return col < cols - 1 && i + 1 < n ? i + 1 : null;
    case "up":
      return row > 0 ? i - cols : null;
    case "down":
      return i + cols < n ? i + cols : row < lastRow ? n - 1 : null;
  }
}

/** The ids from index `a` to index `b` of `list`, both included. */
export function listRange(list: string[], a: number, b: number): string[] {
  return list.slice(Math.min(a, b), Math.max(a, b) + 1);
}

// ---------------------------------------------------------------- double-click

export type Click = { t: number; x: number; y: number };
/** Windows' default double-click time and (about) its double-click rectangle. */
export const DOUBLE_CLICK_MS = 500;
export const DOUBLE_CLICK_PX = 4;

/** `cur` completes a double-click with `prev` (both plain clicks: no drag in between). */
export function isDoubleClick(prev: Click | null, cur: Click, ms = DOUBLE_CLICK_MS, px = DOUBLE_CLICK_PX) {
  if (!prev) return false;
  const dt = cur.t - prev.t;
  return dt >= 0 && dt <= ms && Math.hypot(cur.x - prev.x, cur.y - prev.y) <= px;
}

// ---------------------------------------------------------------- Ctrl+wheel zoom

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
/** One wheel notch (100 px) zooms by this factor. */
export const ZOOM_STEP = 1.1;

/** A wheel event's vertical delta in pixels (line mode ≈ 33 px a line, page mode = 8 notches). */
export function wheelPixels(deltaY: number, deltaMode: number) {
  const px = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 800 : deltaY;
  // a burst of accelerated notches in one event: at most three at a time
  return Math.max(-300, Math.min(300, px));
}

/** Icon scale after `px` of wheel (up = negative = bigger), clamped; not rounded, so small steps add up. */
export function zoomBy(scale: number, px: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale * ZOOM_STEP ** (-px / 100)));
}

export const roundScale = (s: number) => Math.round(s * 100) / 100;

// ---------------------------------------------------------------- drops

/** "c:" or "\\server\share" (lowercased), like `shell::volume_of`. */
export function volumeOf(path: string) {
  const n = path.replace(/\//g, "\\").toLowerCase();
  if (n.startsWith("\\\\")) {
    const [server = "", share = ""] = n.slice(2).split("\\");
    return `\\\\${server}\\${share}`;
  }
  return n.slice(0, 2);
}

/** Explorer's rule for files dropped into a folder: Ctrl copies, Shift moves, else the same volume moves and another copies. */
export function dropEffect(src: string, destDir: string, keys: { ctrl: boolean; shift: boolean }): "copy" | "move" {
  if (keys.ctrl && !keys.shift) return "copy";
  if (keys.shift && !keys.ctrl) return "move";
  return volumeOf(src) === volumeOf(destDir) ? "move" : "copy";
}

const EXECUTABLE = /\.(exe|bat|cmd|com)$/i;
export const isExecutablePath = (p: string) => EXECUTABLE.test(p.trim().replace(/^"|"$/g, ""));

/** "file:///C:/x/app.exe" → "C:\x\app.exe", "file://server/share/x" → "\\server\share\x". */
export function fileUrlPath(url: string) {
  let rest = url.replace(/^file:/i, "");
  let decoded = rest;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    /* keep it as it is */
  }
  rest = decoded.replace(/\//g, "\\");
  if (/^\\\\\\[a-z]:/i.test(rest)) return rest.slice(3);
  return rest.startsWith("\\\\") ? rest : rest.replace(/^\\+/, "");
}

export type DropKind = { kind: "app" | "dir"; target: string };

/**
 * What a shortcut is as a drop target, from `shortcut_target`: an app (dropped files open with it),
 * a folder (they move in) or neither (null).
 */
export function shortcutDropKind(info: { target: string; isDir?: boolean } | null): DropKind | null {
  const target = info?.target?.trim() ?? "";
  if (!target) return null;
  if (info?.isDir) return { kind: "dir", target };
  const file = /^file:/i.test(target) ? fileUrlPath(target) : target;
  return isExecutablePath(file) ? { kind: "app", target: file } : null;
}
