// Mouse and keyboard on the desktop beyond clicks and drags: double-click on the empty desktop
// hides / shows the icons, Ctrl+wheel zooms them, the arrow keys walk the grid (desktop, fences,
// the open panel), and the drop targets that are real files (folders and apps, shortcuts too).

import { api } from "../api";
import { t } from "../i18n";
import { FENCE_INSET, FENCE_PAD_X, FENCE_PAD_Y, FENCE_TITLE, fenceGeometry, fenceOf, isFence } from "../layout/blocks";
import { gridAt, primaryGrid } from "../layout/grid";
import { acceptsDrops, isFolderId, pageCount } from "../layout/model";
import type { Layout, Settings } from "../types";
import { isDragging } from "./dnd";
import {
  arrowDir,
  firstLast,
  gridStep,
  isDoubleClick,
  isExecutablePath,
  listRange,
  neighbour,
  rangeIds,
  roundScale,
  shortcutDropKind,
  wheelPixels,
  zoomBy,
  type CellRect,
  type Click,
  type Dir,
  type DropKind,
} from "./input";
import { liveItem, useLive } from "./live";
import { isUnlocked } from "./locks";
import { fenceBodies, panelGrid } from "./registry";
import { applySettings, recordOpen, refreshItems, saveSettings, setPage, toast, useDesk } from "./store";

const desk = () => useDesk.getState();

// ---------------------------------------------------------------- files as drop targets

const kinds = new Map<string, DropKind | null>();
const queue: { key: string; path: string }[] = [];
const asked = new Set<string>();
let running = 0;

function pump() {
  while (running < 3 && queue.length) {
    const { key, path } = queue.shift()!;
    running++;
    api
      .shortcutTarget(path)
      .then((info) => kinds.set(key, shortcutDropKind(info)))
      .catch(() => kinds.set(key, null))
      .finally(() => {
        running--;
        pump();
      });
  }
}

/**
 * A desktop item as a drop target for files: a folder (they move in) or an app (`.exe` & co., or a
 * shortcut to one or to a folder; it opens them). Shortcuts are resolved once per version in the
 * background (`shortcut_target`), so null can mean "not known yet"; drags re-evaluate every frame.
 */
export function dropKindOf(id: string): DropKind | null {
  const it = desk().itemMap.get(id);
  if (!it || it.kind === "system") return null;
  if (it.kind === "folder") return { kind: "dir", target: it.path };
  if (isExecutablePath(it.path)) return { kind: "app", target: it.path };
  if (!it.isShortcut) return null;
  const key = `${it.id}|${it.modified}`;
  const known = kinds.get(key);
  if (known !== undefined) return known;
  if (!asked.has(key)) {
    asked.add(key);
    // the one under the pointer goes first
    queue.unshift({ key, path: it.path });
    pump();
  }
  return null;
}

/** Resolves the shortcuts shown on the current pages before the pointer reaches them (drag start). */
export function warmDropKinds() {
  const { layout, pages, itemMap } = desk();
  for (const [id, pl] of Object.entries(layout.placements)) {
    if (pl.p !== (pages[pl.m] ?? 0)) continue;
    const it = itemMap.get(id);
    if (!it?.isShortcut) continue;
    const key = `${it.id}|${it.modified}`;
    if (kinds.has(key) || asked.has(key)) continue;
    asked.add(key);
    queue.push({ key, path: it.path });
  }
  pump();
}

/** The real directory behind a folder icon or a shortcut to a folder. */
export function realDirOf(id: string): string | null {
  const k = dropKindOf(id);
  return k?.kind === "dir" ? k.target : null;
}

/** Explorer's drop of files on an app icon: the app opens them (its own drop target, `drop_on_item`). */
export async function dropOnApp(appId: string, paths: string[]) {
  const it = desk().itemMap.get(appId);
  const k = dropKindOf(appId);
  if (!it || k?.kind !== "app" || !paths.length) return;
  try {
    // a .url has no drop target of its own: its file target gets the files
    const effect = await api.dropOnItem(it.ext === ".url" ? k.target : it.path, paths);
    recordOpen(appId);
    if (effect === "move") refreshItems().catch(() => {});
  } catch (e) {
    console.warn("drop on app", e);
    toast(t.dropOnAppFailed);
  }
}

/** Modifier keys during a drag from another app (its events carry none): asked from Rust, throttled. */
let keys = { ctrl: false, shift: false, alt: false };
let keysAt = 0;
let keysBusy = false;
export const heldKeys = () => keys;
export function refreshHeldKeys() {
  if (keysBusy || performance.now() - keysAt < 120) return;
  keysBusy = true;
  api
    .keyState()
    .then((k) => {
      keys = k ?? keys;
      keysAt = performance.now();
    })
    .catch(() => {})
    .finally(() => (keysBusy = false));
}

