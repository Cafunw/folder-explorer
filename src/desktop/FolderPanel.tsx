import { Archive, FolderOpen, Hourglass, Lock, Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { primaryGrid, type GridInfo } from "../layout/grid";
import { createFolderAt, holdsChildren, renameFolder } from "../layout/model";
import { activeTabOf, DEFAULT_TEMP_DAYS, setActiveTab, staleItems, tabsOf, type Tab } from "../layout/smart";
import { groupBoxStyle, spring, tween } from "../settings";
import { closePanel, panelGoTo } from "./actions";
import { useDrag } from "./dnd";
import { openStyleOf, panelMotion } from "./fx";
import { EntryTile, entryId, useFrequentIds, useLiveKeys, type Entry } from "./GroupContent";
import { archiveStale, bubbleCols, FAN_MAX } from "./kinds";
import { useLiveFailed, useLiveItems } from "./live";
import { requestUnlock, useContentHidden } from "./locks";
import { panelGrid, rectOf } from "./registry";
import { StackFan } from "./StackView";
import { commit, replaceLayout, toast, undoEntry, useDesk, type PanelState } from "./store";
import { Positioned, Tile, useFolderLook, useGroupBox } from "./Tile";
import { Icon } from "../ui/Icons";

export function FolderPanel() {
  const panel = useDesk((s) => s.panel);
  return <AnimatePresence>{panel && <PanelInner key="folder-panel" />}</AnimatePresence>;
}

const NO_IDS: string[] = [];
const PAD_X = 18;
const PAD_Y = 16;
const TABS_H = 40;
const NOTE_H = 36;

/** What the open group shows: its children, a tab's, a frequent group's picks or a live folder's entries. */
type Content = {
  entries: Entry[];
  /** the group a drop in the grid goes into (a tabs group's open tab may be a child group) */
  gridFolder: string;
  /** the shown ids when they are not exactly gridFolder's children ("Genel" tab) */
  items: string[] | null;
  tabs: Tab[] | null;
  activeTab: string | null;
  readOnly: boolean;
  /** a locked child group's tab: its content stays hidden until verified */
  hidden: string | null;
  stale: number;
  tempDays: number;
  liveSource: string | null;
  empty: string;
};

function usePanelContent(folderId: string): Content {
  const layout = useDesk((s) => s.layout);
  const folder = layout.folders[folderId];
  const tabsMode = !!folder && folder.display === "tabs" && holdsChildren(folder);
  const tabs = tabsMode ? tabsOf(layout, folderId) : null;
  const activeTab = tabsMode ? activeTabOf(layout, folderId) : null;
  const tab = tabs?.find((x) => x.id === activeTab) ?? null;
  const viewId = tab?.folderId ?? folderId;
  const view = layout.folders[viewId];
  const liveSource = view?.kind === "live" ? view.source ?? null : null;
  const liveItems = useLiveItems(liveSource);
  const liveFailed = useLiveFailed(liveSource);
  const freq = useFrequentIds(view);
  const lockedTab = useContentHidden(viewId) && viewId !== folderId;

  const base = {
    gridFolder: viewId,
    items: tab && !tab.folderId ? tab.items : null,
    tabs,
    activeTab,
    hidden: lockedTab ? viewId : null,
    stale: view?.kind === "temp" ? staleItems(view).length : 0,
    tempDays: view?.tempDays ?? DEFAULT_TEMP_DAYS,
    liveSource: null,
    readOnly: false,
    empty: tabsMode ? t.grp.tabEmpty : t.emptyFolder,
  };
  if (!view || lockedTab) return { ...base, entries: [] };
  if (view.kind === "frequent") {
    return { ...base, readOnly: true, entries: freq.map((id) => ({ kind: "ref", id })), empty: t.grp.frequentEmpty };
  }
  if (view.kind === "live") {
    return {
      ...base,
      readOnly: true,
      entries: (liveItems ?? []).map((item) => ({ kind: "live", item })),
      liveSource,
      empty: !liveSource ? t.grp.liveNoSource : liveFailed ? t.grp.liveMissing : liveItems ? t.grp.liveEmpty : t.loading,
    };
  }
  const ids = tab ? tab.items : view.children;
  return { ...base, entries: ids.map((id) => ({ kind: "child", id })) };
}

function PanelInner() {
  const live = useDesk((s) => s.panel);
  const last = useRef<PanelState | null>(live);
  if (live) last.current = live;
  const panel = last.current!;
  const grids = useDesk((s) => s.grids);
  const rootDisplay = useDesk((s) => s.layout.folders[panel.stack[0]]?.display);
  const folderId = panel.stack[panel.stack.length - 1];
  const content = usePanelContent(folderId);
  useLiveKeys(content.entries.some((e) => e.kind === "live"));

  const g = grids[panel.monitorId] ?? primaryGrid(grids);
  // a stack opens as a fan from its tile (a grid bubble when it holds more), a panel without one
  const stackMode = rootDisplay === "stack" && panel.stack.length === 1;
  const tileRect = stackMode ? rectOf(panel.stack[0]) : null;
  if (stackMode && tileRect && !content.hidden && content.entries.length > 0 && content.entries.length <= FAN_MAX) {
    return <StackFan panel={panel} entries={content.entries} rect={tileRect} g={g} />;
  }
  return <PanelCard panel={panel} folderId={folderId} content={content} g={g} bubble={stackMode && !!tileRect} />;
}

function PanelCard({
  panel,
  folderId,
  content,
  g,
  bubble,
}: {
  panel: PanelState;
  folderId: string;
  content: Content;
  g: GridInfo;
  /** a stack too big for a fan: a grid bubble anchored to its tile */
  bubble: boolean;
}) {
  const settings = useDesk((s) => s.settings);
  // the dragged ids and a reorder slot in this grid only: other target changes don't re-render the panel
  const dragIds = useDrag((d) => d.drag?.ids) ?? NO_IDS;
  const reorderAt = useDrag((d) => {
    const t = d.drag?.target;
    return t?.kind === "reorder" && t.folderId === content.gridFolder ? t.index : -1;
  });
  const quiet = useDesk((s) => s.quiet.game || s.quiet.battery);
  const ownOpenStyle = useDesk((s) => s.layout.folders[panel.stack[0]]?.look?.openStyle);

  // the top-level folder decides how the panel opens; the current one how see-through it is
  const rootLook = useFolderLook(panel.stack[0]);
  const look = useFolderLook(folderId);
  const box = useGroupBox(folderId);
  const style = bubble ? "android" : rootLook.panelStyle;
  const pOpacity = look.panelOpacity;
  const pEdge = Math.min(1, pOpacity / 0.2);

  const shown = content.entries.filter((e) => !(e.kind === "child" && dragIds.includes(e.id)));
  const gap = content.readOnly ? -1 : reorderAt;
  const slots = shown.length + (gap >= 0 ? 1 : 0);
  const stable = Math.max(content.entries.length, slots, 1);

  const cols = bubble
    ? bubbleCols(stable)
    : style === "ios"
      ? settings.folders.panelColumns
      : Math.min(settings.folders.panelColumns, Math.max(3, Math.ceil(Math.sqrt(stable))));
  const cellW = g.cellW + 6;
  const cellH = g.cellH + 4;
  const rows = Math.max(1, Math.ceil(stable / cols));
  const titleH = style === "android" ? 46 : 0;
  const tabsH = content.tabs ? TABS_H : 0;
  const noteH = content.stale > 0 || content.liveSource ? NOTE_H : 0;
  const headerH = titleH + tabsH + noteH;
  const contentH = rows * cellH + PAD_Y * 2;
  const maxH = g.workHeight * (style === "ios" ? 0.6 : 0.55);
  const cardW = Math.max(cols * cellW + PAD_X * 2, tabsH || noteH ? 360 : 0);
  const cardH = Math.min(contentH, maxH) + headerH;
  const padX = (cardW - cols * cellW) / 2;

  // ------------------------------------------------ placement (window coords)
  const monLeft = g.left + g.workLeft;
  const monTop = g.top + g.workTop;
  let left: number;
  let top: number;
  const o = panel.origin;
  // a group opened from a fence grows out of its own tile in the fence, not the fence's title
  const tile = rectOf(panel.from ?? panel.stack[0]);
  if (bubble && tile) {
    left = tile.left + tile.width / 2 - cardW / 2;
    top = tile.top - cardH - 12;
    // below the tile: under its label
    if (top < monTop + 12) top = tile.bottom + Math.max(12, g.cellH - g.iconSize);
  } else if (style === "android" && o) {
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
  const tileRect = tile ?? (o ? { left: o.x, top: o.y, width: o.w, height: o.h } : null);
  const from = tileRect
    ? {
        scale: tileRect.width / cardW,
        x: tileRect.left + tileRect.width / 2 - (left + cardW / 2),
        y: tileRect.top + tileRect.height / 2 - (top + cardH / 2),
        radius: (settings.folders.radius * tileRect.width) / (tileRect.width / cardW),
      }
    : null;
  // open style (zoom / spring / flip / blur / fade; the group's own first): closing mirrors it
  const open = panelMotion(openStyleOf(settings, { openStyle: ownOpenStyle }, quiet), settings, from, cardRadius);

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
        initial={open.hidden}
        animate={{ ...open.shown, left, top, width: cardW, height: cardH }}
        exit={{ ...open.exit, transition: open.close }}
        transition={open.open}
        style={{
          ...open.style,
          left,
          top,
          width: cardW,
          height: cardH,
          backgroundColor: `rgba(var(--glass-rgb), ${pOpacity})`,
          ...(box.border ? null : { borderColor: `rgba(255, 255, 255, ${0.16 * pEdge})` }),
          boxShadow: pOpacity > 0.005 ? undefined : "none",
          backdropFilter: pOpacity > 0.005 ? undefined : "none",
          ...groupBoxStyle(box, pOpacity > 0.005 ? "var(--shadow-lg)" : undefined),
        }}
        ref={(el) => {
          if (el) panelGrid.panelEl = el;
          else if (panelGrid.panelEl && !panelGrid.panelEl.isConnected) panelGrid.panelEl = null;
        }}
      >
        {style === "android" && (
          <div style={{ height: titleH }}>
            <div className="panel-inner-title">
              <Title folderId={folderId} edit={panel.editTitle} />
              {!panel.editTitle && <EditButton folderId={folderId} />}
            </div>
            {panel.stack.length > 1 && (
              <Crumbs stack={panel.stack} style={{ position: "absolute", right: 14, top: 12, left: "auto" }} compact />
            )}
          </div>
        )}
        {content.tabs && <TabBar ownerId={folderId} tabs={content.tabs} active={content.activeTab} />}
        {noteH > 0 &&
          (content.liveSource ? (
            <LiveNote source={content.liveSource} count={content.entries.length} />
          ) : (
            <TempNote folderId={content.gridFolder} stale={content.stale} days={content.tempDays} />
          ))}
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
                  owner = folderId;
                  panelGrid.el = el;
                  syncGrid(content, cols, cellW, cellH, g.iconSize, padX);
                }
              }}
            >
              <PanelGeometrySync folderId={folderId} content={content} cols={cols} cellW={cellW} cellH={cellH} iconSize={g.iconSize} padX={padX} />
              {content.hidden ? (
                <LockedContent folderId={content.hidden} />
              ) : (
                <div style={{ position: "relative", height: contentH }}>
                  {shown.length === 0 && gap < 0 && (
                    <div className="panel-empty" style={{ whiteSpace: "pre-line" }}>
                      {content.empty}
                    </div>
                  )}
                  {shown.map((e, i) => {
                    const slot = gap >= 0 && i >= gap ? i + 1 : i;
                    const x = padX + (slot % cols) * cellW;
                    const y = PAD_Y + Math.floor(slot / cols) * cellH;
                    const id = entryId(e);
                    return (
                      <Positioned key={id} id={id} x={x} y={y}>
                        {e.kind === "child" ? (
                          <Tile id={id} cellW={cellW} cellH={cellH} size={g.iconSize} where="panel" />
                        ) : (
                          <EntryTile entry={e} cellW={cellW} cellH={cellH} size={g.iconSize} />
                        )}
                      </Positioned>
                    );
                  })}
                </div>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}

/** The panel whose grid geometry dnd reads (an exiting panel must not overwrite it). */
let owner: string | null = null;

function syncGrid(content: Content, cols: number, cellW: number, cellH: number, iconSize: number, padX: number) {
  panelGrid.cols = cols;
  panelGrid.cellW = cellW;
  panelGrid.cellH = cellH;
  panelGrid.iconSize = iconSize;
  panelGrid.padX = padX;
  panelGrid.padY = PAD_Y;
  panelGrid.folderId = content.gridFolder;
  panelGrid.items = content.items;
  panelGrid.tabsOwner = content.tabs ? owner : null;
  panelGrid.shown = content.entries.map(entryId);
}

/** Keeps the shared hit-test geometry in sync when the panel re-renders without remounting. */
function PanelGeometrySync({
  folderId,
  content,
  cols,
  cellW,
  cellH,
  iconSize,
  padX,
}: {
  folderId: string;
  content: Content;
  cols: number;
  cellW: number;
  cellH: number;
  iconSize: number;
  padX: number;
}) {
  useLayoutEffect(() => {
    if (owner === folderId) syncGrid(content, cols, cellW, cellH, iconSize, padX);
  });
  return null;
}

// ---------------------------------------------------------------- tabs, notes

function TabBar({ ownerId, tabs, active }: { ownerId: string; tabs: Tab[]; active: string | null }) {
  const folders = useDesk((s) => s.layout.folders);
  const target = useDrag((d) => d.drag?.target ?? null);
  const [editing, setEditing] = useState<string | null>(null);
  const select = (id: string) => replaceLayout(setActiveTab(useDesk.getState().layout, ownerId, id));
  const add = () => {
    const { layout, grids } = useDesk.getState();
    const f = layout.folders[ownerId];
    if (!f) return;
    const r = createFolderAt(layout, grids, { folderId: ownerId, index: f.children.length }, t.grp.newTab, null);
    commit(setActiveTab(r.layout, ownerId, r.folderId));
    setEditing(r.folderId);
  };
  return (
    <div className="group-tabs" style={{ height: TABS_H }} onPointerDown={(e) => e.stopPropagation()}>
      {tabs.map((tab) => {
        const fid = tab.folderId ?? ownerId;
        const drop = target?.kind === "into" && target.folderId === fid;
        return (
          <button
            key={tab.id}
            className="group-tab"
            data-active={tab.id === active}
            data-drop={drop}
            ref={(el) => {
              if (el) panelGrid.tabs.set(tab.id, { el, folderId: fid });
              else panelGrid.tabs.delete(tab.id);
            }}
            onClick={() => select(tab.id)}
            onDoubleClick={() => tab.folderId && setEditing(tab.folderId)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (tab.folderId) useDesk.setState({ dialog: { kind: "customize", id: tab.folderId } });
            }}
          >
            {editing && editing === tab.folderId ? (
              <TabRename id={tab.folderId} onDone={() => setEditing(null)} />
            ) : tab.folderId ? (
              folders[tab.folderId]?.name ?? ""
            ) : (
              t.grp.tabGeneral
            )}
          </button>
        );
      })}
      <button className="group-tab-add" title={t.grp.newTab} aria-label={t.grp.newTab} onClick={add}>
        <Plus size={16} />
      </button>
    </div>
  );
}

