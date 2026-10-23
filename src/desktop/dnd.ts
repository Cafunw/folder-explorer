// Pointer-driven drag & drop for desktop icons and folder panels, plus marquee selection.

import { motionValue } from "motion/react";
import { create } from "zustand";
import { api } from "../api";
import { t } from "../i18n";
import { cellAt, cellKey, gridAt, iconBox, ICON_TOP, type GridInfo } from "../layout/grid";
import {
  isFolderId,
  isInside,
  mergeIntoNewFolder,
  moveIntoFolder,
  moveToCell,
  nearestFree,
  occupancy,
  pageCount,
  removeIds,
} from "../layout/model";
import type { Placement } from "../types";
import { closePanel, currentPanelFolder, deleteIds, openFolder, panelBack, panelEnter } from "./actions";
import { flyFrom, iconEls, panelGrid } from "./registry";
import { baseName, commit, refreshItems, setPage, toast, useDesk } from "./store";

export const RECYCLE_ID = "::{645ff040-5081-101b-9f08-00aa002f954e}";

export type DropTarget =
  | { kind: "cell"; placement: Placement; displaced: { id: string; to: Placement } | null }
  | { kind: "merge"; id: string }
  | { kind: "into"; folderId: string }
  | { kind: "real"; id: string }
  | { kind: "recycle"; id: string }
  | { kind: "reorder"; folderId: string; index: number }
  | null;

export type DragVisual = {
  ids: string[];
  primary: string;
  target: DropTarget;
  extraPage: string | null; // monitor that shows one extra (empty) page while dragging
};

type Marquee = { x0: number; y0: number; x1: number; y1: number } | null;

export const useDrag = create<{ drag: DragVisual | null; marquee: Marquee; external: DropTarget }>(() => ({
  drag: null,
  marquee: null,
  external: null,
}));

/** Pointer position (window coords) and grab offset, read by the drag ghost. */
export const ghost = { x: motionValue(0), y: motionValue(0), offX: 0, offY: 0 };

const desk = () => useDesk.getState();
const setDrag = (patch: Partial<DragVisual> | null) => {
  if (patch === null) useDrag.setState({ drag: null });
  else {
    const cur = useDrag.getState().drag;
    if (!cur) return;
    // skip no-op updates: this runs every animation frame while dragging
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (JSON.stringify(v) !== JSON.stringify(cur[k as keyof DragVisual])) changed = true;
    }
    if (changed) useDrag.setState({ drag: { ...cur, ...patch } });
  }
};

// ---------------------------------------------------------------- session

type Session = {
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  id: string;
  ids: string[];
  started: boolean;
  ctrl: boolean;
  fromPanel: boolean;
  raf: number;
  hoverKey: string;
  hoverSince: number;
  edgeKey: string;
  edgeSince: number;
  outsideSince: number;
  lastForeign: number;
  foreignBusy: boolean;
  lockedWarned: boolean;
  gap: number; // reorder slot inside the panel
  panelSeen: number; // openedAt of the panel we last evaluated
  enteredPanel: boolean; // pointer has been inside that panel at least once
};

let s: Session | null = null;

const now = () => performance.now();

function orderedSelection(primary: string): string[] {
  const { selection, layout } = desk();
  if (!selection.has(primary) || selection.size === 1) return [primary];
  const ids = [...selection];
  const folder = currentPanelFolder();
  if (folder) {
    const order = layout.folders[folder]?.children ?? [];
    ids.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  } else {
    ids.sort((a, b) => {
      const A = layout.placements[a];
      const B = layout.placements[b];
      if (!A || !B) return 0;
      return A.p - B.p || A.c - B.c || A.r - B.r;
    });
  }
  return [primary, ...ids.filter((i) => i !== primary)];
}

