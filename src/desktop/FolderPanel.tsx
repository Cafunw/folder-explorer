import { AnimatePresence, motion } from "motion/react";
import { useLayoutEffect, useRef } from "react";
import { t } from "../i18n";
import { primaryGrid } from "../layout/grid";
import { renameFolder } from "../layout/model";
import { spring, tween } from "../settings";
import { closePanel, panelGoTo } from "./actions";
import { useDrag } from "./dnd";
import { panelGrid, rectOf } from "./registry";
import { commit, useDesk, type PanelState } from "./store";
import { Positioned, Tile, useFolderLook } from "./Tile";
import { Icon } from "../ui/Icons";

export function FolderPanel() {
  const panel = useDesk((s) => s.panel);
  return <AnimatePresence>{panel && <PanelInner key="folder-panel" />}</AnimatePresence>;
}

const PAD_X = 18;
const PAD_Y = 16;

function PanelInner() {
  const live = useDesk((s) => s.panel);
  const last = useRef<PanelState | null>(live);
  if (live) last.current = live;
  const panel = last.current!;

  const grids = useDesk((s) => s.grids);
  const layout = useDesk((s) => s.layout);
  const settings = useDesk((s) => s.settings);
  const drag = useDrag((d) => d.drag);

  const g = grids[panel.monitorId] ?? primaryGrid(grids);
  const folderId = panel.stack[panel.stack.length - 1];
  const folder = layout.folders[folderId];
  // the top-level folder decides how the panel opens; the current one how see-through it is
  const rootLook = useFolderLook(panel.stack[0]);
  const look = useFolderLook(folderId);
  const style = rootLook.panelStyle;
  const pOpacity = look.panelOpacity;
  const pEdge = Math.min(1, pOpacity / 0.2);

  const all = folder?.children ?? [];
  const dragIds = drag?.ids ?? [];
  const children = all.filter((c) => !dragIds.includes(c));
  const target = drag?.target ?? null;
  const gap = target?.kind === "reorder" && target.folderId === folderId ? target.index : -1;
  const slots = children.length + (gap >= 0 ? 1 : 0);
  const stable = Math.max(all.length, slots, 1);

  const cols =
    style === "ios"
      ? settings.folders.panelColumns
      : Math.min(settings.folders.panelColumns, Math.max(3, Math.ceil(Math.sqrt(stable))));
  const cellW = settings.grid.cellWidth + 6;
  const cellH = settings.grid.cellHeight + 4;
  const rows = Math.max(1, Math.ceil(stable / cols));
  const headerH = style === "android" ? 46 : 0;
  const contentH = rows * cellH + PAD_Y * 2;
  const maxH = g.workHeight * (style === "ios" ? 0.6 : 0.55);
  const cardW = cols * cellW + PAD_X * 2;
  const cardH = Math.min(contentH, maxH) + headerH;

  // ------------------------------------------------ placement (window coords)
  const monLeft = g.left + g.workLeft;
  const monTop = g.top + g.workTop;
  let left: number;
  let top: number;
  const o = panel.origin;
  if (style === "android" && o) {
    left = o.x + o.w / 2 - cardW / 2;
    top = o.y + o.h + 10;
    if (top + cardH > monTop + g.workHeight - 12) top = o.y - cardH - 10;
  } else {
    left = monLeft + (g.workWidth - cardW) / 2;
    top = monTop + (g.workHeight - cardH) / 2 + (style === "ios" ? 24 : 0);
  }
  left = Math.max(monLeft + 12, Math.min(left, monLeft + g.workWidth - cardW - 12));
  top = Math.max(monTop + (style === "ios" ? 96 : 12), Math.min(top, monTop + g.workHeight - cardH - 12));

  const cardRadius = style === "ios" ? 38 : 26;
  const tileRect = rectOf(panel.stack[0]) ?? (o ? { left: o.x, top: o.y, width: o.w, height: o.h } : null);
  const collapsed = tileRect
    ? {
        opacity: 0,
        scale: tileRect.width / cardW,
        x: tileRect.left + tileRect.width / 2 - (left + cardW / 2),
        y: tileRect.top + tileRect.height / 2 - (top + cardH / 2),
        borderRadius: (settings.folders.radius * tileRect.width) / (tileRect.width / cardW),
      }
    : { opacity: 0, scale: 0.85, x: 0, y: 0, borderRadius: cardRadius };

  const openSpring = spring(settings, 0.5, 0.16);
  const closeSpring = spring(settings, 0.38, 0.05);

  return (
    <motion.div className="panel-overlay" style={{ zIndex: 30 }}>
      <motion.div
        className="panel-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={tween(settings, 0.25)}
        style={{
          background: style === "ios" ? "rgba(0,0,0,0.26)" : "rgba(0,0,0,0.12)",
          backdropFilter: style === "ios" ? "blur(26px) saturate(1.3)" : undefined,
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
          if (Date.now() - panel.openedAt > 350) closePanel();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      />

      {style === "ios" && (
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={tween(settings, 0.26)}
        >
          {panel.stack.length > 1 && (
            <Crumbs stack={panel.stack} style={{ left: left - 80, width: cardW + 160, top: top - 104 }} />
          )}
          <div className="panel-title" style={{ left: left - 60, width: cardW + 120, top: top - 66 }}>
            <Title folderId={folderId} edit={panel.editTitle} />
            {!panel.editTitle && <EditButton folderId={folderId} />}
          </div>
        </motion.div>
      )}

      <motion.div
        className="panel-card"
        onPointerDown={(e) => {
          e.stopPropagation();
          useDesk.setState({ selection: new Set() });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        initial={collapsed}
        animate={{ opacity: 1, scale: 1, x: 0, y: 0, borderRadius: cardRadius, left, top, width: cardW, height: cardH }}
        exit={{ ...collapsed, transition: closeSpring }}
        transition={openSpring}
        style={{
          left,
          top,
          width: cardW,
          height: cardH,
          background: `rgba(var(--glass-rgb), ${pOpacity})`,
          borderColor: `rgba(255, 255, 255, ${0.16 * pEdge})`,
          boxShadow: pOpacity > 0.005 ? undefined : "none",
          backdropFilter: pOpacity > 0.005 ? undefined : "none",
        }}
        ref={(el) => {
          if (el) panelGrid.panelEl = el;
          else if (panelGrid.panelEl && !panelGrid.panelEl.isConnected) panelGrid.panelEl = null;
        }}
      >
        {style === "android" && (
          <div style={{ height: headerH }}>
            <div className="panel-inner-title">
              <Title folderId={folderId} edit={panel.editTitle} />
              {!panel.editTitle && <EditButton folderId={folderId} />}
            </div>
            {panel.stack.length > 1 && (
              <Crumbs stack={panel.stack} style={{ position: "absolute", right: 14, top: 12, left: "auto" }} compact />
            )}
          </div>
        )}
        <AnimatePresence initial={false} custom={panel.dir} mode="popLayout">
          <motion.div
            key={folderId}
            custom={panel.dir}
            variants={{
              enter: (d: number) => ({ x: d * cardW * 0.4, opacity: 0 }),
              center: { x: 0, opacity: 1 },
              exit: (d: number) => ({ x: -d * cardW * 0.4, opacity: 0 }),
            }}
            initial="enter"
            animate="center"
            exit="exit"
            transition={spring(settings, 0.4, 0.08)}
            style={{ position: "absolute", left: 0, right: 0, top: headerH, bottom: 0 }}
          >
            <div
              className="panel-scroll"
              style={{ overflowY: contentH > maxH + 1 ? "auto" : "hidden" }}
              ref={(el) => {
                if (el) {
                  panelGrid.el = el;
                  panelGrid.cols = cols;
                  panelGrid.cellW = cellW;
                  panelGrid.cellH = cellH;
                  panelGrid.padX = PAD_X;
                  panelGrid.padY = PAD_Y;
                  panelGrid.folderId = folderId;
                }
              }}
            >
              <PanelGeometrySync folderId={folderId} cols={cols} cellW={cellW} cellH={cellH} />
              <div style={{ position: "relative", height: contentH }}>
                {children.length === 0 && gap < 0 && <div className="panel-empty" style={{ whiteSpace: "pre-line" }}>{t.emptyFolder}</div>}
                {children.map((id, i) => {
                  const slot = gap >= 0 && i >= gap ? i + 1 : i;
                  const x = PAD_X + (slot % cols) * cellW;
                  const y = PAD_Y + Math.floor(slot / cols) * cellH;
                  return (
                    <Positioned key={id} id={id} x={x} y={y}>
                      <Tile id={id} cellW={cellW} cellH={cellH} where="panel" dropTarget={target} />
                    </Positioned>
                  );
                })}
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}

/** Keeps the shared hit-test geometry in sync when the panel re-renders without remounting. */
function PanelGeometrySync({ folderId, cols, cellW, cellH }: { folderId: string; cols: number; cellW: number; cellH: number }) {
  useLayoutEffect(() => {
    if (panelGrid.folderId === folderId) {
      panelGrid.cols = cols;
      panelGrid.cellW = cellW;
      panelGrid.cellH = cellH;
    }
  });
  return null;
}

function Crumbs({ stack, style, compact }: { stack: string[]; style: React.CSSProperties; compact?: boolean }) {
  const folders = useDesk((s) => s.layout.folders);
  const items = compact ? stack.slice(0, -1) : stack;
  return (
    <div className="crumbs" style={style} onPointerDown={(e) => e.stopPropagation()}>
      <button className="crumb" onClick={() => panelGoTo(-1)}>
        {t.home}
      </button>
      {items.map((id, i) => (
        <span key={id} style={{ display: "contents" }}>
          <span style={{ opacity: 0.7 }}>›</span>
          <button className="crumb" data-current={i === stack.length - 1} onClick={() => panelGoTo(i)}>
            {folders[id]?.name ?? ""}
          </button>
        </span>
      ))}
    </div>
  );
}

/** Small round button next to the title: opens the folder's own settings. */
function EditButton({ folderId }: { folderId: string }) {
  return (
    <button
      className="panel-edit"
      title={t.editFolder}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => useDesk.setState({ dialog: { kind: "customize", id: folderId } })}
    >
      <Icon name="sliders" size={15} />
    </button>
  );
}

function Title({ folderId, edit }: { folderId: string; edit: boolean }) {
  const name = useDesk((s) => s.layout.folders[folderId]?.name ?? "");
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    if (edit && ref.current) {
      done.current = false;
      ref.current.focus();
      ref.current.select();
    }
  }, [edit, folderId]);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const v = ref.current?.value.trim() ?? "";
    if (save && v && v !== name) commit(renameFolder(useDesk.getState().layout, folderId, v));
    const p = useDesk.getState().panel;
    if (p) useDesk.setState({ panel: { ...p, editTitle: false } });
  };
  if (edit) {
    return (
      <input
        ref={ref}
        defaultValue={name}
        spellCheck={false}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") finish(true);
          else if (e.key === "Escape") finish(false);
        }}
        onBlur={() => finish(true)}
      />
    );
  }
  return (
    <span
      style={{ cursor: "text", pointerEvents: "auto" }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => {
        const p = useDesk.getState().panel;
        if (p) useDesk.setState({ panel: { ...p, editTitle: true } });
      }}
    >
      {name}
    </span>
  );
}
