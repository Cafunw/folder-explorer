// Pure layout logic. Every exported operation returns a NEW layout (inputs are never mutated).

import type { DesktopItem, Environment, FolderLook, Layout, Placement, WindowsLayout } from "../types";
import {
  cellKey,
  fromOrderIndex,
  inBounds,
  orderIndex,
  placementKey,
  primaryGrid,
  type GridMap,
} from "./grid";

export const emptyLayout = (): Layout => ({
  version: 1,
  folders: {},
  placements: {},
  custom: {},
  remembered: {},
  home: {},
  importedFromWindows: false,
});

export const isFolderId = (id: string) => id.startsWith("v:");
export const newFolderId = () => `v:${crypto.randomUUID()}`;
export const clone = (l: Layout): Layout => structuredClone(l);

const REMEMBER_MS = 14 * 24 * 3600 * 1000;
const HOME_MS = 30 * 24 * 3600 * 1000;

const validPlacement = (p: any): p is Placement =>
  !!p && typeof p.m === "string" && [p.p, p.c, p.r].every((n) => Number.isInteger(n) && n >= 0);

export function normalizeLayout(raw: unknown): Layout {
  const out = emptyLayout();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, any>;
  if (r.folders && typeof r.folders === "object") {
    for (const [id, f] of Object.entries<any>(r.folders)) {
      if (!isFolderId(id) || !f || typeof f !== "object") continue;
      out.folders[id] = {
        id,
        name: typeof f.name === "string" ? f.name : "Klasör",
        color: typeof f.color === "string" ? f.color : null,
        children: Array.isArray(f.children) ? f.children.filter((c: unknown) => typeof c === "string") : [],
      };
      const look = normalizeLook(f.look);
      if (look) out.folders[id].look = look;
    }
  }
  if (r.placements && typeof r.placements === "object") {
    for (const [id, p] of Object.entries<any>(r.placements)) {
      if (p && typeof p.m === "string" && [p.p, p.c, p.r].every((n) => Number.isInteger(n) && n >= 0)) {
        out.placements[id] = { m: p.m, p: p.p, c: p.c, r: p.r };
      }
    }
  }
  if (r.custom && typeof r.custom === "object") {
    for (const [id, c] of Object.entries<any>(r.custom)) {
      if (!c || typeof c !== "object") continue;
      const e: { name?: string; icon?: string } = {};
      if (typeof c.name === "string" && c.name) e.name = c.name;
      if (typeof c.icon === "string" && c.icon) e.icon = c.icon;
      if (e.name || e.icon) out.custom[id] = e;
    }
  }
  if (r.remembered && typeof r.remembered === "object") {
    for (const [id, m] of Object.entries<any>(r.remembered)) {
      if (m && typeof m.at === "number") out.remembered[id] = m;
    }
  }
  if (r.home && typeof r.home === "object") {
    for (const [id, h] of Object.entries<any>(r.home)) {
      if (h && typeof h.at === "number" && validPlacement(h.placement)) {
        out.home[id] = { at: h.at, placement: { m: h.placement.m, p: h.placement.p, c: h.placement.c, r: h.placement.r } };
      }
    }
  }
  out.importedFromWindows = r.importedFromWindows === true;
  return out;
}

const num = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;

/** Clean a per-folder look; returns undefined when nothing is overridden. */
export function normalizeLook(raw: unknown): FolderLook | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const look: FolderLook = {};
  const opacity = num(r.opacity, 0, 1);
  if (opacity !== undefined) look.opacity = opacity;
  const blur = num(r.blur, 0, 40);
  if (blur !== undefined) look.blur = blur;
  const radius = num(r.radius, 0, 0.5);
  if (radius !== undefined) look.radius = radius;
  if (r.preview === 2 || r.preview === 3) look.preview = r.preview;
  if (typeof r.icon === "string" && r.icon) look.icon = r.icon;
  if (r.panelStyle === "ios" || r.panelStyle === "android") look.panelStyle = r.panelStyle;
  const panelOpacity = num(r.panelOpacity, 0, 1);
  if (panelOpacity !== undefined) look.panelOpacity = panelOpacity;
  return Object.keys(look).length ? look : undefined;
}

