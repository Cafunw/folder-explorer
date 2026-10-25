// Keyboard focus and screen-reader naming shared by the modal surfaces (desktop dialogs, Quick Look,
// the search / command palette window). Esc stays with each surface's own window-level handler.

import { useEffect, useState, type RefObject } from "react";

/** id of the open dialog's heading (`aria-labelledby`); one dialog is open at a time. */
export const DIALOG_TITLE = "dialog-title";
/** id of a confirm dialog's message (`aria-describedby`). */
export const DIALOG_BODY = "dialog-body";

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"]), audio[controls], video[controls]';

/** Index Tab (or Shift+Tab with `back`) moves to among `count` focusable elements; `current` -1 = focus is outside. Wraps at both ends. */
export function nextFocusIndex(count: number, current: number, back: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return back ? count - 1 : 0;
  return (current + (back ? count - 1 : 1)) % count;
}

/** What Tab can reach inside `root`, in document order (hidden ones, e.g. a `visibility: hidden` reset button, left out). */
function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden",
  );
}

/**
 * Focus for a modal surface. Call it in a component that mounts with the surface; `active` false =
 * closing (e.g. motion's `useIsPresent()` during the exit animation). While active: focus moves in
 * (unless something inside already took it, like an autoFocus field), Tab / Shift+Tab stay inside;
 * on closing focus goes back to where it was when the surface opened.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, active = true) {
  // read while the surface first renders, before an autoFocus inside it moves the focus
  const [back] = useState(() => document.activeElement);
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (root && !root.contains(document.activeElement)) focusables(root)[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.ctrlKey || e.altKey || e.metaKey || !ref.current) return;
      const list = focusables(ref.current);
      e.preventDefault();
      list[nextFocusIndex(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey)]?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      // focus that already moved on (e.g. into a rename field) stays where it is; `root`, not the
      // ref, which React has cleared when the surface unmounts without an exit animation
      const now = document.activeElement;
      if (now && now !== document.body && !root?.contains(now)) return;
      if (back instanceof HTMLElement && back !== document.body && back.isConnected) back.focus();
      else (document.activeElement as HTMLElement | null)?.blur();
    };
  }, [active, ref, back]);
}
