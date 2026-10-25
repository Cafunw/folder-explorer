import { api } from "../api";
import { t } from "../i18n";
import { cellAt, gridAt, primaryGrid } from "../layout/grid";
import { createFenceAt, createHeadingNear, HEADING_WIDTH, isFence } from "../layout/blocks";
import {
  createFolderAt,
  DEFAULT_FENCE_SIZE,
  descendants,
  dissolveFolder,
  firstFree,
  folderPath,
  isFolderId,
  isHeadingId,
  occupancy,
  removeDeep,
  removeIds,
  remapIds,
  renameFolder,
  setCustom,
  setHeading,
  sortMonitor,
  updateFolder,
  withSpan,
  type SortKey,
} from "../layout/model";
import {
  headingMenu,
  ICON_SCALES,
  type MenuPick,
} from "../menu/model";
import type { Placement } from "../types";
import { enterJiggle } from "./Jiggle";
import { liveItem } from "./live";
import { lockedOnPath, requestUnlock } from "./locks";
import { rectOf } from "./registry";
import { playSound } from "./sounds";
import {
  baseName,
  commit,
  displayName,
  expectNewItem,
  recordOpen,
  redo,
  refreshItems,
  renameNewItem,
  saveSettings,
  toast,
  undo,
  undoEntry,
  useDesk,
} from "./store";

const get = () => useDesk.getState();
const set = useDesk.setState;

// ---------------------------------------------------------------- open / folders

export function openId(id: string) {
  if (isFolderId(id)) {
    openFolder(id);
    return;
  }
  const it = get().itemMap.get(id);
  if (!it) {
    // an entry of a live group (a real folder's file, not a desktop item)
    const live = liveItem(id);
    if (live) api.openItem(live.path).catch(() => toast(t.operationFailed));
    return;
  }
  api
    .openItem(it.path)
    .then(() => recordOpen(id))
    .catch(() => toast(t.operationFailed));
}

export function openFolder(folderId: string, opts: { editTitle?: boolean } = {}) {
  const { layout, panel, grids } = get();
  if (!layout.folders[folderId]) return;
  const locked = lockedOnPath(folderId);
  if (locked) {
    requestUnlock(locked, () => openFolder(folderId, opts));
    return;
  }
  const stack = folderPath(layout, folderId);
  const top = stack[0];
  // a group inside a fence: its own tile there, not the fence's title bar
  const inFence = stack.length > 1 && isFence(layout, top) ? stack[1] : undefined;
  const r = rectOf(inFence ?? top);
  const pl = layout.placements[top];
  const monitorId = panel?.monitorId ?? pl?.m ?? primaryGrid(grids).monitorId;
  set({
    panel: {
      stack,
      monitorId,
      from: panel ? panel.from : inFence,
      origin: panel ? panel.origin : r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
      editTitle: !!opts.editTitle,
      dir: 1,
      openedAt: Date.now(),
    },
    selection: new Set(),
  });
  playSound("open");
}

export function closePanel() {
  if (get().panel) playSound("close");
  set({ panel: null, selection: new Set(), rename: get().rename?.where === "panel" ? null : get().rename });
}

export function panelBack() {
  const p = get().panel;
  if (!p) return;
  if (p.stack.length <= 1) closePanel();
  else set({ panel: { ...p, stack: p.stack.slice(0, -1), dir: -1, editTitle: false }, selection: new Set() });
}

export function panelGoTo(depth: number) {
  const p = get().panel;
  if (!p) return;
  if (depth < 0) return closePanel();
  if (depth >= p.stack.length - 1) return;
  set({ panel: { ...p, stack: p.stack.slice(0, depth + 1), dir: -1, editTitle: false }, selection: new Set() });
}

export function panelEnter(folderId: string) {
  const p = get().panel;
  if (!p) return openFolder(folderId);
  const locked = lockedOnPath(folderId);
  if (locked) {
    requestUnlock(locked, () => panelEnter(folderId));
    return;
  }
  set({ panel: { ...p, stack: [...p.stack, folderId], dir: 1, editTitle: false }, selection: new Set() });
}

export const currentPanelFolder = () => {
  const p = get().panel;
  return p ? p.stack[p.stack.length - 1] : null;
};

// ---------------------------------------------------------------- delete

