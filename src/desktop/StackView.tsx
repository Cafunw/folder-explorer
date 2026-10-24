// A "stack" group with a few items opens as a fan rising from its tile (like a Dock stack); more
// items open as a grid bubble (FolderPanel). Click / double-click / right-click work like in a
// panel; dragging an item closes the fan, so it can be dropped anywhere on the desktop.

import { motion } from "motion/react";
import { useEffect, useLayoutEffect } from "react";
import type { GridInfo } from "../layout/grid";
import { isFolderId } from "../layout/model";
import { tween } from "../settings";
import type { OpenStyle } from "../types";
import { closePanel } from "./actions";
import { useDrag } from "./dnd";
import { fanMotion, openStyleOf } from "./fx";
import { entryId, LiveImage, useEntryHandlers, useIconEl, type Entry } from "./GroupContent";
import { fanLayout, type FanSpot } from "./kinds";
import { panelGrid } from "./registry";
import { displayName, useAnimation, useDesk, type PanelState } from "./store";
import { FolderGlyph, ItemImage } from "./Tile";
import "./groups.css";

type Rect = { left: number; top: number; width: number; height: number };

export function StackFan({ panel, entries, rect, g }: { panel: PanelState; entries: Entry[]; rect: Rect; g: GridInfo }) {
  const settings = useDesk((s) => s.settings);
  const dragging = useDrag((d) => !!d.drag);
  const openStyle = useDesk((s) => openStyleOf(s.settings, s.layout.folders[panel.stack[0]]?.look, s.quiet.game || s.quiet.battery));
  const size = Math.round(g.iconSize);
  const step = size + Math.max(12, size * 0.28);

  useEffect(() => {
    if (dragging) closePanel();
  }, [dragging]);

  // no panel grid while the fan is open: drags are evaluated against the desktop
  useLayoutEffect(() => {
    panelGrid.panelEl = null;
    panelGrid.el = null;
    panelGrid.iconSize = size;
    panelGrid.cellW = g.cellW;
    panelGrid.folderId = panel.stack[0];
    panelGrid.items = null;
  });

  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const workTop = g.top + g.workTop;
  const workBottom = workTop + g.workHeight;
  const side: 1 | -1 = cx < g.left + g.workLeft + g.workWidth / 2 ? 1 : -1;
  const need = entries.length * step + size / 2 + 8;
  const up = cy - workTop >= need || cy - workTop >= workBottom - cy;
  // a downward fan starts below the tile's label
  const drop = up ? 0 : Math.max(0, g.cellH - size) * 0.7;
  const spots = fanLayout(entries.length, step, side, up).map((s) => ({ ...s, y: s.y + drop }));

  return (
    <motion.div className="fan-overlay" style={{ zIndex: 30 }}>
      <motion.div
        className="fan-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={tween(settings, 0.2)}
        style={{ background: "rgba(0,0,0,0.22)" }}
        onPointerDown={(e) => {
          e.stopPropagation();
          if (Date.now() - panel.openedAt > 250) closePanel();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      {entries.map((e, i) => (
        <FanItem key={entryId(e)} entry={e} spot={spots[i]} cx={cx} cy={cy} size={size} side={side} index={i} openStyle={openStyle} />
      ))}
    </motion.div>
  );
}

function FanItem({
  entry,
  spot,
  cx,
  cy,
  size,
  side,
  index,
  openStyle,
}: {
  entry: Entry;
  spot: FanSpot;
  cx: number;
  cy: number;
  size: number;
  side: 1 | -1;
  index: number;
  openStyle: OpenStyle;
}) {
  const animation = useAnimation();
  const id = entryId(entry);
  const h = useEntryHandlers(entry);
  const ref = useIconEl(id, entry.kind === "child");
  const name = useDesk(() => (entry.kind === "live" ? entry.item.name : displayName(id)));
  const m = fanMotion(openStyle, { animation }, spot, side, index);
  return (
    <motion.div
      ref={ref}
      className="fan-item"
      data-hit="tile"
      data-selected={h.selected}
      style={{ ...m.style, left: cx + spot.x - size / 2, top: cy + spot.y - size / 2, width: size, height: size }}
      initial={m.home}
      animate={m.shown}
      exit={{ ...m.home, transition: m.close }}
      transition={m.open}
      onPointerDown={h.onPointerDown}
      onDoubleClick={h.onDoubleClick}
      onContextMenu={h.onContextMenu}
    >
      <div className="tile-icon" style={{ width: size, height: size }}>
        {entry.kind === "live" ? (
          <LiveImage item={entry.item} size={size} />
        ) : isFolderId(id) ? (
          <FolderGlyph folderId={id} size={size} />
        ) : (
          <ItemImage id={id} size={size} />
        )}
      </div>
      <div className="fan-label" style={side > 0 ? { left: size + 10 } : { right: size + 10 }}>
        {name}
      </div>
    </motion.div>
  );
}
