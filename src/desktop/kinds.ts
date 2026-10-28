// Pure helpers behind the group kinds / displays UI: the customize draft, the smart rule editor,
// PIN hashing, the stack fan, tab drops and the temp archive. No store, no DOM.

import type { GridMap } from "../layout/grid";
import {
  createFolderAt,
  isFolderId,
  isHeadingId,
  locate,
  moveIntoFolder,
  normalizeRule,
  parentMap,
  type FolderPatch,
} from "../layout/model";
import { DEFAULT_FREQUENT_LIMIT, DEFAULT_TEMP_DAYS, matchesRule, staleItems } from "../layout/smart";
import type {
  DesktopItem,
  GroupDisplay,
  GroupKind,
  GroupLock,
  Layout,
  SmartCondition,
  SmartRule,
  SmartType,
  VirtualFolder,
} from "../types";

// ---------------------------------------------------------------- PIN

export const PIN_MIN = 4;
export const PIN_MAX = 12;
export const validPin = (pin: string) => new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin);

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** 16 random bytes as hex. */
export function newSalt(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

/** SHA-256 of salt + pin, lowercase hex. */
export async function hashPin(pin: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + pin));
  return hex(new Uint8Array(digest));
}

export async function checkPin(lock: GroupLock | undefined | null, pin: string): Promise<boolean> {
  if (!lock?.hash || !lock.salt || !validPin(pin)) return false;
  return (await hashPin(pin, lock.salt)) === lock.hash;
}

/** A new lock: Windows Hello when it is available (the PIN stays as a fallback), else the PIN. */
export async function makeLock(pin: string, hello: boolean, salt = newSalt()): Promise<GroupLock> {
  return { method: hello ? "hello" : "pin", hash: await hashPin(pin, salt), salt };
}

// ---------------------------------------------------------------- smart rule editor

export type RowField = SmartCondition["field"];
/** One editable condition row; `ruleOf` drops the incomplete ones. */
export type RowDraft = {
  key: number;
  field: RowField;
  nameOp: "contains" | "startsWith";
  ageOp: "newerThan" | "olderThan";
  text: string; // ext: comma list, name: the text
  type: SmartType;
  days: number;
};
export type RuleDraft = { all: boolean; rows: RowDraft[] };

let rowSeq = 1;
export function newRow(field: RowField = "ext"): RowDraft {
  return { key: rowSeq++, field, nameOp: "contains", ageOp: "newerThan", text: "", type: "image", days: 7 };
}

export function ruleDraft(rule: SmartRule | undefined): RuleDraft {
  const rows = (rule?.conditions ?? []).map((c): RowDraft => {
    const r = newRow(c.field);
    if (c.field === "ext") r.text = c.value.join(", ");
    else if (c.field === "name") {
      r.text = c.value;
      r.nameOp = c.op;
    } else if (c.field === "type") r.type = c.value;
    else {
      r.days = c.days;
      r.ageOp = c.op;
    }
    return r;
  });
  return { all: rule?.all ?? true, rows: rows.length ? rows : [newRow()] };
}

export function ruleOf(d: RuleDraft): SmartRule {
  const conditions = d.rows.map((r) => {
    switch (r.field) {
      case "ext":
        return { field: "ext", value: r.text.split(/[\s,;]+/) };
      case "name":
        return { field: "name", op: r.nameOp, value: r.text };
      case "type":
        return { field: "type", value: r.type };
      case "age":
        return { field: "age", op: r.ageOp, days: r.days };
    }
  });
  return normalizeRule({ all: d.all, conditions }) ?? { all: d.all, conditions: [] };
}

/**
 * How many loose desktop items the rule would collect into `folderId` now (top-level, not system,
 * not a group / heading, not in the group's `exclude`) — the live count of the rule editor.
 */
export function smartMatchCount(l: Layout, items: Iterable<DesktopItem>, folderId: string, rule: SmartRule, now = Date.now()) {
  if (!rule.conditions.length) return 0;
  const exclude = new Set(l.folders[folderId]?.exclude ?? []);
  let n = 0;
  for (const it of items) {
    if (it.kind === "system" || isFolderId(it.id) || isHeadingId(it.id) || !l.placements[it.id] || exclude.has(it.id)) continue;
    if (matchesRule(it, rule, now)) n++;
  }
  return n;
}

// ---------------------------------------------------------------- customize draft

export type GroupDraft = {
  kind: GroupKind;
  display: GroupDisplay;
  rule: RuleDraft;
  source: string | null;
  limit: number;
  tempDays: number;
  lock: GroupLock | null;
};

