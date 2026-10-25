import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { t } from "../i18n";
import { computeGrids, type GridMap } from "../layout/grid";
import {
  anchorToEdges,
  autoArrange,
  emptyLayout,
  forgetHomes,
  importWindowsLayout,
  isFolderId,
  isHeadingId,
  normalizeLayout,
  reconcile,
  remapIds,
} from "../layout/model";
import { collectSmart, newItemIds, recordOpen as countOpen, smartChanged } from "../layout/smart";
import { applyTheme, DEFAULT_SETTINGS, normalizeSettings } from "../settings";
import type { DesktopItem, Environment, Layout, Placement, Quiet, Settings, WallpaperInfo } from "../types";
import { playSound } from "./sounds";

// ---------------------------------------------------------------- types

export type FileOp =
  | { kind: "recycle"; paths: string[] }
  | { kind: "rename"; from: string; to: string }
  | { kind: "move"; moves: { from: string; to: string }[] };

type HistoryEntry = { before: Layout; after: Layout; fileOp?: FileOp };

export type Toast = {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
};

export type PanelState = {
  stack: string[]; // folder ids, top-level first
  monitorId: string;
  origin: { x: number; y: number; w: number; h: number } | null; // window coords of the folder tile
  /** the tile the panel grows from when it is not stack[0]'s (a group inside a fence) */
  from?: string;
  editTitle: boolean;
  dir: 1 | -1;
  openedAt: number;
};

export type DialogState =
  | { kind: "addApp"; placement: Placement | null }
  | { kind: "customize"; id: string; focus?: "rule" | "source" }
  | { kind: "confirmDeleteFolder"; folderIds: string[]; files: string[] }
  | { kind: "quicklook"; id: string }
  | { kind: "unlock"; id: string } // a locked group asks for Windows Hello / its PIN (locks.ts)
  | null;

export type RenameState = { id: string; where: "desktop" | "panel" } | null;

// ---------------------------------------------------------------- store

type DeskState = {
  ready: boolean;
  env: Environment | null;
  grids: GridMap;
  items: DesktopItem[];
  itemMap: Map<string, DesktopItem>;
  layout: Layout;
  settings: Settings;
  wallpapers: WallpaperInfo[];
  pages: Record<string, number>;
  selection: Set<string>;
  panel: PanelState | null;
  dialog: DialogState;
  rename: RenameState;
  toasts: Toast[];
  raised: boolean;
  quiet: Quiet; // game / battery mode (Rust `quiet-changed`)
  iconBust: number;
  canUndo: boolean;
  canRedo: boolean;
};

export const useDesk = create<DeskState>(() => ({
  ready: false,
  env: null,
  grids: {},
  items: [],
  itemMap: new Map(),
  layout: emptyLayout(),
  settings: DEFAULT_SETTINGS,
  wallpapers: [],
  pages: {},
  selection: new Set(),
  panel: null,
  dialog: null,
  rename: null,
  toasts: [],
  raised: false,
  quiet: { game: false, battery: false, covered: [] },
  iconBust: 0,
  canUndo: false,
  canRedo: false,
}));

const get = () => useDesk.getState();
const set = useDesk.setState;

// ---------------------------------------------------------------- persistence

let saveTimer: number | undefined;
function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    api.saveLayout(get().layout).catch((e) => console.error("save_layout", e));
  }, 350);
}

export function saveSettings(next: Settings) {
  applySettings(next);
  api.saveSettings(next).catch((e) => console.error("save_settings", e));
}

// ---------------------------------------------------------------- pending placements for new items

const pending = new Map<string, { pl: Placement; until: number }>();
let newItemHook: { placement: Placement | null; rename: boolean; until: number } | null = null;

export function expectItemAt(id: string, pl: Placement) {
  pending.set(id, { pl, until: Date.now() + 20000 });
}

/**
 * Something on the desktop menu is about to create items (New ▸, Paste, Compress): whatever brand-new
 * items appear next land near `placement`; with `rename`, a single new item starts being renamed.
 */
export function expectNewItem(placement: Placement | null, rename = false) {
  newItemHook = { placement, rename, until: Date.now() + 20000 };
}

function pendingMap(): Map<string, Placement> {
  const now = Date.now();
  const m = new Map<string, Placement>();
  for (const [id, v] of pending) {
    if (v.until < now) pending.delete(id);
    else m.set(id, v.pl);
  }
  return m;
}

// ---------------------------------------------------------------- history

