// Files dragged in from Explorer (or any app) and dropped on the desktop / a folder.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, isTauri } from "../api";
import { t } from "../i18n";
import { cellAt, cellKey, gridAt, iconBox } from "../layout/grid";
import { isFence } from "../layout/blocks";
import { clone, isFolderId, isHeadingId, mergeIntoNewFolder, moveIntoFolder, moveToCell, occupancy, removeIds } from "../layout/model";
import type { Placement } from "../types";
import { currentPanelFolder } from "./actions";
import { RECYCLE_ID, useDrag, type DropTarget } from "./dnd";
import { dropEffect } from "./input";
import { dropKindOf, dropOnApp, heldKeys, realDirOf, refreshHeldKeys, warmDropKinds } from "./interaction";
import { panelGrid } from "./registry";
import {
  baseName,
  commit,
  dirName,
  expectItemAt,
  recordFileOpOnly,
  refreshItems,
  replaceLayout,
  toast,
  undo,
  useDesk,
  type FileOp,
} from "./store";

const desk = () => useDesk.getState();

type Keys = { ctrl: boolean; shift: boolean };

function targetAt(x: number, y: number, keys: Keys = heldKeys()): DropTarget {
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
  if (move.length) {
    await api.moveIntoFolder(move, d);
    const op: FileOp = { kind: "move", moves: move.map((p) => ({ from: p, to: `${d}\\${baseName(p, true)}` })) };
    // icons of our desktop that went with it leave the layout in the same undo step
    const gone = move.map((p) => p.toLowerCase()).filter((id) => desk().itemMap.has(id));
    if (gone.length) commit(removeIds(desk().layout, gone), op);
    else recordFileOpOnly(op);
  }
  toast(move.length ? t.moved : t.copied, move.length ? { label: t.undo, run: () => void undo() } : undefined);
}

function toCss(pos: { x: number; y: number }) {
  const r = window.devicePixelRatio || 1;
  return { x: pos.x / r, y: pos.y / r };
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
  } catch (e) {
    console.error("drop", e);
    toast(t.operationFailed);
  }
}

export async function setupExternalDrop(): Promise<() => void> {
  if (!isTauri) return () => {};
  return getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "leave") {
      useDrag.setState({ external: null });
      return;
    }
    const { x, y } = toCss(p.position);
    if (p.type === "drop") {
      useDrag.setState({ external: null });
      // the event carries no modifier keys: ask for them (Ctrl copies / Shift moves, Shift on an app = group)
      const paths = p.paths;
      api
        .keyState()
        .catch(() => heldKeys())
        .then((keys) => handleDrop(paths, targetAt(x, y, keys), keys));
      return;
    }
    if (p.type === "enter") warmDropKinds();
    const target = targetAt(x, y);
    // Shift turns an app target into a group: keep the key state fresh while over an app
    if ((target?.kind === "app" || target?.kind === "merge") && dropKindOf(target.id)?.kind === "app") refreshHeldKeys();
    useDrag.setState({ external: target });
  });
}