function TabRename({ id, onDone }: { id: string; onDone: () => void }) {
  const name = useDesk((s) => s.layout.folders[id]?.name ?? "");
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const v = ref.current?.value.trim() ?? "";
    if (save && v && v !== name) commit(renameFolder(useDesk.getState().layout, id, v));
    onDone();
  };
  return (
    <input
      ref={ref}
      defaultValue={name}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

function TempNote({ folderId, stale, days }: { folderId: string; stale: number; days: number }) {
  const archive = () => {
    const { layout, grids, settings } = useDesk.getState();
    const r = archiveStale(layout, grids, folderId, t.grp.archiveName, settings.folders.defaultColor);
    if (!r.moved) return;
    const entry = commit(r.layout);
    toast(t.grp.archived(r.moved), { label: t.undo, run: () => undoEntry(entry) });
  };
  return (
    <div className="group-note" style={{ height: NOTE_H }} onPointerDown={(e) => e.stopPropagation()}>
      <Hourglass size={14} />
      <span>{t.grp.staleNotice(stale, days)}</span>
      <button onClick={archive}>
        <Archive size={13} />
        {t.grp.archiveAction}
      </button>
    </div>
  );
}

function LiveNote({ source, count }: { source: string; count: number }) {
  return (
    <div className="group-note" style={{ height: NOTE_H }} onPointerDown={(e) => e.stopPropagation()}>
      <FolderOpen size={14} />
      <span>
        <button className="path" title={source} onClick={() => api.openItem(source).catch(() => toast(t.operationFailed))}>
          {source}
        </button>
      </span>
      {count >= 500 && <small style={{ opacity: 0.7 }}>{t.grp.liveShowing(count)}</small>}
    </div>
  );
}

function LockedContent({ folderId }: { folderId: string }) {
  return (
    <div className="panel-locked">
      <Lock size={30} />
      <div>{t.ql.locked}</div>
      <button className="btn" onPointerDown={(e) => e.stopPropagation()} onClick={() => requestUnlock(folderId, () => {})}>
        {t.grp.open}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- title

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