// ---------------------------------------------------------------- queries

export function parentMap(l: Layout): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of Object.values(l.folders)) for (const c of f.children) m.set(c, f.id);
  return m;
}

export function occupancy(l: Layout, exclude?: Set<string>): Map<string, string> {
  const occ = new Map<string, string>();
  for (const [id, pl] of Object.entries(l.placements)) {
    if (exclude?.has(id)) continue;
    occ.set(placementKey(pl), id);
  }
  return occ;
}

export type Location =
  | { type: "desktop"; placement: Placement }
  | { type: "folder"; folderId: string; index: number };

export function locate(l: Layout, id: string): Location | null {
  const pl = l.placements[id];
  if (pl) return { type: "desktop", placement: { ...pl } };
  for (const f of Object.values(l.folders)) {
    const i = f.children.indexOf(id);
    if (i >= 0) return { type: "folder", folderId: f.id, index: i };
  }
  return null;
}

/** Folder ids from the top-level folder down to `folderId` (inclusive). */
export function folderPath(l: Layout, folderId: string): string[] {
  const parents = parentMap(l);
  const path: string[] = [];
  let cur: string | undefined = folderId;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    path.unshift(cur);
    cur = parents.get(cur);
  }
  return path;
}

/** True when `folderId` equals `ancestorId` or is nested somewhere inside it. */
export function isInside(l: Layout, folderId: string, ancestorId: string): boolean {
  return folderPath(l, folderId).includes(ancestorId);
}

export function descendants(l: Layout, folderId: string): string[] {
  const out: string[] = [];
  const walk = (id: string, guard: Set<string>) => {
    const f = l.folders[id];
    if (!f || guard.has(id)) return;
    guard.add(id);
    for (const c of f.children) {
      out.push(c);
      if (isFolderId(c)) walk(c, guard);
    }
  };
  walk(folderId, new Set());
  return out;
}

export function pageCount(l: Layout, monitorId: string) {
  let max = 0;
  for (const pl of Object.values(l.placements)) if (pl.m === monitorId && pl.p > max) max = pl.p;
  return max + 1;
}

// ---------------------------------------------------------------- free-cell search

export function firstFree(
  occ: Map<string, string>,
  grids: GridMap,
  m: string,
  startPage = 0,
  startIndex = 0,
): Placement {
  const g = grids[m] ?? primaryGrid(grids);
  const per = g.cols * g.rows;
  for (let p = startPage; p < startPage + 500; p++) {
    for (let i = p === startPage ? startIndex : 0; i < per; i++) {
      const { c, r } = fromOrderIndex(g, i);
      if (!occ.has(cellKey(g.monitorId, p, c, r))) return { m: g.monitorId, p, c, r };
    }
  }
  return { m: g.monitorId, p: startPage + 500, c: 0, r: 0 };
}

export function nearestFree(occ: Map<string, string>, grids: GridMap, pl: Placement): Placement {
  const g = grids[pl.m] ?? primaryGrid(grids);
  const c0 = Math.min(g.cols - 1, Math.max(0, pl.c));
  const r0 = Math.min(g.rows - 1, Math.max(0, pl.r));
  const maxD = g.cols + g.rows;
  for (let d = 0; d <= maxD; d++) {
    let best: Placement | null = null;
    let bestScore = Infinity;
    for (let dc = -d; dc <= d; dc++) {
      for (let dr = -d; dr <= d; dr++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== d) continue;
        const c = c0 + dc;
        const r = r0 + dr;
        if (!inBounds(g, c, r)) continue;
        if (occ.has(cellKey(g.monitorId, pl.p, c, r))) continue;
        // prefer straight-line neighbours, then column-major order
        const score = Math.abs(dc) + Math.abs(dr) + orderIndex(g, c, r) / 10000;
        if (score < bestScore) {
          bestScore = score;
          best = { m: g.monitorId, p: pl.p, c, r };
        }
      }
    }
    if (best) return best;
  }
  return firstFree(occ, grids, g.monitorId, pl.p + 1);
}

