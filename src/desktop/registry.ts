// Live DOM handles shared between components and the drag controller (not React state).

/** Icon tiles currently on screen, keyed by item id. */
export const iconEls = new Map<string, HTMLElement>();

/** Geometry of the grid inside the open folder panel. */
export const panelGrid: {
  el: HTMLElement | null; // scroll container
  panelEl: HTMLElement | null; // whole panel card
  cols: number;
  cellW: number;
  cellH: number;
  padX: number;
  padY: number;
  folderId: string | null;
} = { el: null, panelEl: null, cols: 1, cellW: 1, cellH: 1, padX: 0, padY: 0, folderId: null };

/**
 * Window-space points icons should fly in from on their next mount/move
 * (e.g. where the user dropped them).
 */
export const flyFrom = new Map<string, { x: number; y: number; at: number }>();

export function takeFlyFrom(id: string) {
  const f = flyFrom.get(id);
  if (!f) return null;
  flyFrom.delete(id);
  return Date.now() - f.at < 1500 ? f : null;
}

/** Window rect of an item's icon image (falls back to the whole tile). */
export function rectOf(id: string) {
  const el = iconEls.get(id);
  if (!el || !el.isConnected) return null;
  const icon = el.querySelector(".tile-icon") as HTMLElement | null;
  return (icon ?? el).getBoundingClientRect();
}
