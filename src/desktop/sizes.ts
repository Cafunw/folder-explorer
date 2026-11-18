// Sizes under the icons (settings.labels.showSize). A file shows its own size, a real folder the
// files under it (`dir_size`, summed by Rust in the background, two folders at a time, kept for the
// session), the Recycle Bin what it holds, and a group adds up its children (a live group: its
// folder). Nothing is asked for while the setting is off.

import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { api } from "../api";
import { isFolderId } from "../layout/model";
import type { DesktopItem, Layout } from "../types";
import { formatBytes } from "./bytes";
import { useDesk } from "./store";

/** The Recycle Bin's item id (lowercased parsing name, items.rs RECYCLE_BIN). */
const RECYCLE_BIN = "::{645ff040-5081-101b-9f08-00aa002f954e}";

/** What a tile's size is made of: bytes known now, or a real folder to sum (`stamp` = its mtime). */
export type SizePart = { bytes: number } | { dir: string; stamp: number };

/** One desktop / live item's part; null = it has no size (This PC, Network…). */
export function itemPart(it: DesktopItem | undefined): SizePart | null {
  if (!it) return null;
  if (it.kind === "file") return { bytes: it.size };
  if (it.kind === "folder") return { dir: it.path, stamp: it.modified };
  return it.id === RECYCLE_BIN ? { bytes: it.size } : null;
}

/**
 * The parts of a tile `id`: an item, or a group's children (nested groups too, each item once).
 * null = no size to show: locked and frequent groups (one shows nothing of its content, the other
 * only refers to items that live elsewhere), items without a size.
 */
export function sizeParts(id: string, layout: Pick<Layout, "folders">, itemMap: Map<string, DesktopItem>): SizePart[] | null {
  if (!isFolderId(id)) {
    const part = itemPart(itemMap.get(id));
    return part ? [part] : null;
  }
  const out: SizePart[] = [];
  const seen = new Set<string>();
  const walk = (gid: string): boolean => {
    if (seen.has(gid)) return true;
    seen.add(gid);
    const f = layout.folders[gid];
    if (!f || f.lock || f.kind === "frequent") return false;
    if (f.kind === "live") {
      if (!f.source) return false;
      out.push({ dir: f.source, stamp: 0 });
      return true;
    }
    for (const c of f.children) {
      if (isFolderId(c)) {
        walk(c);
      } else if (!seen.has(c)) {
        seen.add(c);
        const part = itemPart(itemMap.get(c));
        if (part) out.push(part);
      }
    }
    return true;
  };
  return walk(id) ? out : null;
}

// ---------------------------------------------------------------- folder sizes (Rust walks)

/** bytes < 0: the folder could not be read. */
type DirSize = { bytes: number; at: number; stamp: number };

export const useDirSizes = create<{ map: Record<string, DirSize> }>(() => ({ map: {} }));

/** A known size is asked again after this long when a tile shows it (nothing polls). */
const TTL = 10 * 60_000;
const PARALLEL = 2;
const queue: { key: string; path: string; stamp: number }[] = [];
const pending = new Set<string>();
let running = 0;

const dirKey = (path: string) => path.toLowerCase();

/** Asks Rust for `path`'s size unless a fresh one for this `stamp` is known or on the way. */
export function wantDirSize(path: string, stamp: number) {
  const key = dirKey(path);
  const have = useDirSizes.getState().map[key];
  if ((have && have.stamp === stamp && Date.now() - have.at < TTL) || pending.has(key)) return;
  pending.add(key);
  queue.push({ key, path, stamp });
  pump();
}

function pump() {
  while (running < PARALLEL && queue.length) {
    const job = queue.shift()!;
    running++;
    const done = (bytes: number) => {
      useDirSizes.setState((s) => ({ map: { ...s.map, [job.key]: { bytes, at: Date.now(), stamp: job.stamp } } }));
      pending.delete(job.key);
      running--;
      pump();
    };
    api.dirSize(job.path).then(done, () => done(-1));
  }
}

/**
 * Adds the parts up: the text under the tile, "…" while a folder is still being summed (its old
 * size stays shown meanwhile), null when there is nothing to show.
 */
export function sizeText(parts: SizePart[] | null, dirs: Record<string, DirSize>): string | null {
  if (!parts) return null;
  let total = 0;
  let known = 0;
  for (const p of parts) {
    if ("bytes" in p) {
      total += p.bytes;
      known++;
      continue;
    }
    const d = dirs[dirKey(p.dir)];
    if (!d) return "…";
    if (d.bytes >= 0) {
      total += d.bytes;
      known++;
    }
  }
  return known || !parts.length ? formatBytes(total) : null;
}

/** Stable text key of the parts, so a tile re-renders only when what it adds up changes. */
const partsKey = (parts: SizePart[] | null) => (parts ? JSON.stringify(parts) : "");

const liveParts = (it: DesktopItem) => {
  const part = itemPart(it);
  return part ? [part] : null;
};

/**
 * The size text under tile `id` (a desktop item or a group), or under a live entry (`live`).
 * null while the setting is off or when the tile has no size. Folder sizes older than TTL are
 * summed again when the tile mounts (a panel opens) or the desktop's items change.
 */
export function useSizeText(id: string, live?: DesktopItem): string | null {
  const show = useDesk((s) => s.settings.labels.showSize);
  const key = useDesk((s) => (show ? partsKey(live ? liveParts(live) : sizeParts(id, s.layout, s.itemMap)) : ""));
  const items = useDesk((s) => (show ? s.itemMap : null));
  const parts = useMemo<SizePart[] | null>(() => (key ? JSON.parse(key) : null), [key]);
  useEffect(() => {
    for (const p of parts ?? []) if ("dir" in p) wantDirSize(p.dir, p.stamp);
  }, [parts, items]);
  return useDirSizes((s) => (show ? sizeText(parts, s.map) : null));
}
