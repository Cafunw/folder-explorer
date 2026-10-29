// Files dragged in from Explorer (or any app) and dropped on the desktop / a folder.

import { api, on } from "../api";
import { t } from "../i18n";
import { cellAt, cellKey, gridAt, iconBox } from "../layout/grid";
import { isFence } from "../layout/blocks";
import { clone, isFolderId, isHeadingId, mergeIntoNewFolder, moveIntoFolder, moveToCell, occupancy, removeIds } from "../layout/model";
import type { Placement } from "../types";
import { currentPanelFolder } from "./actions";
import { RECYCLE_ID, useDrag, type DropTarget } from "./dnd";
import { dropEffect } from "./input";
import { dropKindOf, dropOnApp, realDirOf, warmDropKinds } from "./interaction";
import { panelGrid } from "./registry";
import {
  commit,
  dirName,
  expectItemAt,
  recordFileOpOnly,
  refreshItems,
  replaceLayout,
  toast,
  undoEntry,
  useDesk,
  type FileOp,
} from "./store";

const desk = () => useDesk.getState();

type Keys = { ctrl: boolean; shift: boolean };

function targetAt(x: number, y: number, keys: Keys): DropTarget {
  const st = desk();
  if (st.panel && panelGrid.panelEl) {
    const r = panelGrid.panelEl.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      for (const tab of panelGrid.tabs.values()) {
        const tr = tab.el.getBoundingClientRect();
        if (x >= tr.left && x <= tr.right && y >= tr.top && y <= tr.bottom) return { kind: "into", folderId: tab.folderId };
      }
      const f = panelGrid.folderId ?? currentPanelFolder();
      return f ? { kind: "into", folderId: f } : null;
    }
    return null;
  }
  const g = gridAt(st.grids, x, y);
  if (!g) return null;
  const page = st.pages[g.monitorId] ?? 0;
  const lx = x - g.left;
  const ly = y - g.top;
  const { c, r } = cellAt(g, lx, ly);
  const occ = occupancy(st.layout).get(cellKey(g.monitorId, page, c, r));
  const placement: Placement = { m: g.monitorId, p: page, c, r };
  if (!occ) return { kind: "cell", placement, displaced: null };
  // a fence takes the files like a group (all its cells); a heading's cells give the nearest free one
  if (isFence(st.layout, occ)) return { kind: "into", folderId: occ };
  if (isHeadingId(occ)) return { kind: "cell", placement, displaced: null };
  const box = iconBox(g, c, r);
  const pad = g.iconSize * 0.2;
  const inCenter = lx >= box.x - pad && lx <= box.x + box.w + pad && ly >= box.y - pad && ly <= box.y + box.h + pad;
  if (!inCenter) return { kind: "cell", placement, displaced: null };
  if (isFolderId(occ)) return { kind: "into", folderId: occ };
  if (occ === RECYCLE_ID) return { kind: "recycle", id: occ };
  // a folder (or a shortcut to one) takes the files; an app opens them (Shift: a group, as before)
  const file = dropKindOf(occ);
  if (file?.kind === "dir") return { kind: "real", id: occ };
  if (file?.kind === "app" && st.settings.behavior.dropOnApp && !keys.shift) return { kind: "app", id: occ };
  return { kind: "merge", id: occ };
}

/**
 * Files from another app dropped into a real folder (a folder icon, a live group's folder): like
 * Explorer, the same volume moves and another copies, Ctrl copies, Shift moves. Moves can be undone.
 */
async function dropIntoDir(paths: string[], dir: string, keys: Keys) {
  const d = dir.replace(/[\\/]+$/, "");
  const key = d.toLowerCase();
  // files already there and the folder itself stay where they are
  const src = paths.filter((p) => dirName(p).toLowerCase() !== key && p.replace(/[\\/]+$/, "").toLowerCase() !== key);
  if (!src.length) return;
  const copy = src.filter((p) => dropEffect(p, d, keys) === "copy");
  const move = src.filter((p) => !copy.includes(p));
  if (copy.length) await api.copyIntoFolder(copy, d);
  // Windows' conflict dialog may skip a file or rename it ("x (2)"): only real moves count
  const landed = move.length ? await api.moveIntoFolder(move, d) : [];
  const moves = landed.flatMap((to, i) => (to ? [{ from: move[i], to }] : []));
  if (moves.length) {
    const op: FileOp = { kind: "move", moves };
    // icons of our desktop that went with it leave the layout in the same undo step
    const gone = moves.map((m) => m.from.toLowerCase()).filter((id) => desk().itemMap.has(id));
    const entry = gone.length ? commit(removeIds(desk().layout, gone), op) : recordFileOpOnly(op);
    toast(t.moved, { label: t.undo, run: () => void undoEntry(entry) });
  } else toast(copy.length ? t.copied : t.operationFailed);
}

const drive = (p: string) => p.slice(0, 2).toLowerCase();

