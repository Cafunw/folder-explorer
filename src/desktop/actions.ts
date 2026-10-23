import { api } from "../api";
import { t } from "../i18n";
import { cellAt, gridAt, primaryGrid } from "../layout/grid";
import {
  createFolderAt,
  descendants,
  dissolveFolder,
  folderPath,
  isFolderId,
  removeDeep,
  removeIds,
  remapIds,
  renameFolder,
  setCustom,
} from "../layout/model";
import { MENU_W, menuHeight, menuRows, type MenuAction, type MenuRequest } from "../menu/layout";
import type { Placement } from "../types";
import { rectOf } from "./registry";
import {
  baseName,
  commit,
  displayName,
  expectNewItem,
  redo,
  refreshItems,
  saveSettings,
  toast,
  undo,
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
  if (it) api.openItem(it.path).catch(() => toast(t.operationFailed));
}

export function openFolder(folderId: string, opts: { editTitle?: boolean } = {}) {
  const { layout, panel, grids } = get();
  if (!layout.folders[folderId]) return;
  const stack = folderPath(layout, folderId);
  const top = stack[0];
  const r = rectOf(top);
  const pl = layout.placements[top];
  const monitorId = panel?.monitorId ?? pl?.m ?? primaryGrid(grids).monitorId;
  set({
    panel: {
      stack,
      monitorId,
      origin: panel ? panel.origin : r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
      editTitle: !!opts.editTitle,
      dir: 1,
      openedAt: Date.now(),
    },
    selection: new Set(),
  });
}

export function closePanel() {
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
  if (folders.length === 0 && files.length === 0) return;

  let next = layout;
  for (const f of folders) next = dissolveFolder(next, get().grids, f);
  if (files.length) {
    const paths = files.map((id) => itemMap.get(id)!.path);
    try {
      await api.recycle(paths);
    } catch (e) {
      console.error(e);
      toast(t.operationFailed);
      return;
    }
    next = removeIds(next, files);
    commit(next, { kind: "recycle", paths });
    toast(t.movedToRecycle(files.length), { label: t.undo, run: () => undo() });
  } else {
    commit(next);
    toast(t.folderDissolved, { label: t.undo, run: () => undo() });
  }
  set({ selection: new Set() });
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
  const { layout, itemMap } = get();
  const paths = fileIds.map((id) => itemMap.get(id)?.path).filter((p): p is string => !!p);
  try {
    if (paths.length) await api.recycle(paths);
  } catch (e) {
    console.error(e);
    toast(t.operationFailed);
    return;
  }
  const next = removeDeep(layout, folderIds);
  commit(next, paths.length ? { kind: "recycle", paths } : undefined);
  if (folderIds.some((f) => get().panel?.stack.includes(f))) set({ panel: null });
  toast(paths.length ? t.movedToRecycle(paths.length) : t.folderDissolved, { label: t.undo, run: () => undo() });
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

/**
 * Right-click on one of our icons (an object of this app, not Windows' desktop): a Windows 11 style
 * menu drawn by the app in its own popup window (`src/menu`), which opens instantly. The shell's full
 * classic menu (every shell extension) is only built when "Daha fazla seçenek göster" is chosen.
 * A group (our virtual folder) opens its settings window. The right-click on the empty desktop never
 * reaches us: Windows handles it itself.
 */
export async function showItemMenu(id: string) {
  const { selection, itemMap } = get();
  if (isFolderId(id)) {
    set({ selection: new Set([id]), dialog: { kind: "customize", id } });
    return;
  }
  const picked = selection.has(id) ? [...selection] : [id];
  if (!selection.has(id)) set({ selection: new Set([id]) });
  const real = [id, ...picked.filter((i) => i !== id)].filter((i) => !isFolderId(i) && itemMap.has(i));
  if (!real.length) return;
  const items = real.map((i) => itemMap.get(i)!);
  const request: MenuRequest = {
    ids: real,
    paths: items.map((i) => i.path),
    system: items.some((i) => i.kind === "system"),
    canRunAs: /\.(exe|bat|cmd|msi|lnk|com|ps1)$/i.test(items[0].path),
  };
  const rows = menuRows(request);
  try {
    await api.showItemMenu(request, MENU_W, menuHeight(rows));
  } catch (e) {
    console.warn("item menu", e);
    toast(t.operationFailed);
  }
}

/** An entry of the item popup was chosen (the popup tells us; it has no access to the desktop's state). */
export async function runMenuAction(action: MenuAction, ids: string[], at?: [number, number]) {
  const { itemMap } = get();
  const items = ids.map((i) => itemMap.get(i)).filter((i): i is NonNullable<typeof i> => !!i);
  const paths = items.map((i) => i.path);
  try {
    switch (action) {
      case "open":
        ids.forEach(openId);
        break;
      case "cut":
      case "copy":
        await api.clipboardFiles(paths, action === "cut");
        break;
      case "rename":
        startRename(ids[0]);
        break;
      case "delete":
        deleteIds(ids);
        break;
      case "runas":
        await api.runAsAdmin(paths[0]);
        break;
      case "copypath":
        await api.copyText(paths.map((p) => `"${p}"`).join("\r\n"));
        break;
      case "properties":
        await api.showProperties(paths[0]);
        break;
      case "more": {
        // the classic menu loads every shell extension: this is the slow part, only on request
        const verb = await api.showShellMenu(paths, at);
        if (verb === "rename") startRename(ids[0]);
        else if (verb === "delete") deleteIds(ids);
        break;
      }
    }
  } catch (e) {
    console.warn("menu action", action, e);
    toast(t.operationFailed);
  }
}

/**
 * The user right-clicked the empty desktop at (x, y) (window pixels): Windows opened its own menu.
 * Whatever new item it creates (New ▸ Folder…) should land where the user clicked.
 */
export function onEmptyRightClick(x: number, y: number) {
  expectNewItem(cellAtWindowPoint(x, y));
}

// ---------------------------------------------------------------- misc actions

export function newEmptyFolder(cell: Placement | null) {
  const { layout, grids, settings } = get();
  const pl = cell ?? { m: primaryGrid(grids).monitorId, p: 0, c: 0, r: 0 };
  const r = createFolderAt(layout, grids, { placement: pl }, t.newFolderName, settings.folders.defaultColor);
  commit(r.layout);
  window.setTimeout(() => openFolder(r.folderId, { editTitle: true }), 80);
}

export function toggleLock() {
  const s = get().settings;
  saveSettings({ ...s, behavior: { ...s.behavior, lockLayout: !s.behavior.lockLayout } });
}

export { undo, redo, baseName };