export async function deleteIds(ids: string[]) {
  const { layout, itemMap } = get();
  const folders = ids.filter((id) => isFolderId(id) && layout.folders[id]);
  const files = ids.filter((id) => {
    const it = itemMap.get(id);
    return it && it.kind !== "system";
  });
  const headings = ids.filter((id) => isHeadingId(id) && layout.headings[id]);
  if (folders.length === 0 && files.length === 0 && headings.length === 0) return;

  const paths = files.map((id) => itemMap.get(id)!.path);
  if (files.length) {
    try {
      await api.recycle(paths);
    } catch (e) {
      console.error(e);
      toast(t.operationFailed);
      playSound("error");
      return;
    }
  }
  // the Recycle Bin can take a while: build on the layout as it is now, so moves made meanwhile stay
  let next = headings.length ? removeIds(get().layout, headings) : get().layout;
  for (const f of folders) if (next.folders[f]) next = dissolveFolder(next, get().grids, f);
  if (files.length) {
    next = removeIds(next, files);
    const entry = commit(next, { kind: "recycle", paths });
    playSound("delete");
    toast(t.movedToRecycle(files.length), { label: t.undo, run: () => undoEntry(entry) });
  } else {
    const entry = commit(next);
    playSound("delete");
    toast(folders.length ? t.folderDissolved : t.fence.headingRemoved, { label: t.undo, run: () => undoEntry(entry) });
  }
  set({ selection: new Set([...get().selection].filter((id) => !ids.includes(id))) });
}

export function askDeleteFolderDeep(folderIds: string[]) {
  const { layout, itemMap } = get();
  const files = new Set<string>();
  for (const f of folderIds) {
    for (const d of descendants(layout, f)) {
      const it = itemMap.get(d);
      if (it && it.kind !== "system") files.add(d);
    }
  }
  set({ dialog: { kind: "confirmDeleteFolder", folderIds, files: [...files] } });
}

export async function deleteFolderDeep(folderIds: string[], fileIds: string[]) {
  const { itemMap } = get();
  const paths = fileIds.map((id) => itemMap.get(id)?.path).filter((p): p is string => !!p);
  try {
    if (paths.length) await api.recycle(paths);
  } catch (e) {
    console.error(e);
    toast(t.operationFailed);
    return;
  }
  const next = removeDeep(get().layout, folderIds); // current layout: changes made meanwhile stay
  const entry = commit(next, paths.length ? { kind: "recycle", paths } : undefined);
  if (folderIds.some((f) => get().panel?.stack.includes(f))) set({ panel: null });
  toast(paths.length ? t.movedToRecycle(paths.length) : t.folderDissolved, { label: t.undo, run: () => undoEntry(entry) });
}

// ---------------------------------------------------------------- rename

export function startRename(id: string) {
  const { panel } = get();
  set({ rename: { id, where: panel ? "panel" : "desktop" }, selection: new Set([id]) });
}

export async function commitRename(id: string, value: string) {
  set({ rename: null });
  const name = value.trim();
  const { layout, itemMap } = get();
  if (!name || name === displayName(id)) return;
  if (isFolderId(id)) {
    commit(renameFolder(layout, id, name));
    return;
  }
  const it = itemMap.get(id);
  if (!it) return;
  if (it.kind === "system") {
    commit(setCustom(layout, id, { name }));
    return;
  }
  // a custom display name wins over the file name; renaming the file clears it
  try {
    const newPath = await api.renameItem(it.path, name);
    const newId = newPath.toLowerCase();
    let next = remapIds(get().layout, new Map([[id, newId]]));
    if (next.custom[newId]?.name) next = setCustom(next, newId, { name: null });
    commit(next, { kind: "rename", from: it.path, to: newPath });
    set({ selection: new Set([newId]) });
    refreshItems().catch(() => {});
  } catch (e) {
    const msg = String(e);
    if (/denied|erişim|0x80070005|access/i.test(msg)) {
      commit(setCustom(get().layout, id, { name }));
      toast(t.renameNeedsAdmin);
    } else {
      console.error(e);
      toast(t.renameFailed);
    }
  }
}

// ---------------------------------------------------------------- menus