// ---------------------------------------------------------------- mutating helpers (internal, on clones)

function detachMut(l: Layout, id: string): Location | null {
  const loc = locate(l, id);
  if (!loc) return null;
  if (loc.type === "desktop") delete l.placements[id];
  else l.folders[loc.folderId].children.splice(loc.index, 1);
  return loc;
}

function insertMut(l: Layout, folderId: string, ids: string[], index?: number) {
  const f = l.folders[folderId];
  const at = index === undefined ? f.children.length : Math.max(0, Math.min(index, f.children.length));
  f.children.splice(at, 0, ...ids);
}

// ---------------------------------------------------------------- operations

/**
 * Move `ids` onto the desktop. The primary item lands on `target`; the others keep their
 * relative offsets when they came from the same desktop page, else take the nearest free cells.
 */
export function moveToCell(
  l0: Layout,
  grids: GridMap,
  ids: string[],
  primaryId: string,
  target: Placement,
  displaced?: { id: string; to: Placement } | null,
): Layout {
  const l = clone(l0);
  const origin = l.placements[primaryId] ? { ...l.placements[primaryId] } : null;
  const origins = new Map<string, Placement | null>();
  for (const id of ids) origins.set(id, l.placements[id] ? { ...l.placements[id] } : null);
  for (const id of ids) detachMut(l, id);
  if (displaced && l.placements[displaced.id]) l.placements[displaced.id] = { ...displaced.to };

  const occ = occupancy(l);
  const g = grids[target.m];
  const ordered = [primaryId, ...ids.filter((i) => i !== primaryId)];
  for (const id of ordered) {
    let want: Placement = target;
    const o = origins.get(id);
    if (id !== primaryId && o && origin && o.m === origin.m && o.p === origin.p) {
      want = { m: target.m, p: target.p, c: target.c + (o.c - origin.c), r: target.r + (o.r - origin.r) };
    }
    let pl: Placement;
    if (g && inBounds(g, want.c, want.r) && !occ.has(placementKey(want))) pl = want;
    else pl = nearestFree(occ, grids, { ...want, c: Math.max(0, want.c), r: Math.max(0, want.r) });
    l.placements[id] = pl;
    occ.set(placementKey(pl), id);
  }
  return l;
}

/**
 * Put items into a virtual folder. `index` is a position in the folder's child list
 * AFTER the moved items have been taken out (default: end). Refuses cycles.
 */
export function moveIntoFolder(l0: Layout, ids: string[], folderId: string, index?: number): Layout {
  if (!l0.folders[folderId]) return l0;
  const valid = ids.filter((id) => id !== folderId && !(isFolderId(id) && isInside(l0, folderId, id)));
  if (valid.length === 0) return l0;
  const l = clone(l0);
  for (const id of valid) detachMut(l, id);
  insertMut(l, folderId, valid, index);
  return l;
}

/** Turn `targetId` into a new folder that contains it plus `ids`. */
export function mergeIntoNewFolder(
  l0: Layout,
  targetId: string,
  ids: string[],
  name: string,
  color: string | null,
): { layout: Layout; folderId: string } | null {
  const valid = ids.filter((id) => id !== targetId);
  if (valid.length === 0) return null;
  const l = clone(l0);
  const loc = locate(l, targetId);
  if (!loc) return null;
  // Items dragged out of the same parent folder shift the target index.
  for (const id of valid) detachMut(l, id);
  const tloc = locate(l, targetId)!;
  detachMut(l, targetId);
  const folderId = newFolderId();
  l.folders[folderId] = { id: folderId, name, color, children: [targetId, ...valid] };
  if (tloc.type === "desktop") l.placements[folderId] = tloc.placement;
  else insertMut(l, tloc.folderId, [folderId], tloc.index);
  return { layout: l, folderId };
}

