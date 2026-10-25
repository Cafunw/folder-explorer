// Pointer-driven drag & drop for desktop icons and folder panels, plus marquee selection.

import { motionValue } from "motion/react";
import { create } from "zustand";
import { api } from "../api";
import { t } from "../i18n";
import { FENCE_TITLE, fenceGeometry, fenceHit, fenceOf, isBlock, isFence, slotAt, snapMove, snapResize } from "../layout/blocks";
import { cellAt, cellKey, cellXY, gridAt, iconBox, ICON_TOP, primaryGrid, type GridInfo } from "../layout/grid";
import {
  acceptsDrops,
  isFolderId,
  isHeadingId,
  isInside,
  mergeIntoNewFolder,
  moveIntoFolder,
  moveToCell,
  nearestFree,
  occupancy,
  pageCount,
  removeIds,
  resizeSpan,
  spanOf,
  withSpan,
} from "../layout/model";
import { setActiveTab } from "../layout/smart";
import type { Placement } from "../types";
import { closePanel, currentPanelFolder, deleteIds, openFolder, panelBack, panelEnter } from "./actions";
import { dropKindOf, dropOnApp, notePlainClick, realDirOf, resetPlainClick, warmDropKinds } from "./interaction";
import { displayToChildIndex } from "./kinds";
import { jiggling, takeLongPress } from "./Jiggle";
import { lockedOnPath } from "./locks";
import { fenceBodies, flyFrom, iconEls, panelGrid } from "./registry";
import { playSound } from "./sounds";
import { baseName, commit, refreshItems, replaceLayout, setPage, toast, useDesk } from "./store";

export const RECYCLE_ID = "::{645ff040-5081-101b-9f08-00aa002f954e}";

export type DropTarget =
  | { kind: "cell"; placement: Placement; displaced: { id: string; to: Placement } | null }
  | { kind: "merge"; id: string }
  | { kind: "into"; folderId: string }
  | { kind: "real"; id: string }
  | { kind: "recycle"; id: string }
  | { kind: "reorder"; folderId: string; index: number }
  | { kind: "app"; id: string } // files dropped on an app open with it (`drop_on_item`)
  | null;

export type DragVisual = {
  ids: string[];
  primary: string;
  target: DropTarget;
  extraPage: string | null; // monitor that shows one extra (empty) page while dragging
  size: number; // icon size / cell width where the drag started (monitors can differ)
  cellW: number;
};

type Marquee = { x0: number; y0: number; x1: number; y1: number } | null;

/** A fence / heading being moved or resized: where it will land (`to` carries its w × h). */
export type BlockPreview = { id: string; mode: "move" | "resize"; to: Placement; extraPage: string | null };

