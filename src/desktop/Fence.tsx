import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import { t } from "../i18n";
import {
  FENCE_INSET,
  FENCE_TITLE,
  fenceContentHeight,
  fenceGeometry,
  fenceSlotXY,
  setCollapsed,
} from "../layout/blocks";
import { cellXY, type GridInfo } from "../layout/grid";
import { isHeadingId, spanOf } from "../layout/model";
import { DEFAULT_FREQUENT_LIMIT, frequentItems } from "../layout/smart";
import { groupBoxStyle, rgba } from "../settings";
import type { Placement, VirtualFolder } from "../types";
import { Icon } from "../ui/Icons";
import { commitRename, showItemMenu, startRename } from "./actions";
import { beginBlockPointer, useDrag, type DropTarget } from "./dnd";
import { Heading } from "./Heading";
import { JiggleBadge } from "./Jiggle";
import { requestUnlock, useContentHidden } from "./locks";
import { fenceBodies, iconEls } from "./registry";
import { commit, useDesk } from "./store";
import { Positioned, Tile, useFolderLook, useGroupBox } from "./Tile";
import "./fence.css";

/** A fence or a heading at its cells; while it is resized, at its new size. */
export function Block({ id, pl, g }: { id: string; pl: Placement; g: GridInfo }) {
  const preview = useDrag((d) => (d.block?.id === id ? d.block : null));
  const at = preview?.mode === "resize" ? preview.to : pl;
  const { x, y } = cellXY(g, at.c, at.r);
  const moving = preview?.mode === "move";
  return (
    <Positioned id={id} x={x} y={y}>
      {isHeadingId(id) ? (
        <Heading id={id} g={g} pl={at} moving={moving} />
      ) : (
        <Fence id={id} g={g} pl={at} moving={moving} />
      )}
    </Positioned>
  );
}

/** Where a moved fence / heading will land on this page (shown while it is dragged). */
export function BlockOutline({ g, page }: { g: GridInfo; page: number }) {
  const b = useDrag((d) => d.block);
  if (!b || b.mode !== "move" || b.to.m !== g.monitorId || b.to.p !== page) return null;
  const { x, y } = cellXY(g, b.to.c, b.to.r);
  const { w, h } = spanOf(b.to);
  return (
    <div
      className="block-outline"
      style={{ left: x + FENCE_INSET - 1, top: y + FENCE_INSET - 1, width: w * g.cellW - FENCE_INSET * 2 + 2, height: h * g.cellH - FENCE_INSET * 2 + 2 }}
    />
  );
}

/**
 * The box of a fence: a dark glass (the group's colour when it has one) at the group tile's
 * opacity / blur / roundness, plus the group-box effects (border, shadow, gradient, glow).
 */
function useBoxStyle(id: string, iconSize: number): CSSProperties {
  const look = useFolderLook(id);
  const box = useGroupBox(id);
  const color = useDesk((s) => s.layout.folders[id]?.color ?? s.settings.folders.defaultColor);
  const o = look.opacity;
  const visible = o > 0.005;
  return {
    borderRadius: Math.min(18, Math.max(4, look.radius * iconSize * 0.6)),
    backgroundColor: color ? rgba(color, o) : `rgba(18, 18, 22, ${o})`,
    border: `1px solid rgba(255, 255, 255, ${visible ? 0.14 : 0.08})`,
    backdropFilter: visible && look.blur > 0 ? `blur(${look.blur}px) saturate(1.4)` : "none",
    ...groupBoxStyle(box),
  };
}

