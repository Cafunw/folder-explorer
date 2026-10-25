// What groups of the other kinds show: the tile glyph parts (kind badges, live / frequent previews,
// the lock) and the read-only tiles of frequent and live groups, shared by the panel and the stack.

import { FolderSync, Hourglass, Layers, Lock, LockOpen, PanelTop, Sparkles, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, iconUrl } from "../api";
import { t } from "../i18n";
import { ICON_TOP } from "../layout/grid";
import { frequentItems, staleItems, DEFAULT_FREQUENT_LIMIT } from "../layout/smart";
import type { DesktopItem, VirtualFolder } from "../types";
import { closePanel, openId, showItemMenu } from "./actions";
import { beginIconPointer } from "./dnd";
import { hoverHandlers } from "./effects";
import { jiggling } from "./Jiggle";
import { liveItem, reloadLive, useLive, useLiveItems } from "./live";
import { useUnlocked } from "./locks";
import { iconEls } from "./registry";
import { dirName, nameIn, recordFileOpOnly, toast, undoEntry, useDesk } from "./store";
import { iconPx, ItemImage } from "./Tile";
import "./groups.css";

const DAY = 24 * 3600 * 1000;

// ---------------------------------------------------------------- what a group shows

/** One thing a group view shows: its own child, a desktop item it only refers to, or a live entry. */
export type Entry = { kind: "child"; id: string } | { kind: "ref"; id: string } | { kind: "live"; item: DesktopItem };

export const entryId = (e: Entry) => (e.kind === "live" ? e.item.id : e.id);