export function draftOf(f: VirtualFolder): GroupDraft {
  return {
    kind: f.kind ?? "group",
    display: f.display ?? "panel",
    rule: ruleDraft(f.rule),
    source: f.source ?? null,
    limit: f.limit ?? DEFAULT_FREQUENT_LIMIT,
    tempDays: f.tempDays ?? DEFAULT_TEMP_DAYS,
    lock: f.lock ?? null,
  };
}

/** The `updateFolder` patch for a saved draft; options of other kinds are left as they are. */
export function patchOf(d: GroupDraft): FolderPatch {
  const p: FolderPatch = {
    kind: d.kind === "group" ? null : d.kind,
    display: d.display === "panel" ? null : d.display,
    lock: d.lock,
  };
  if (d.kind === "smart") p.rule = ruleOf(d.rule);
  if (d.kind === "live") p.source = d.source;
  if (d.kind === "frequent") p.limit = d.limit;
  if (d.kind === "temp") p.tempDays = d.tempDays;
  return p;
}

// ---------------------------------------------------------------- tabs

/**
 * A drop slot of a filtered view (`shown`, e.g. the loose items of a tabs group's "Genel" tab) as an
 * index into the folder's whole child list (`children`), both without the dragged items — what
 * `moveIntoFolder` expects. Past the last shown item = right after it.
 */
export function displayToChildIndex(children: string[], shown: string[], dragged: string[], index: number): number {
  const skip = new Set(dragged);
  const rest = children.filter((c) => !skip.has(c));
  const vis = shown.filter((c) => !skip.has(c) && rest.includes(c));
  if (index < vis.length) return rest.indexOf(vis[Math.max(0, index)]);
  if (!vis.length) return rest.length;
  return rest.indexOf(vis[vis.length - 1]) + 1;
}

// ---------------------------------------------------------------- stack fan

/** Up to this many items a stack opens as a fan, more as a grid bubble. */
export const FAN_MAX = 9;

export type FanSpot = { x: number; y: number; rot: number };

/**
 * Spots of a fan of `n` icons rising from a tile (like a Dock stack): offsets of each icon's centre
 * from the tile's centre, the first nearest the tile, each next `step` further along an arc that bends
 * towards `side` (+1 right, -1 left); `up` false fans downwards. `rot` follows the arc (degrees).
 */
export function fanLayout(n: number, step: number, side: 1 | -1, up: boolean): FanSpot[] {
  const r = step * 14;
  return Array.from({ length: Math.max(0, n) }, (_, i) => {
    const d = (i + 1) * step;
    const x = side * (r - Math.sqrt(Math.max(0, r * r - d * d)));
    const angle = (Math.asin(Math.min(1, d / r)) * 180) / Math.PI;
    return { x, y: up ? -d : d, rot: side * (up ? 1 : -1) * angle * 0.4 };
  });
}

/** Columns of the grid bubble a large stack opens as. */
export const bubbleCols = (n: number) => Math.min(6, Math.max(3, Math.ceil(Math.sqrt(n))));

// ---------------------------------------------------------------- temp

/**
 * Move a temp group's expired children into its archive group next to it (same parent folder,
 * or on the desktop near it), creating that group when missing. The archive group is
 * remembered by id on the temp group, so a renamed group (a language switch, say) is still
 * the archive; layouts without the id fall back to matching `archiveName`. Same layout back
 * when nothing is stale.
 */
export function archiveStale(
  l: Layout,
  grids: GridMap,
  folderId: string,
  archiveName: string,
  color: string | null,
  now = Date.now(),
): { layout: Layout; moved: number; archiveId: string | null } {
  const f = l.folders[folderId];
  const stale = f ? staleItems(f, now) : [];
  const loc = locate(l, folderId);
  if (!stale.length || !loc) return { layout: l, moved: 0, archiveId: null };
  const parent = parentMap(l).get(folderId) ?? null;
  const siblings = parent ? l.folders[parent]?.children ?? [] : Object.keys(l.placements);
  const usable = (id: string) =>
    isFolderId(id) && id !== folderId && siblings.includes(id) && !!l.folders[id] && !l.folders[id]?.kind;
  const remembered = f?.archiveId && usable(f.archiveId) ? f.archiveId : null;
  let archiveId = remembered ?? siblings.find((id) => usable(id) && l.folders[id]?.name === archiveName) ?? null;
  let next = l;
  if (!archiveId) {
    const where = loc.type === "folder" ? { folderId: loc.folderId, index: loc.index + 1 } : { placement: loc.placement };
    const created = createFolderAt(next, grids, where, archiveName, color, [], now);
    next = created.layout;
    archiveId = created.folderId;
  }
  next = moveIntoFolder(next, stale, archiveId, undefined, now);
  const temp = next.folders[folderId];
  if (temp && temp.archiveId !== archiveId) {
    next = { ...next, folders: { ...next.folders, [folderId]: { ...temp, archiveId } } };
  }
  return { layout: next, moved: stale.length, archiveId };
}
