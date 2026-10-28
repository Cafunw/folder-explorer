// Pure layout logic. Every exported operation returns a NEW layout (inputs are never mutated).

import { locale, t } from "../i18n";
import type {
  DesktopItem,
  Environment,
  FolderLook,
  GroupLock,
  Heading,
  Layout,
  OpenStyle,
  Placement,
  Remembered,
  SmartCondition,
  SmartRule,
  SmartType,
  VirtualFolder,
  WindowsLayout,
} from "../types";
import {
  cellKey,
  coveredKeys,
  fromOrderIndex,
  orderIndex,
  placementKey,
  primaryGrid,
  spanInBounds,
  type GridInfo,
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
  headings: {},
  usage: {},
});

export const isFolderId = (id: string) => id.startsWith("v:");
export const isHeadingId = (id: string) => id.startsWith("h:");
export const newFolderId = () => `v:${crypto.randomUUID()}`;
export const newHeadingId = () => `h:${crypto.randomUUID()}`;
export const clone = (l: Layout): Layout => structuredClone(l);

const REMEMBER_MS = 14 * 24 * 3600 * 1000;
const HOME_MS = 30 * 24 * 3600 * 1000;
/** usage entries kept (most recently used first) */
export const USAGE_MAX = 500;
/** size a group gets when it becomes a fence */
export const DEFAULT_FENCE_SIZE = { w: 3, h: 2 };
const MAX_SPAN = 100;
const HEADING_MAX = 200;

export const SMART_TYPES: SmartType[] = ["shortcut", "folder", "file", "document", "image", "video", "audio", "archive", "game"];
const KINDS = ["smart", "live", "frequent", "temp"] as const;
const DISPLAYS = ["fence", "stack", "tabs"] as const;
const OPEN_STYLES: OpenStyle[] = ["zoom", "spring", "flip", "blur", "fade"];

// ---------------------------------------------------------------- spans

export const spanOf = (pl: Placement) => ({ w: pl.w ?? 1, h: pl.h ?? 1 });
const isSpanned = (pl: Placement) => (pl.w ?? 1) > 1 || (pl.h ?? 1) > 1;

/** The placement's top-left cell with a w × h size (w / h are only stored when > 1). */
export function withSpan(pl: Placement, w = 1, h = 1): Placement {
  const out: Placement = { m: pl.m, p: pl.p, c: pl.c, r: pl.r };
  if (w > 1) out.w = w;
  if (h > 1) out.h = h;
  return out;
}

function isFree(occ: Map<string, string>, pl: Placement, self?: string) {
  if (!isSpanned(pl)) {
    const o = occ.get(placementKey(pl));
    return o === undefined || o === self;
  }
  for (const k of coveredKeys(pl)) {
    const o = occ.get(k);
    if (o !== undefined && o !== self) return false;
  }
  return true;
}

/** The whole block of `pl` is on an existing grid and free (cells owned by `self` count as free). */
export function canPlace(occ: Map<string, string>, grids: GridMap, pl: Placement, self?: string) {
  const g = grids[pl.m];
  return !!g && spanInBounds(g, pl) && isFree(occ, pl, self);
}

function mark(occ: Map<string, string>, pl: Placement, id: string) {
  if (!isSpanned(pl)) occ.set(placementKey(pl), id);
  else for (const k of coveredKeys(pl)) occ.set(k, id);
}

// ---------------------------------------------------------------- normalization

const num = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;
const int = (v: unknown, min: number, max: number) => {
  const n = num(v, min, max);
  return n === undefined ? undefined : Math.round(n);
};
const spanSize = (v: unknown) => (Number.isInteger(v) && (v as number) > 1 ? Math.min(MAX_SPAN, v as number) : undefined);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined =>
  list.includes(v as T) ? (v as T) : undefined;
const strings = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && !!x))] : []);

const validPlacement = (p: any): p is Placement =>
  !!p && typeof p.m === "string" && [p.p, p.c, p.r].every((n) => Number.isInteger(n) && n >= 0);

/** A valid placement (w / h kept only when they are integers > 1), else null. */
export function cleanPlacement(raw: unknown): Placement | null {
  if (!validPlacement(raw)) return null;
  const p = raw as Placement;
  return withSpan(p, spanSize(p.w), spanSize(p.h));
}

export function normalizeLayout(raw: unknown): Layout {
  const out = emptyLayout();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, any>;
  if (r.folders && typeof r.folders === "object") {
    for (const [id, f] of Object.entries<any>(r.folders)) {
      const folder = normalizeFolder(id, f);
      if (folder) out.folders[id] = folder;
    }
  }
  if (r.headings && typeof r.headings === "object") {
    for (const [id, h] of Object.entries<any>(r.headings)) {
      const heading = normalizeHeading(id, h);
      if (heading) out.headings[id] = heading;
    }
  }
  if (r.placements && typeof r.placements === "object") {
    for (const [id, p] of Object.entries<any>(r.placements)) {
      const pl = cleanPlacement(p);
      if (pl && !(isHeadingId(id) && !out.headings[id])) out.placements[id] = pl;
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
      if (!m || typeof m.at !== "number") continue;
      const e: Remembered = { at: m.at };
      const pl = cleanPlacement(m.placement);
      if (pl) e.placement = pl;
      if (typeof m.folder === "string") e.folder = m.folder;
      if (Number.isInteger(m.index) && m.index >= 0) e.index = m.index;
      out.remembered[id] = e;
    }
  }
  if (r.home && typeof r.home === "object") {
    for (const [id, h] of Object.entries<any>(r.home)) {
      const pl = h && typeof h.at === "number" ? cleanPlacement(h.placement) : null;
      if (pl) out.home[id] = { at: h.at, placement: pl };
    }
  }
  if (r.usage && typeof r.usage === "object") {
    for (const [id, u] of Object.entries<any>(r.usage)) {
      if (u && typeof u.n === "number" && u.n >= 1 && Number.isFinite(u.n) && typeof u.last === "number" && Number.isFinite(u.last)) {
        out.usage[id] = { n: Math.round(u.n), last: u.last };
      }
    }
    out.usage = boundUsage(out.usage);
  }
  out.importedFromWindows = r.importedFromWindows === true;
  return out;
}

