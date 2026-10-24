// Pure motion helpers: how group panels / stack fans open (settings.animation.openStyle, per group
// look.openStyle), how pages change (pageTransition), hover magnify / tilt and the jiggle phase.
// No store, no DOM.

import type { TargetAndTransition, Transition } from "motion/react";
import { spring, tween } from "../settings";
import type { FolderLook, OpenStyle, PageTransition, Settings } from "../types";

type Anim = Pick<Settings, "animation">;

/** A group's open style: its own, else the global one; quiet modes only fade (no blur, no 3D). */
export function openStyleOf(s: Anim, look: FolderLook | undefined, quiet: boolean): OpenStyle {
  return quiet ? "fade" : (look?.openStyle ?? s.animation.openStyle);
}

/** Where the group's tile is, relative to the open card's centre: offset, scale and corner radius. */
export type TileOrigin = { x: number; y: number; scale: number; radius: number };

export type PanelMotion = {
  hidden: TargetAndTransition;
  shown: TargetAndTransition;
  exit: TargetAndTransition;
  open: Transition;
  close: Transition;
  /** extra style for the card (3D flip) */
  style: { transformPerspective?: number; backfaceVisibility?: "hidden" };
};

/**
 * Open / close of a group panel card. zoom = grows out of the tile; spring = the same, bouncier;
 * flip = turns over in 3D from the tile; blur = sharpens from a blurred, smaller card; fade =
 * opacity + a slight scale. Closing mirrors opening.
 */
export function panelMotion(style: OpenStyle, s: Anim, from: TileOrigin | null, radius: number): PanelMotion {
  const shown: TargetAndTransition = { opacity: 1, scale: 1, x: 0, y: 0, borderRadius: radius };
  const fromTile: TargetAndTransition = from
    ? { opacity: 0, scale: from.scale, x: from.x, y: from.y, borderRadius: from.radius }
    : { opacity: 0, scale: 0.85, x: 0, y: 0, borderRadius: radius };
  switch (style) {
    case "spring": {
      const hidden = from ? { ...fromTile, borderRadius: radius } : { ...fromTile, scale: 0.6 };
      return {
        hidden,
        shown,
        exit: hidden,
        open: { ...spring(s, 0.62, 0.42), opacity: tween(s, 0.14) },
        close: { ...spring(s, 0.34, 0.04), opacity: tween(s, 0.2) },
        style: {},
      };
    }
    case "flip": {
      const turn = from && from.x < 0 ? -1 : 1;
      const hidden: TargetAndTransition = {
        opacity: 0,
        x: from?.x ?? 0,
        y: from?.y ?? 0,
        scale: from ? Math.max(from.scale, 0.3) : 0.8,
        rotateY: 110 * turn,
        rotateX: 16,
        borderRadius: radius,
      };
      return {
        hidden,
        shown: { ...shown, rotateY: 0, rotateX: 0 },
        exit: hidden,
        open: { ...spring(s, 0.66, 0.14), opacity: tween(s, 0.12) },
        close: { ...spring(s, 0.42, 0.02), opacity: tween(s, 0.3) },
        style: { transformPerspective: 1100, backfaceVisibility: "hidden" },
      };
    }
    case "blur": {
      const hidden: TargetAndTransition = { opacity: 0, scale: 0.92, x: 0, y: 0, borderRadius: radius, filter: "blur(18px)" };
      return {
        hidden,
        // no filter at rest: a filter would make the card's own backdrop blur its "backdrop root"
        shown: { ...shown, filter: "blur(0px)", transitionEnd: { filter: "none" } },
        exit: { ...hidden, filter: ["blur(0px)", "blur(18px)"] },
        open: { ...spring(s, 0.5, 0.08), opacity: tween(s, 0.28), filter: tween(s, 0.34) },
        close: tween(s, 0.22),
        style: {},
      };
    }
    case "fade": {
      const hidden: TargetAndTransition = { opacity: 0, scale: 0.96, x: 0, y: 0, borderRadius: radius };
      return { hidden, shown, exit: hidden, open: tween(s, 0.22), close: tween(s, 0.16), style: {} };
    }
    default:
      return { hidden: fromTile, shown, exit: fromTile, open: spring(s, 0.5, 0.16), close: spring(s, 0.38, 0.05), style: {} };
  }
}

export type FanMotion = { home: TargetAndTransition; shown: TargetAndTransition; open: Transition; close: Transition; style: { transformPerspective?: number } };

/** One entry of a stack fan: rises from the tile (`spot` = its place relative to the tile's centre). */
export function fanMotion(style: OpenStyle, s: Anim, spot: { x: number; y: number; rot: number }, side: 1 | -1, index: number): FanMotion {
  const shown: TargetAndTransition = { x: 0, y: 0, scale: 1, opacity: 1, rotate: spot.rot };
  const fromTile: TargetAndTransition = { x: -spot.x, y: -spot.y, scale: 0.35, opacity: 0, rotate: 0 };
  const stagger = (t: Transition, step = 0.02): Transition => ({ ...t, delay: index * step });
  switch (style) {
    case "spring":
      return { home: fromTile, shown, open: stagger(spring(s, 0.5, 0.45), 0.03), close: tween(s, 0.16), style: {} };
    case "flip":
      return {
        home: { ...fromTile, rotateY: -100 * side },
        shown: { ...shown, rotateY: 0 },
        open: stagger({ ...spring(s, 0.55, 0.16), opacity: tween(s, 0.12) }, 0.03),
        close: tween(s, 0.18),
        style: { transformPerspective: 500 },
      };
    case "blur":
      return {
        home: { x: -spot.x * 0.3, y: -spot.y * 0.3, scale: 0.7, opacity: 0, rotate: spot.rot, filter: "blur(8px)" },
        shown: { ...shown, filter: "blur(0px)", transitionEnd: { filter: "none" } },
        open: stagger(tween(s, 0.3), 0.025),
        close: tween(s, 0.18),
        style: {},
      };
    case "fade":
      return { home: { x: 0, y: 0, scale: 0.9, opacity: 0, rotate: spot.rot }, shown, open: stagger(tween(s, 0.2), 0.015), close: tween(s, 0.14), style: {} };
    default:
      return { home: fromTile, shown, open: stagger(spring(s, 0.42, 0.2)), close: tween(s, 0.16), style: {} };
  }
}