export const useDrag = create<{ drag: DragVisual | null; marquee: Marquee; external: DropTarget; block: BlockPreview | null }>(() => ({
  drag: null,
  marquee: null,
  external: null,
  block: null,
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
  shift: boolean; // held now: an app under the pointer takes a group instead of opening the files
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
  fence: string | null; // the fence the dragged icon came from
  gapFence: string | null; // the fence whose body the pointer is over
  fenceGap: number; // reorder slot inside that fence
};

let s: Session | null = null;

const now = () => performance.now();

function orderedSelection(primary: string): string[] {
  const { selection, layout } = desk();
  if (!selection.has(primary) || selection.size === 1) return [primary];
  // fences and headings move with their own handles, not along with icons
  const ids = [...selection].filter((id) => id === primary || !isBlock(layout, id));
  const folder = currentPanelFolder() ?? fenceOf(layout, primary);
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
    shift: e.shiftKey,
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
    fence: fromPanel ? null : fenceOf(st.layout, id),
    gapFence: null,
    fenceGap: -1,
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
}

function detach() {
  window.removeEventListener("pointermove", onMove, true);
  window.removeEventListener("pointerup", onUp, true);
  window.removeEventListener("pointercancel", onCancel, true);
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("keyup", onKey, true);
  if (s?.raf) cancelAnimationFrame(s.raf);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Shift" && s) s.shift = e.type === "keydown";
  if (e.key === "Escape" && e.type === "keydown" && s) {
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
  s.shift = e.shiftKey;
  if (!s.started) {
    // in icon edit mode a drag starts at once
    if (Math.hypot(s.x - s.startX, s.y - s.startY) < (jiggling() ? 2 : 6)) return;
    if (desk().settings.behavior.lockLayout) {
      if (!s.lockedWarned) {
        s.lockedWarned = true;
        toast(t.layoutLocked, undefined, 3500);
        playSound("error");
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
  warmDropKinds();
  const el = iconEls.get(s.id);
  const r = el?.getBoundingClientRect();
  ghost.offX = r ? s.startX - r.left : 24;
  ghost.offY = r ? s.startY - r.top : 24;
  ghost.x.set(s.x);
  ghost.y.set(s.y);
  useDesk.setState({ selection: new Set(s.ids), rename: null });
  if (s.fromPanel) {
    const folder = panelGrid.folderId ?? currentPanelFolder();
    const kids = panelGrid.items ?? (folder ? desk().layout.folders[folder]?.children ?? [] : []);
    const idx = kids.indexOf(s.id);
    const dragged = s.ids;
    s.gap = idx < 0 ? -1 : kids.slice(0, idx).filter((k) => !dragged.includes(k)).length;
  } else if (s.fence) {
    // its own place in the fence, until the pointer goes elsewhere
    const kids = desk().layout.folders[s.fence]?.children ?? [];
    const idx = kids.indexOf(s.id);
    const dragged = s.ids;
    s.gapFence = s.fence;
    s.fenceGap = idx < 0 ? kids.length : kids.slice(0, idx).filter((k) => !dragged.includes(k)).length;
  }
  useDrag.setState({
    drag: {
      ids: s.ids,
      primary: s.id,
      target:
        s.fromPanel && s.gap >= 0
          ? { kind: "reorder", folderId: panelGrid.folderId ?? currentPanelFolder()!, index: s.gap }
          : s.fence
            ? { kind: "reorder", folderId: s.fence, index: s.fenceGap }
            : null,
      extraPage: null,
      ...ghostSize(s),
    },
  });
  const loop = () => {
    if (!s || !s.started) return;
    tick();
    s.raf = requestAnimationFrame(loop);
  };
  s.raf = requestAnimationFrame(loop);
}

function ghostSize(s: Session) {
  if (s.fromPanel) return { size: panelGrid.iconSize, cellW: panelGrid.cellW };
  const { grids, layout } = desk();
  const g = grids[layout.placements[s.fence ?? s.id]?.m ?? ""] ?? primaryGrid(grids);
  return { size: g.iconSize, cellW: g.cellW };
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
      // the long press that started the icon edit mode does not open the group under it
      if (isFolderId(id) && !takeLongPress(e.pointerId)) {
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
  const { grids, pages, layout } = desk();
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

  const wasInFence = s.gapFence;
  s.gapFence = null;
  if (!occupant) {
    hover(`cell:${c}:${r}`);
    return setDrag({ target: cellTarget(null) });
  }
  // every cell a fence covers is the fence; a heading's cells send the icon to the nearest free one
  if (isFence(layout, occupant)) return evaluateFence(occupant, g, lx, ly, wasInFence);
  if (isHeadingId(occupant)) {
    hover(`cell:${c}:${r}`);
    return setDrag({ target: cellTarget(null) });
  }

  const box = iconBox(g, c, r);
  const pad = g.iconSize * 0.2;
  const inCenter = lx >= box.x - pad && lx <= box.x + box.w + pad && ly >= box.y - pad && ly <= box.y + box.h + pad;

  if (inCenter) {
    if (isFolderId(occupant)) return setDrag({ target: groupTarget(occupant, openFolder) });
    const file = fileTarget(occupant);
    if (file) return setDrag({ target: file });
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
  // the grid's group: a tabs group's open tab may be one of its child groups
  const folderId = panelGrid.folderId ?? currentPanelFolder();
  const el = panelGrid.el;
  const { layout } = desk();
  if (!folderId || !el || !layout.folders[folderId]) return setDrag({ target: null });

  // a tab header of a tabs group: into that tab's group; dwelling switches to it
  for (const [tabId, tab] of panelGrid.tabs) {
    const r = tab.el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const into = groupTarget(tab.folderId, () => {
      if (panelGrid.tabsOwner) replaceLayout(setActiveTab(desk().layout, panelGrid.tabsOwner, tabId));
      if (s) s.gap = -1;
    });
    return setDrag({ target: into });
  }

  const rect = el.getBoundingClientRect();
  // auto-scroll near the top/bottom edge
  if (y < rect.top + 28) el.scrollTop -= 10;
  else if (y > rect.bottom - 28) el.scrollTop += 10;

  const children = (panelGrid.items ?? layout.folders[folderId].children).filter((c) => !s!.ids.includes(c));
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
      const size = panelGrid.iconSize;
      const ix = col * cellW + (cellW - size) / 2;
      const iy = row * cellH + ICON_TOP;
      const pad = size * 0.2;
      const inCenter = lx >= ix - pad && lx <= ix + size + pad && ly >= iy - pad && ly <= iy + size + pad;
      if (inCenter) {
        return setDrag({
          target: iconTarget(child, (id) => {
            panelEnter(id);
            if (s) s.gap = -1;
          }),
        });
      }
    }
    if (hover(`slot:${slot}`) > 90) s.gap = slot;
  } else hover(`slot:${slot}`);
  setDrag({ target: { kind: "reorder", folderId, index: s.gap } });
}

/**
 * Dropping onto a group: into it — a live group takes real files only (they move into its folder),
 * a frequent one nothing. Dwelling on it springs it open, unless it is a stack, a fence or locked.
 */
function groupTarget(folderId: string, openAfter: (id: string) => void): DropTarget {
  if (!s) return null;
  const { layout } = desk();
  const f = layout.folders[folderId];
  const dwell = hover(`into:${folderId}`);
  if (!f || s.ids.some((id) => isFolderId(id) && isInside(layout, folderId, id))) return null;
  if (f.kind === "frequent" || (f.kind === "live" && !draggedAreRealFiles())) return null;
  if (dwell > 950 && acceptsDrops(f) && f.display !== "stack" && f.display !== "fence" && !lockedOnPath(folderId)) {
    s.hoverSince = now() + 10_000;
    openAfter(folderId);
  }
  return { kind: "into", folderId };
}

/**
 * Dropping files on a real folder (or a shortcut to one) moves them there; on an app (`.exe`, a
 * shortcut to one) opens them with it, unless Shift is held or `behavior.dropOnApp` is off (then
 * a group is made, as with any icon). Null = neither (groups, system items, headings dragged…).
 */
function fileTarget(id: string): DropTarget {
  if (!s || !draggedAreRealFiles()) return null;
  const k = dropKindOf(id);
  if (k?.kind === "dir") {
    hover(`real:${id}`);
    return { kind: "real", id };
  }
  if (k?.kind === "app" && !s.shift && desk().settings.behavior.dropOnApp) {
    hover(`app:${id}`);
    return { kind: "app", id };
  }
  return null;
}

/** What dropping on a child's icon does (a group: into it; a real folder: move there; an app: open; else a new group). */
function iconTarget(child: string, openAfter: (id: string) => void): DropTarget {
  if (!s) return null;
  if (isFolderId(child)) return groupTarget(child, openAfter);
  const file = fileTarget(child);
  if (file) return file;
  if (child === RECYCLE_ID) {
    hover("recycle");
    return { kind: "recycle", id: child };
  }
  hover(`merge:${child}`);
  return canMergeWith(child) ? { kind: "merge", id: child } : null;
}

/**
 * Pointer over a fence (`lx` / `ly` relative to monitor `g`'s surface): its title bar (and a
 * folded body) drops at the end, its body makes a gap like an open panel.
 */
function evaluateFence(fenceId: string, g: GridInfo, lx: number, ly: number, wasInFence: string | null) {
  if (!s) return;
  const { layout } = desk();
  const f = layout.folders[fenceId];
  const pl = layout.placements[fenceId];
  if (!f || !pl || s.ids.some((id) => isFolderId(id) && isInside(layout, fenceId, id))) return setDrag({ target: null });
  if (!acceptsDrops(f)) {
    // a live group moves the files into its folder; a frequent one takes nothing
    hover(`fence:${fenceId}`);
    return setDrag({ target: f.kind === "live" ? { kind: "into", folderId: fenceId } : null });
  }
  const geo = fenceGeometry(g, pl, !!f.collapsed);
  const el = fenceBodies.get(fenceId);
  const hit = fenceHit(geo, lx, ly, el?.scrollTop ?? 0);
  if (hit.part === "title") {
    hover(`fence:${fenceId}`);
    return setDrag({ target: { kind: "into", folderId: fenceId } });
  }
  if (el) {
    if (ly < geo.bodyY + 18) el.scrollTop -= 8;
    else if (ly > geo.y + geo.h - 18) el.scrollTop += 8;
  }
  const children = f.children.filter((c) => !s!.ids.includes(c));
  const { col, row, slot } = slotAt(hit.bx, hit.by, geo.cols, geo.cellW, geo.cellH, children.length);
  s.gapFence = fenceId;
  // coming in from elsewhere the gap starts at the end (dropping on a child's icon stays possible)
  if (wasInFence !== fenceId || s.fenceGap < 0 || s.fenceGap > children.length) s.fenceGap = children.length;

  if (slot !== s.fenceGap) {
    const child = slot < s.fenceGap ? children[slot] : children[slot - 1];
    if (child) {
      const size = g.iconSize;
      const ix = col * geo.cellW + (geo.cellW - size) / 2;
      const iy = row * geo.cellH + ICON_TOP;
      const pad = size * 0.2;
      if (hit.bx >= ix - pad && hit.bx <= ix + size + pad && hit.by >= iy - pad && hit.by <= iy + size + pad) {
        return setDrag({ target: iconTarget(child, openFolder) });
      }
    }
    if (hover(`fslot:${fenceId}:${slot}`) > 90) s.fenceGap = slot;
  } else hover(`fslot:${fenceId}:${slot}`);
  setDrag({ target: { kind: "reorder", folderId: fenceId, index: s.fenceGap } });
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
      playSound("drop");
      break;
    }
    case "merge": {
      const r = mergeIntoNewFolder(layout, target.id, ids, t.newFolderName, settings.folders.defaultColor);
      if (!r) return;
      flyFrom.delete(target.id);
      commit(r.layout);
      playSound("merge");
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
      const into = layout.folders[target.folderId];
      if (into?.kind === "live") {
        // a live group shows a real folder: the files move there (undoable)
        if (into.source) moveToDir(ids, into.source).then((ok) => ok && bump(target.folderId));
        else toast(t.grp.liveNoSource);
        break;
      }
      if (into?.kind === "frequent") {
        toast(t.grp.frequentNoDrop);
        break;
      }
      const next = moveIntoFolder(layout, ids, target.folderId);
      if (next === layout) {
        toast(t.cantDropIntoItself);
        playSound("error");
      } else {
        commit(next);
        bump(target.folderId);
        playSound("drop");
      }
      break;
    }
    case "reorder": {
      // a filtered grid (a tabs group's "Genel" tab) counts its slots among the shown ids only
      const index =
        panelGrid.items && desk().panel && panelGrid.folderId === target.folderId
          ? displayToChildIndex(layout.folders[target.folderId]?.children ?? [], panelGrid.items, ids, target.index)
          : target.index;
      const next = moveIntoFolder(layout, ids, target.folderId, index);
      if (next === layout) {
        toast(t.cantDropIntoItself);
        playSound("error");
      } else {
        commit(next);
        playSound("drop");
      }
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
    case "app": {
      // the icons fly back home; the app gets the files like from Explorer
      const { itemMap } = desk();
      const paths = ids.filter((id) => id !== target.id).map((id) => itemMap.get(id)?.path).filter((p): p is string => !!p);
      void dropOnApp(target.id, paths);
      break;
    }
  }
  const after = desk().layout;
  useDesk.setState({ selection: new Set(ids.filter((id) => after.placements[id] || isFolderId(id) || fenceOf(after, id))) });
}

export async function moveToRealFolder(ids: string[], folderItemId: string) {
  // a folder icon, or a shortcut to a folder (its target)
  const dir = realDirOf(folderItemId);
  if (dir) await moveToDir(ids.filter((id) => id !== folderItemId), dir);
}

/** Move desktop items' files into a real directory (a folder icon, a live group's folder); undoable. */
export async function moveToDir(ids: string[], dir: string): Promise<boolean> {
  const { itemMap } = desk();
  const movable = ids.filter((id) => {
    const it = itemMap.get(id);
    return it && it.kind !== "system";
  });
  if (!movable.length) return false;
  const paths = movable.map((id) => itemMap.get(id)!.path);
  try {
    await api.moveIntoFolder(paths, dir);
    const moves = paths.map((p) => ({ from: p, to: `${dir.replace(/[\\/]+$/, "")}\\${baseName(p, true)}` }));
    // the move can take a while: build on the layout as it is now, so changes made meanwhile stay
    commit(removeIds(desk().layout, movable), { kind: "move", moves });
    toast(t.moved);
    playSound("drop");
    return true;
  } catch (e) {
    console.error(e);
    toast(t.operationFailed);
    playSound("error");
    return false;
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

/**
 * Rubber-band selection on the empty desktop. `plain` = a press without modifiers outside every
 * `[data-hit]` element: released without moving it counts towards a double-click (hide icons).
 */
let marq: { pointerId: number; x0: number; y0: number; base: Set<string>; moved: boolean; plain: boolean } | null = null;

function marqBegin(x: number, y: number, additive: boolean, pointerId: number, plain: boolean) {
  marq = { pointerId, x0: x, y0: y, base: additive ? new Set(desk().selection) : new Set(), moved: false, plain };
  if (!additive) useDesk.setState({ selection: new Set(), rename: null });
}

function marqUpdate(x: number, y: number) {
  if (!marq) return;
  if (!marq.moved && Math.hypot(x - marq.x0, y - marq.y0) < 4) return;
  marq.moved = true;
  // hidden icons (View ▸ Show desktop icons off) are not selected
  if (!desk().settings.behavior.showIcons) return;
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
    let cx = g.left + g.originX + pl.c * g.cellW + 4;
    let cy = g.top + g.originY + pl.r * g.cellH + 2;
    let w = g.cellW - 8;
    let h = g.cellH - 4;
    if (isFence(layout, id)) {
      // a fence is picked by its title bar (its children are not selected)
      const geo = fenceGeometry(g, pl);
      cx = g.left + geo.x;
      cy = g.top + geo.y;
      w = geo.w;
      h = FENCE_TITLE;
    } else if (isHeadingId(id)) {
      w = spanOf(pl).w * g.cellW - 8;
      h = spanOf(pl).h * g.cellH - 4;
    }
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
  const plain =
    !(e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) && !(e.target as Element | null)?.closest?.("[data-hit]");
  marqBegin(e.clientX, e.clientY, e.ctrlKey || e.metaKey, e.pointerId, plain);
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
  const click = marq.plain && !marq.moved && e.type === "pointerup" && !e.ctrlKey && !e.shiftKey && !e.altKey;
  marqFinish();
  if (click) notePlainClick(e.clientX, e.clientY, e.timeStamp);
  else resetPlainClick();
}

export function isDragging() {
  return !!s?.started || !!bs?.started;
}

// ---------------------------------------------------------------- moving / resizing fences and headings

type BlockSession = {
  pointerId: number;
  id: string;
  mode: "move" | "resize" | "resize-x";
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** pointer minus the block's top-left corner (move) / bottom-right corner (resize), window px */
  offX: number;
  offY: number;
  started: boolean;
  ctrl: boolean;
  warned: boolean;
  edge: string;
  edgeTimer: number;
};

let bs: BlockSession | null = null;

const setBlock = (b: BlockPreview | null) => {
  const cur = useDrag.getState().block;
  if (JSON.stringify(cur) !== JSON.stringify(b)) useDrag.setState({ block: b });
};

/**
 * Press on a fence's title bar or a heading (`move`), or on its resize handle (`resize`; headings
 * `resize-x`, only the width). Snaps to whole cells, previews live (`useDrag.block`) and commits
 * once on release; a click without moving selects it.
 */
export function beginBlockPointer(e: React.PointerEvent, id: string, mode: BlockSession["mode"]) {
  if (e.button !== 0 || s || bs || marq) return;
  const st = desk();
  const pl = st.layout.placements[id];
  const g = pl ? st.grids[pl.m] : undefined;
  if (!pl || !g || st.rename?.id === id) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (mode === "move" && !ctrl && !st.selection.has(id)) useDesk.setState({ selection: new Set([id]) });
  const span = spanOf(pl);
  const { x, y } = cellXY(g, pl.c, pl.r);
  const cornerX = g.left + x + (mode === "move" ? 0 : span.w * g.cellW);
  const cornerY = g.top + y + (mode === "move" ? 0 : span.h * g.cellH);
  bs = {
    pointerId: e.pointerId,
    id,
    mode,
    startX: e.clientX,
    startY: e.clientY,
    x: e.clientX,
    y: e.clientY,
    offX: e.clientX - cornerX,
    offY: e.clientY - cornerY,
    started: false,
    ctrl,
    warned: false,
    edge: "",
    edgeTimer: 0,
  };
  window.addEventListener("pointermove", blockMove, true);
  window.addEventListener("pointerup", blockUp, true);
  window.addEventListener("pointercancel", blockCancel, true);
  window.addEventListener("keydown", blockKey, true);
}

function blockDetach() {
  window.removeEventListener("pointermove", blockMove, true);
  window.removeEventListener("pointerup", blockUp, true);
  window.removeEventListener("pointercancel", blockCancel, true);
  window.removeEventListener("keydown", blockKey, true);
  if (bs?.edgeTimer) window.clearTimeout(bs.edgeTimer);
}

function blockMove(e: PointerEvent) {
  if (!bs || e.pointerId !== bs.pointerId) return;
  bs.x = e.clientX;
  bs.y = e.clientY;
  if (!bs.started) {
    if (Math.hypot(bs.x - bs.startX, bs.y - bs.startY) < 5) return;
    if (desk().settings.behavior.lockLayout) {
      if (!bs.warned) {
        bs.warned = true;
        toast(t.layoutLocked, undefined, 3500);
      }
      return;
    }
    bs.started = true;
    useDesk.setState({ rename: null });
  }
  blockEvaluate();
}

/** Recompute where the block would land for the last pointer position. */
function blockEvaluate() {
  if (!bs) return;
  const { layout, grids, pages } = desk();
  const pl = layout.placements[bs.id];
  if (!pl) return blockEnd(false);
  const extraPage = useDrag.getState().block?.extraPage ?? null;
  if (bs.mode === "move") {
    const g = gridAt(grids, bs.x, bs.y);
    if (!g) return;
    blockEdgePaging(g);
    const page = desk().pages[g.monitorId] ?? 0;
    const to = snapMove(layout, grids, bs.id, g, page, bs.x - bs.offX - g.left, bs.y - bs.offY - g.top);
    if (to) setBlock({ id: bs.id, mode: "move", to, extraPage });
    return;
  }
  const g = grids[pl.m];
  if (!g || pl.p !== (pages[pl.m] ?? 0)) return;
  const size = snapResize(layout, grids, bs.id, bs.x - bs.offX - g.left, bs.y - bs.offY - g.top, bs.mode === "resize-x" ? "x" : "xy");
  if (size) setBlock({ id: bs.id, mode: "resize", to: withSpan(pl, size.w, size.h), extraPage: null });
  else if (!useDrag.getState().block) setBlock({ id: bs.id, mode: "resize", to: pl, extraPage: null });
}

/** Holding a moved block at a monitor's left / right edge turns the page (one empty page more). */
function blockEdgePaging(g: GridInfo) {
  if (!bs) return;
  const lx = bs.x - g.left;
  const dir = lx < g.workLeft + 26 ? -1 : lx > g.workLeft + g.workWidth - 26 ? 1 : 0;
  const key = dir ? `${g.monitorId}:${dir}` : "";
  if (key === bs.edge) return;
  bs.edge = key;
  window.clearTimeout(bs.edgeTimer);
  bs.edgeTimer = 0;
  if (!dir) return;
  bs.edgeTimer = window.setTimeout(() => {
    if (!bs || bs.edge !== key) return;
    const { layout, pages } = desk();
    const next = (pages[g.monitorId] ?? 0) + dir;
    if (next < 0 || next > pageCount(layout, g.monitorId)) return;
    setPage(g.monitorId, next);
    const cur = useDrag.getState().block;
    if (cur) setBlock({ ...cur, extraPage: g.monitorId });
    bs.edge = "";
    blockEvaluate();
  }, 650);
}

function blockKey(e: KeyboardEvent) {
  if (e.key === "Escape" && bs) {
    e.preventDefault();
    e.stopPropagation();
    blockEnd(false);
  }
}

function blockCancel(e: PointerEvent) {
  if (bs && e.pointerId === bs.pointerId) blockEnd(false);
}

function blockUp(e: PointerEvent) {
  if (!bs || e.pointerId !== bs.pointerId) return;
  if (!bs.started) {
    const { id, ctrl, mode } = bs;
    blockEnd(false);
    if (mode !== "move") return;
    const sel = new Set(ctrl ? desk().selection : []);
    if (ctrl && sel.has(id)) sel.delete(id);
    else sel.add(id);
    useDesk.setState({ selection: sel });
    return;
  }
  blockEnd(true);
}

function blockEnd(apply: boolean) {
  const sess = bs;
  blockDetach();
  bs = null;
  const preview = useDrag.getState().block;
  useDrag.setState({ block: null });
  if (!apply || !sess || !preview || preview.id !== sess.id) return;
  const { layout, grids } = desk();
  const pl = layout.placements[sess.id];
  if (!pl) return;
  const to = preview.to;
  if (preview.mode === "move") {
    if (to.m === pl.m && to.p === pl.p && to.c === pl.c && to.r === pl.r) return;
    commit(moveToCell(layout, grids, [sess.id], sess.id, { m: to.m, p: to.p, c: to.c, r: to.r }));
  } else {
    const { w, h } = spanOf(to);
    const next = resizeSpan(layout, grids, sess.id, w, h);
    if (next !== layout) commit(next);
  }
  useDesk.setState({ selection: new Set([sess.id]) });
}
