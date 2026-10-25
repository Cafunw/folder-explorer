// Locked groups: which ones are open for this session (in memory only, so a restart locks them
// all), the verification flow (Windows Hello or the PIN, see the "unlock" dialog) and re-locking
// 5 minutes after a group was closed. The lock hides content in this app only.

import { create } from "zustand";
import { api } from "../api";
import { folderPath } from "../layout/model";
import { useDesk } from "./store";

const RELOCK_MS = 5 * 60_000;

export const useUnlocked = create<{ ids: ReadonlySet<string> }>(() => ({ ids: new Set() }));

const timers = new Map<string, number>();

export const isUnlocked = (id: string) => useUnlocked.getState().ids.has(id);

/** The first locked, not yet unlocked group on the way to `folderId` (itself included). */
export function lockedOnPath(folderId: string): string | null {
  const l = useDesk.getState().layout;
  return folderPath(l, folderId).find((id) => l.folders[id]?.lock && !isUnlocked(id)) ?? null;
}

/** The group's content must stay hidden right now (fence / tile / preview renderers). */
export function useContentHidden(folderId: string): boolean {
  const locked = useDesk((s) => !!s.layout.folders[folderId]?.lock);
  const open = useUnlocked((u) => u.ids.has(folderId));
  return locked && !open;
}

function scheduleRelock(id: string) {
  if (timers.has(id)) return;
  timers.set(
    id,
    window.setTimeout(() => {
      timers.delete(id);
      const ids = new Set(useUnlocked.getState().ids);
      ids.delete(id);
      useUnlocked.setState({ ids });
    }, RELOCK_MS),
  );
}

function markUnlocked(id: string) {
  useUnlocked.setState({ ids: new Set([...useUnlocked.getState().ids, id]) });
  // re-locks 5 min from now unless its panel opens (then: 5 min after it closes)
  scheduleRelock(id);
}

/** Lock every group again (tray / command palette could use it). */
export function relockAll() {
  timers.forEach((t) => window.clearTimeout(t));
  timers.clear();
  useUnlocked.setState({ ids: new Set() });
}

useDesk.subscribe((s, prev) => {
  if (s.panel === prev.panel) return;
  const open = new Set(s.panel?.stack ?? []);
  for (const id of useUnlocked.getState().ids) {
    if (open.has(id)) {
      window.clearTimeout(timers.get(id));
      timers.delete(id);
    } else scheduleRelock(id);
  }
});

// ---------------------------------------------------------------- verification flow

let pending: { id: string; run: () => void } | null = null;

/** Ask for the group's Windows Hello / PIN; `then` runs once it is unlocked. */
export function requestUnlock(id: string, then: () => void) {
  pending = { id, run: then };
  useDesk.setState({ dialog: { kind: "unlock", id } });
}

/** Called by the unlock dialog. The continuation opens the panel before the dialog goes, so the
 *  desktop window stays raised in between. */
export function unlockSucceeded(id: string) {
  markUnlocked(id);
  const p = pending;
  pending = null;
  if (p?.id === id) p.run();
  // the continuation may have asked for the next locked group on the way already
  const d = useDesk.getState().dialog;
  if (d?.kind === "unlock" && d.id === id) useDesk.setState({ dialog: null });
}

export function unlockCancelled(id: string) {
  if (pending?.id === id) pending = null;
}

let hello: Promise<boolean> | null = null;
/** Windows Hello is set up (asked once per session; a failed check is asked again next time). */
export function helloAvailable(): Promise<boolean> {
  hello ??= api.helloAvailable().catch(() => false);
  const p = hello;
  p.then((ok) => {
    if (!ok && hello === p) hello = null;
  });
  return p;
}

/** Windows' Hello prompt; afterwards the desktop window is put back in front (the prompt took it). */
export async function helloVerify(name: string, message: (n: string) => string): Promise<boolean> {
  let ok = false;
  try {
    ok = await api.helloVerify(message(name));
  } catch (e) {
    console.warn("hello", e);
  }
  const st = useDesk.getState();
  if (st.dialog || st.panel) api.raiseDesktop(true).catch(() => {});
  return ok;
}

// wrong PIN attempts: after 5 in a row, wait 30 s
let fails = 0;
let blockedUntil = 0;

export function pinBlockedFor(): number {
  return Math.max(0, Math.ceil((blockedUntil - Date.now()) / 1000));
}

export function notePinResult(ok: boolean) {
  if (ok) {
    fails = 0;
    return;
  }
  fails++;
  if (fails >= 5) {
    fails = 0;
    blockedUntil = Date.now() + 30_000;
  }
}
