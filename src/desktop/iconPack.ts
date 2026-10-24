// Icon pack lookup for one item: display name / file stem first; for a .lnk without a match, the
// stem of its target (`shortcut_target`, asked once per shortcut version, at most 2 at a time).

import { useEffect, useSyncExternalStore } from "react";
import { api } from "../api";
import type { DesktopItem } from "../types";
import { packMatch, packNames, stemOf } from "../visual";
import { useDesk } from "./store";

const stems = new Map<string, string | null>();
const asked = new Set<string>();
const queue: { key: string; path: string }[] = [];
const subs = new Set<() => void>();
let running = 0;
let notifyQueued = false;

function notify() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    subs.forEach((f) => f());
  });
}

function pump() {
  while (running < 2 && queue.length) {
    const { key, path } = queue.shift()!;
    running++;
    api
      .shortcutTarget(path)
      .then((info) => stems.set(key, info?.target ? stemOf(info.target) : null))
      .catch(() => stems.set(key, null))
      .finally(() => {
        running--;
        notify();
        pump();
      });
  }
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

function useTargetStem(item: DesktopItem | null): string | null {
  const key = item ? `${item.id}|${item.modified}` : "";
  const stem = useSyncExternalStore(subscribe, () => (key ? (stems.get(key) ?? null) : null));
  useEffect(() => {
    if (!item || !key || asked.has(key)) return;
    asked.add(key);
    queue.push({ key, path: item.path });
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return stem;
}

/** Media path of the pack icon for an item, or null (no pack / no match). */
export function usePackIcon(item: DesktopItem | undefined): string | null {
  const direct = useDesk((s) => {
    const pack = s.settings.icons.pack;
    return pack && item ? packMatch(pack.map, packNames(item)) : null;
  });
  const hasPack = useDesk((s) => !!s.settings.icons.pack);
  const stem = useTargetStem(hasPack && !direct && item?.ext === ".lnk" ? item : null);
  const viaTarget = useDesk((s) => {
    const pack = s.settings.icons.pack;
    return pack && stem ? packMatch(pack.map, [stem]) : null;
  });
  return direct ?? viaTarget;
}