function cellAtWindowPoint(x: number, y: number): Placement | null {
  const { grids, pages } = get();
  const g = gridAt(grids, x, y);
  if (!g) return null;
  const { c, r } = cellAt(g, x - g.left, y - g.top);
  return { m: g.monitorId, p: pages[g.monitorId] ?? 0, c, r };
}

/** A point of the desktop window in screen pixels. */
function toScreen(x: number, y: number): [number, number] {
  const env = get().env;
  const k = env?.scaleFactor || 1;
  return [Math.round((env?.windowOrigin.x ?? 0) + x * k), Math.round((env?.windowOrigin.y ?? 0) + y * k)];
}

/**
 * Files use their native Windows Shell menu. Virtual groups keep their settings dialog;
 * headings use an OS-rendered popup because they have no corresponding Shell object.
 */
export async function showItemMenu(id: string, at?: [number, number]) {
  const { selection, itemMap, layout } = get();
  if (isHeadingId(id)) {
    const h = layout.headings[id];
    if (!h) return;
    set({ selection: new Set([id]) });
    try {
      const chosen = await api.nativeMenu(headingMenu(h), at ?? null);
      if (chosen) headingAction(chosen.slice("heading:".length), id);
    } catch (e) {
      console.warn("heading menu", e);
      toast(t.operationFailed);
    }
    return;
  }
  if (isFolderId(id)) {
    set({ selection: new Set([id]), dialog: { kind: "customize", id } });
    return;
  }
  const picked = selection.has(id) ? [...selection] : [id];
  if (!selection.has(id)) set({ selection: new Set([id]) });
  const real = [id, ...picked.filter((i) => i !== id)].filter((i) => !isFolderId(i) && itemMap.has(i));
  if (!real.length) return;
  const items = real.map((i) => itemMap.get(i)!);
  try {
    await api.itemContextMenu(items.map((i) => i.parsingName), at ?? null);
  } catch (e) {
    console.warn("shell menu", e);
    toast(t.operationFailed);
  }
}

/** Right-click on the empty desktop at (x, y) (window px). */
export function showDesktopMenu(x: number, y: number, at?: [number, number]) {
  set({ selection: new Set(), rename: null });
  expectNewItem(cellAtWindowPoint(x, y));
  api.desktopContextMenu(at ?? toScreen(x, y)).catch((e) => {
    console.warn("desktop menu", e);
    toast(t.operationFailed);
  });
}

/** Shift+F10 / the menu key: the menu of the selection, or the desktop's under the pointer. */
export function showMenuFromKeyboard(pointer: { x: number; y: number }) {
  const sel = [...get().selection];
  const first = sel.find((id) => !isFolderId(id)) ?? sel[0];
  const r = first ? rectOf(first) : null;
  if (first && r) {
    showItemMenu(first, toScreen(r.left + r.width / 2, r.top + r.height / 2));
    return;
  }
  showDesktopMenu(pointer.x, pointer.y, toScreen(pointer.x, pointer.y));
}

function sortInfo(id: string) {
  const { layout, itemMap } = get();
  if (isFolderId(id)) return { name: layout.folders[id]?.name ?? "", ext: "", modified: 0, size: 0, group: 1 };
  const it = itemMap.get(id);
  const group = it?.kind === "system" ? 0 : it?.kind === "folder" ? 1 : 2;
  return { name: displayName(id), ext: it?.ext ?? "", modified: it?.modified ?? 0, size: it?.size ?? 0, group };
}

async function verb(paths: string[], verbs: string[]) {
  if (!(await api.shellVerb(paths, verbs))) toast(t.notAvailableHere);
}