/** Create an empty folder (or one wrapping `ids`) at a desktop cell or inside a folder. */
export function createFolderAt(
  l0: Layout,
  grids: GridMap,
  where: { placement: Placement } | { folderId: string; index?: number },
  name: string,
  color: string | null,
  ids: string[] = [],
): { layout: Layout; folderId: string } {
  const l = clone(l0);
  for (const id of ids) detachMut(l, id);
  const folderId = newFolderId();
  l.folders[folderId] = { id: folderId, name, color, children: [...ids] };
  if ("placement" in where) {
    const occ = occupancy(l);
    const pl = occ.has(placementKey(where.placement)) ? nearestFree(occ, grids, where.placement) : where.placement;
    l.placements[folderId] = pl;
  } else {
    insertMut(l, where.folderId, [folderId], where.index);
  }
  return { layout: l, folderId };
}

/** Remove a virtual folder; its children take its place. */
export function dissolveFolder(l0: Layout, grids: GridMap, folderId: string): Layout {
  const f = l0.folders[folderId];
  if (!f) return l0;
  const l = clone(l0);
  const children = [...l.folders[folderId].children];
  const loc = detachMut(l, folderId);
  delete l.folders[folderId];
  if (!loc) return placeLoose(l, grids, children);
  if (loc.type === "folder") {
    insertMut(l, loc.folderId, children, loc.index);
    return l;
  }
  const occ = occupancy(l);
  let first = true;
  for (const id of children) {
    const pl = first ? loc.placement : nearestFree(occ, grids, loc.placement);
    first = false;
    l.placements[id] = pl;
    occ.set(placementKey(pl), id);
  }
  return l;
}

/** Take items out of folders and put them on the desktop near `near` (or first free cells). */
export function moveToDesktop(l0: Layout, grids: GridMap, ids: string[], near?: Placement): Layout {
  const l = clone(l0);
  for (const id of ids) detachMut(l, id);
  const occ = occupancy(l);
  const pg = primaryGrid(grids);
  for (const id of ids) {
    const pl = near ? nearestFree(occ, grids, near) : firstFree(occ, grids, pg.monitorId);
    l.placements[id] = pl;
    occ.set(placementKey(pl), id);
  }
  return l;
}

function placeLoose(l: Layout, grids: GridMap, ids: string[]): Layout {
  const occ = occupancy(l);
  const pg = primaryGrid(grids);
  for (const id of ids) {
    const pl = firstFree(occ, grids, pg.monitorId);
    l.placements[id] = pl;
    occ.set(placementKey(pl), id);
  }
  return l;
}

/** Delete virtual folders and everything inside them from the layout (files are handled by the caller). */
export function removeDeep(l0: Layout, folderIds: string[]): Layout {
  const l = clone(l0);
  for (const fid of folderIds) {
    if (!l.folders[fid]) continue;
    for (const d of descendants(l, fid)) {
      if (isFolderId(d)) delete l.folders[d];
      delete l.placements[d];
      delete l.home[d];
    }
    detachMut(l, fid);
    delete l.folders[fid];
    delete l.home[fid];
  }
  return l;
}

/** Remove items from the desktop/folders without remembering them (deleted by the user). */
export function removeIds(l0: Layout, ids: string[]): Layout {
  const l = clone(l0);
  for (const id of ids) {
    detachMut(l, id);
    delete l.remembered[id];
    delete l.home[id];
  }
  return l;
}

export function renameFolder(l0: Layout, folderId: string, name: string): Layout {
  if (!l0.folders[folderId]) return l0;
  const l = clone(l0);
  l.folders[folderId].name = name;
  return l;
}

export function setFolderLook(l0: Layout, folderId: string, look: FolderLook | undefined): Layout {
  if (!l0.folders[folderId]) return l0;
  const l = clone(l0);
  const clean = normalizeLook(look);
  if (clean) l.folders[folderId].look = clean;
  else delete l.folders[folderId].look;
  return l;
}

export function setFolderColor(l0: Layout, folderId: string, color: string | null): Layout {
  if (!l0.folders[folderId]) return l0;
  const l = clone(l0);
  l.folders[folderId].color = color;
  return l;
}