/** The ids a frequent group lists now. */
export function useFrequentIds(folder: VirtualFolder | undefined, limit?: number): string[] {
  const usage = useDesk((s) => s.layout.usage);
  const folders = useDesk((s) => s.layout.folders);
  const itemMap = useDesk((s) => s.itemMap);
  const on = folder?.kind === "frequent";
  const n = limit ?? folder?.limit ?? DEFAULT_FREQUENT_LIMIT;
  return useMemo(
    () => (on ? frequentItems(useDesk.getState().layout, itemMap, n) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [on, usage, folders, itemMap, n],
  );
}

/** The image of a live entry (a real file, not a desktop item). */
export function LiveImage({ item, size }: { item: DesktopItem; size: number }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <div className="live-fallback" />;
  return (
    <img
      src={iconUrl(item.parsingName, iconPx(size), item.iconVersion)}
      alt=""
      draggable={false}
      decoding="async"
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

// ---------------------------------------------------------------- tile glyph parts

/** The mini previews of a live / frequent group's tile (grid cells of `.folder-tile`). */
export function KindMinis({ folder, count, mini }: { folder: VirtualFolder; count: number; mini: number }) {
  const live = useLiveItems(folder.kind === "live" ? folder.source : null);
  const freq = useFrequentIds(folder, count);
  if (folder.kind === "live") {
    return (
      <>
        {(live ?? []).slice(0, count).map((it) => (
          <div className="mini" key={it.id} style={{ width: mini, height: mini }}>
            <LiveImage item={it} size={mini} />
          </div>
        ))}
      </>
    );
  }
  return (
    <>
      {freq.map((id) => (
        <div className="mini" key={id} style={{ width: mini, height: mini }}>
          <ItemImage id={id} size={mini} />
        </div>
      ))}
    </>
  );
}

/** Kinds whose tile shows something else than its children. */
export const showsOwnMinis = (f: VirtualFolder) => f.kind === "live" || f.kind === "frequent";

/** A locked group's tile: a lock instead of the preview (no child icon or name leaks). */
export function LockMark({ folderId, size }: { folderId: string; size: number }) {
  const open = useUnlocked((u) => u.ids.has(folderId));
  const Icon = open ? LockOpen : Lock;
  return (
    <div className="lock-mark" style={{ gridColumn: "1 / -1", gridRow: "1 / -1" }}>
      <Icon size={Math.max(12, size * 0.4)} strokeWidth={2.2} />
    </div>
  );
}

/** Temp group: how many children are past their days, refreshed when the next one expires. */
function useStaleCount(folder: VirtualFolder): number {
  const [now, setNow] = useState(() => Date.now());
  const stale = folder.kind === "temp" ? staleItems(folder, now).length : 0;
  useEffect(() => {
    if (folder.kind !== "temp" || !folder.added) return;
    const ms = (folder.tempDays ?? 7) * DAY;
    const next = Math.min(...Object.values(folder.added).map((at) => at + ms).filter((at) => at > Date.now()));
    if (!Number.isFinite(next)) return;
    // setTimeout overflows past ~24.8 days
    const tm = window.setTimeout(() => setNow(Date.now()), Math.min(next - Date.now() + 1000, 2 ** 31 - 1));
    return () => window.clearTimeout(tm);
  }, [folder, now]);
  return stale;
}

/** Small corner marks of a group tile: its kind (top right), stack / tabs (bottom left), stale count. */
export function GlyphBadges({ folder, size, radius }: { folder: VirtualFolder; size: number; radius: number }) {
  const stale = useStaleCount(folder);
  const b = Math.max(11, Math.round(size * 0.27));
  const inset = Math.max(1, radius * 0.3 - b * 0.22);
  const icon = Math.round(b * 0.62);
  const kind =
    folder.kind === "smart" ? <Sparkles size={icon} strokeWidth={2.4} />
    : folder.kind === "live" ? <FolderSync size={icon} strokeWidth={2.4} />
    : folder.kind === "frequent" ? <Star size={icon} strokeWidth={2.4} />
    : folder.kind === "temp" ? <Hourglass size={icon} strokeWidth={2.4} />
    : null;
  const display =
    folder.display === "stack" ? <Layers size={icon} strokeWidth={2.4} />
    : folder.display === "tabs" ? <PanelTop size={icon} strokeWidth={2.4} />
    : null;
  const box = (pos: CSSProperties, child: ReactNode, cls = "glyph-badge") => (
    <span className={cls} style={{ width: b, height: b, ...pos }}>
      {child}
    </span>
  );
  return (
    <>
      {kind && box({ top: inset, right: inset }, kind)}
      {display && box({ bottom: inset, left: inset }, display)}
      {stale > 0 && !folder.lock && (
        <span className="glyph-count" style={{ top: inset, left: inset, minWidth: b, height: b, fontSize: Math.max(8, b * 0.6) }}>
          {stale}
        </span>
      )}
    </>
  );
}

// ---------------------------------------------------------------- read-only and live tiles

/** Pointer press that reports a drag (moved ≥ 6 px with the button down) once. */
function trackPress(e: React.PointerEvent, onDrag: () => void) {
  const x0 = e.clientX;
  const y0 = e.clientY;
  const id = e.pointerId;
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id || Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
    done();
    onDrag();
  };
  const done = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", done, true);
    window.removeEventListener("pointercancel", done, true);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", done, true);
  window.addEventListener("pointercancel", done, true);
}

/** Native drag of a live entry: other apps, Explorer, or our desktop (where it is moved to). */
function dragLiveOut(item: DesktopItem) {
  closePanel();
  api
    .startDragOut([item.path])
    .then((effect) => {
      if (effect === "move") reloadLive(dirName(item.path));
    })
    .catch((e) => console.error("drag out", e));
}

/** A live entry to the Recycle Bin, undoable like a desktop delete. */
async function recycleLive(item: DesktopItem) {
  try {
    await api.recycle([item.path]);
    const entry = recordFileOpOnly({ kind: "recycle", paths: [item.path] });
    toast(t.movedToRecycle(1), { label: t.undo, run: () => undoEntry(entry) });
    reloadLive(dirName(item.path));
  } catch (e) {
    console.warn("recycle", e);
    toast(t.operationFailed);
  }
}

/** Right-click on a live entry: Windows' own classic menu (it is not a desktop item). */
async function liveMenu(item: DesktopItem) {
  try {
    const chosen = await api.classicMenu([item.path], null);
    if (chosen === "delete") await recycleLive(item);
    else if (chosen === "rename") useLive.setState({ renaming: item.id });
  } catch (e) {
    console.warn("live menu", e);
    toast(t.operationFailed);
  }
}

export type EntryHandlers = {
  selected: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
};

/** Click / double-click / right-click / drag of one entry, the same in the panel and the stack. */
export function useEntryHandlers(entry: Entry): EntryHandlers {
  const id = entryId(entry);
  const deskSel = useDesk((s) => entry.kind !== "live" && s.selection.has(id));
  const liveSel = useLive((s) => entry.kind === "live" && s.sel === id);
  return {
    selected: deskSel || liveSel,
    onPointerDown: (e) => {
      e.stopPropagation();
      if (entry.kind === "child") {
        beginIconPointer(e, id, true);
        return;
      }
      if (e.button !== 0) return;
      if (entry.kind === "ref") {
        useDesk.setState({ selection: new Set([id]) });
        trackPress(e, () => toast(t.grp.frequentNoDrag, undefined, 3500));
      } else {
        useLive.setState({ sel: id });
        useDesk.setState({ selection: new Set() });
        trackPress(e, () => dragLiveOut(entry.item));
      }
    },
    onDoubleClick: (e) => {
      e.stopPropagation();
      if (!jiggling()) openId(id);
    },
    onContextMenu: (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (entry.kind === "live") {
        useLive.setState({ sel: id });
        void liveMenu(entry.item);
      } else showItemMenu(id);
    },
  };
}

/** A frequent / live entry in the panel grid, drawn like a desktop tile. */
export function EntryTile({ entry, cellW, cellH, size }: { entry: Entry; cellW: number; cellH: number; size: number }) {
  const h = useEntryHandlers(entry);
  const labels = useDesk((s) => s.settings.grid.labels);
  const labelLines = useDesk((s) => s.settings.grid.labelLines);
  const deskName = useDesk((s) => (entry.kind === "live" ? "" : nameIn(s, entry.id)));
  const renaming = useLive((s) => entry.kind === "live" && s.renaming === entry.item.id);
  const name = entry.kind === "live" ? entry.item.name : deskName;
  return (
    <div
      className="tile"
      data-hit="tile"
      data-selected={h.selected}
      style={{ width: cellW, height: cellH }}
      {...hoverHandlers}
      onPointerDown={h.onPointerDown}
      onDoubleClick={h.onDoubleClick}
      onContextMenu={h.onContextMenu}
    >
      <div className="tile-bg" />
      <div className="tile-icon" style={{ width: size, height: size, marginTop: ICON_TOP }}>
        {entry.kind === "live" ? <LiveImage item={entry.item} size={size} /> : <ItemImage id={entry.id} size={size} />}
      </div>
      {renaming && entry.kind === "live" ? (
        <LiveRename item={entry.item} />
      ) : (
        labels && (
          <div className="tile-label" style={{ WebkitLineClamp: labelLines }}>
            {name}
          </div>
        )
      )}
    </div>
  );
}

/** Renaming a live entry (the real file; undoable like a desktop rename). */
export function LiveRename({ item }: { item: DesktopItem }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = item.kind === "folder" ? -1 : item.name.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : item.name.length);
  }, [item]);
  const finish = async (save: boolean) => {
    if (done.current) return;
    done.current = true;
    useLive.setState({ renaming: null });
    const name = ref.current?.value.trim() ?? "";
    if (!save || !name || name === item.name) return;
    try {
      const to = await api.renameItem(item.path, name);
      recordFileOpOnly({ kind: "rename", from: item.path, to });
      reloadLive(dirName(item.path));
    } catch (e) {
      console.error(e);
      toast(t.renameFailed);
    }
  };
  return (
    <textarea
      ref={ref}
      className="rename-box"
      defaultValue={item.name}
      spellCheck={false}
      rows={1}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          void finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          void finish(false);
        }
      }}
      onBlur={() => void finish(true)}
    />
  );
}

/** Keyboard for the selected live entry while a live group is open: Enter, Space (Quick Look), F2, Delete. */
export function useLiveKeys(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const st = useDesk.getState();
      const { sel, renaming } = useLive.getState();
      const target = e.target as HTMLElement | null;
      if (!sel || renaming || st.dialog || st.rename || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      const item = liveItem(sel);
      if (!item) return;
      if (e.key === "Enter") openId(sel);
      else if (e.key === " " && st.settings.behavior.quickLook && !e.repeat) useDesk.setState({ dialog: { kind: "quicklook", id: sel } });
      else if (e.key === "F2") useLive.setState({ renaming: sel });
      else if (e.key === "Delete") void recycleLive(item);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}

/** Registers a child's element for the drag ghost / fly-in, like a Tile does. */
export function useIconEl(id: string, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    iconEls.set(id, el);
    return () => {
      if (iconEls.get(id) === el) iconEls.delete(id);
    };
  }, [id, enabled]);
  return ref;
}
