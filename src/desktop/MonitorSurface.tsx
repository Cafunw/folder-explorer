import { motion } from "motion/react";
import { useMemo } from "react";
import { cellXY, type GridInfo } from "../layout/grid";
import { pageCount } from "../layout/model";
import { spring } from "../settings";
import { useDrag } from "./dnd";
import { setPage, useDesk } from "./store";
import { Positioned, Tile } from "./Tile";

export function MonitorSurface({ g }: { g: GridInfo }) {
  const placements = useDesk((s) => s.layout.placements);
  const layout = useDesk((s) => s.layout);
  const settings = useDesk((s) => s.settings);
  const page = useDesk((s) => s.pages[g.monitorId] ?? 0);
  const drag = useDrag((d) => d.drag);
  const external = useDrag((d) => d.external);

  const base = pageCount(layout, g.monitorId);
  const count = Math.max(base + (drag?.extraPage === g.monitorId ? 1 : 0), page + 1);

  const entries = useMemo(
    () => Object.entries(placements).filter(([, pl]) => pl.m === g.monitorId),
    [placements, g.monitorId],
  );

  const target = drag?.target ?? external;
  const displaced = target?.kind === "cell" ? target.displaced : null;
  const hidden = useMemo(() => new Set(drag?.ids ?? []), [drag]);

  return (
    <div className="monitor" style={{ left: g.left, top: g.top, width: g.width, height: g.height }}>
      <motion.div
        className="page-track"
        initial={false}
        animate={{ x: -page * g.width }}
        transition={spring(settings, 0.5, 0.1)}
      >
        {Array.from({ length: count }, (_, p) => (
          <div key={p} className="page" style={{ left: p * g.width, width: g.width }}>
            {entries
              .filter(([, pl]) => pl.p === p)
              .map(([id, pl]) => {
                const at = displaced && displaced.id === id && displaced.to.p === p ? displaced.to : pl;
                const { x, y } = cellXY(g, at.c, at.r);
                return (
                  <Positioned key={id} id={id} x={x} y={y}>
                    <Tile
                      id={id}
                      cellW={g.cellW}
                      cellH={g.cellH}
                      where="desktop"
                      hidden={hidden.has(id)}
                      dropTarget={target}
                    />
                  </Positioned>
                );
              })}
          </div>
        ))}
      </motion.div>
      {count > 1 && (
        <div className="page-dots" data-hit="" style={{ left: g.workLeft + g.workWidth / 2, top: g.workTop + g.workHeight - 24 }}>
          {Array.from({ length: count }, (_, p) => (
            <button
              key={p}
              className="page-dot"
              data-active={p === page}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setPage(g.monitorId, p)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