export function beginIconPointer(e: React.PointerEvent, id: string, fromPanel: boolean) {
  if (e.button !== 0 || s) return;
  const st = desk();
  if (st.rename?.id === id) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl && !st.selection.has(id)) useDesk.setState({ selection: new Set([id]) });
  s = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    x: e.clientX,
    y: e.clientY,
    id,
    ids: [],
    started: false,
    ctrl,
    fromPanel,
    raf: 0,
    hoverKey: "",
    hoverSince: 0,
    edgeKey: "",
    edgeSince: 0,
    outsideSince: 0,
    lastForeign: 0,
    foreignBusy: false,
    lockedWarned: false,
    gap: -1,
    panelSeen: st.panel?.openedAt ?? 0,
    enteredPanel: fromPanel,
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("keydown", onKey, true);
}

function detach() {
  window.removeEventListener("pointermove", onMove, true);
  window.removeEventListener("pointerup", onUp, true);
  window.removeEventListener("pointercancel", onCancel, true);
  window.removeEventListener("keydown", onKey, true);
  if (s?.raf) cancelAnimationFrame(s.raf);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && s) {
    e.preventDefault();
    e.stopPropagation();
    endDrag(null);
  }
}

function onCancel() {
  if (s?.foreignBusy) return;
  endDrag(null);
}

function onMove(e: PointerEvent) {
  if (!s || e.pointerId !== s.pointerId) return;
  s.x = e.clientX;
  s.y = e.clientY;
  if (!s.started) {
    if (Math.hypot(s.x - s.startX, s.y - s.startY) < 6) return;
    if (desk().settings.behavior.lockLayout) {
      if (!s.lockedWarned) {
        s.lockedWarned = true;
        toast(t.layoutLocked, undefined, 3500);
      }
      return;
    }
    startDrag();
  }
  ghost.x.set(s.x);
  ghost.y.set(s.y);
}

function startDrag() {
  if (!s) return;
  s.started = true;
  s.ids = orderedSelection(s.id);
  const el = iconEls.get(s.id);
  const r = el?.getBoundingClientRect();
  ghost.offX = r ? s.startX - r.left : 24;
  ghost.offY = r ? s.startY - r.top : 24;
  ghost.x.set(s.x);
  ghost.y.set(s.y);
  useDesk.setState({ selection: new Set(s.ids), rename: null });
  if (s.fromPanel) {
    const folder = currentPanelFolder();
    const kids = folder ? desk().layout.folders[folder]?.children ?? [] : [];
    const idx = kids.indexOf(s.id);
    const dragged = s.ids;
    s.gap = idx < 0 ? -1 : kids.slice(0, idx).filter((k) => !dragged.includes(k)).length;
  }
  useDrag.setState({
    drag: {
      ids: s.ids,
      primary: s.id,
      target: s.fromPanel && s.gap >= 0 ? { kind: "reorder", folderId: currentPanelFolder()!, index: s.gap } : null,
      extraPage: null,
    },
  });
  const loop = () => {
    if (!s || !s.started) return;
    tick();
    s.raf = requestAnimationFrame(loop);
  };
  s.raf = requestAnimationFrame(loop);
}

function onUp(e: PointerEvent) {
  if (!s || e.pointerId !== s.pointerId) return;
  if (!s.started) {
    const id = s.id;
    const ctrl = s.ctrl;
    detach();
    s = null;
    const st = desk();
    if (ctrl) {
      const sel = new Set(st.selection);
      if (sel.has(id)) sel.delete(id);
      else sel.add(id);
      useDesk.setState({ selection: sel });
    } else {
      useDesk.setState({ selection: new Set([id]) });
      if (isFolderId(id)) {
        if (st.panel && st.panel.stack.length > 0 && st.layout.folders[id] && currentPanelFolder() !== id) panelEnter(id);
        else if (!st.panel) openFolder(id);
      }
    }
    return;
  }
  const target = useDrag.getState().drag?.target ?? null;
  endDrag(target);
}

// ---------------------------------------------------------------- hit testing