/** Clean one group; null when it isn't one. Kind / display "group" / "panel" are implicit. */
function normalizeFolder(id: string, f: any): VirtualFolder | null {
  if (!isFolderId(id) || !f || typeof f !== "object") return null;
  const out: VirtualFolder = {
    id,
    name: typeof f.name === "string" ? f.name : t.ql.group,
    color: typeof f.color === "string" ? f.color : null,
    children: [],
  };
  const look = normalizeLook(f.look);
  if (look) out.look = look;
  const kind = oneOf(f.kind, KINDS);
  if (kind) out.kind = kind;
  const display = oneOf(f.display, DISPLAYS);
  if (display) out.display = display;
  const rule = normalizeRule(f.rule);
  if (rule) out.rule = rule;
  const exclude = strings(f.exclude);
  if (exclude.length) out.exclude = exclude;
  if (typeof f.source === "string" && f.source.trim()) out.source = f.source;
  const limit = int(f.limit, 1, 50);
  if (limit !== undefined) out.limit = limit;
  const tempDays = int(f.tempDays, 1, 365);
  if (tempDays !== undefined) out.tempDays = tempDays;
  if (typeof f.activeTab === "string" && f.activeTab) out.activeTab = f.activeTab;
  const lock = normalizeLock(f.lock);
  if (lock) out.lock = lock;
  if (f.collapsed === true) out.collapsed = true;
  if (holdsChildren(out) && Array.isArray(f.children)) {
    out.children = f.children.filter((c: unknown) => typeof c === "string" && c !== id && !isHeadingId(c));
  }
  if (out.kind === "temp" && f.added && typeof f.added === "object") {
    const kids = new Set(out.children);
    const added: Record<string, number> = {};
    for (const [k, v] of Object.entries<unknown>(f.added)) {
      if (kids.has(k) && typeof v === "number" && Number.isFinite(v)) added[k] = v;
    }
    if (Object.keys(added).length) out.added = added;
  }
  if (out.kind === "temp" && typeof f.archiveId === "string" && isFolderId(f.archiveId) && f.archiveId !== id) {
    out.archiveId = f.archiveId;
  }
  return out;
}

function normalizeHeading(id: string, h: any): Heading | null {
  if (!isHeadingId(id) || !h || typeof h !== "object") return null;
  const out: Heading = {
    id,
    text: typeof h.text === "string" ? h.text.slice(0, HEADING_MAX) : "",
    style: h.style === "divider" ? "divider" : "title",
    align: h.align === "center" ? "center" : "left",
  };
  if (h.underline === true) out.underline = true;
  return out;
}

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
  const borderWidth = num(r.borderWidth, 0, 4);
  if (borderWidth !== undefined) look.borderWidth = borderWidth;
  if (typeof r.borderColor === "string" && r.borderColor) look.borderColor = r.borderColor;
  const shadow = num(r.shadow, 0, 1);
  if (shadow !== undefined) look.shadow = shadow;
  if (typeof r.gradient === "boolean") look.gradient = r.gradient;
  const glow = num(r.glow, 0, 1);
  if (glow !== undefined) look.glow = glow;
  const openStyle = oneOf(r.openStyle, OPEN_STYLES);
  if (openStyle) look.openStyle = openStyle;
  return Object.keys(look).length ? look : undefined;
}

const normExt = (s: string) => {
  const e = s.trim().toLowerCase().replace(/^\*/, "");
  if (!e || e === ".") return "";
  return e.startsWith(".") ? e : `.${e}`;
};

function normalizeCondition(c: any): SmartCondition | null {
  if (!c || typeof c !== "object") return null;
  switch (c.field) {
    case "ext": {
      const value = [...new Set(strings(c.value).map(normExt).filter(Boolean))];
      return value.length ? { field: "ext", value } : null;
    }
    case "name": {
      const op = oneOf(c.op, ["contains", "startsWith"] as const);
      const value = typeof c.value === "string" ? c.value.trim() : "";
      return op && value ? { field: "name", op, value } : null;
    }
    case "type": {
      const value = oneOf(c.value, SMART_TYPES);
      return value ? { field: "type", value } : null;
    }
    case "age": {
      const op = oneOf(c.op, ["newerThan", "olderThan"] as const);
      const days = num(c.days, 0, 36500);
      return op && days !== undefined ? { field: "age", op, days } : null;
    }
  }
  return null;
}

/** Clean a smart rule (invalid conditions dropped; `all` defaults to true). */
export function normalizeRule(raw: unknown): SmartRule | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const conditions = Array.isArray(r.conditions)
    ? r.conditions.map(normalizeCondition).filter((c): c is SmartCondition => !!c)
    : [];
  return { all: r.all !== false, conditions };
}

/** A PIN lock needs both hash and salt; a Hello lock may carry a PIN fallback. */
export function normalizeLock(raw: unknown): GroupLock | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const method = oneOf(r.method, ["pin", "hello"] as const);
  if (!method) return undefined;
  const hash = typeof r.hash === "string" && r.hash ? r.hash : null;
  const salt = typeof r.salt === "string" && r.salt ? r.salt : null;
  if (!hash || !salt) return method === "pin" ? undefined : { method, hash: null, salt: null };
  return { method, hash, salt };
}