async function handleDrop(paths: string[], target: DropTarget, keys: Keys) {
  const st = desk();
  if (!target || !st.env || paths.length === 0) return;
  try {
    if (target.kind === "recycle") {
      await api.recycle(paths);
      toast(t.movedToRecycle(paths.length));
      return;
    }
    if (target.kind === "real") {
      const dir = realDirOf(target.id);
      if (dir) await dropIntoDir(paths, dir, keys);
      return;
    }
    if (target.kind === "app") {
      const self = st.itemMap.get(target.id)?.path.toLowerCase();
      await dropOnApp(target.id, paths.filter((p) => p.toLowerCase() !== self));
      return;
    }
    const group = target.kind === "into" ? st.layout.folders[target.folderId] : undefined;
    if (group?.kind === "frequent") {
      toast(t.grp.frequentNoDrop);
      return;
    }
    if (group?.kind === "live") {
      // like a real folder: the files go into the live group's folder (not the ones already there)
      if (!group.source) {
        toast(t.grp.liveNoSource);
        return;
      }
      await dropIntoDir(paths, group.source, keys);
      return;
    }

    const desktopDrive = drive(st.env.desktopDir);
    const same = paths.filter((p) => drive(p) === desktopDrive);
    const other = paths.filter((p) => drive(p) !== desktopDrive);
    const result: string[] = [];
    if (same.length) result.push(...(await api.importDropped(same, false)));
    if (other.length) result.push(...(await api.importDropped(other, true)));
    await place(result, target);
  } catch (e) {
    console.error("drop", e);
    toast(t.operationFailed);
  }
}

/** Puts files that are now on the desktop where the drop asked: a cell, a group, or a new group. */
async function place(result: string[], target: NonNullable<DropTarget>) {
  const ids = result.map((p) => p.toLowerCase());
  const known = ids.filter((id) => desk().itemMap.has(id));
  const fresh = ids.filter((id) => !desk().itemMap.has(id));

  let layout = desk().layout;
  if (target.kind === "cell") {
    if (known.length) layout = moveToCell(layout, desk().grids, known, known[0], target.placement);
    for (const id of fresh) expectItemAt(id, target.placement);
  } else {
    let folderId: string | null = target.kind === "into" ? target.folderId : null;
    if (target.kind === "merge") {
      const r = mergeIntoNewFolder(layout, target.id, known, t.newFolderName, desk().settings.folders.defaultColor);
      if (r) {
        layout = r.layout;
        folderId = r.folderId;
      } else if (fresh.length) {
        // only new files: wrap the target alone first
        const l2 = clone(layout);
        const fid = `v:${crypto.randomUUID()}`;
        const pl = l2.placements[target.id];
        if (pl) {
          delete l2.placements[target.id];
          l2.folders[fid] = { id: fid, name: t.newFolderName, color: desk().settings.folders.defaultColor, children: [target.id] };
          l2.placements[fid] = pl;
          layout = l2;
          folderId = fid;
        }
      }
    } else if (folderId && known.length) {
      layout = moveIntoFolder(layout, known, folderId);
    }
    if (folderId && fresh.length) {
      const l2 = clone(layout);
      const now = Date.now();
      fresh.forEach((id, i) => {
        l2.remembered[id] = { at: now, folder: folderId!, index: (l2.folders[folderId!]?.children.length ?? 0) + i };
      });
      layout = l2;
    }
  }
  if (layout !== desk().layout) {
    if (known.length) commit(layout);
    else replaceLayout(layout);
  }
  await refreshItems();
}

/**
 * Files out of an archive, extracted by Windows into `folder` (native_drop.rs): on the desktop they go
 * where the drop asked under their names; a real folder or a live group's folder shows them itself.
 */
async function placeExtracted(names: string[], folder: string, target: DropTarget) {
  const desktop = desk().env?.desktopDir.replace(/[\\/]+$/, "");
  try {
    if (target && desktop && folder.replace(/[\\/]+$/, "").toLowerCase() === desktop.toLowerCase()) {
      await place(names.map((n) => `${desktop}\\${n}`), target);
    } else await refreshItems();
  } catch (e) {
    console.error("drop", e);
    toast(t.operationFailed);
  }
}

type DropDest = { kind: "none" } | { kind: "accept" } | { kind: "folder"; path: string };

/** Where the native layer sends a drag: real files the page imports itself, virtual ones a folder takes. */
function destFor(target: DropTarget, files: boolean): DropDest {
  if (!target) return { kind: "none" };
  if (files) return { kind: "accept" };
  const desktop = desk().env?.desktopDir;
  if (target.kind === "real") {
    const dir = realDirOf(target.id);
    return dir ? { kind: "folder", path: dir } : { kind: "none" };
  }
  if (target.kind === "into") {
    const group = desk().layout.folders[target.folderId];
    if (group?.kind === "frequent") return { kind: "none" };
    if (group?.kind === "live") return group.source ? { kind: "folder", path: group.source } : { kind: "none" };
  }
  if (target.kind === "app" || target.kind === "recycle" || !desktop) return { kind: "none" };
  return { kind: "folder", path: desktop };
}