/** What a fence shows: its children; a frequent group its most opened items. */
function useFenceItems(folder: VirtualFolder | undefined) {
  const frequentFrom = useDesk((s) => (folder?.kind === "frequent" ? s.layout : null));
  const itemMap = useDesk((s) => s.itemMap);
  return useMemo(() => {
    if (!folder) return [];
    if (frequentFrom) return frequentItems(frequentFrom, itemMap, folder.limit ?? DEFAULT_FREQUENT_LIMIT);
    return folder.children;
  }, [folder, frequentFrom, itemMap]);
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/**
 * A group shown as an always-open box over its cells: the title bar moves it (drag), renames it
 * (double-click) and opens its menu (right-click) or settings (the edit button); the body is a scrolling
 * grid of its children; the corner handle resizes it in whole cells.
 */
/** What the current drag (or a drop from another app) points at. */
const dropTargetOf = (d: ReturnType<typeof useDrag.getState>): DropTarget => d.drag?.target ?? d.external;

function Fence({ id, g, pl, moving }: { id: string; g: GridInfo; pl: Placement; moving: boolean }) {
  const folder = useDesk((s) => s.layout.folders[id]);
  const selected = useDesk((s) => s.selection.has(id));
  const renaming = useDesk((s) => s.rename?.id === id);
  const lockLayout = useDesk((s) => s.settings.behavior.lockLayout);
  const dragIds = useDrag((d) => d.drag?.ids);
  const gap = useDrag((d) => {
    const t = dropTargetOf(d);
    return t?.kind === "reorder" && t.folderId === id ? t.index : -1;
  });
  const into = useDrag((d) => {
    const t = dropTargetOf(d);
    return t?.kind === "into" && t.folderId === id;
  });
  const busy = useDrag((d) => !!d.drag || !!d.block);
  const items = useFenceItems(folder);
  const box = useBoxStyle(id, g.iconSize);
  const hidden = useContentHidden(id);
  const titleRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    iconEls.set(id, el);
    return () => {
      if (iconEls.get(id) === el) iconEls.delete(id);
    };
  }, [id]);

  if (!folder) return null;
  const collapsed = !!folder.collapsed;
  const geo = fenceGeometry(g, pl, collapsed);
  const children = dragIds ? items.filter((c) => !dragIds.includes(c)) : items;
  const slots = children.length + (gap >= 0 ? 1 : 0);
  const contentH = fenceContentHeight(geo, Math.max(slots, 1));
  const editable = !lockLayout;
  const customize = () => useDesk.setState({ selection: new Set([id]), dialog: { kind: "customize", id } });

  return (
    <>
      {collapsed && busy && (
        <div className="fence-reserve" style={{ left: FENCE_INSET, top: FENCE_INSET, width: geo.w, height: spanOf(pl).h * g.cellH - FENCE_INSET * 2 }} />
      )}
      <div
        className="fence"
        data-hit=""
        data-selected={selected}
        data-drop={into || gap >= 0}
        data-moving={moving}
        data-collapsed={collapsed}
        style={{ ...box, left: FENCE_INSET, top: FENCE_INSET, width: geo.w, height: geo.h }}
        onDoubleClick={stop}
      >
        <div
          ref={titleRef}
          className="fence-title"
          style={{ height: FENCE_TITLE }}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (!renaming) beginBlockPointer(e, id, "move");
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (!renaming) startRename(id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void showItemMenu(id);
          }}
        >
          <button
            className="fence-btn fence-fold"
            data-collapsed={collapsed}
            title={collapsed ? t.fence.expand : t.fence.collapse}
            aria-label={collapsed ? t.fence.expand : t.fence.collapse}
            aria-expanded={!collapsed}
            onPointerDown={stop}
            onClick={() => commit(setCollapsed(useDesk.getState().layout, id, !collapsed))}
          >
            <Icon name="chevron" size={14} />
          </button>
          {renaming ? <TitleEditor id={id} name={folder.name} /> : <span className="fence-name">{folder.name}</span>}
          {collapsed && !hidden && items.length > 0 && <span className="fence-count">{items.length}</span>}
          <button className="fence-btn fence-edit" title={t.fence.edit} aria-label={t.fence.edit} onPointerDown={stop} onClick={customize}>
            <Icon name="sliders" size={13} />
          </button>
        </div>
        {!collapsed && (
          <div
            ref={(el) => {
              bodyRef.current = el;
              if (el) fenceBodies.set(id, el);
              else if (fenceBodies.get(id) && !fenceBodies.get(id)!.isConnected) fenceBodies.delete(id);
            }}
            className="fence-body"
            style={{ top: FENCE_TITLE, overflowY: contentH > geo.bodyH + 1 ? "auto" : "hidden" }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              if (!(e.ctrlKey || e.metaKey)) useDesk.setState({ selection: new Set(), rename: null });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void showItemMenu(id);
            }}
            onWheel={(e) => {
              const el = bodyRef.current;
              if (el && el.scrollHeight > el.clientHeight + 1) e.stopPropagation();
            }}
          >
            {hidden ? (
              <button className="fence-locked" onPointerDown={stop} onClick={() => requestUnlock(id, () => {})}>
                <Icon name="lock" size={18} />
                <span>{t.fence.locked}</span>
              </button>
            ) : (
              <div style={{ position: "relative", height: contentH }}>
                {children.length === 0 && gap < 0 && <div className="fence-empty">{t.fence.empty}</div>}
                {children.map((cid, i) => {
                  const p = fenceSlotXY(geo, gap >= 0 && i >= gap ? i + 1 : i);
                  return (
                    <Positioned key={cid} id={cid} x={p.x} y={p.y}>
                      <Tile id={cid} cellW={geo.cellW} cellH={geo.cellH} size={g.iconSize} where="desktop" />
                    </Positioned>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {editable && !collapsed && (
          <div
            className="fence-resize"
            title={t.fence.resize}
            onPointerDown={(e) => {
              e.stopPropagation();
              beginBlockPointer(e, id, "resize");
            }}
          />
        )}
      </div>
      {/* outside the box (it clips): icon edit mode's dissolve badge */}
      <JiggleBadge id={id} style={{ left: FENCE_INSET - 8, top: FENCE_INSET - 8 }} />
    </>
  );
}

function TitleEditor({ id, name }: { id: string; name: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) void commitRename(id, ref.current?.value ?? name);
    else useDesk.setState({ rename: null });
  };
  return (
    <input
      ref={ref}
      className="fence-input"
      defaultValue={name}
      spellCheck={false}
      onPointerDown={stop}
      onDoubleClick={stop}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}