/** Shared desktop actions used by keyboard shortcuts, search and native menu callbacks. */
export async function runMenuAction(p: MenuPick): Promise<void> {
  const { id, ids, paths, cell } = p;
  const s = get().settings;
  const one = paths.length === 1 ? paths[0] : null;
  const item = ids.length === 1 ? get().itemMap.get(ids[0]) : undefined;
  try {
    if (id.startsWith("openwith:")) {
      const n = id.slice("openwith:".length);
      await api.openWith(paths, n === "other" ? null : Number(n));
      return;
    }
    if (id.startsWith("new:")) {
      expectNewItem(cell, true);
      await api.newItem(Number(id.slice("new:".length)));
      return;
    }
    if (id.startsWith("compress:")) {
      expectNewItem(get().layout.placements[ids[0]] ?? null, true);
      try {
        await api.compress(paths, id.slice("compress:".length));
      } catch (e) {
        console.warn("compress", e);
        toast(t.compressFailed);
      }
      return;
    }
    if (id.startsWith("view:")) {
      const k = ICON_SCALES[id.slice("view:".length) as keyof typeof ICON_SCALES];
      if (k) saveSettings({ ...s, grid: { ...s.grid, iconScale: k } });
      return;
    }
    if (id.startsWith("sort:")) {
      const { grids, layout } = get();
      const m = cell?.m ?? primaryGrid(grids).monitorId;
      commit(sortMonitor(layout, grids, m, id.slice("sort:".length) as SortKey, sortInfo));
      return;
    }
    if (id.startsWith("heading:")) {
      if (ids[0]) headingAction(id.slice("heading:".length), ids[0]);
      return;
    }
    switch (id) {
      case "newfence":
        newFence(cell);
        break;
      case "editicons":
        enterJiggle();
        break;
      case "newheading":
        newHeading(cell, "title");
        break;
      case "newdivider":
        newHeading(cell, "divider");
        break;
      case "open":
        ids.forEach(openId);
        break;
      case "cut":
      case "copy":
        await api.clipboardFiles(paths, id === "cut");
        break;
      case "paste":
      case "pasteshortcut":
        expectNewItem(cell);
        await api.pasteFiles(id === "pasteshortcut");
        break;
      case "rename":
        startRename(ids[0]);
        break;
      case "renameNew":
        renameNewItem();
        break;
      case "delete":
        deleteIds(ids);
        break;
      case "share":
        await verb(paths, ["Windows.ModernShare"]);
        break;
      case "favorite":
        await verb(paths, ["pintohomefile"]);
        break;
      case "pinhome":
        await verb(paths, ["pintohome"]);
        break;
      case "pinstart":
        await verb(paths, ["PinToStartScreen"]);
        break;
      case "emptybin":
        await verb(paths, ["empty"]);
        break;
      case "opencontaining":
        await verb(paths, ["opencontaining"]);
        break;
      case "runas":
        if (one && item?.kind === "file") await api.runAsAdmin(one);
        else await verb(paths, ["runas"]);
        break;
      case "newtab":
        if (one) await api.openVerb(one, ["opennewtab", "opennewwindow"]);
        break;
      case "newwindow":
        if (one) await api.openVerb(one, ["opennewwindow"]);
        break;
      case "copypath":
        await api.copyText(paths.map((x) => `"${x}"`).join("\r\n"));
        break;
      case "properties":
        if (one && item && item.kind !== "system") await api.showProperties(one);
        else await verb(paths, ["properties"]);
        break;
      case "terminal":
        await api.openTerminal(one ?? get().env?.desktopDir ?? "");
        break;
      case "autoarrange":
        saveSettings({ ...s, grid: { ...s.grid, autoArrange: !s.grid.autoArrange } });
        break;
      case "showicons":
        saveSettings({ ...s, behavior: { ...s.behavior, showIcons: !s.behavior.showIcons } });
        break;
      case "refresh":
        set({ iconBust: get().iconBust + 1 });
        await refreshItems();
        break;
      case "newgroup":
        newEmptyFolder(cell);
        break;
      case "newsmart":
        newKindFolder(cell, "smart");
        break;
      case "newlive":
        newKindFolder(cell, "live");
        break;
      case "newfrequent":
        newKindFolder(cell, "frequent");
        break;
      case "display":
        await api.openItem("ms-settings:display");
        break;
      case "personalize":
        await api.openItem("ms-settings:personalization");
        break;
    }
  } catch (e) {
    console.warn("menu action", id, e);
    toast(t.operationFailed);
  }
}

/** A menu entry for the selected icons, from the keyboard (Ctrl+C, Alt+Enter…). */
export function runOnSelection(id: string) {
  const { selection, itemMap } = get();
  const files = id === "cut" || id === "copy" || id === "copypath";
  const ids = [...selection].filter((i) => !isFolderId(i) && itemMap.has(i) && !(files && itemMap.get(i)!.kind === "system"));
  if (!ids.length) return;
  void runMenuAction({ id, target: "items", ids, paths: ids.map((i) => itemMap.get(i)!.path), at: [0, 0], cell: null, canPaste: false });
}