/** Keep the `USAGE_MAX` most recently used entries. */
export function boundUsage(u: Layout["usage"]): Layout["usage"] {
  const ids = Object.keys(u);
  if (ids.length <= USAGE_MAX) return u;
  ids.sort((a, b) => u[b].last - u[a].last);
  const out: Layout["usage"] = {};
  for (const id of ids.slice(0, USAGE_MAX)) out[id] = u[id];
  return out;
}

// ---------------------------------------------------------------- queries

/** Frequent and live groups show content from elsewhere: they never have children of their own. */
export const holdsChildren = (f: Pick<VirtualFolder, "kind">) => f.kind !== "frequent" && f.kind !== "live";

/**
 * Whether items may be put into the group. Live groups refuse too: a drop on one is a real file
 * move into its `source`, which the caller does.
 */
export const acceptsDrops = (f: VirtualFolder | undefined | null) => !!f && holdsChildren(f);

/** Headings and fences (any spanned entry) keep their cells when icons are re-flowed. */
export function isAnchored(l: Layout, id: string): boolean {
  if (isHeadingId(id)) return true;
  const pl = l.placements[id];
  if (pl && isSpanned(pl)) return true;
  return l.folders[id]?.display === "fence";
}

export function parentMap(l: Layout): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of Object.values(l.folders)) for (const c of f.children) m.set(c, f.id);
  return m;
}

