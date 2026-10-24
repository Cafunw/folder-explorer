import { motion, useTransform } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { isFolderId } from "../layout/model";
import { ghost, useDrag } from "./dnd";
import { displayName, useDesk } from "./store";
import { FolderGlyph, ItemImage } from "./Tile";
import { ICON_TOP } from "../layout/grid";

export function DragLayer() {
  // not the whole drag: a new target re-renders the ghost only when the target's kind changes
  const drag = useDrag(
    useShallow((d) =>
      d.drag ? { ids: d.drag.ids, primary: d.drag.primary, cellW: d.drag.cellW, size: d.drag.size, kind: d.drag.target?.kind } : null,
    ),
  );
  const marquee = useDrag((d) => d.marquee);
  const labels = useDesk((s) => s.settings.grid.labels);
  const x = useTransform(ghost.x, (v) => v - ghost.offX);
  const y = useTransform(ghost.y, (v) => v - ghost.offY);

  const cellW = drag?.cellW ?? 0;
  const size = drag?.size ?? 0;
  const kind = drag?.kind;
  // the target tile shows what happens ("<App> ile aç" for an app): the ghost shrinks, no label
  const merging = kind === "merge" || kind === "into" || kind === "app";

  return (
    <>
      {marquee && (
        <div
          className="marquee"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}
      {drag && (
        <div className="drag-layer">
          <motion.div className="drag-ghost" style={{ x, y, width: cellW }}>
            <motion.div
              initial={{ scale: 1 }}
              animate={{ scale: merging ? 0.86 : 1.06 }}
              transition={{ type: "spring", duration: 0.3, bounce: 0.3 }}
              style={{ display: "flex", flexDirection: "column", alignItems: "center" }}
            >
              <div style={{ position: "relative", width: size, height: size, marginTop: ICON_TOP }}>
                {drag.ids.slice(1, 3).map((id, i) => (
                  <div
                    key={id}
                    style={{
                      position: "absolute",
                      inset: 0,
                      transform: `translate(${(i + 1) * 5}px, ${(i + 1) * 4}px) rotate(${(i + 1) * 4}deg)`,
                      opacity: 0.7,
                    }}
                  >
                    <GhostImage id={id} size={size} />
                  </div>
                ))}
                <div style={{ position: "absolute", inset: 0, filter: "drop-shadow(0 10px 18px rgba(0,0,0,.35))" }}>
                  <GhostImage id={drag.primary} size={size} />
                </div>
                {drag.ids.length > 1 && <div className="drag-badge">{drag.ids.length}</div>}
              </div>
              {labels && !merging && (
                <div className="tile-label" style={{ WebkitLineClamp: 2, opacity: 0.95 }}>
                  {displayName(drag.primary)}
                </div>
              )}
            </motion.div>
          </motion.div>
        </div>
      )}
    </>
  );
}

function GhostImage({ id, size }: { id: string; size: number }) {
  return (
    <div style={{ width: size, height: size, display: "grid", placeItems: "center" }} className="tile-icon">
      {isFolderId(id) ? <FolderGlyph folderId={id} size={size} /> : <ItemImage id={id} size={size} plate />}
    </div>
  );
}
