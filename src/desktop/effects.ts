// Hover effects of the icons and the sound settings, kept in step with the store.
// `:root[data-hover]` = the effect that may run now (fx.css); it is absent in quiet modes, with
// reduced motion, while dragging / renaming / editing icons, so CSS never has to know about those.
// Tilt and magnify need the pointer: handlers on the hovered tile only, rAF-throttled, no global work.

import { useDrag } from "./dnd";
import { magnifyScale, rowNeighbours, tiltOf } from "./fx";
import { useJiggle } from "./Jiggle";
import { setSoundConfig } from "./sounds";
import { reducedMotion, useDesk } from "./store";
import "./fx.css";

const root = () => document.documentElement;

/** Call once on the desktop; returns the teardown. */
export function installEffects(): () => void {
  const sync = () => {
    const st = useDesk.getState();
    const d = useDrag.getState();
    const a = st.settings.animation;
    const off =
      a.hover === "none" ||
      reducedMotion(st) ||
      !!st.rename ||
      useJiggle.getState().on ||
      !!d.drag ||
      !!d.block ||
      !!d.marquee;
    const mode = off ? undefined : a.hover;
    if (root().dataset.hover !== mode) {
      clearHover();
      if (mode) root().dataset.hover = mode;
      else delete root().dataset.hover;
    }
  };
  const sounds = () => {
    const st = useDesk.getState();
    setSoundConfig({ enabled: st.settings.animation.sounds, volume: st.settings.animation.soundVolume, muted: st.quiet.game });
  };
  sync();
  sounds();
  const unsubs = [
    useDesk.subscribe((s, p) => {
      if (s.settings !== p.settings || s.quiet !== p.quiet) sounds();
      // cheap: a few flags compared with the attribute (also catches Windows' animation switch)
      sync();
    }),
    useDrag.subscribe((s, p) => {
      if (!s.drag !== !p.drag || !s.block !== !p.block || !s.marquee !== !p.marquee) sync();
    }),
    useJiggle.subscribe(sync),
  ];
  return () => {
    unsubs.forEach((u) => u());
    clearHover();
    delete root().dataset.hover;
  };
}

// ---------------------------------------------------------------- tilt / magnify

let hovered: HTMLElement | null = null;
let box: DOMRect | null = null;
let row: { el: HTMLElement; cx: number }[] = [];
let stale: HTMLElement[] = [];
let cellW = 1;
let px = 0;
let py = 0;
let raf = 0;

const pointerMode = () => {
  const m = root().dataset.hover;
  return m === "tilt" || m === "magnify" ? m : null;
};

function schedule() {
  if (!raf) raf = requestAnimationFrame(apply);
}

/** The tiles of the hovered tile's row (same grid container, same top, within reach). */
function collectRow(tile: HTMLElement) {
  const container = tile.parentElement?.parentElement;
  const tiles: HTMLElement[] = [];
  for (const c of container?.children ?? []) {
    const el = c.firstElementChild;
    if (el instanceof HTMLElement && el.classList.contains("tile")) tiles.push(el);
  }
  const i = tiles.indexOf(tile);
  if (i < 0) return [];
  const rects = tiles.map((el) => el.getBoundingClientRect());
  const centres = rects.map((r) => r.left + r.width / 2);
  cellW = rects[i].width || 1;
  return rowNeighbours(
    rects.map((r) => r.top),
    centres,
    i,
    cellW,
  ).map((j) => ({ el: tiles[j], cx: centres[j] }));
}

function setRow(next: { el: HTMLElement; cx: number }[]) {
  for (const n of row) stale.push(n.el);
  row = next;
}

function apply() {
  raf = 0;
  for (const el of stale) if (!row.some((n) => n.el === el)) el.style.removeProperty("--mag");
  stale = [];
  const mode = pointerMode();
  if (!hovered || !mode) return;
  if (mode === "magnify") {
    for (const n of row) n.el.style.setProperty("--mag", magnifyScale((n.cx - px) / cellW).toFixed(3));
  } else if (box) {
    // the icon sits in the upper part of the tile: tilt around the tile's centre line and its icon
    const half = Math.min(box.width, box.height) / 2;
    const t = tiltOf((px - (box.left + box.width / 2)) / half, (py - (box.top + half)) / half);
    hovered.style.setProperty("--tilt-x", String(t.x));
    hovered.style.setProperty("--tilt-y", String(t.y));
    hovered.style.setProperty("--tilt-a", `${t.a}deg`);
  }
}

function resetTilt(el: HTMLElement | null) {
  el?.style.removeProperty("--tilt-x");
  el?.style.removeProperty("--tilt-y");
  el?.style.removeProperty("--tilt-a");
}

/** Drops every hover variable (mode change, drag start). */
function clearHover() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  for (const n of row) n.el.style.removeProperty("--mag");
  for (const el of stale) el.style.removeProperty("--mag");
  resetTilt(hovered);
  row = [];
  stale = [];
  hovered = null;
  box = null;
}

export function hoverEnter(e: React.PointerEvent<HTMLElement>) {
  const mode = pointerMode();
  if (!mode || e.pointerType === "touch") return;
  if (hovered !== e.currentTarget) resetTilt(hovered);
  hovered = e.currentTarget;
  box = hovered.getBoundingClientRect();
  if (mode === "magnify") setRow(collectRow(hovered));
  px = e.clientX;
  py = e.clientY;
  schedule();
}

export function hoverMove(e: React.PointerEvent<HTMLElement>) {
  if (e.currentTarget !== hovered) return;
  px = e.clientX;
  py = e.clientY;
  schedule();
}

export function hoverLeave(e: React.PointerEvent<HTMLElement>) {
  if (e.currentTarget !== hovered) return;
  resetTilt(hovered);
  hovered = null;
  box = null;
  // the next tile's enter usually follows at once: the row is swapped on the next frame, no dip
  setRow([]);
  schedule();
}

/** Pointer handlers for a tile (desktop, panel, fence). */
export const hoverHandlers = { onPointerEnter: hoverEnter, onPointerMove: hoverMove, onPointerLeave: hoverLeave };