/** Cell key → id for every cell covered by a desktop entry (spans cover w × h cells). */
export function occupancy(l: Layout, exclude?: Set<string>): Map<string, string> {
  const occ = new Map<string, string>();
  for (const [id, pl] of Object.entries(l.placements)) {
    if (exclude?.has(id)) continue;
    mark(occ, pl, id);
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

/** First free top-left cell (column-major) where a block of `size` fits. */
export function firstFree(
  occ: Map<string, string>,
  grids: GridMap,
  m: string,
  startPage = 0,
  startIndex = 0,
  size?: { w: number; h: number },
): Placement {
  const g = grids[m] ?? primaryGrid(grids);
  const w = Math.max(1, Math.min(size?.w ?? 1, g.cols));
  const h = Math.max(1, Math.min(size?.h ?? 1, g.rows));
  const per = g.cols * g.rows;
  for (let p = startPage; p < startPage + 500; p++) {
    for (let i = p === startPage ? startIndex : 0; i < per; i++) {
      const { c, r } = fromOrderIndex(g, i);
      if (c + w > g.cols || r + h > g.rows) continue;
      const pl = withSpan({ m: g.monitorId, p, c, r }, w, h);
      if (isFree(occ, pl)) return pl;
    }
  }
  return withSpan({ m: g.monitorId, p: startPage + 500, c: 0, r: 0 }, w, h);
}

/** Nearest free spot for `pl`'s block (its own w × h) on its page, else the next pages. */
export function nearestFree(occ: Map<string, string>, grids: GridMap, pl: Placement): Placement {
  const g = grids[pl.m] ?? primaryGrid(grids);
  const w = Math.min(pl.w ?? 1, g.cols);
  const h = Math.min(pl.h ?? 1, g.rows);
  const c0 = Math.min(g.cols - w, Math.max(0, pl.c));
  const r0 = Math.min(g.rows - h, Math.max(0, pl.r));
  const maxD = g.cols + g.rows;
  for (let d = 0; d <= maxD; d++) {
    let best: Placement | null = null;
    let bestScore = Infinity;
    for (let dc = -d; dc <= d; dc++) {
      for (let dr = -d; dr <= d; dr++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== d) continue;
        const c = c0 + dc;
        const r = r0 + dr;
        if (c < 0 || r < 0 || c + w > g.cols || r + h > g.rows) continue;
        const cand = withSpan({ m: g.monitorId, p: pl.p, c, r }, w, h);
        if (!isFree(occ, cand)) continue;
        // prefer straight-line neighbours, then column-major order
        const score = Math.abs(dc) + Math.abs(dr) + orderIndex(g, c, r) / 10000;
        if (score < bestScore) {
          bestScore = score;
          best = cand;
        }
      }
    }
    if (best) return best;
  }
  return firstFree(occ, grids, g.monitorId, pl.p + 1, 0, { w, h });
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

/**
 * Group bookkeeping for items whose parent changed (`from` = parents before the change):
 * leaving a smart group excludes the item from it (never collected again), entering one clears
 * that; temp groups note when an item came in.
 */
function noteMembership(l: Layout, ids: string[], from: Map<string, string>, now: number) {
  if (!ids.length) return;
  const to = parentMap(l);
  for (const id of ids) {
    const a = from.get(id);
    const b = to.get(id);
    if (a === b) continue;
    const fa = a ? l.folders[a] : undefined;
    if (fa) {
      if (fa.kind === "smart" && !fa.exclude?.includes(id)) fa.exclude = [...(fa.exclude ?? []), id];
      if (fa.added && id in fa.added) {
        delete fa.added[id];
        if (!Object.keys(fa.added).length) delete fa.added;
      }
    }
    const fb = b ? l.folders[b] : undefined;
    if (fb) {
      if (fb.exclude?.includes(id)) {
        fb.exclude = fb.exclude.filter((x) => x !== id);
        if (!fb.exclude.length) delete fb.exclude;
      }
      if (fb.kind === "temp") fb.added = { ...fb.added, [id]: now };
    }
  }
}

// ---------------------------------------------------------------- operations

/**
 * Move `ids` onto the desktop. The primary item lands on `target` (its top-left cell); the others
 * keep their relative offsets when they came from the same desktop page, else take the nearest
 * free cells. Spanned entries keep their size. A cell covered by another entry is never taken: the
 * item goes to the nearest free spot. `displaced` moves the occupant of the target out of the way,
 * but only when its whole block fits at `to` without touching anything (else it stays).
 */
export function moveToCell(
  l0: Layout,
  grids: GridMap,
  ids: string[],
  primaryId: string,
  target: Placement,
  displaced?: { id: string; to: Placement } | null,
  now = Date.now(),
): Layout {
  const l = clone(l0);
  const from = parentMap(l0);
  const origin = l.placements[primaryId] ? { ...l.placements[primaryId] } : null;
  const origins = new Map<string, Placement | null>();
  for (const id of ids) origins.set(id, l.placements[id] ? { ...l.placements[id] } : null);
  for (const id of ids) detachMut(l, id);

  const cell = withSpan(target);
  if (displaced && l.placements[displaced.id] && !ids.includes(displaced.id)) {
    const cur = spanOf(l.placements[displaced.id]);
    const to = withSpan(displaced.to, cur.w, cur.h);
    const occ = occupancy(l, new Set([displaced.id]));
    const ps = origin ? spanOf(origin) : { w: 1, h: 1 };
    mark(occ, withSpan(cell, ps.w, ps.h), primaryId);
    if (canPlace(occ, grids, to)) l.placements[displaced.id] = to;
  }

  const occ = occupancy(l);
  const ordered = [primaryId, ...ids.filter((i) => i !== primaryId)];
  for (const id of ordered) {
    const o = origins.get(id);
    let want: Placement = cell;
    if (id !== primaryId && o && origin && o.m === origin.m && o.p === origin.p) {
      want = { m: cell.m, p: cell.p, c: cell.c + (o.c - origin.c), r: cell.r + (o.r - origin.r) };
    }
    const size = o ? spanOf(o) : { w: 1, h: 1 };
    want = withSpan(want, size.w, size.h);
    const pl = canPlace(occ, grids, want)
      ? want
      : nearestFree(occ, grids, { ...want, c: Math.max(0, want.c), r: Math.max(0, want.r) });
    l.placements[id] = pl;
    mark(occ, pl, id);
  }
  noteMembership(l, ids, from, now);
  return l;
}

/**
 * Put items into a virtual folder. `index` is a position in the folder's child list
 * AFTER the moved items have been taken out (default: end). Refuses cycles, headings and
 * groups that hold no children (see `acceptsDrops`).
 */
export function moveIntoFolder(l0: Layout, ids: string[], folderId: string, index?: number, now = Date.now()): Layout {
  if (!acceptsDrops(l0.folders[folderId])) return l0;
  const valid = ids.filter(
    (id) => id !== folderId && !isHeadingId(id) && !(isFolderId(id) && isInside(l0, folderId, id)),
  );
  if (valid.length === 0) return l0;
  const l = clone(l0);
  const from = parentMap(l0);
  for (const id of valid) detachMut(l, id);
  insertMut(l, folderId, valid, index);
  noteMembership(l, valid, from, now);
  return l;
}

/** Turn `targetId` into a new folder that contains it plus `ids`. */
export function mergeIntoNewFolder(
  l0: Layout,
  targetId: string,
  ids: string[],
  name: string,
  color: string | null,
  now = Date.now(),
): { layout: Layout; folderId: string } | null {
  if (isHeadingId(targetId)) return null;
  const valid = ids.filter((id) => id !== targetId && !isHeadingId(id));
  if (valid.length === 0) return null;
  const l = clone(l0);
  const loc = locate(l, targetId);
  if (!loc) return null;
  const from = parentMap(l0);
  // Items dragged out of the same parent folder shift the target index.
  for (const id of valid) detachMut(l, id);
  const tloc = locate(l, targetId)!;
  detachMut(l, targetId);
  const folderId = newFolderId();
  l.folders[folderId] = { id: folderId, name, color, children: [targetId, ...valid] };
  if (tloc.type === "desktop") l.placements[folderId] = withSpan(tloc.placement);
  else insertMut(l, tloc.folderId, [folderId], tloc.index);
  noteMembership(l, [targetId, ...valid], from, now);
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
  now = Date.now(),
): { layout: Layout; folderId: string } {
  const l = clone(l0);
  const from = parentMap(l0);
  const kids = ids.filter((id) => !isHeadingId(id));
  for (const id of kids) detachMut(l, id);
  const folderId = newFolderId();
  l.folders[folderId] = { id: folderId, name, color, children: [...kids] };
  if ("folderId" in where && acceptsDrops(l.folders[where.folderId])) {
    insertMut(l, where.folderId, [folderId], where.index);
  } else {
    const occ = occupancy(l);
    const want = "placement" in where ? withSpan(where.placement) : null;
    l.placements[folderId] = !want
      ? firstFree(occ, grids, primaryGrid(grids).monitorId)
      : canPlace(occ, grids, want)
        ? want
        : nearestFree(occ, grids, want);
  }
  noteMembership(l, kids, from, now);
  return { layout: l, folderId };
}

/**
 * Plain groups that the change from `before` to `after` left empty (their last item left) go too,
 * in the same step; so does a parent emptied that way. A group created empty stays until it has
 * had items; fences (boxes on the desktop) and special kinds always stay.
 */
export function dropEmptiedGroups(before: Layout, after: Layout, grids: GridMap): Layout {
  let out = after;
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of Object.values(out.folders)) {
      const emptied = f.children.length === 0 && (before.folders[f.id]?.children.length ?? 0) > 0;
      if (emptied && (f.kind ?? "group") === "group" && f.display !== "fence") {
        out = dissolveFolder(out, grids, f.id);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Remove a virtual folder; its children take its place. */
export function dissolveFolder(l0: Layout, grids: GridMap, folderId: string, now = Date.now()): Layout {
  const f = l0.folders[folderId];
  if (!f) return l0;
  const l = clone(l0);
  const children = [...l.folders[folderId].children];
  const from = parentMap(l0);
  const loc = detachMut(l, folderId);
  delete l.folders[folderId];
  if (!loc) return placeLoose(l, grids, children);
  if (loc.type === "folder") {
    insertMut(l, loc.folderId, children, loc.index);
    noteMembership(l, children, from, now);
    return l;
  }
  const occ = occupancy(l);
  const at = withSpan(loc.placement);
  let first = true;
  for (const id of children) {
    const pl = first && canPlace(occ, grids, at) ? at : nearestFree(occ, grids, at);
    first = false;
    l.placements[id] = pl;
    mark(occ, pl, id);
  }
  return l;
}

/** Take items out of folders and put them on the desktop near `near` (or first free cells). */
export function moveToDesktop(l0: Layout, grids: GridMap, ids: string[], near?: Placement, now = Date.now()): Layout {
  const l = clone(l0);
  const from = parentMap(l0);
  const sizes = new Map(ids.map((id) => [id, l.placements[id] ? spanOf(l.placements[id]) : { w: 1, h: 1 }]));
  for (const id of ids) detachMut(l, id);
  const occ = occupancy(l);
  const pg = primaryGrid(grids);
  for (const id of ids) {
    const size = sizes.get(id)!;
    const pl = near
      ? nearestFree(occ, grids, withSpan(near, size.w, size.h))
      : firstFree(occ, grids, pg.monitorId, 0, 0, size);
    l.placements[id] = pl;
    mark(occ, pl, id);
  }
  noteMembership(l, ids, from, now);
  return l;
}

function placeLoose(l: Layout, grids: GridMap, ids: string[]): Layout {
  const occ = occupancy(l);
  const pg = primaryGrid(grids);
  for (const id of ids) {
    const pl = firstFree(occ, grids, pg.monitorId);
    l.placements[id] = pl;
    mark(occ, pl, id);
  }
  return l;
}

/** Forget ids everywhere a group or the usage list refers to them (mutates). */
function forgetRefs(l: Layout, ids: Set<string>) {
  for (const id of ids) {
    delete l.usage[id];
    delete l.home[id];
  }
  for (const f of Object.values(l.folders)) {
    if (f.exclude?.some((x) => ids.has(x))) {
      f.exclude = f.exclude.filter((x) => !ids.has(x));
      if (!f.exclude.length) delete f.exclude;
    }
    if (f.added) {
      for (const id of ids) delete f.added[id];
      if (!Object.keys(f.added).length) delete f.added;
    }
  }
}

/** Delete virtual folders and everything inside them from the layout (files are handled by the caller). */
export function removeDeep(l0: Layout, folderIds: string[]): Layout {
  const l = clone(l0);
  const gone = new Set<string>();
  for (const fid of folderIds) {
    if (!l.folders[fid]) continue;
    for (const d of descendants(l, fid)) {
      if (isFolderId(d)) delete l.folders[d];
      delete l.placements[d];
      gone.add(d);
    }
    detachMut(l, fid);
    delete l.folders[fid];
    gone.add(fid);
  }
  forgetRefs(l, gone);
  return l;
}

/** Remove items (or headings) from the desktop/folders without remembering them (deleted by the user). */
export function removeIds(l0: Layout, ids: string[]): Layout {
  const l = clone(l0);
  for (const id of ids) {
    detachMut(l, id);
    delete l.remembered[id];
    if (isHeadingId(id)) delete l.headings[id];
  }
  forgetRefs(l, new Set(ids));
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

/** A group's kind / display / options; `null` clears a field, `undefined` leaves it. */
export type FolderPatch = {
  [K in "kind" | "display" | "rule" | "exclude" | "source" | "limit" | "tempDays" | "activeTab" | "lock"]?:
    | VirtualFolder[K]
    | null;
};

/**
 * Change a group's kind, display and their options (cleaned like on load). Becoming frequent / live
 * hands its children back to where the group is; becoming temp starts the clock for its children;
 * becoming a fence grows a 1 × 1 group to `DEFAULT_FENCE_SIZE` (or smaller) where that fits, leaving
 * fence display shrinks it back to one cell. Smart collection after a rule change is the caller's
 * (the store's `commit` does it).
 */
export function updateFolder(l0: Layout, grids: GridMap, folderId: string, patch: FolderPatch, now = Date.now()): Layout {
  const f0 = l0.folders[folderId];
  if (!f0) return l0;
  const raw: Record<string, unknown> = { ...f0 };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete raw[k];
    else if (v !== undefined) raw[k] = v;
  }
  const l = clone(l0);
  const f = normalizeFolder(folderId, raw)!;
  l.folders[folderId] = f;

  if (!holdsChildren(f) && f0.children.length) {
    const kids = [...f0.children];
    const loc = locate(l, folderId);
    if (loc?.type === "folder") insertMut(l, loc.folderId, kids, loc.index + 1);
    else {
      const occ = occupancy(l);
      const near = loc ? withSpan(loc.placement) : null;
      for (const id of kids) {
        const pl = near ? nearestFree(occ, grids, near) : firstFree(occ, grids, primaryGrid(grids).monitorId);
        l.placements[id] = pl;
        mark(occ, pl, id);
      }
    }
    noteMembership(l, kids, new Map(kids.map((k) => [k, folderId])), now);
  }
  if (f.kind === "temp") {
    const added: Record<string, number> = {};
    for (const c of f.children) added[c] = f.added?.[c] ?? now;
    if (Object.keys(added).length) f.added = added;
    else delete f.added;
  }

  const pl = l.placements[folderId];
  if (pl && f.display !== f0.display) {
    if (f.display === "fence" && !isSpanned(pl)) {
      const occ = occupancy(l, new Set([folderId]));
      const sizes = [[DEFAULT_FENCE_SIZE.w, DEFAULT_FENCE_SIZE.h], [2, 2], [2, 1]];
      const fit = sizes.map(([w, h]) => withSpan(pl, w, h)).find((next) => canPlace(occ, grids, next));
      if (fit) l.placements[folderId] = fit;
    } else if (f.display !== "fence" && isSpanned(pl)) {
      l.placements[folderId] = withSpan(pl);
    }
  }
  return l;
}

/**
 * Resize a desktop entry's block (top-left cell stays). Refused (same layout back) when the block
 * would leave the grid or cover another entry.
 */
export function resizeSpan(l0: Layout, grids: GridMap, id: string, w: number, h: number): Layout {
  const pl = l0.placements[id];
  if (!pl || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_SPAN || h > MAX_SPAN) return l0;
  const cur = spanOf(pl);
  if (cur.w === w && cur.h === h) return l0;
  const next = withSpan(pl, w, h);
  if (!canPlace(occupancy(l0), grids, next, id)) return l0;
  return { ...l0, placements: { ...l0.placements, [id]: next } };
}

// ---------------------------------------------------------------- headings

/** Put a new heading / divider on the desktop at `placement` (its w × h), or the nearest free spot. */
export function createHeadingAt(
  l0: Layout,
  grids: GridMap,
  init: Partial<Omit<Heading, "id">>,
  placement: Placement,
): { layout: Layout; headingId: string } {
  const l = clone(l0);
  const id = newHeadingId();
  l.headings[id] = normalizeHeading(id, init)!;
  const g = grids[placement.m] ?? primaryGrid(grids);
  const size = spanOf(placement);
  const want = withSpan(
    { ...placement, m: g.monitorId },
    Math.min(Math.max(1, Math.floor(size.w)), g.cols),
    Math.min(Math.max(1, Math.floor(size.h)), g.rows),
  );
  const occ = occupancy(l);
  l.placements[id] = canPlace(occ, grids, want) ? want : nearestFree(occ, grids, want);
  return { layout: l, headingId: id };
}

export function removeHeading(l0: Layout, id: string): Layout {
  if (!l0.headings[id] && !l0.placements[id]) return l0;
  const l = clone(l0);
  delete l.headings[id];
  delete l.placements[id];
  delete l.home[id];
  return l;
}

export function setHeading(l0: Layout, id: string, patch: Partial<Omit<Heading, "id">>): Layout {
  const h = l0.headings[id];
  if (!h) return l0;
  const l = clone(l0);
  l.headings[id] = normalizeHeading(id, { ...h, ...patch })!;
  return l;
}

export const setHeadingText = (l0: Layout, id: string, text: string) => setHeading(l0, id, { text });

export function setCustom(l0: Layout, id: string, patch: { name?: string | null; icon?: string | null }): Layout {
  const l = clone(l0);
  const cur = { ...l.custom[id] };
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
  const move = <T>(rec: Record<string, T>, from: string, to: string) => {
    if (!(from in rec)) return;
    rec[to] = rec[from];
    delete rec[from];
    touched = true;
  };
  for (const [from, to] of map) {
    if (from === to) continue;
    move(l.placements, from, to);
    move(l.custom, from, to);
    move(l.home, from, to);
    move(l.usage, from, to);
    for (const f of Object.values(l.folders)) {
      const i = f.children.indexOf(from);
      if (i >= 0) {
        f.children[i] = to;
        touched = true;
      }
      if (f.added) move(f.added, from, to);
      const j = f.exclude?.indexOf(from) ?? -1;
      if (j >= 0) {
        f.exclude![j] = to;
        touched = true;
      }
    }
  }
  return touched ? l : l0;
}

/**
 * Fill cells in column-major order, page after page, with `ids` (1 × 1 entries), skipping the
 * cells covered by `fixed` entries, which keep theirs (mutates).
 */
function flowAround(l: Layout, g: GridInfo, ids: string[], fixed: string[]) {
  const occ = new Map<string, string>();
  for (const id of fixed) mark(occ, l.placements[id], id);
  const per = g.cols * g.rows;
  let i = 0;
  for (const id of ids) {
    for (;; i++) {
      const p = Math.floor(i / per);
      const { c, r } = fromOrderIndex(g, i % per);
      if (!occ.has(cellKey(g.monitorId, p, c, r))) {
        l.placements[id] = { m: g.monitorId, p, c, r };
        i++;
        break;
      }
    }
  }
}

/** Re-flow the top-level items of every monitor without gaps (keeps order); fences and headings stay. */
export function autoArrange(l0: Layout, grids: GridMap, priority?: Set<string>): Layout {
  const l = clone(l0);
  for (const g of Object.values(grids)) {
    const ids = Object.keys(l.placements).filter((id) => l.placements[id].m === g.monitorId);
    const fixed = ids.filter((id) => isAnchored(l, id));
    const flow = ids.filter((id) => !isAnchored(l, id));
    const per = g.cols * g.rows;
    const seq = (id: string) => {
      const pl = l.placements[id];
      return pl.p * per + orderIndex(g, pl.c, pl.r) - (priority?.has(id) ? 0.5 : 0);
    };
    flow.sort((a, b) => seq(a) - seq(b));
    flowAround(l, g, flow, fixed);
  }
  return l;
}

export type SortKey = "name" | "type" | "date" | "size";

/** Sort a monitor's icons; fences and headings keep their cells, the icons flow around them. */
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
  const all = Object.keys(l.placements).filter((id) => l.placements[id].m === monitorId);
  const fixed = all.filter((id) => isAnchored(l, id));
  const ids = all.filter((id) => !isAnchored(l, id));
  const coll = new Intl.Collator(locale(), { numeric: true, sensitivity: "base" });
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
  flowAround(l, g, ids, fixed);
  return l;
}

// ---------------------------------------------------------------- reconciliation

/**
 * Bring the layout in line with the real item list and the current monitors:
 * forget vanished items (remembering where they were), place new ones, repair
 * collisions / out-of-grid cells / missing monitors / broken folder trees.
 * Headings are kept while they are in `headings`; fences and headings win collisions.
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
  const exists = (id: string) =>
    isFolderId(id) ? !!l.folders[id] : isHeadingId(id) ? !!l.headings[id] : itemIds.has(id);
  const pg = primaryGrid(grids);
  if (!pg) return l0;

  // 1. vanished items -> remembered (headings only live on the grid; frequent / live groups hold nothing)
  for (const [id, pl] of Object.entries(l.placements)) {
    if (!exists(id)) {
      if (!isFolderId(id) && !isHeadingId(id)) l.remembered[id] = { at: now, placement: pl };
      delete l.placements[id];
    }
  }
  for (const f of Object.values(l.folders)) {
    if (!holdsChildren(f)) {
      f.children = [];
      continue;
    }
    const kept: string[] = [];
    f.children.forEach((c, index) => {
      if (isHeadingId(c)) return;
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

  // 3b. fix monitor / bounds / collisions (fences and headings first: icons make way)
  const anchored = new Set(Object.keys(l.placements).filter((id) => isAnchored(l, id)));
  const occ = new Map<string, string>();
  const fix: string[] = [];
  const sorted = Object.entries(l.placements).sort(
    ([ia, a], [ib, b]) => Number(anchored.has(ib)) - Number(anchored.has(ia)) || a.p - b.p || a.c - b.c || a.r - b.r,
  );
  for (const [id, pl] of sorted) {
    const g = grids[pl.m];
    if (!g || !spanInBounds(g, pl)) {
      // the screen can't show this cell right now: remember it, show the item nearby
      if (!l.home[id]) l.home[id] = { placement: { ...pl }, at: now };
      fix.push(id);
      continue;
    }
    if (!isFree(occ, pl)) {
      fix.push(id);
      continue;
    }
    mark(occ, pl, id);
  }
  for (const id of fix) {
    const pl = l.placements[id];
    const g = grids[pl.m] ?? pg;
    const w = Math.min(pl.w ?? 1, g.cols);
    const h = Math.min(pl.h ?? 1, g.rows);
    const want = withSpan(
      { m: g.monitorId, p: pl.p, c: Math.min(pl.c, g.cols - w), r: Math.min(pl.r, g.rows - h) },
      w,
      h,
    );
    const np = nearestFree(occ, grids, want);
    l.placements[id] = np;
    mark(occ, np, id);
  }

  // 4. place orphans, new items and headings that lost their place
  const placeNew = (id: string) => {
    const mem = l.remembered[id];
    if (mem && now - mem.at < REMEMBER_MS) {
      const mf = mem.folder ? l.folders[mem.folder] : undefined;
      if (mf && seen.has(mf.id) && holdsChildren(mf)) {
        insertMut(l, mf.id, [id], mem.index);
        seen.add(id);
        delete l.remembered[id];
        return;
      }
      if (mem.placement && canPlace(occ, grids, mem.placement)) {
        l.placements[id] = { ...mem.placement };
        mark(occ, mem.placement, id);
        seen.add(id);
        delete l.remembered[id];
        return;
      }
    }
    const want = pending?.get(id);
    const pl = want && grids[want.m] ? nearestFree(occ, grids, withSpan(want)) : firstFree(occ, grids, pg.monitorId);
    l.placements[id] = pl;
    mark(occ, pl, id);
    seen.add(id);
    delete l.remembered[id];
  };
  for (const fid of orphanFolders) {
    if (seen.has(fid)) continue;
    placeNew(fid);
    walk(fid, new Set());
  }
  for (const it of items) if (!seen.has(it.id)) placeNew(it.id);
  for (const hid of Object.keys(l.headings)) if (!seen.has(hid)) placeNew(hid);

  // 5. prune memory
  for (const [id, m] of Object.entries(l.remembered)) {
    if (now - m.at > REMEMBER_MS || seen.has(id)) delete l.remembered[id];
  }
  for (const [id, h] of Object.entries(l.home)) {
    // gone from the desktop (put in a folder), or waited too long
    const inFolder = seen.has(id) && !l.placements[id];
    if (inFolder || now - h.at > HOME_MS) delete l.home[id];
  }
  // 6. group bookkeeping: temp arrival times, smart exclusions and usage of things that still exist
  const known = (id: string) => itemIds.has(id) || !!l.remembered[id] || !!l.folders[id];
  for (const f of Object.values(l.folders)) {
    if (f.kind === "temp") {
      const added: Record<string, number> = {};
      for (const c of f.children) added[c] = f.added?.[c] ?? now;
      if (Object.keys(added).length) f.added = added;
      else delete f.added;
    } else delete f.added;
    if (f.exclude) {
      const ex = f.exclude.filter(known);
      if (ex.length) f.exclude = ex;
      else delete f.exclude;
    }
  }
  for (const id of Object.keys(l.usage)) if (!known(id)) delete l.usage[id];
  return l;
}

/** Move displaced entries back to their home block when it is visible and free (mutates). */
function restoreHomes(l: Layout, grids: GridMap) {
  const homed = Object.keys(l.home).filter((id) => l.placements[id]);
  if (homed.length === 0) return;
  const canGoHome = (id: string) => {
    const h = l.home[id].placement;
    const g = grids[h.m];
    return !!g && spanInBounds(g, h);
  };
  const going = new Set(homed.filter(canGoHome));
  // cells taken by entries that stay where they are
  const taken = new Map<string, string>();
  for (const [id, pl] of Object.entries(l.placements)) if (!going.has(id)) mark(taken, pl, id);
  const order = [...going].sort((a, b) => l.home[a].at - l.home[b].at);
  for (const id of order) {
    const h = l.home[id].placement;
    if (!isFree(taken, h)) continue; // someone put something there meanwhile: stay displaced
    l.placements[id] = { ...h };
    mark(taken, h, id);
    delete l.home[id];
  }
  // entries that could not go home keep their current cell (step 3b repairs any clash)
}

/**
 * After a user action: items the user moved (or resized) have a new home of their choosing,
 * so forget where the screen had pushed them from.
 */
export function forgetHomes(before: Layout, after: Layout): Layout {
  const ids = Object.keys(after.home);
  if (ids.length === 0) return after;
  const same = (a?: Placement, b?: Placement) =>
    !!a && !!b && a.m === b.m && a.p === b.p && a.c === b.c && a.r === b.r && a.w === b.w && a.h === b.h;
  const drop = ids.filter((id) => !same(before.placements[id], after.placements[id]));
  if (drop.length === 0) return after;
  const home = { ...after.home };
  for (const id of drop) delete home[id];
  return { ...after, home };
}

/**
 * A monitor's grid got more or fewer cells because the icon size changed. Cells keep their
 * index, so a row's trailing run (the icons after its last empty cell, when that run starts in the
 * right half) slides by the column difference to stay against the right edge; columns do the same
 * for the bottom edge. Full rows / columns never split. A block spanning several rows (columns)
 * slides only when it is in the sliding run of every one of them; otherwise it stays and so do
 * those runs. Overlaps after a shrink go to reconcile.
 */
export function anchorToEdges(l: Layout, from: GridMap, to: GridMap): Layout {
  const next = { ...l.placements };
  let changed = false;
  type Line = { ids: string[]; used: Set<number>; len: number; d: number; start: number; ok: boolean };
  const slide = (axis: "c" | "r") => {
    const cross = axis === "c" ? "r" : "c";
    const along = (pl: Placement) => (axis === "c" ? pl.w ?? 1 : pl.h ?? 1);
    const across = (pl: Placement) => (axis === "c" ? pl.h ?? 1 : pl.w ?? 1);
    const lines = new Map<string, Line>();
    const linesOf = new Map<string, Line[]>();
    for (const [id, pl] of Object.entries(next)) {
      const a = from[pl.m];
      const b = to[pl.m];
      if (!a || !b) continue;
      const len = axis === "c" ? a.cols : a.rows;
      const newLen = axis === "c" ? b.cols : b.rows;
      // the column pass may already have moved an icon past the old width: only this axis is checked
      if (len === newLen || pl[axis] < 0 || pl[axis] + along(pl) > len) continue;
      const mine: Line[] = [];
      for (let k = 0; k < across(pl); k++) {
        const key = `${pl.m}|${pl.p}|${pl[cross] + k}`;
        let line = lines.get(key);
        if (!line) {
          line = { ids: [], used: new Set(), len, d: newLen - len, start: 0, ok: false };
          lines.set(key, line);
        }
        line.ids.push(id);
        for (let x = 0; x < along(pl); x++) line.used.add(pl[axis] + x);
        mine.push(line);
      }
      linesOf.set(id, mine);
    }
    for (const line of lines.values()) {
      let gap = line.len - 1;
      while (gap >= 0 && line.used.has(gap)) gap--;
      line.start = gap + 1;
      line.ok = gap >= 0 && line.start < line.len && line.start > (line.len - 1) / 2;
      // shrinking: only slide into cells that are free
      if (line.ok && line.d < 0) {
        const into = Array.from({ length: -line.d }, (_, i) => line.start + line.d + i);
        if (into.some((i) => i < 0 || line.used.has(i))) line.ok = false;
      }
    }
    const inRun = (id: string, line: Line) => next[id][axis] >= line.start;
    for (let again = true; again; ) {
      again = false;
      for (const [id, mine] of linesOf) {
        if (mine.length < 2 || mine.every((line) => line.ok && inRun(id, line))) continue;
        for (const line of mine) {
          if (line.ok && inRun(id, line)) {
            line.ok = false;
            again = true;
          }
        }
      }
    }
    const moved = new Set<string>();
    for (const line of lines.values()) {
      if (!line.ok) continue;
      for (const id of line.ids) {
        if (moved.has(id) || !inRun(id, line)) continue;
        next[id] = { ...next[id], [axis]: next[id][axis] + line.d };
        moved.add(id);
        changed = true;
      }
    }
  };
  slide("c");
  slide("r");
  return changed ? { ...l, placements: next } : l;
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