export function setCustom(l0: Layout, id: string, patch: { name?: string | null; icon?: string | null }): Layout {
  const l = clone(l0);
  const cur = { ...(l.custom[id] ?? {}) };
  if (patch.name !== undefined) {
    if (patch.name) cur.name = patch.name;
    else delete cur.name;
  }
  if (patch.icon !== undefined) {
    if (patch.icon) cur.icon = patch.icon;
    else delete cur.icon;
  }
  if (cur.name || cur.icon) l.custom[id] = cur;
  else delete l.custom[id];
  return l;
}

/** Rename ids everywhere (file renamed on disk). */
export function remapIds(l0: Layout, map: Map<string, string>): Layout {
  if (map.size === 0) return l0;
  let touched = false;
  const l = clone(l0);
  for (const [from, to] of map) {
    if (from === to) continue;
    if (l.placements[from]) {
      l.placements[to] = l.placements[from];
      delete l.placements[from];
      touched = true;
    }
    for (const f of Object.values(l.folders)) {
      const i = f.children.indexOf(from);
      if (i >= 0) {
        f.children[i] = to;
        touched = true;
      }
    }
    if (l.custom[from]) {
      l.custom[to] = l.custom[from];
      delete l.custom[from];
      touched = true;
    }
    if (l.home[from]) {
      l.home[to] = l.home[from];
      delete l.home[from];
      touched = true;
    }
  }
  return touched ? l : l0;
}

/** Re-flow the top-level items of every monitor without gaps (keeps order). */
export function autoArrange(l0: Layout, grids: GridMap, priority?: Set<string>): Layout {
  const l = clone(l0);
  for (const g of Object.values(grids)) {
    const ids = Object.keys(l.placements).filter((id) => l.placements[id].m === g.monitorId);
    const per = g.cols * g.rows;
    const seq = (id: string) => {
      const pl = l.placements[id];
      return pl.p * per + orderIndex(g, pl.c, pl.r) - (priority?.has(id) ? 0.5 : 0);
    };
    ids.sort((a, b) => seq(a) - seq(b));
    ids.forEach((id, i) => {
      const p = Math.floor(i / per);
      const { c, r } = fromOrderIndex(g, i % per);
      l.placements[id] = { m: g.monitorId, p, c, r };
    });
  }
  return l;
}

export type SortKey = "name" | "type" | "date" | "size";

export function sortMonitor(
  l0: Layout,
  grids: GridMap,
  monitorId: string,
  key: SortKey,
  info: (id: string) => { name: string; ext: string; modified: number; size: number; group: number },
): Layout {
  const g = grids[monitorId];
  if (!g) return l0;
  const l = clone(l0);
  const ids = Object.keys(l.placements).filter((id) => l.placements[id].m === monitorId);
  const coll = new Intl.Collator("tr", { numeric: true, sensitivity: "base" });
  ids.sort((a, b) => {
    const A = info(a);
    const B = info(b);
    if (A.group !== B.group) return A.group - B.group;
    let d = 0;
    if (key === "type") d = coll.compare(A.ext, B.ext);
    else if (key === "date") d = B.modified - A.modified;
    else if (key === "size") d = B.size - A.size;
    return d || coll.compare(A.name, B.name);
  });
  const per = g.cols * g.rows;
  ids.forEach((id, i) => {
    const p = Math.floor(i / per);
    const { c, r } = fromOrderIndex(g, i % per);
    l.placements[id] = { m: monitorId, p, c, r };
  });
  return l;
}

// ---------------------------------------------------------------- reconciliation

/**
 * Bring the layout in line with the real item list and the current monitors:
 * forget vanished items (remembering where they were), place new ones, repair
 * collisions / out-of-grid cells / missing monitors / broken folder trees.
 */