function hover(key: string) {
  if (!s) return 0;
  if (s.hoverKey !== key) {
    s.hoverKey = key;
    s.hoverSince = now();
  }
  return now() - s.hoverSince;
}

function draggedAreRealFiles() {
  const { itemMap } = desk();
  return s!.ids.every((id) => {
    const it = itemMap.get(id);
    return it && it.kind !== "system";
  });
}

function canMergeWith(targetId: string) {
  if (!s) return false;
  const { layout } = desk();
  // a virtual folder can't end up inside itself
  for (const id of s.ids) {
    if (id === targetId) return false;
    if (isFolderId(id) && !isFolderId(targetId)) {
      const parent = Object.values(layout.folders).find((f) => f.children.includes(targetId));
      if (parent && isInside(layout, parent.id, id)) return false;
    }
  }
  return true;
}

function tick() {
  if (!s) return;
  const st = desk();
  const x = s.x;
  const y = s.y;

  // leaving the window area for another app's window -> native OLE drag
  if (!s.foreignBusy && now() - s.lastForeign > 140 && draggedAreRealFiles()) {
    s.lastForeign = now();
    api
      .cursorOverForeignWindow()
      .then((foreign) => {
        if (foreign && s && s.started && !s.foreignBusy) startForeignDrag();
      })
      .catch(() => {});
  }

  if (st.panel && panelGrid.panelEl) {
    if (s.panelSeen !== st.panel.openedAt) {
      s.panelSeen = st.panel.openedAt;
      s.enteredPanel = false;
    }
    const pr = panelGrid.panelEl.getBoundingClientRect();
    const m = 14;
    const inside = x >= pr.left - m && x <= pr.right + m && y >= pr.top - m && y <= pr.bottom + m;
    if (inside) {
      s.outsideSince = 0;
      s.enteredPanel = true;
      evaluatePanel(x, y);
      return;
    }
    // A panel that sprang open while hovering its folder: until the pointer reaches it,
    // letting go anywhere drops into that folder.
    if (!s.enteredPanel && Date.now() - st.panel.openedAt < 2500) {
      s.outsideSince = 0;
      const f = currentPanelFolder();
      setDrag({ target: f ? { kind: "into", folderId: f } : null });
      return;
    }
    setDrag({ target: null });
    if (!s.outsideSince) s.outsideSince = now();
    if (now() - s.outsideSince > 420) {
      s.outsideSince = now();
      if (st.panel.stack.length > 1) panelBack();
      else closePanel();
      s.gap = -1;
    }
    return;
  }
  evaluateDesktop(x, y);
}

