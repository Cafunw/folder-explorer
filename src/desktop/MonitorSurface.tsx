import { animate, type MotionValue } from "motion/react";
import { memo, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { cellXY, type GridInfo } from "../layout/grid";
import { isBlock } from "../layout/blocks";
import { pageCount } from "../layout/model";
import type { PageTransition, Placement } from "../types";
import { useDrag } from "./dnd";
import { Block, BlockOutline } from "./Fence";
import { pageLook, pagePerspective, pageTransition } from "./fx";
import { JiggleDone } from "./Jiggle";
import { pagePos } from "./registry";
import { setPage, useAnimation, useDesk, useReducedMotion } from "./store";
import { Positioned, Tile } from "./Tile";
import { Icon } from "../ui/Icons";

export function MonitorSurface({ g }: { g: GridInfo }) {
  const placements = useDesk((s) => s.layout.placements);
  const layout = useDesk((s) => s.layout);
  const showIcons = useDesk((s) => s.settings.behavior.showIcons);
  const animation = useAnimation();
  const reduced = useReducedMotion();
  const page = useDesk((s) => s.pages[g.monitorId] ?? 0);
  // only what the surface itself draws: a drag re-renders it when it starts / ends or an icon is
  // pushed aside, not on every target change (tiles and fences follow the target themselves)
  const dragIds = useDrag((d) => d.drag?.ids);
  const dragPage = useDrag((d) => d.drag?.extraPage === g.monitorId);
  const blockPage = useDrag((d) => d.block?.extraPage === g.monitorId);
  const displacedKey = useDrag((d) => {
    const t = d.drag?.target ?? d.external;
    return t?.kind === "cell" && t.displaced ? JSON.stringify(t.displaced) : "";
  });
  const mode = animation.pageTransition;
  const pos = pagePos(g.monitorId);
  const first = useRef(true);

  // one spring on the page position drives every page (and the wallpaper parallax)
  useLayoutEffect(() => {
    if (first.current || reduced) {
      first.current = false;
      pos.jump(page);
      return;
    }
    const a = animate(pos, page, pageTransition(mode, { animation }));
    return () => a.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const base = pageCount(layout, g.monitorId);
  const count = Math.max(base + (dragPage || blockPage ? 1 : 0), page + 1);

  const entries = useMemo(
    () => Object.entries(placements).filter(([, pl]) => pl.m === g.monitorId),
    [placements, g.monitorId],
  );

  const displaced = useMemo(
    () => (displacedKey ? (JSON.parse(displacedKey) as { id: string; to: Placement }) : null),
    [displacedKey],
  );
  const hidden = useMemo(() => new Set(dragIds ?? []), [dragIds]);
  // View ▸ Show desktop icons / double-click: the icons fade, then stop taking the pointer
  const fade = reduced ? 0 : Math.round(220 / animation.speed);

  return (
    <div className="monitor" style={{ left: g.left, top: g.top, width: g.width, height: g.height }}>
      <div
        className="page-track"
        style={{
          visibility: showIcons ? undefined : "hidden",
          opacity: showIcons ? undefined : 0,
          transition: fade ? `opacity ${fade}ms ease, visibility 0s linear ${showIcons ? 0 : fade}ms` : undefined,
          perspective: pagePerspective(mode, g.width),
        }}
      >
        {Array.from({ length: count }, (_, p) => (
          <Page key={p} p={p} pos={pos} mode={mode} width={g.width}>
            <BlockOutline g={g} page={p} />
            {entries
              .filter(([, pl]) => pl.p === p)
              .map(([id, pl]) => {
                // fences and headings span their cells
                if (isBlock(layout, id)) return <Block key={id} id={id} pl={pl} g={g} />;
                const at = displaced && displaced.id === id && displaced.to.p === p ? displaced.to : pl;
                const { x, y } = cellXY(g, at.c, at.r);
                return (
                  <DeskTile key={id} id={id} x={x} y={y} cellW={g.cellW} cellH={g.cellH} size={g.iconSize} hidden={hidden.has(id)} />
                );
              })}
          </Page>
        ))}
      </div>
      {count > 1 && showIcons && <PageIndicator g={g} count={count} page={page} />}
      <JiggleDone g={g} />
    </div>
  );
}

/**
 * One page, drawn for the animated page position (`pageLook`: slide / cube / cards / fade). Styles
 * are written straight to the element, only when they change; pages a whole page away are hidden,
 * and a page gets a compositor layer only while it is between two positions.
 */
function Page({ p, pos, mode, width, children }: { p: number; pos: MotionValue<number>; mode: PageTransition; width: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last = "";
    const apply = (v: number) => {
      const look = pageLook(mode, p - v, width);
      const key = `${look.transform}|${look.opacity}|${look.zIndex}|${look.visible}`;
      if (key === last) return;
      last = key;
      const moving = look.visible && (look.transform !== "none" || look.opacity < 1);
      el.style.transform = look.transform === "none" ? "" : look.transform;
      el.style.opacity = look.opacity < 1 ? String(look.opacity) : "";
      el.style.zIndex = String(look.zIndex);
      el.style.visibility = look.visible ? "" : "hidden";
      el.style.willChange = moving ? "transform, opacity" : "";
    };
    apply(pos.get());
    return pos.on("change", apply);
  }, [p, pos, mode, width]);
  return (
    <div ref={ref} className="page" style={{ left: 0, width }}>
      {children}
    </div>
  );
}

/** A desktop icon at its cell; memoized, so a surface re-render only touches the icons that moved. */
const DeskTile = memo(function DeskTile(p: { id: string; x: number; y: number; cellW: number; cellH: number; size: number; hidden: boolean }) {
  return (
    <Positioned id={p.id} x={p.x} y={p.y}>
      <Tile id={p.id} cellW={p.cellW} cellH={p.cellH} size={p.size} where="desktop" hidden={p.hidden} />
    </Positioned>
  );
});

/** Page dots / line / "2 / 3" on one edge of the work area (settings.pageIndicator); click = go to page. */
function PageIndicator({ g, count, page }: { g: GridInfo; count: number; page: number }) {
  const style = useDesk((s) => s.settings.pageIndicator.style);
  const pos = useDesk((s) => s.settings.pageIndicator.position);
  if (style === "hidden") return null;
  // centre of the pill: in the free band right / below the grid when there is room, else near the edge
  const right = g.workLeft + g.workWidth;
  const bottom = g.workTop + g.workHeight;
  const bandR = right - (g.originX + g.cols * g.cellW);
  const bandB = bottom - (g.originY + g.rows * g.cellH);
  const cx = g.workLeft + g.workWidth / 2;
  const cy = g.workTop + g.workHeight / 2;
  const at =
    pos === "top"
      ? { left: cx, top: g.workTop + 14 }
      : pos === "left"
        ? { left: g.workLeft + 14, top: cy }
        : pos === "right"
          ? { left: right - (bandR >= 28 ? bandR / 2 : 14), top: cy }
          : { left: cx, top: bottom - (bandB >= 28 ? bandB / 2 : 14) };
  const go = (p: number) => setPage(g.monitorId, Math.max(0, Math.min(count - 1, p)));
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  return (
    <div className="page-dots" data-hit="" data-style={style} data-pos={pos} style={at}>
      {style === "numbers" ? (
        <>
          <button className="page-step" data-dir="prev" disabled={page === 0} onPointerDown={stop} onClick={() => go(page - 1)}>
            <Icon name="chevron" size={13} />
          </button>
          <span className="page-num">
            {page + 1} / {count}
          </span>
          <button className="page-step" data-dir="next" disabled={page >= count - 1} onPointerDown={stop} onClick={() => go(page + 1)}>
            <Icon name="chevron" size={13} />
          </button>
        </>
      ) : (
        Array.from({ length: count }, (_, p) => (
          <button key={p} className="page-dot" data-active={p === page} onPointerDown={stop} onClick={() => go(p)} />
        ))
      )}
    </div>
  );
}
