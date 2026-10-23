// Files dragged in from Explorer (or any app) and dropped on the desktop / a folder.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, isTauri } from "../api";
import { t } from "../i18n";
import { cellAt, cellKey, gridAt, iconBox } from "../layout/grid";
import { clone, isFolderId, mergeIntoNewFolder, moveIntoFolder, moveToCell, occupancy } from "../layout/model";
import type { Placement } from "../types";
import { currentPanelFolder } from "./actions";
import { RECYCLE_ID, useDrag, type DropTarget } from "./dnd";
import { panelGrid } from "./registry";
import { commit, expectItemAt, refreshItems, replaceLayout, toast, useDesk } from "./store";

const desk = () => useDesk.getState();

function targetAt(x: number, y: number): DropTarget {
  const st = desk();
  if (st.panel && panelGrid.panelEl) {
    const r = panelGrid.panelEl.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      const f = currentPanelFolder();
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
  const box = iconBox(g, c, r);
  const pad = g.iconSize * 0.2;
  const inCenter = lx >= box.x - pad && lx <= box.x + box.w + pad && ly >= box.y - pad && ly <= box.y + box.h + pad;
  if (!inCenter) return { kind: "cell", placement, displaced: null };
  if (isFolderId(occ)) return { kind: "into", folderId: occ };
  if (occ === RECYCLE_ID) return { kind: "recycle", id: occ };
  if (st.itemMap.get(occ)?.kind === "folder") return { kind: "real", id: occ };
  return { kind: "merge", id: occ };
}

function toCss(pos: { x: number; y: number }) {
  const r = window.devicePixelRatio || 1;
  return { x: pos.x / r, y: pos.y / r };
}

const drive = (p: string) => p.slice(0, 2).toLowerCase();

async function handleDrop(paths: string[], target: DropTarget) {
  const st = desk();
  if (!target || !st.env || paths.length === 0) return;
  try {
    if (target.kind === "recycle") {
      await api.recycle(paths);
      toast(t.movedToRecycle(paths.length));
      return;
    }
    if (target.kind === "real") {
      const dir = st.itemMap.get(target.id)?.path;
      if (dir) {
        await api.moveIntoFolder(paths, dir);
        toast(t.moved);
      }
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
    const target = targetAt(x, y);
    if (p.type === "drop") {
      useDrag.setState({ external: null });
      handleDrop(p.paths, target);
    } else {
      useDrag.setState({ external: target });
    }
  });
}
