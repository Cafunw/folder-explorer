// Live groups: the entries of real folders, cached per directory while some live group's tile or
// panel shows them, watched by Rust (`watch_folder`) and reloaded on `folder-changed`.
// Live entries are NOT desktop items: they never go into the layout.

import { useEffect } from "react";
import { create } from "zustand";
import { api, on } from "../api";
import type { DesktopItem } from "../types";

type DirState = { items: DesktopItem[] | null; failed: boolean };

export const useLive = create<{
  dirs: Record<string, DirState>;
  /** the selected live entry (live entries are not part of the desktop selection) */
  sel: string | null;
  /** the live entry being renamed */
  renaming: string | null;
}>(() => ({ dirs: {}, sel: null, renaming: null }));

export const dirKey = (dir: string) => dir.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

const refs = new Map<string, { dir: string; n: number; timer?: number }>();
const loading = new Map<string, boolean>(); // key → another load is wanted after this one
let listening = false;

function setDir(key: string, st: DirState) {
  useLive.setState((s) => ({ dirs: { ...s.dirs, [key]: st } }));
}

function load(dir: string) {
  const key = dirKey(dir);
  if (loading.has(key)) {
    loading.set(key, true);
    return;
  }
  loading.set(key, false);
  api
    .listFolder(dir)
    .then((items) => refs.has(key) && setDir(key, { items, failed: false }))
    .catch(() => refs.has(key) && setDir(key, { items: [], failed: true }))
    .finally(() => {
      const again = loading.get(key);
      loading.delete(key);
      if (again && refs.has(key)) load(dir);
    });
}

/** Reload a live folder now (after we changed it ourselves). */
export function reloadLive(dir: string) {
  if (refs.has(dirKey(dir))) load(dir);
}

function retain(dir: string) {
  const key = dirKey(dir);
  const r = refs.get(key);
  if (r) {
    r.n++;
    window.clearTimeout(r.timer);
    r.timer = undefined;
    return;
  }
  refs.set(key, { dir, n: 1 });
  if (!listening) {
    listening = true;
    void on<{ dir: string }>("folder-changed", (p) => {
      const e = p?.dir ? refs.get(dirKey(p.dir)) : undefined;
      if (e) load(e.dir);
    });
  }
  api.watchFolder(dir).catch(() => {});
  load(dir);
}

function release(dir: string) {
  const key = dirKey(dir);
  const r = refs.get(key);
  if (!r || --r.n > 0) return;
  // a tile remounting (page change, panel opening) keeps the watcher
  r.timer = window.setTimeout(() => {
    if (r.n > 0) return;
    refs.delete(key);
    api.unwatchFolder(r.dir).catch(() => {});
    useLive.setState((s) => {
      const dirs = { ...s.dirs };
      delete dirs[key];
      return { dirs };
    });
  }, 3000);
}

/** The entries of `dir` (null while loading); keeps it watched while mounted. */
export function useLiveItems(dir: string | null | undefined): DesktopItem[] | null {
  useEffect(() => {
    if (!dir) return;
    retain(dir);
    return () => release(dir);
  }, [dir]);
  return useLive((s) => (dir ? s.dirs[dirKey(dir)]?.items ?? null : null));
}

export function useLiveFailed(dir: string | null | undefined): boolean {
  return useLive((s) => (dir ? !!s.dirs[dirKey(dir)]?.failed : false));
}

/** A cached live entry by id (Quick Look, open). */
export function liveItem(id: string): DesktopItem | undefined {
  for (const d of Object.values(useLive.getState().dirs)) {
    const it = d.items?.find((x) => x.id === id);
    if (it) return it;
  }
  return undefined;
}

export function useLiveItem(id: string | null): DesktopItem | undefined {
  return useLive((s) => {
    if (!id) return undefined;
    for (const d of Object.values(s.dirs)) {
      const it = d.items?.find((x) => x.id === id);
      if (it) return it;
    }
    return undefined;
  });
}

/** The entries next to a live entry, in the order shown (Quick Look ←/→). */
export function liveSiblings(id: string): string[] | null {
  for (const d of Object.values(useLive.getState().dirs)) {
    if (d.items?.some((x) => x.id === id)) return d.items.map((x) => x.id);
  }
  return null;
}