// ---------------------------------------------------------------- page transitions

/**
 * How one page of a monitor is drawn while the page position moves (`rel` = page index minus the
 * animated position: 0 = on screen, ±1 = one page away). Only pages with |rel| < 1 are visible, so a
 * transition touches the outgoing and the incoming page only.
 */
export type PageLook = { transform: string; opacity: number; zIndex: number; visible: boolean };

const f2 = (n: number) => +n.toFixed(2);

export function pageLook(mode: PageTransition, rel: number, width: number): PageLook {
  const a = Math.abs(rel);
  if (a < 1e-4) return { transform: "none", opacity: 1, zIndex: 2, visible: true };
  if (a >= 1 - 1e-4) return { transform: "none", opacity: 1, zIndex: 0, visible: false };
  const front = a < 0.5 ? 2 : 1;
  switch (mode) {
    case "cube": {
      // faces of a cube as wide as the monitor, turning around its centre (perspective on the track);
      // the cube moves back while it turns, so the shared edge stays at screen depth (never clipped)
      const d = width / 2;
      const th = (a * Math.PI) / 2;
      const back = d + d * (Math.sin(th) + Math.cos(th) - 1);
      return { transform: `translateZ(${-f2(back)}px) rotateY(${f2(rel * 90)}deg) translateZ(${f2(d)}px)`, opacity: 1, zIndex: front, visible: true };
    }
    case "cards":
      // the page on the right slides over; the one on the left sinks back and fades
      return rel > 0
        ? { transform: `translateX(${f2(rel * width)}px)`, opacity: 1, zIndex: 2, visible: true }
        : { transform: `scale(${f2(1 + 0.12 * rel)})`, opacity: f2(1 + 0.75 * rel), zIndex: 1, visible: true };
    case "fade":
      return { transform: "none", opacity: f2(1 - a), zIndex: front, visible: true };
    default:
      return { transform: `translateX(${f2(rel * width)}px)`, opacity: 1, zIndex: front, visible: true };
  }
}

/** The page track's perspective (cube only). */
export const pagePerspective = (mode: PageTransition, width: number) => (mode === "cube" ? Math.round(width * 1.5) : undefined);

export function pageTransition(mode: PageTransition, s: Anim): Transition {
  switch (mode) {
    case "cube":
      return spring(s, 0.75, 0.05);
    case "cards":
      return spring(s, 0.55, 0.06);
    case "fade":
      return tween(s, 0.32);
    default:
      return spring(s, 0.5, 0.1);
  }
}

// ---------------------------------------------------------------- hover

/** Dock-like magnification by distance (in cells) from the pointer: `max` at 0, 1 from `reach` on. */
export function magnifyScale(distance: number, max = 1.3, reach = 2): number {
  const d = Math.abs(distance);
  if (d >= reach) return 1;
  return 1 + ((max - 1) * (1 + Math.cos((Math.PI * d) / reach))) / 2;
}

/** Tiles in the hovered tile's row (same top) within `reach` cells: indexes into `tops` / `centres`. */
export function rowNeighbours(tops: number[], centres: number[], hovered: number, cellW: number, reach = 2.5): number[] {
  const out: number[] = [];
  for (let i = 0; i < tops.length; i++) {
    if (Math.abs(tops[i] - tops[hovered]) < 4 && Math.abs(centres[i] - centres[hovered]) <= reach * cellW) out.push(i);
  }
  return out;
}

/**
 * 3D tilt toward the pointer: `dx` / `dy` = pointer offset from the icon centre in half-sizes
 * (-1..1). The edge under the pointer is pressed away. CSS `rotate: <x> <y> 0 <a>deg`.
 */
export function tiltOf(dx: number, dy: number, maxDeg = 14): { x: number; y: number; a: number } {
  const cx = Math.max(-1, Math.min(1, dx));
  const cy = Math.max(-1, Math.min(1, dy));
  const len = Math.hypot(cx, cy);
  if (len < 0.01) return { x: 1, y: 0, a: 0 };
  return { x: f2(-cy / len), y: f2(cx / len), a: f2(maxDeg * Math.min(1, len)) };
}

// ---------------------------------------------------------------- jiggle

/** A stable pseudo-random wiggle phase per item, so icons do not move in step. */
export function jigglePhase(id: string): { delay: string; duration: string } {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const u = (h >>> 0) / 2 ** 32;
  return { delay: `-${(u * 0.5).toFixed(3)}s`, duration: `${230 + ((h >>> 8) & 63)}ms` };
}