export function reconcile(
  l0: Layout,
  items: DesktopItem[],
  grids: GridMap,
  pending?: Map<string, Placement>,
  now = Date.now(),
): Layout {
  const l = clone(l0);
  const itemIds = new Set(items.map((i) => i.id));
  const exists = (id: string) => (isFolderId(id) ? !!l.folders[id] : itemIds.has(id));
  const pg = primaryGrid(grids);
  if (!pg) return l0;

  // 1. vanished items -> remembered
  for (const [id, pl] of Object.entries(l.placements)) {
    if (!exists(id)) {
      if (!isFolderId(id)) l.remembered[id] = { at: now, placement: pl };
      delete l.placements[id];
    }
  }
  for (const f of Object.values(l.folders)) {
    const kept: string[] = [];
    f.children.forEach((c, index) => {
      if (exists(c)) kept.push(c);
      else if (!isFolderId(c)) l.remembered[c] = { at: now, folder: f.id, index };
    });
    f.children = kept;
  }

  // 2. single membership + break cycles (walk from the desktop)
  const seen = new Set<string>();
  const walk = (folderId: string, stack: Set<string>) => {
    const f = l.folders[folderId];
    if (!f) return;
    stack.add(folderId);
    f.children = f.children.filter((c) => {
      if (seen.has(c) || stack.has(c)) return false;
      seen.add(c);
      return true;
    });
    for (const c of f.children) if (isFolderId(c)) walk(c, stack);
    stack.delete(folderId);
  };
  for (const id of Object.keys(l.placements)) {
    if (seen.has(id)) {
      delete l.placements[id];
      continue;
    }
    seen.add(id);
  }
  for (const id of Object.keys(l.placements)) if (isFolderId(id)) walk(id, new Set());
  // folders still unreached are orphans; their subtree is walked when placed below
  const orphanFolders = Object.keys(l.folders).filter((id) => !seen.has(id));

  // 3a. items the screen pushed away go back home once their cell exists again
  restoreHomes(l, grids);

  // 3b. fix monitor / bounds / collisions
  const occ = new Map<string, string>();
  const fix: string[] = [];
  const sorted = Object.entries(l.placements).sort(([, a], [, b]) => a.p - b.p || a.c - b.c || a.r - b.r);
  for (const [id, pl] of sorted) {
    const g = grids[pl.m];
    if (!g || !inBounds(g, pl.c, pl.r)) {
      // the screen can't show this cell right now: remember it, show the item nearby
      if (!l.home[id]) l.home[id] = { placement: { ...pl }, at: now };
      fix.push(id);
      continue;
    }
    if (occ.has(placementKey(pl))) {
      fix.push(id);
      continue;
    }
    occ.set(placementKey(pl), id);
  }
  for (const id of fix) {
    const pl = l.placements[id];
    const g = grids[pl.m] ?? pg;
    const want: Placement = {
      m: g.monitorId,
      p: pl.p,
      c: Math.min(pl.c, g.cols - 1),
      r: Math.min(pl.r, g.rows - 1),
    };
    const np = nearestFree(occ, grids, want);
    l.placements[id] = np;
    occ.set(placementKey(np), id);
  }

  // 4. place orphans and new items
  const placeNew = (id: string) => {
    const mem = l.remembered[id];
    if (mem && now - mem.at < REMEMBER_MS) {
      if (mem.folder && l.folders[mem.folder] && seen.has(mem.folder)) {
        insertMut(l, mem.folder, [id], mem.index);
        seen.add(id);
        delete l.remembered[id];
        return;
      }
      if (mem.placement && grids[mem.placement.m] && !occ.has(placementKey(mem.placement))) {
        const g = grids[mem.placement.m];
        if (inBounds(g, mem.placement.c, mem.placement.r)) {
          l.placements[id] = { ...mem.placement };
          occ.set(placementKey(mem.placement), id);
          seen.add(id);
          delete l.remembered[id];
          return;
        }
      }
    }
    const want = pending?.get(id);
    const pl = want && grids[want.m] ? nearestFree(occ, grids, want) : firstFree(occ, grids, pg.monitorId);
    l.placements[id] = pl;
    occ.set(placementKey(pl), id);
    seen.add(id);
    delete l.remembered[id];
  };
  for (const fid of orphanFolders) {
    if (seen.has(fid)) continue;
    placeNew(fid);
    walk(fid, new Set());
  }
  for (const it of items) if (!seen.has(it.id)) placeNew(it.id);

  // 5. prune memory
  for (const [id, m] of Object.entries(l.remembered)) {
    if (now - m.at > REMEMBER_MS || seen.has(id)) delete l.remembered[id];
  }
  for (const [id, h] of Object.entries(l.home)) {
    // gone from the desktop (put in a folder), or waited too long
    const inFolder = seen.has(id) && !l.placements[id];
    if (inFolder || now - h.at > HOME_MS) delete l.home[id];
  }
  return l;
}