const undoStack: HistoryEntry[] = [];
const redoStack: HistoryEntry[] = [];
let historyBusy = false;

function syncHistoryFlags() {
  set({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
}

/** Apply a user change: records undo, auto-arranges if enabled, saves. */
export function commit(next: Layout, fileOp?: FileOp, priority?: Set<string>) {
  const { layout: before, settings, grids } = get();
  let after = next;
  // a new smart group / changed rule collects the matching loose items in the same undo step
  const smart = smartChanged(before, after);
  if (smart.length) after = collectSmart(after, get().items, Date.now(), { groups: smart });
  if (settings.grid.autoArrange) after = autoArrange(after, grids, priority);
  if (after === before) return;
  after = forgetHomes(before, after);
  undoStack.push({ before, after, fileOp });
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  set({ layout: after });
  syncHistoryFlags();
  scheduleSave();
}

/** Replace the layout without an undo entry (reconciliation, imports). */
export function replaceLayout(next: Layout) {
  if (next === get().layout) return;
  set({ layout: next });
  scheduleSave();
}

/** Open counts aren't undoable: history entries take the current ones. */
const withUsage = (l: Layout): Layout => ({ ...l, usage: get().layout.usage });

/** An item was opened (here or from the search window): counts for frequent groups, no undo entry. */
export function recordOpen(id: string) {
  const l = get().layout;
  replaceLayout(countOpen(l, id));
}

export function recordFileOpOnly(fileOp: FileOp) {
  const l = get().layout;
  undoStack.push({ before: l, after: l, fileOp });
  redoStack.length = 0;
  syncHistoryFlags();
}

async function revert(op: FileOp) {
  if (op.kind === "recycle") await api.restoreFromRecycle(op.paths);
  else if (op.kind === "rename") await api.renameItem(op.to, baseName(op.from, true));
  else if (op.kind === "move") {
    for (const mv of op.moves) await api.moveIntoFolder([mv.to], dirName(mv.from));
  }
}

async function reapply(op: FileOp) {
  if (op.kind === "recycle") await api.recycle(op.paths);
  else if (op.kind === "rename") await api.renameItem(op.from, baseName(op.to, true));
  else if (op.kind === "move") {
    for (const mv of op.moves) await api.moveIntoFolder([mv.from], dirName(mv.to));
  }
}

export async function undo() {
  if (historyBusy) return;
  const e = undoStack.pop();
  if (!e) {
    toast(t.nothingToUndo);
    return;
  }
  historyBusy = true;
  try {
    if (e.fileOp) await revert(e.fileOp);
    set({ layout: withUsage(e.before) });
    redoStack.push(e);
    await refreshItems();
    scheduleSave();
    toast(t.undone);
  } catch (err) {
    console.error(err);
    toast(t.operationFailed);
  } finally {
    historyBusy = false;
    syncHistoryFlags();
  }
}

export async function redo() {
  if (historyBusy) return;
  const e = redoStack.pop();
  if (!e) return;
  historyBusy = true;
  try {
    if (e.fileOp) await reapply(e.fileOp);
    set({ layout: withUsage(e.after) });
    undoStack.push(e);
    await refreshItems();
    scheduleSave();
    toast(t.redone);
  } catch (err) {
    console.error(err);
    toast(t.operationFailed);
  } finally {
    historyBusy = false;
    syncHistoryFlags();
  }
}

// ---------------------------------------------------------------- toasts

let toastSeq = 1;
export function toast(text: string, action?: Toast["action"], ms = 6000) {
  const id = toastSeq++;
  set({ toasts: [...get().toasts.slice(-2), { id, text, action }] });
  window.setTimeout(() => dismissToast(id), ms);
}
export function dismissToast(id: number) {
  set({ toasts: get().toasts.filter((x) => x.id !== id) });
}

// ---------------------------------------------------------------- items

function filterItems(items: DesktopItem[], s: Settings) {
  return s.behavior.showSystemIcons ? items : items.filter((i) => i.kind !== "system");
}

let rawItems: DesktopItem[] = [];

export async function refreshItems(renames: { from: string; to: string }[] = []) {
  const fresh = await api.listDesktopItems();
  rawItems = fresh;
  applyItems(renames);
}

function applyItems(renames: { from: string; to: string }[] = []) {
  const { settings, grids, itemMap: prevMap } = get();
  const items = filterItems(rawItems, settings);
  const itemMap = new Map(items.map((i) => [i.id, i]));
  let layout = get().layout;
  if (renames.length) layout = remapIds(layout, new Map(renames.map((r) => [r.from, r.to])));

  // brand-new items from the New menu / Paste land where the user right-clicked
  let renameId: string | null = null;
  if (newItemHook && newItemHook.until > Date.now() && prevMap.size > 0) {
    const fresh = items.filter((i) => !prevMap.has(i.id) && !layout.remembered[i.id] && !pending.has(i.id));
    if (fresh.length > 0) {
      if (newItemHook.placement) for (const it of fresh) expectItemAt(it.id, newItemHook.placement);
      if (newItemHook.rename && fresh.length === 1) renameId = fresh[0].id;
      newItemHook = null;
    }
  }

  if (Object.keys(grids).length) {
    const pend = pendingMap();
    // items that just appeared go into matching smart groups, unless the user put them somewhere
    const fresh = newItemIds(layout, items);
    for (const id of pend.keys()) fresh.delete(id);
    layout = reconcile(layout, items, grids, pend);
    if (fresh.size) layout = collectSmart(layout, items, Date.now(), { only: fresh });
  }
  const sel = new Set([...get().selection].filter((id) => itemMap.has(id) || isFolderId(id) || isHeadingId(id)));
  set({ items, itemMap, selection: sel });
  replaceLayout(get().settings.grid.autoArrange ? autoArrange(layout, grids) : layout);
  if (renameId && get().layout.placements[renameId] && !get().panel) {
    set({ rename: { id: renameId, where: "desktop" }, selection: new Set([renameId]) });
  }
}

// ---------------------------------------------------------------- settings / environment

export function applySettings(next: Settings) {
  const prev = get().settings;
  applyTheme(next);
  set({ settings: next });
  const env = get().env;
  const gridChanged =
    prev.grid.autoSize !== next.grid.autoSize ||
    prev.grid.cellWidth !== next.grid.cellWidth ||
    prev.grid.cellHeight !== next.grid.cellHeight ||
    prev.grid.iconSize !== next.grid.iconSize ||
    prev.grid.iconScale !== next.grid.iconScale ||
    prev.grid.labels !== next.grid.labels ||
    prev.grid.labelLines !== next.grid.labelLines ||
    prev.labels.size !== next.labels.size ||
    prev.grid.autoArrange !== next.grid.autoArrange;
  if (env && gridChanged) {
    const grids = computeGrids(env, next);
    const anchored = anchorToEdges(get().layout, get().grids, grids);
    set({ grids });
    replaceLayout(anchored);
  }
  if (gridChanged || prev.behavior.showSystemIcons !== next.behavior.showSystemIcons) {
    if (get().ready) applyItems();
  }
}

export async function refreshEnvironment() {
  const env = await api.getEnvironment();
  set({ env, grids: computeGrids(env, get().settings) });
  applyItems();
}

export async function refreshWallpapers() {
  try {
    set({ wallpapers: await api.getWallpapers() });
  } catch (e) {
    console.error("get_wallpapers", e);
  }
}

/** `:root[data-quiet="game" | "battery"]` (absent when not quiet; game wins) + the store field. */
export function applyQuiet(q: Quiet) {
  const mode = q.game ? "game" : q.battery ? "battery" : "";
  if (mode) document.documentElement.dataset.quiet = mode;
  else delete document.documentElement.dataset.quiet;
  set({ quiet: q });
}

// ---------------------------------------------------------------- boot

export async function initDesktop() {
  const [env, state, items] = await Promise.all([
    api.getEnvironment(),
    api.loadState(),
    api.listDesktopItems(),
  ]);
  // settings the installer wrote (only "start with Windows", no grid yet) still count as a first run
  const firstRun = (state.settings as { grid?: unknown } | null)?.grid === undefined;
  let settings = normalizeSettings(state.settings);
  let layout = normalizeLayout(state.layout);

  let wl: Awaited<ReturnType<typeof api.getWindowsLayout>> | null = null;
  if (!layout.importedFromWindows) {
    try {
      wl = await api.getWindowsLayout();
    } catch (e) {
      console.error("get_windows_layout", e);
    }
    if (firstRun && wl?.spacing) {
      const sc = env.scaleFactor || 1;
      const cw = Math.round(wl.spacing.x / sc);
      const ch = Math.round(wl.spacing.y / sc);
      if (cw >= 56 && cw <= 200 && ch >= 56 && ch <= 220) {
        settings = normalizeSettings({ ...settings, grid: { ...settings.grid, cellWidth: cw, cellHeight: ch } });
      }
    }
  }

  applyTheme(settings);
  const grids = computeGrids(env, settings);
  // First run, or the first start with automatic size: the Windows positions / the stored layout
  // were made for the manual cell size (Windows' spacing on a first run), so carry them over.
  const migrating =
    settings.grid.autoSize && (state.settings as { grid?: { autoSize?: unknown } } | null)?.grid?.autoSize === undefined;
  const madeFor = migrating ? computeGrids(env, { ...settings, grid: { ...settings.grid, autoSize: false } }) : grids;
  rawItems = items;
  const visible = filterItems(items, settings);
  if (wl && !layout.importedFromWindows) {
    layout = importWindowsLayout(layout, wl, env, madeFor, visible);
  }
  if (madeFor !== grids) layout = anchorToEdges(layout, madeFor, grids);
  const fresh = newItemIds(layout, visible);
  layout = reconcile(layout, visible, grids);
  if (fresh.size) layout = collectSmart(layout, visible, Date.now(), { only: fresh });
  if (settings.grid.autoArrange) layout = autoArrange(layout, grids);

  set({
    env,
    settings,
    grids,
    items: visible,
    itemMap: new Map(visible.map((i) => [i.id, i])),
    layout,
    ready: true,
  });
  scheduleSave();
  if (firstRun || migrating) api.saveSettings(settings).catch(() => {});
  refreshWallpapers();
}

// ---------------------------------------------------------------- small helpers

export function baseName(path: string, keepExt = false) {
  const n = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
  if (keepExt) return n;
  const dot = n.lastIndexOf(".");
  return dot > 0 ? n.slice(0, dot) : n;
}

export function dirName(path: string) {
  const i = path.replace(/[\\/]+$/, "").search(/[\\/][^\\/]*$/);
  return i > 0 ? path.slice(0, i) : path;
}

export function displayName(id: string): string {
  return nameIn(get(), id);
}

/** `displayName` of a given state, for selectors: `useDesk((s) => nameIn(s, id))`. */
export function nameIn(s: { layout: Layout; itemMap: Map<string, DesktopItem> }, id: string): string {
  const c = s.layout.custom[id]?.name;
  if (c) return c;
  if (isFolderId(id)) return s.layout.folders[id]?.name ?? "";
  return s.itemMap.get(id)?.name ?? "";
}

/** settings.animation, re-rendering only when one of its values changes (for `spring` / `tween`). */
export const useAnimation = () => useDesk(useShallow((s) => s.settings.animation));

const osReducedMotion = typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
// Windows' "Animation effects" switch: re-evaluate the selectors when it changes
osReducedMotion?.addEventListener("change", () => set({}));

/** No motion: the setting, a quiet mode (game / battery) or Windows' "Animation effects" off. */
export const reducedMotion = (s: DeskState) =>
  s.settings.animation.reduceMotion || s.quiet.game || s.quiet.battery || !!osReducedMotion?.matches;
export const useReducedMotion = () => useDesk(reducedMotion);

export function setPage(monitorId: string, page: number) {
  const p = Math.max(0, page);
  if ((get().pages[monitorId] ?? 0) !== p) playSound("page");
  const pages = { ...get().pages, [monitorId]: p };
  set({ pages });
}

export function selectOnly(ids: string[]) {
  set({ selection: new Set(ids) });
}

// The desktop window is raised over the app windows only while a panel or dialog is open, however
// it was opened (click, group settings, tray, "Yeni ▸ Grup", search…); back behind the apps as soon
// as nothing is open.
useDesk.subscribe((s, prev) => {
  const open = !!(s.panel || s.dialog);
  const was = !!(prev.panel || prev.dialog);
  if (open !== was) api.raiseDesktop(open).catch(() => {});
});

// Explorer's hidden desktop view keeps the same selection, so tools that read the desktop's
// selection (Filee's shortcut, preview apps) get the icons selected here. Item loads count too:
// the first one clears what was selected on Windows' own desktop before we started.
let mirrorTimer = 0;
useDesk.subscribe((s, prev) => {
  if (s.selection === prev.selection && s.itemMap === prev.itemMap) return;
  window.clearTimeout(mirrorTimer);
  mirrorTimer = window.setTimeout(() => {
    const { selection, itemMap } = get();
    const paths = [...selection].flatMap((id) => itemMap.get(id)?.parsingName ?? []);
    api.mirrorSelection(paths).catch(() => {});
  }, 150);
});