type NativeDrag = { phase: "over" | "leave"; x: number; y: number; ctrl: boolean; shift: boolean; files: boolean };
type NativeDrop = { x: number; y: number; ctrl: boolean; shift: boolean; paths: string[]; names: string[]; folder: string | null };

type WebView2 = { postMessageWithAdditionalObjects(message: unknown, objects: FileList): void };
const webview2 = () => (window as unknown as { chrome?: { webview?: WebView2 } }).chrome?.webview;

const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
const keysOf = (e: DragEvent): Keys => ({ ctrl: e.ctrlKey, shift: e.shiftKey });

let dropSeq = 0;
const waiting = new Map<number, (paths: string[]) => void>();

/**
 * Drops from other apps. When a file drag comes in, the page asks for the native drop layer
 * (native_drop.rs), which takes the drag from WebView2 and reports it here: `native-drag` to follow
 * it, `native-drop` with real files' paths or the names Windows extracted out of an archive. Should the
 * drop still land on the page, real files come through WebView2 (desktop_window.rs `watch_drops`).
 * Nothing else may be dropped: a link or text would navigate the page.
 */
export async function setupExternalDrop(): Promise<() => void> {
  const unlisten = await on<{ id: number; paths: string[] }>("drop-paths", (p) => {
    waiting.get(p.id)?.(p.paths);
    waiting.delete(p.id);
  });
  let layer = false;
  let lastDest = "";
  const css = (p: { x: number; y: number }) => ({ x: p.x / (window.devicePixelRatio || 1), y: p.y / (window.devicePixelRatio || 1) });
  const unlistenDrag = await on<NativeDrag>("native-drag", (p) => {
    if (p.phase === "leave") {
      layer = false;
      lastDest = "";
      useDrag.setState({ external: null });
      return;
    }
    const { x, y } = css(p);
    const target = targetAt(x, y, { ctrl: p.ctrl, shift: p.shift });
    useDrag.setState({ external: target });
    const dest = destFor(target, p.files);
    if (JSON.stringify(dest) !== lastDest) {
      lastDest = JSON.stringify(dest);
      void api.setDropDest(dest).catch(() => {});
    }
  });
  const unlistenDrop = await on<NativeDrop>("native-drop", (p) => {
    layer = false;
    lastDest = "";
    useDrag.setState({ external: null });
    const { x, y } = css(p);
    const keys = { ctrl: p.ctrl, shift: p.shift };
    const target = targetAt(x, y, keys);
    if (p.paths.length) void handleDrop(p.paths, target, keys);
    else if (p.folder) void placeExtracted(p.names, p.folder, target);
  });
  const over = (e: DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer) return;
    if (!hasFiles(e)) {
      e.dataTransfer.dropEffect = "none";
      return;
    }
    if (e.type === "dragenter") {
      warmDropKinds();
      if (!layer) {
        layer = true;
        void api.beginNativeDrop().catch(() => (layer = false));
      }
    }
    const target = targetAt(e.clientX, e.clientY, keysOf(e));
    // always "copy" to the source, even for a move: we move the files after the drop, and a source
    // told "move" could delete them before that
    e.dataTransfer.dropEffect = target ? "copy" : "none";
    useDrag.setState({ external: target });
  };
  const leave = (e: DragEvent) => {
    if (e.relatedTarget) return;
    useDrag.setState({ external: null });
    layer = false;
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    useDrag.setState({ external: null });
    layer = false;
    const files = e.dataTransfer?.files;
    const keys = keysOf(e);
    const target = targetAt(e.clientX, e.clientY, keys);
    const wv = webview2();
    if (!hasFiles(e) || !files?.length || !target || !wv) return;
    // A file inside an archive (Explorer's ZIP / RAR view, WinRAR) has no path on disk, and handing it
    // to WebView2 crashes the page: real files and folders come with a file-system entry, those don't.
    if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file" && !i.webkitGetAsEntry())) {
      toast(t.dropFromArchive);
      return;
    }
    const id = ++dropSeq;
    waiting.set(id, (paths) => void (paths.length ? handleDrop(paths, target, keys) : toast(t.operationFailed)));
    // During the event (the FileList is emptied afterwards), and as a string: Tauri's own message
    // handler runs first and fails on anything else, which stops WebView2 from calling ours.
    wv.postMessageWithAdditionalObjects(JSON.stringify({ feDrop: id }), files);
  };
  window.addEventListener("dragenter", over);
  window.addEventListener("dragover", over);
  window.addEventListener("dragleave", leave);
  window.addEventListener("drop", drop);
  return () => {
    unlisten();
    unlistenDrag();
    unlistenDrop();
    window.removeEventListener("dragenter", over);
    window.removeEventListener("dragover", over);
    window.removeEventListener("dragleave", leave);
    window.removeEventListener("drop", drop);
  };
}