function evaluateDesktop(x: number, y: number) {
  if (!s) return;
  const { grids, pages, layout, itemMap } = desk();
  const g = gridAt(grids, x, y);
  if (!g) return setDrag({ target: null });
  const lx = x - g.left;
  const ly = y - g.top;
  const page = pages[g.monitorId] ?? 0;

  // page switching at the monitor's left/right edge
  const edge = lx < g.workLeft + 26 ? -1 : lx > g.workLeft + g.workWidth - 26 ? 1 : 0;
  if (edge !== 0) {
    const key = `${g.monitorId}:${edge}`;
    if (s.edgeKey !== key) {
      s.edgeKey = key;
      s.edgeSince = now();
    } else if (now() - s.edgeSince > 650) {
      const count = pageCount(layout, g.monitorId);
      const next = page + edge;
      if (next >= 0 && next <= count) {
        setPage(g.monitorId, next);
        setDrag({ extraPage: g.monitorId });
      }
      s.edgeSince = now() + 350;
    }
  } else s.edgeKey = "";

  const { c, r } = cellAt(g, lx, ly);
  const exclude = new Set(s.ids);
  const occ = occupancy(layout, exclude);
  const occupant = occ.get(cellKey(g.monitorId, page, c, r));
  const cellTarget = (displaced: { id: string; to: Placement } | null): DropTarget => ({
    kind: "cell",
    placement: { m: g.monitorId, p: page, c, r },
    displaced,
  });

  if (!occupant) {
    hover(`cell:${c}:${r}`);
    return setDrag({ target: cellTarget(null) });
  }

  const box = iconBox(g, c, r);
  const pad = g.iconSize * 0.2;
  const inCenter = lx >= box.x - pad && lx <= box.x + box.w + pad && ly >= box.y - pad && ly <= box.y + box.h + pad;
  const it = itemMap.get(occupant);

  if (inCenter) {
    if (isFolderId(occupant)) {
      if (s.ids.some((id) => isFolderId(id) && isInside(layout, occupant, id))) {
        return setDrag({ target: null });
      }
      const dwell = hover(`into:${occupant}`);
      if (dwell > 950) {
        s.hoverSince = now() + 10_000;
        openFolder(occupant);
      }
      return setDrag({ target: { kind: "into", folderId: occupant } });
    }
    if (it?.kind === "folder" && draggedAreRealFiles()) {
      hover(`real:${occupant}`);
      return setDrag({ target: { kind: "real", id: occupant } });
    }
    if (occupant === RECYCLE_ID) {
      hover(`recycle`);
      return setDrag({ target: { kind: "recycle", id: occupant } });
    }
    hover(`merge:${occupant}`);
    if (canMergeWith(occupant)) return setDrag({ target: { kind: "merge", id: occupant } });
    return setDrag({ target: null });
  }

  // edge of an occupied cell: make room (single item only)
  const dwell = hover(`room:${occupant}`);
  if (s.ids.length === 1 && dwell > 170) {
    const origin = layout.placements[s.ids[0]];
    let to: Placement;
    if (origin && origin.m === g.monitorId && origin.p === page) to = origin;
    else {
      occ.set(cellKey(g.monitorId, page, c, r), s.ids[0]);
      to = nearestFree(occ, grids, { m: g.monitorId, p: page, c, r });
    }
    return setDrag({ target: cellTarget({ id: occupant, to }) });
  }
  if (s.ids.length > 1) return setDrag({ target: cellTarget(null) });
}

function evaluatePanel(x: number, y: number) {
  if (!s) return;
  const folderId = currentPanelFolder();
  const el = panelGrid.el;
  const { layout, itemMap } = desk();
  if (!folderId || !el || !layout.folders[folderId]) return setDrag({ target: null });

  const rect = el.getBoundingClientRect();
  // auto-scroll near the top/bottom edge
  if (y < rect.top + 28) el.scrollTop -= 10;
  else if (y > rect.bottom - 28) el.scrollTop += 10;

  const children = layout.folders[folderId].children.filter((c) => !s!.ids.includes(c));
  const { cols, cellW, cellH, padX, padY } = panelGrid;
  const lx = x - rect.left - padX;
  const ly = y - rect.top - padY + el.scrollTop;
  const col = Math.min(cols - 1, Math.max(0, Math.floor(lx / cellW)));
  const row = Math.max(0, Math.floor(ly / cellH));
  const total = children.length + 1; // + gap slot
  const slot = Math.min(total - 1, row * cols + col);
  if (s.gap < 0 || s.gap > children.length) s.gap = children.length;

  if (slot !== s.gap) {
    const child = slot < s.gap ? children[slot] : children[slot - 1];
    if (child) {
      const ix = col * cellW + (cellW - desk().settings.grid.iconSize) / 2;
      const iy = row * cellH + ICON_TOP;
      const size = desk().settings.grid.iconSize;
      const pad = size * 0.2;
      const inCenter = lx >= ix - pad && lx <= ix + size + pad && ly >= iy - pad && ly <= iy + size + pad;
      if (inCenter) {
        const it = itemMap.get(child);
        if (isFolderId(child)) {
          if (s.ids.some((id) => isFolderId(id) && isInside(layout, child, id))) return setDrag({ target: null });
          const dwell = hover(`into:${child}`);
          if (dwell > 950) {
            s.hoverSince = now() + 10_000;
            panelEnter(child);
            s.gap = -1;
          }
          return setDrag({ target: { kind: "into", folderId: child } });
        }
        if (it?.kind === "folder" && draggedAreRealFiles()) {
          hover(`real:${child}`);
          return setDrag({ target: { kind: "real", id: child } });
        }
        if (child === RECYCLE_ID) {
          hover("recycle");
          return setDrag({ target: { kind: "recycle", id: child } });
        }
        hover(`merge:${child}`);
        if (canMergeWith(child)) return setDrag({ target: { kind: "merge", id: child } });
        return setDrag({ target: null });
      }
    }
    if (hover(`slot:${slot}`) > 90) s.gap = slot;
  } else hover(`slot:${slot}`);
  setDrag({ target: { kind: "reorder", folderId, index: s.gap } });
}

