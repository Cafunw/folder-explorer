import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../settings";
import type { Settings } from "../types";
import { fanMotion, jigglePhase, magnifyScale, openStyleOf, pageLook, pagePerspective, panelMotion, rowNeighbours, tiltOf } from "./fx";

const s = DEFAULT_SETTINGS;
const reduced: Settings = { ...s, animation: { ...s.animation, reduceMotion: true } };

describe("open styles", () => {
  it("a group's own style wins; quiet modes only fade", () => {
    const flip: Settings = { ...s, animation: { ...s.animation, openStyle: "flip" } };
    expect(openStyleOf(flip, undefined, false)).toBe("flip");
    expect(openStyleOf(flip, { openStyle: "blur" }, false)).toBe("blur");
    expect(openStyleOf(flip, { openStyle: "blur" }, true)).toBe("fade");
  });

  it("zoom grows out of the tile and closes back into it", () => {
    const from = { x: -300, y: 120, scale: 0.2, radius: 60 };
    const m = panelMotion("zoom", s, from, 38);
    expect(m.hidden).toMatchObject({ opacity: 0, scale: 0.2, x: -300, y: 120, borderRadius: 60 });
    expect(m.exit).toEqual(m.hidden);
    expect(m.shown).toMatchObject({ opacity: 1, scale: 1, x: 0, y: 0, borderRadius: 38 });
  });

  it("spring is bouncier than zoom", () => {
    const zoom = panelMotion("zoom", s, null, 38).open as { bounce: number };
    const spr = panelMotion("spring", s, null, 38).open as { bounce: number };
    expect(spr.bounce).toBeGreaterThan(zoom.bounce);
  });

  it("flip turns in 3D with the back face hidden, towards the tile's side", () => {
    const left = panelMotion("flip", s, { x: -200, y: 0, scale: 0.2, radius: 20 }, 38);
    const right = panelMotion("flip", s, { x: 200, y: 0, scale: 0.2, radius: 20 }, 38);
    expect(left.style).toEqual({ transformPerspective: 1100, backfaceVisibility: "hidden" });
    expect(left.hidden.rotateY).toBe(-110);
    expect(right.hidden.rotateY).toBe(110);
    expect(left.shown).toMatchObject({ rotateY: 0, rotateX: 0 });
  });

  it("blur leaves no filter on the card at rest", () => {
    const m = panelMotion("blur", s, null, 38);
    expect(m.hidden.filter).toBe("blur(18px)");
    expect(m.shown.transitionEnd).toEqual({ filter: "none" });
    expect(m.exit.filter).toEqual(["blur(0px)", "blur(18px)"]);
  });

  it("reduced motion makes every style instant", () => {
    for (const st of ["zoom", "spring", "flip", "blur", "fade"] as const) {
      expect(panelMotion(st, reduced, null, 30).close).toMatchObject({ duration: 0 });
    }
  });

  it("fan entries rise from the tile, staggered", () => {
    const a = fanMotion("zoom", s, { x: 0, y: -80, rot: 3 }, 1, 0);
    const b = fanMotion("zoom", s, { x: 0, y: -160, rot: 5 }, 1, 2);
    expect(a.home).toMatchObject({ x: -0, y: 80, opacity: 0 });
    expect(b.shown).toMatchObject({ rotate: 5, opacity: 1 });
    expect((b.open as { delay: number }).delay).toBeCloseTo(0.04);
    expect(fanMotion("fade", s, { x: 10, y: -80, rot: 3 }, 1, 0).home).toMatchObject({ x: 0, y: 0 });
  });
});

describe("page transitions", () => {
  const W = 1000;

  it("the current page is untouched and pages a whole page away are hidden", () => {
    for (const mode of ["slide", "cube", "cards", "fade"] as const) {
      expect(pageLook(mode, 0, W)).toEqual({ transform: "none", opacity: 1, zIndex: 2, visible: true });
      expect(pageLook(mode, 1, W).visible).toBe(false);
      expect(pageLook(mode, -2, W).visible).toBe(false);
    }
  });

  it("slide moves pages side by side", () => {
    expect(pageLook("slide", 0.5, W).transform).toBe("translateX(500px)");
    expect(pageLook("slide", -0.25, W).transform).toBe("translateX(-250px)");
  });

  it("cube turns two faces of a cube, pushed back so the shared edge stays at screen depth", () => {
    // halfway: the outgoing face has turned 45° left, the incoming one comes from 45° right; both
    // move back by d·(√2 − 1)
    expect(pageLook("cube", -0.5, W).transform).toBe("translateZ(-707.11px) rotateY(-45deg) translateZ(500px)");
    expect(pageLook("cube", 0.5, W).transform).toBe("translateZ(-707.11px) rotateY(45deg) translateZ(500px)");
    expect(pageLook("cube", 0.25, W).transform).toBe(pageLook("cube", -0.75, W).transform.replace("-67.5deg", "22.5deg"));
    // the shared edge (x = −d on the incoming face) ends at z = 0
    const d = W / 2;
    const th = Math.PI / 4;
    const back = d + d * (Math.sin(th) + Math.cos(th) - 1);
    expect(d * Math.sin(th) + d * Math.cos(th) - back).toBeCloseTo(0);
    expect(pagePerspective("cube", W)).toBe(1500);
    expect(pagePerspective("slide", W)).toBeUndefined();
  });

  it("cards: the next page slides over, the previous one sinks back and fades", () => {
    const over = pageLook("cards", 0.4, W);
    const under = pageLook("cards", -0.6, W);
    expect(over).toMatchObject({ transform: "translateX(400px)", opacity: 1 });
    expect(under.transform).toBe("scale(0.93)");
    expect(under.opacity).toBeCloseTo(0.55);
    expect(over.zIndex).toBeGreaterThan(under.zIndex);
  });

  it("fade cross-fades in place", () => {
    expect(pageLook("fade", 0.3, W)).toMatchObject({ transform: "none", opacity: 0.7 });
    expect(pageLook("fade", -0.7, W).opacity).toBeCloseTo(0.3);
  });
});

describe("hover", () => {
  it("magnify falls off smoothly with the distance", () => {
    expect(magnifyScale(0)).toBeCloseTo(1.3);
    expect(magnifyScale(1)).toBeCloseTo(1.15);
    expect(magnifyScale(-1)).toBeCloseTo(1.15);
    expect(magnifyScale(2)).toBe(1);
    expect(magnifyScale(5)).toBe(1);
    expect(magnifyScale(0.5)).toBeGreaterThan(magnifyScale(1.5));
  });

  it("neighbours are the tiles of the same row within reach", () => {
    const tops = [100, 100, 100, 100, 200, 101];
    const centres = [50, 150, 250, 450, 150, 350];
    expect(rowNeighbours(tops, centres, 1, 100)).toEqual([0, 1, 2, 5]);
  });

  it("tilt presses the edge under the pointer away", () => {
    expect(tiltOf(0, 0)).toEqual({ x: 1, y: 0, a: 0 });
    expect(tiltOf(1, 0)).toEqual({ x: 0, y: 1, a: 14 });
    expect(tiltOf(0, -1)).toEqual({ x: 1, y: 0, a: 14 });
    expect(tiltOf(3, 0).a).toBe(14);
  });
});

describe("jiggle", () => {
  it("phase is stable per id and differs between ids", () => {
    expect(jigglePhase("a")).toEqual(jigglePhase("a"));
    expect(jigglePhase("c:\\a.lnk").delay).not.toBe(jigglePhase("c:\\b.lnk").delay);
    expect(jigglePhase("x").delay).toMatch(/^-0\.\d{3}s$/);
  });
});
