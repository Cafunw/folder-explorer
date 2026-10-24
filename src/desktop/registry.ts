// Live DOM handles shared between components and the drag controller (not React state).

import { motionValue, type MotionValue } from "motion/react";

/** Icon tiles currently on screen, keyed by item id. */
export const iconEls = new Map<string, HTMLElement>();

/** Geometry of the grid inside the open folder panel. */
export const panelGrid: {
  el: HTMLElement | null; // scroll container
  panelEl: HTMLElement | null; // whole panel card
  cols: number;
  cellW: number;
  cellH: number;
  iconSize: number;
  padX: number;
  padY: number;
  /** the group whose children the grid shows (a tabs group's open tab may be a child group) */
  folderId: string | null;
  /** the ids the grid shows when they are not exactly `folderId`'s children (a tabs group's "Genel" tab) */
  items: string[] | null;
  /** tab headers of a tabs group: drop targets (into that tab's group) */
  tabs: Map<string, { el: HTMLElement; folderId: string }>;
  /** the tabs group the headers belong to */
  tabsOwner: string | null;
  /** every entry the grid shows, in order (children, a frequent group's picks, live entries): arrow keys */
  shown: string[];
} = {
  el: null,
  panelEl: null,
  cols: 1,
  cellW: 1,
  cellH: 1,
  iconSize: 1,
  padX: 0,
  padY: 0,
  folderId: null,
  items: null,
  tabs: new Map(),
  tabsOwner: null,
  shown: [],
};

/** Scrolling body of each fence on screen, keyed by its group id. */
export const fenceBodies = new Map<string, HTMLElement>();

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

const pagePositions = new Map<string, MotionValue<number>>();

/**
 * A monitor's page position, fractional while a page transition runs: the page track
 * (MonitorSurface) and the wallpaper parallax both follow it, so they always move together.
 */
export function pagePos(monitorId: string): MotionValue<number> {
  let v = pagePositions.get(monitorId);
  if (!v) {
    v = motionValue(0);
    pagePositions.set(monitorId, v);
  }
  return v;
}