// ---------------------------------------------------------------- drop

function rememberFly(ids: string[], x: number, y: number) {
  const at = Date.now();
  ids.forEach((id, i) => flyFrom.set(id, { x: x - ghost.offX + i * 6, y: y - ghost.offY + i * 6, at }));
}

function endDrag(target: DropTarget) {
  const sess = s;
  detach();
  s = null;
  const visual = useDrag.getState().drag;
  useDrag.setState({ drag: null });
  if (!sess || !sess.started || !visual) return;
  const ids = sess.ids;
  const { layout, grids, settings } = desk();
  rememberFly(ids, sess.x, sess.y);

  if (!target) return; // icons fly back home
  switch (target.kind) {
    case "cell": {
      commit(moveToCell(layout, grids, ids, sess.id, target.placement, target.displaced), undefined, new Set(ids));
      break;
    }
    case "merge": {
      const r = mergeIntoNewFolder(layout, target.id, ids, t.newFolderName, settings.folders.defaultColor);
      if (!r) return;
      flyFrom.delete(target.id);
      commit(r.layout);
      const inPanel = !!desk().panel;
      window.setTimeout(() => {
        if (inPanel) {
          panelEnter(r.folderId);
          const p = desk().panel;
          if (p) useDesk.setState({ panel: { ...p, editTitle: true } });
        } else openFolder(r.folderId, { editTitle: true });
      }, 260);
      break;
    }
    case "into": {
      const next = moveIntoFolder(layout, ids, target.folderId);
      if (next === layout) toast(t.cantDropIntoItself);
      else {
        commit(next);
        bump(target.folderId);
      }
      break;
    }
    case "reorder": {
      const next = moveIntoFolder(layout, ids, target.folderId, target.index);
      if (next === layout) toast(t.cantDropIntoItself);
      else commit(next);
      break;
    }
    case "real": {
      moveToRealFolder(ids, target.id);
      break;
    }
    case "recycle": {
      deleteIds(ids);
      break;
    }
  }
  useDesk.setState({ selection: new Set(ids.filter((id) => desk().layout.placements[id] || isFolderId(id))) });
}

export async function moveToRealFolder(ids: string[], folderItemId: string) {
  const { itemMap, layout } = desk();
  const target = itemMap.get(folderItemId);
  if (!target) return;
  const movable = ids.filter((id) => {
    const it = itemMap.get(id);
    return it && it.kind !== "system" && id !== folderItemId;
  });
  if (!movable.length) return;
  const paths = movable.map((id) => itemMap.get(id)!.path);
  try {
    await api.moveIntoFolder(paths, target.path);
    const moves = paths.map((p) => ({ from: p, to: `${target.path}\\${baseName(p, true)}` }));
    commit(removeIds(layout, movable), { kind: "move", moves });
    toast(t.moved);
  } catch (e) {
    console.error(e);
    toast(t.operationFailed);
  }
}

/** Short "absorb" pulse on a folder tile after something was dropped in. */
export const useBump = create<{ id: string | null; n: number }>(() => ({ id: null, n: 0 }));
function bump(id: string) {
  useBump.setState({ id, n: useBump.getState().n + 1 });
}