/** Move displaced items back to their home cell when it is visible and free (mutates). */
function restoreHomes(l: Layout, grids: GridMap) {
  const homed = Object.keys(l.home).filter((id) => l.placements[id]);
  if (homed.length === 0) return;
  const canGoHome = (id: string) => {
    const h = l.home[id].placement;
    const g = grids[h.m];
    return !!g && inBounds(g, h.c, h.r);
  };
  const going = new Set(homed.filter(canGoHome));
  // cells taken by items that stay where they are
  const taken = new Map<string, string>();
  for (const [id, pl] of Object.entries(l.placements)) if (!going.has(id)) taken.set(placementKey(pl), id);
  const order = [...going].sort((a, b) => l.home[a].at - l.home[b].at);
  for (const id of order) {
    const h = l.home[id].placement;
    const k = placementKey(h);
    if (taken.has(k)) continue; // someone put something there meanwhile: stay displaced
    l.placements[id] = { ...h };
    taken.set(k, id);
    delete l.home[id];
  }
  // items that could not go home keep their current cell (step 3b repairs any clash)
}

/**
 * After a user action: items the user moved have a new home of their choosing,
 * so forget where the screen had pushed them from.
 */
export function forgetHomes(before: Layout, after: Layout): Layout {
  const ids = Object.keys(after.home);
  if (ids.length === 0) return after;
  const same = (a?: Placement, b?: Placement) => !!a && !!b && a.m === b.m && a.p === b.p && a.c === b.c && a.r === b.r;
  const drop = ids.filter((id) => !same(before.placements[id], after.placements[id]));
  if (drop.length === 0) return after;
  const home = { ...after.home };
  for (const id of drop) delete home[id];
  return { ...after, home };
}

/** First-run import of the Windows desktop icon positions. */
export function importWindowsLayout(
  l0: Layout,
  wl: WindowsLayout,
  env: Environment,
  grids: GridMap,
  items: DesktopItem[],
): Layout {
  const l = clone(l0);
  const itemIds = new Set(items.map((i) => i.id));
  const occ = occupancy(l);
  const scale = env.scaleFactor || 1;
  const late: { id: string; want: Placement }[] = [];
  const sortedItems = [...wl.items].sort((a, b) => a.x - b.x || a.y - b.y);
  for (const it of sortedItems) {
    if (!itemIds.has(it.id) || l.placements[it.id]) continue;
    const mon =
      env.monitors.find(
        (m) =>
          it.x >= m.bounds.x &&
          it.y >= m.bounds.y &&
          it.x < m.bounds.x + m.bounds.width &&
          it.y < m.bounds.y + m.bounds.height,
      ) ?? env.monitors.find((m) => m.primary) ?? env.monitors[0];
    const g = grids[mon.id];
    if (!g) continue;
    const sx = wl.spacing ? wl.spacing.x / scale : g.cellW;
    const sy = wl.spacing ? wl.spacing.y / scale : g.cellH;
    const lx = (it.x - mon.work.x) / scale;
    const ly = (it.y - mon.work.y) / scale;
    const c = Math.max(0, Math.round(lx / sx));
    const r = Math.max(0, Math.round(ly / sy));
    let p = 0;
    let cc = c;
    // Windows has one page; overflow columns go to following pages.
    while (cc >= g.cols) {
      cc -= g.cols;
      p++;
    }
    const want: Placement = { m: g.monitorId, p, c: cc, r: Math.min(r, g.rows - 1) };
    if (r < g.rows && !occ.has(placementKey(want))) {
      l.placements[it.id] = want;
      occ.set(placementKey(want), it.id);
    } else late.push({ id: it.id, want });
  }
  for (const { id, want } of late) {
    const pl = nearestFree(occ, grids, want);
    l.placements[id] = pl;
    occ.set(placementKey(pl), id);
  }
  l.importedFromWindows = true;
  return l;
}