export function pasteAt(x: number, y: number) {
  void runMenuAction({ id: "paste", target: "desktop", ids: [], paths: [], at: [0, 0], cell: cellAtWindowPoint(x, y), canPaste: true });
}

// ---------------------------------------------------------------- misc actions

export function newEmptyFolder(cell: Placement | null) {
  const { layout, grids, settings } = get();
  const pl = cell ?? { m: primaryGrid(grids).monitorId, p: 0, c: 0, r: 0 };
  const r = createFolderAt(layout, grids, { placement: pl }, t.newFolderName, settings.folders.defaultColor);
  commit(r.layout);
  window.setTimeout(() => openFolder(r.folderId, { editTitle: true }), 80);
}

/**
 * Yeni ▸ Akıllı grup / Canlı klasör / En çok kullanılanlar: the group lands at `cell`; a smart group
 * opens its settings on the rule editor, a live group on the folder picker.
 */
export function newKindFolder(cell: Placement | null, kind: "smart" | "live" | "frequent") {
  const { grids, settings } = get();
  const pl = cell ?? { m: primaryGrid(grids).monitorId, p: 0, c: 0, r: 0 };
  const name = kind === "smart" ? t.grp.newSmart : kind === "live" ? t.grp.newLive : t.grp.newFrequent;
  const r = createFolderAt(get().layout, grids, { placement: pl }, name, settings.folders.defaultColor);
  const patch = kind === "smart" ? { kind, rule: { all: true, conditions: [] } } : { kind };
  commit(updateFolder(r.layout, grids, r.folderId, patch));
  set({ selection: new Set([r.folderId]) });
  if (kind !== "frequent") {
    window.setTimeout(() => set({ dialog: { kind: "customize", id: r.folderId, focus: kind === "smart" ? "rule" : "source" } }), 80);
  }
}

/** Top-left of the first free block of `size` on the primary monitor's current page (palette: no cell). */
function freeCellFor(size: { w: number; h: number }): Placement {
  const { layout, grids, pages } = get();
  const m = primaryGrid(grids).monitorId;
  return withSpan(firstFree(occupancy(layout), grids, m, pages[m] ?? 0, 0, size));
}

/** Yeni ▸ Kutu: an empty group shown as a fence at the right-clicked cell; its title is edited first. */
export function newFence(cell: Placement | null) {
  const { layout, grids, settings } = get();
  const r = createFenceAt(layout, grids, cell ?? freeCellFor(DEFAULT_FENCE_SIZE), t.fence.newName, settings.folders.defaultColor);
  commit(r.layout);
  // from the command palette the desktop has no keyboard focus: no editing then
  set(cell ? { selection: new Set([r.folderId]), rename: { id: r.folderId, where: "desktop" } } : { selection: new Set([r.folderId]) });
}

/** Yeni ▸ Başlık / Ayraç at the right-clicked cell, its text edited first. */
export function newHeading(cell: Placement | null, style: "title" | "divider") {
  const { layout, grids } = get();
  const r = createHeadingNear(layout, grids, cell ?? freeCellFor({ w: HEADING_WIDTH, h: 1 }), style);
  commit(r.layout);
  set(cell ? { selection: new Set([r.headingId]), rename: { id: r.headingId, where: "desktop" } } : { selection: new Set([r.headingId]) });
}

/** The heading menu's entries ("heading:<action>"). */
function headingAction(action: string, hid: string) {
  const { layout } = get();
  const h = layout.headings[hid];
  if (!h) return;
  if (action === "edit") startRename(hid);
  else if (action === "delete") void deleteIds([hid]);
  else if (action === "underline") commit(setHeading(layout, hid, { underline: !h.underline }));
  else if (action === "align:left" || action === "align:center") commit(setHeading(layout, hid, { align: action === "align:left" ? "left" : "center" }));
  else if (action === "style:title" || action === "style:divider") commit(setHeading(layout, hid, { style: action === "style:title" ? "title" : "divider" }));
}

export function toggleLock() {
  const s = get().settings;
  saveSettings({ ...s, behavior: { ...s.behavior, lockLayout: !s.behavior.lockLayout } });
}

export { undo, redo, baseName };