// ---------------------------------------------------------------- native drag to other apps

function startForeignDrag() {
  if (!s) return;
  const { itemMap } = desk();
  const paths = s.ids.map((id) => itemMap.get(id)?.path).filter((p): p is string => !!p);
  if (!paths.length) return;
  s.foreignBusy = true;
  const sess = s;
  useDrag.setState({ drag: null });
  api
    .startDragOut(paths)
    .then((effect) => {
      if (effect === "move") refreshItems().catch(() => {});
    })
    .catch((e) => console.error("drag out", e))
    .finally(() => {
      if (s === sess) {
        detach();
        s = null;
      }
    });
}

// ---------------------------------------------------------------- marquee selection

/** Rubber-band selection. `pointerId` is null when it is driven by the pass-through events. */
let marq: { pointerId: number | null; x0: number; y0: number; base: Set<string>; moved: boolean } | null = null;

function marqBegin(x: number, y: number, additive: boolean, pointerId: number | null) {
  marq = { pointerId, x0: x, y0: y, base: additive ? new Set(desk().selection) : new Set(), moved: false };
  if (!additive) useDesk.setState({ selection: new Set(), rename: null });
}

function marqUpdate(x: number, y: number) {
  if (!marq) return;
  if (!marq.moved && Math.hypot(x - marq.x0, y - marq.y0) < 4) return;
  marq.moved = true;
  const m = { x0: marq.x0, y0: marq.y0, x1: x, y1: y };
  useDrag.setState({ marquee: m });
  const L = Math.min(m.x0, m.x1);
  const R = Math.max(m.x0, m.x1);
  const T = Math.min(m.y0, m.y1);
  const B = Math.max(m.y0, m.y1);
  const { layout, grids, pages } = desk();
  const sel = new Set(marq.base);
  for (const [id, pl] of Object.entries(layout.placements)) {
    const g: GridInfo | undefined = grids[pl.m];
    if (!g || pl.p !== (pages[pl.m] ?? 0)) continue;
    const cx = g.left + g.originX + pl.c * g.cellW + 4;
    const cy = g.top + g.originY + pl.r * g.cellH + 2;
    const w = g.cellW - 8;
    const h = g.cellH - 4;
    if (cx < R && cx + w > L && cy < B && cy + h > T) sel.add(id);
  }
  useDesk.setState({ selection: sel });
}

function marqFinish() {
  marq = null;
  useDrag.setState({ marquee: null });
}

export function beginMarquee(e: React.PointerEvent) {
  if (e.button !== 0 || marq || s) return;
  marqBegin(e.clientX, e.clientY, e.ctrlKey || e.metaKey, e.pointerId);
  window.addEventListener("pointermove", marqMove, true);
  window.addEventListener("pointerup", marqUp, true);
  window.addEventListener("pointercancel", marqUp, true);
}

function marqMove(e: PointerEvent) {
  if (marq && e.pointerId === marq.pointerId) marqUpdate(e.clientX, e.clientY);
}

function marqUp(e: PointerEvent) {
  if (!marq || e.pointerId !== marq.pointerId) return;
  window.removeEventListener("pointermove", marqMove, true);
  window.removeEventListener("pointerup", marqUp, true);
  window.removeEventListener("pointercancel", marqUp, true);
  marqFinish();
}

/**
 * The same selection rectangle for a press on the EMPTY desktop. Windows handles that click itself
 * (the window lets it through), so the app only observes it: the press, the moves and the release
 * arrive as events from the pass-through poller.
 */
export function emptyPress(x: number, y: number, ctrl: boolean) {
  if (marq || s) return;
  marqBegin(x, y, ctrl, null);
}
export function emptyDrag(x: number, y: number) {
  if (marq && marq.pointerId === null) marqUpdate(x, y);
}
export function emptyRelease() {
  if (marq && marq.pointerId === null) marqFinish();
}

export function isDragging() {
  return !!s?.started;
}
