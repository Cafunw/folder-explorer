// Icon edit mode (iOS "jiggle"): entered from the desktop menu ("Simgeleri düzenle"), the command
// palette or a long press on an icon. Icons wiggle (CSS, only while the mode is on; still with
// reduced motion / in quiet modes) and carry a remove badge; dragging starts at once; clicks do
// not launch files. Esc, a click on the empty desktop or "Bitti" ends it. Not with a locked layout.

import { AnimatePresence, motion } from "motion/react";
import { create } from "zustand";
import { t } from "../i18n";
import type { GridInfo } from "../layout/grid";
import { isFolderId, isHeadingId } from "../layout/model";
import { spring } from "../settings";
import { deleteIds } from "./actions";
import { isDragging } from "./dnd";
import { playSound } from "./sounds";
import { reducedMotion, toast, useAnimation, useDesk } from "./store";

export const useJiggle = create<{ on: boolean }>(() => ({ on: false }));

export const jiggling = () => useJiggle.getState().on;

let teardown: (() => void) | null = null;

export function enterJiggle() {
  if (jiggling()) return;
  if (useDesk.getState().settings.behavior.lockLayout) {
    toast(t.layoutLocked, undefined, 3500);
    playSound("error");
    return;
  }
  teardown = watch();
  useJiggle.setState({ on: true });
  useDesk.setState({ rename: null });
  playSound("jiggleOn");
}

export function exitJiggle() {
  if (!jiggling()) return;
  teardown?.();
  teardown = null;
  useJiggle.setState({ on: false });
  playSound("jiggleOff");
}

/** What stays clickable without ending the mode: icons, fences, headings, panels, dialogs, toasts. */
const KEEP = "[data-hit], .panel-card, .panel-overlay, .fan-overlay, .dialog-backdrop, .dialog, .toasts, .jiggle-done";

function watch(): () => void {
  const root = document.documentElement;
  const sync = () => {
    root.dataset.jiggle = reducedMotion(useDesk.getState()) ? "still" : "wiggle";
  };
  sync();
  const unsub = useDesk.subscribe((s, p) => {
    if (s.settings.behavior.lockLayout && !p.settings.behavior.lockLayout) exitJiggle();
    else if (s.settings !== p.settings || s.quiet !== p.quiet) sync();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    const st = useDesk.getState();
    if (st.panel || st.dialog || st.rename || isDragging()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    exitJiggle();
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const st = useDesk.getState();
    if (st.panel || st.dialog || (e.target as Element | null)?.closest?.(KEEP)) return;
    exitJiggle();
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", onDown, true);
  return () => {
    unsub();
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onDown, true);
    delete root.dataset.jiggle;
  };
}

// ---------------------------------------------------------------- long press

const LONG_PRESS_MS = 600;
let longPressed: number | null = null;

/** Holding an icon ~600 ms without moving starts the mode (the press then goes on as a drag). */
export function armLongPress(e: React.PointerEvent, id: string) {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || jiggling()) return;
  const { pointerId, clientX: x0, clientY: y0 } = e;
  longPressed = null;
  const done = () => {
    window.clearTimeout(timer);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
    window.removeEventListener("blur", done);
  };
  const move = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6) done();
  };
  const end = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) done();
  };
  const timer = window.setTimeout(() => {
    done();
    const st = useDesk.getState();
    if (isDragging() || st.rename || st.dialog) return;
    enterJiggle();
    if (jiggling()) {
      longPressed = pointerId;
      useDesk.setState({ selection: new Set([id]) });
    }
  }, LONG_PRESS_MS);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
  window.addEventListener("blur", done);
}

/** True once for the press that started the mode: its release must not open the group under it. */
export function takeLongPress(pointerId: number) {
  const hit = longPressed === pointerId;
  longPressed = null;
  return hit;
}

// ---------------------------------------------------------------- badges and the "Bitti" pill

type BadgeKind = "dissolve" | "remove" | "delete";

function badgeKind(id: string): BadgeKind | null {
  const { layout, itemMap } = useDesk.getState();
  if (isFolderId(id)) return layout.folders[id] ? "dissolve" : null;
  if (isHeadingId(id)) return layout.headings[id] ? "remove" : null;
  const it = itemMap.get(id);
  return it && it.kind !== "system" ? "delete" : null;
}

/**
 * The remove badge of an item in edit mode: a file goes to the Recycle Bin, a group is dissolved
 * (its items stay), a heading is removed — the same as Delete, with an undo toast.
 */
export function JiggleBadge({ id, style }: { id: string; style?: React.CSSProperties }) {
  const on = useJiggle((j) => j.on);
  const kind = useDesk(() => (on ? badgeKind(id) : null));
  if (!kind) return null;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const title = kind === "delete" ? t.jiggle.recycle : kind === "dissolve" ? t.jiggle.dissolve : t.jiggle.remove;
  return (
    <button
      className="jiggle-badge"
      data-kind={kind}
      data-block={!!style || undefined}
      style={style}
      title={title}
      aria-label={title}
      onPointerDown={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onClick={(e) => {
        e.stopPropagation();
        void deleteIds([id]);
      }}
    >
      {kind === "delete" ? "×" : "−"}
    </button>
  );
}

/** "Simgeleri düzenliyorsun · Bitti" at the top of each monitor while the mode is on. */
export function JiggleDone({ g }: { g: GridInfo }) {
  const on = useJiggle((j) => j.on);
  const animation = useAnimation();
  const indicatorTop = useDesk((s) => s.settings.pageIndicator.position === "top");
  const top = g.workTop + (indicatorTop ? 40 : 12);
  return (
    <AnimatePresence>
      {on && (
        <motion.div
          className="jiggle-done"
          data-hit=""
          style={{ left: g.workLeft + g.workWidth / 2, top }}
          initial={{ opacity: 0, y: -14, x: "-50%" }}
          animate={{ opacity: 1, y: 0, x: "-50%" }}
          exit={{ opacity: 0, y: -14, x: "-50%" }}
          transition={spring({ animation }, 0.36, 0.2)}
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <span>{t.jiggle.hint}</span>
          <button onClick={exitJiggle}>{t.jiggle.done}</button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