// ---------------------------------------------------------------- double-click on the empty desktop

let lastClick: Click | null = null;

/**
 * A plain click on the empty desktop (no drag, no modifier, not on a tile / fence / heading / the
 * page dots). Two of them close together toggle the icons (`behavior.doubleClickHide`).
 */
export function notePlainClick(x: number, y: number, time: number) {
  const st = desk();
  const cur = { t: time, x, y };
  if (!st.settings.behavior.doubleClickHide || st.panel || st.dialog || isDragging()) {
    lastClick = null;
    return;
  }
  if (!isDoubleClick(lastClick, cur)) {
    lastClick = cur;
    return;
  }
  lastClick = null;
  setIconsShown(!st.settings.behavior.showIcons);
}

function setIconsShown(show: boolean) {
  const s = desk().settings;
  if (s.behavior.showIcons === show) return;
  saveSettings({ ...s, behavior: { ...s.behavior, showIcons: show } });
  if (!show) {
    useDesk.setState({ selection: new Set(), rename: null });
    toast(t.iconsHidden, { label: t.showIconsAgain, run: () => setIconsShown(true) }, 5000);
  }
}

/** Forget a half double-click (a marquee that moved, a click elsewhere). */
export function resetPlainClick() {
  lastClick = null;
}

// ---------------------------------------------------------------- Ctrl+wheel zoom

/** The zoom gesture in progress: the unrounded scale, so small (pinch) steps add up. */
let zoom: { scale: number; last: number; raf: number; save: number } | null = null;

function onWheel(e: WheelEvent) {
  if (!e.ctrlKey) return;
  // never the WebView's own page zoom
  e.preventDefault();
  const st = desk();
  if (!st.settings.behavior.ctrlWheelZoom) return; // pages like a plain wheel, as before
  e.stopPropagation();
  if (st.dialog || isDragging()) return;
  const now = performance.now();
  if (!zoom || now - zoom.last > 400) {
    window.clearTimeout(zoom?.save);
    if (zoom?.raf) cancelAnimationFrame(zoom.raf);
    zoom = { scale: st.settings.grid.iconScale, last: now, raf: 0, save: 0 };
  }
  zoom.scale = zoomBy(zoom.scale, wheelPixels(e.deltaY, e.deltaMode));
  zoom.last = now;
  if (!zoom.raf) zoom.raf = requestAnimationFrame(applyZoom);
}

/** At most once a frame: the new size on screen at once, saved (and broadcast) once it settles. */
function applyZoom() {
  if (!zoom) return;
  zoom.raf = 0;
  const s = desk().settings;
  const k = roundScale(zoom.scale);
  if (k === s.grid.iconScale) return;
  applySettings({ ...s, grid: { ...s.grid, iconScale: k } });
  window.clearTimeout(zoom.save);
  zoom.save = window.setTimeout(() => {
    api.saveSettings(desk().settings).catch((err) => console.error("save_settings", err));
  }, 250);
}

/**
 * `settings-changed` while zooming: our own earlier save coming back would undo the last steps, so
 * the size on screen wins for a moment.
 */
export function keepLocalZoom(next: Settings): Settings {
  if (!zoom || performance.now() - zoom.last > 1200) return next;
  const k = desk().settings.grid.iconScale;
  return next.grid.iconScale === k ? next : { ...next, grid: { ...next.grid, iconScale: k } };
}

// ---------------------------------------------------------------- arrow keys

const pointer = { x: 0, y: 0 };
const onPointerMove = (e: PointerEvent) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
};

/** The entry the arrows last moved to, and where a Shift range starts. */
let focusId: string | null = null;
let anchorId: string | null = null;

function pageRects(l: Layout, m: string, p: number): CellRect[] {
  const out: CellRect[] = [];
  for (const [id, pl] of Object.entries(l.placements)) {
    if (pl.m === m && pl.p === p) out.push({ id, c: pl.c, r: pl.r, w: pl.w ?? 1, h: pl.h ?? 1 });
  }
  return out;
}

const rectOfPl = (id: string, l: Layout): CellRect | null => {
  const pl = l.placements[id];
  return pl ? { id, c: pl.c, r: pl.r, w: pl.w ?? 1, h: pl.h ?? 1 } : null;
};

/** A fence whose children the arrows can walk: open, holding its own children, not locked. */
function walkableFence(l: Layout, id: string) {
  const f = l.folders[id];
  return !!f && isFence(l, id) && !f.collapsed && acceptsDrops(f) && (!f.lock || isUnlocked(id)) && f.children.length > 0;
}

function select(ids: string[], focus: string, keepAnchor: boolean) {
  focusId = focus;
  if (!keepAnchor) anchorId = focus;
  useDesk.setState({ selection: new Set(ids), rename: null });
  const { layout, pages } = desk();
  const pl = layout.placements[focus] ?? layout.placements[fenceOf(layout, focus) ?? ""];
  if (pl && (pages[pl.m] ?? 0) !== pl.p) setPage(pl.m, pl.p);
}

function reveal(container: HTMLElement | null | undefined, y: number, h: number) {
  if (!container) return;
  if (y < container.scrollTop) container.scrollTop = y;
  else if (y + h > container.scrollTop + container.clientHeight) container.scrollTop = y + h - container.clientHeight;
}

/**
 * ←↑→↓ / Home / End / PageUp / PageDown on the desktop or in the open panel; true = handled.
 * Desktop: neighbours by cell geometry on the same monitor page (fences and headings are one
 * target; ← / → past the page edge go to the previous / next page), Shift extends the selection
 * as a box, ↓ on a fence enters it. In a fence: its own grid; ↑ from the first row selects the
 * fence, the other edges leave it. Panel: its grid. Nothing selected: the first icon of the page
 * under the pointer (an empty page: ← / → turn it, like before).
 */
export function handleNavKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  const dir = arrowDir(e.key);
  const edge = e.key === "Home" ? "first" : e.key === "End" ? "last" : null;
  const pageStep = e.key === "PageDown" ? 1 : e.key === "PageUp" ? -1 : 0;
  if (!dir && !edge && !pageStep) return false;
  const st = desk();
  if (st.panel) {
    e.preventDefault();
    panelNav(dir, edge, e.shiftKey);
    return true;
  }
  // hidden icons cannot be walked (or selected)
  if (!st.settings.behavior.showIcons) return false;
  e.preventDefault();
  desktopNav(dir, edge, pageStep, e.shiftKey);
  return true;
}

function panelNav(dir: Dir | null, edge: "first" | "last" | null, shift: boolean) {
  const list = panelGrid.shown;
  // a stack's fan has no grid; PageUp / PageDown do nothing in a panel
  if (!panelGrid.el || (!dir && !edge) || !list.length) return;
  const { selection, itemMap } = desk();
  const liveSel = useLive.getState().sel;
  const on = (id: string) => selection.has(id) || liveSel === id;
  const cur = focusId && list.includes(focusId) && on(focusId) ? focusId : list.find(on) ?? null;
  let next: number;
  if (!cur || edge) next = edge === "last" ? list.length - 1 : 0;
  else {
    const j = gridStep(list.indexOf(cur), list.length, Math.max(1, panelGrid.cols), dir!);
    if (j === null) return;
    next = j;
  }
  const id = list[next];
  if (!itemMap.has(id) && !isFolderId(id) && liveItem(id)) {
    // live entries have their own single selection
    focusId = anchorId = id;
    useLive.setState({ sel: id });
    useDesk.setState({ selection: new Set() });
  } else {
    if (shift && (!anchorId || !list.includes(anchorId) || !selection.has(anchorId))) anchorId = cur;
    const a = shift && anchorId ? list.indexOf(anchorId) : -1;
    select(a >= 0 ? listRange(list, a, next) : [id], id, a >= 0);
  }
  reveal(panelGrid.el, Math.floor(next / Math.max(1, panelGrid.cols)) * panelGrid.cellH, panelGrid.cellH + panelGrid.padY * 2);
}

/** The selected entry the arrows start from: the last one they moved to, else the last one picked. */
function currentEntry(l: Layout, selection: Set<string>): string | null {
  const placed = (id: string) => !!l.placements[id] || !!fenceOf(l, id);
  if (focusId && selection.has(focusId) && placed(focusId)) return focusId;
  let last: string | null = null;
  for (const id of selection) if (placed(id)) last = id;
  return last;
}

function desktopNav(dir: Dir | null, edge: "first" | "last" | null, pageStep: number, shift: boolean) {
  const { layout, grids, pages, selection } = desk();
  const cur = currentEntry(layout, selection);
  const curPl = cur ? layout.placements[cur] ?? layout.placements[fenceOf(layout, cur) ?? ""] : undefined;
  const g = (curPl && grids[curPl.m]) || gridAt(grids, pointer.x, pointer.y) || primaryGrid(grids);
  if (!g) return;
  const m = g.monitorId;

  if (pageStep) {
    const next = (pages[m] ?? 0) + pageStep;
    if (next >= 0 && next < pageCount(layout, m)) {
      setPage(m, next);
      focusId = anchorId = null;
      useDesk.setState({ selection: new Set() });
    }
    return;
  }

  if (!cur || !curPl) {
    const p = pages[m] ?? 0;
    const rects = pageRects(layout, m, p);
    if (!rects.length) {
      if (dir === "left" || dir === "right") {
        const next = p + (dir === "right" ? 1 : -1);
        if (next >= 0 && next < pageCount(layout, m)) setPage(m, next);
      }
      return;
    }
    const first = firstLast(rects, edge === "last" ? "last" : "first")!;
    select([first.id], first.id, false);
    return;
  }

  if (shift && (!anchorId || !selection.has(anchorId))) anchorId = cur;
  const fence = layout.placements[cur] ? null : fenceOf(layout, cur);
  if (fence) return fenceNav(fence, cur, dir, edge, shift);

  const rects = pageRects(layout, curPl.m, curPl.p);
  const from = rectOfPl(cur, layout)!;
  let target: CellRect | null;
  if (edge) target = firstLast(rects, edge);
  else if (dir === "down" && !shift && walkableFence(layout, cur)) {
    const kid = layout.folders[cur].children[0];
    select([kid], kid, false);
    revealFenceChild(cur, 0);
    return;
  } else {
    target = neighbour(rects, from, dir!);
    if (!target && !shift && (dir === "left" || dir === "right")) target = crossPage(layout, curPl.m, curPl.p, from, dir, g.cols);
  }
  if (!target) return;
  const anchor = shift && anchorId ? rectOfPl(anchorId, layout) : null;
  const anchorPl = anchor ? layout.placements[anchor.id] : undefined;
  if (anchor && anchorPl && anchorPl.m === curPl.m && anchorPl.p === curPl.p) select(rangeIds(rects, anchor, target), target.id, true);
  else select([target.id], target.id, false);
}

/** ← / → past the page edge: the entry of the next / previous page nearest the edge it comes in at. */
function crossPage(l: Layout, m: string, p: number, from: CellRect, dir: "left" | "right", cols: number): CellRect | null {
  const next = p + (dir === "right" ? 1 : -1);
  if (next < 0 || next >= pageCount(l, m)) return null;
  const virtual = { c: dir === "right" ? -1 : cols, w: 1, r: from.r, h: from.h };
  return neighbour(pageRects(l, m, next), virtual, dir);
}

function fenceNav(fenceId: string, cur: string, dir: Dir | null, edge: "first" | "last" | null, shift: boolean) {
  const { layout, grids } = desk();
  const pl = layout.placements[fenceId];
  const g = pl ? grids[pl.m] : undefined;
  const kids = layout.folders[fenceId]?.children ?? [];
  if (!pl || !g || !walkableFence(layout, fenceId)) {
    select([fenceId], fenceId, false);
    return;
  }
  const geo = fenceGeometry(g, pl);
  const i = kids.indexOf(cur);
  const next = edge ? (edge === "first" ? 0 : kids.length - 1) : gridStep(i, kids.length, geo.cols, dir!);
  if (next !== null) {
    const a = shift && anchorId ? kids.indexOf(anchorId) : -1;
    select(a >= 0 ? listRange(kids, a, next) : [kids[next]], kids[next], a >= 0);
    revealFenceChild(fenceId, next);
    return;
  }
  if (shift) return;
  if (dir === "up") {
    select([fenceId], fenceId, false);
    return;
  }
  // leave the fence on the side pressed, from the child's own row / column
  const w = pl.w ?? 1;
  const h = pl.h ?? 1;
  const body = fenceBodies.get(fenceId);
  const row = Math.floor(i / geo.cols);
  const col = i % geo.cols;
  const y = FENCE_INSET + FENCE_TITLE + FENCE_PAD_Y + row * geo.cellH - (body?.scrollTop ?? 0) + geo.cellH / 2;
  const x = FENCE_INSET + FENCE_PAD_X + col * geo.cellW + geo.cellW / 2;
  const clamp = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor(v)));
  const from =
    dir === "left" || dir === "right"
      ? { id: fenceId, c: pl.c, w, r: pl.r + clamp(y / g.cellH, h), h: 1 }
      : { id: fenceId, c: pl.c + clamp(x / g.cellW, w), w: 1, r: pl.r, h };
  const rects = pageRects(layout, pl.m, pl.p);
  let target = neighbour(rects, from, dir!);
  if (!target && (dir === "left" || dir === "right")) target = crossPage(layout, pl.m, pl.p, from, dir, g.cols);
  if (target) select([target.id], target.id, false);
}

function revealFenceChild(fenceId: string, index: number) {
  const { layout, grids } = desk();
  const pl = layout.placements[fenceId];
  const g = pl ? grids[pl.m] : undefined;
  if (!pl || !g) return;
  const geo = fenceGeometry(g, pl);
  reveal(fenceBodies.get(fenceId), Math.floor(index / geo.cols) * geo.cellH, geo.cellH + FENCE_PAD_Y * 2);
}

// ---------------------------------------------------------------- setup

/** Window listeners of the desktop (once, from DesktopView). */
export function setupInteraction(): () => void {
  // capture + not passive: runs before React's wheel handlers and may cancel the WebView zoom
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  return () => {
    window.removeEventListener("wheel", onWheel, { capture: true });
    window.removeEventListener("pointermove", onPointerMove);
  };
}
