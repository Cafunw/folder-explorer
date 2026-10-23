import { MotionConfig } from "motion/react";
import { useEffect, useRef } from "react";
import { api, on } from "../api";
import { gridAt, orderedGrids } from "../layout/grid";
import { isFolderId, normalizeLayout, pageCount } from "../layout/model";
import { normalizeSettings } from "../settings";
import type { Layout } from "../types";
import {
  closePanel,
  deleteIds,
  openFolder,
  openId,
  panelBack,
  runMenuAction,
  redo,
  newEmptyFolder,
  onEmptyRightClick,
  startRename,
  toggleLock,
  undo,
} from "./actions";
import { startDiag } from "./diag";
import type { MenuAction } from "../menu/layout";
import { Dialogs } from "./Dialogs";
import { beginMarquee, emptyDrag, emptyPress, emptyRelease, isDragging } from "./dnd";
import { DragLayer } from "./DragLayer";
import { setupExternalDrop } from "./externalDrop";
import { FolderPanel } from "./FolderPanel";
import { MonitorSurface } from "./MonitorSurface";
import { useInputRegions } from "./passthrough";
import {
  applySettings,
  commit,
  initDesktop,
  refreshEnvironment,
  refreshItems,
  refreshWallpapers,
  setPage,
  useDesk,
} from "./store";
import { Toasts } from "./Toasts";
import { Wallpaper } from "./Wallpaper";

export function DesktopView() {
  const ready = useDesk((s) => s.ready);
  const grids = useDesk((s) => s.grids);
  const reduce = useDesk((s) => s.settings.animation.reduceMotion);

  useEffect(() => {
    let disposed = false;
    const unsubs: Array<() => void> = [];
    const keep = (p: Promise<() => void>) =>
      p.then((u) => (disposed ? u() : unsubs.push(u))).catch((e) => console.error(e));

    initDesktop().catch((e) => console.error("init", e));
    startDiag();
    keep(on<{ renames: { from: string; to: string }[] }>("desktop-changed", (p) => refreshItems(p?.renames ?? []).catch(console.error)));
    keep(on("environment-changed", () => refreshEnvironment().catch(console.error)));
    keep(on("wallpaper-changed", () => refreshWallpapers()));
    keep(on<{ settings: unknown }>("settings-changed", (p) => applySettings(normalizeSettings(p.settings))));
    keep(on<{ raised: boolean }>("desktop-raised", (p) => useDesk.setState({ raised: p.raised })));
    keep(
      on<{ folderId: string }>("open-virtual-folder", (p) => {
        if (useDesk.getState().layout.folders[p.folderId]) {
          useDesk.setState({ panel: null });
          requestAnimationFrame(() => openFolder(p.folderId));
        }
      }),
    );
    keep(
      on<{ action: MenuAction; ids: string[]; at?: [number, number] }>("menu-action", (p) =>
        runMenuAction(p.action, p.ids, p.at),
      ),
    );
    // Presses on the EMPTY desktop belong to Windows (the window lets them through); we only watch.
    type At = { x: number; y: number; ctrl: boolean };
    keep(on<At>("empty-press", (p) => emptyPress(p.x, p.y, p.ctrl)));
    keep(on<At>("empty-drag", (p) => emptyDrag(p.x, p.y)));
    keep(on<At>("empty-release", () => emptyRelease()));
    keep(on<At>("empty-rclick", (p) => onEmptyRightClick(p.x, p.y)));
    keep(
      on<{ action: string }>("tray-action", (p) => {
        if (p.action === "toggle-lock") toggleLock();
        else if (p.action === "new-group") {
          useDesk.setState({ panel: null });
          newEmptyFolder(null);
        } else if (p.action === "add-app") useDesk.setState({ dialog: { kind: "addApp", placement: null }, panel: null });
      }),
    );
    keep(
      on<{ layout: unknown }>("layout-replaced", (p) => {
        commit(normalizeLayout(p.layout) as Layout);
        refreshItems().catch(console.error);
      }),
    );
    keep(setupExternalDrop());

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => applySettings({ ...useDesk.getState().settings });
    mq.addEventListener("change", onScheme);

    return () => {
      disposed = true;
      unsubs.forEach((u) => u());
      mq.removeEventListener("change", onScheme);
    };
  }, []);

  useInputRegions();
  useKeyboard();
  const onWheel = useWheelPaging();

  return (
    <MotionConfig reducedMotion={reduce ? "always" : "never"}>
      <div
        className="desktop-root"
        onPointerDown={(e) => {
          if (e.button === 0) beginMarquee(e);
        }}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={onWheel}
      >
        {ready &&
          orderedGrids(grids).map((g) => (
            <Wallpaper key={`wp-${g.monitorId}`} g={g} span={spanOf(grids)} />
          ))}
        {ready && orderedGrids(grids).map((g) => <MonitorSurface key={g.monitorId} g={g} />)}
        <FolderPanel />
        <DragLayer />
        <Dialogs />
        <Toasts />
      </div>
    </MotionConfig>
  );
}

function spanOf(grids: ReturnType<typeof useDesk.getState>["grids"]) {
  const all = Object.values(grids);
  const left = Math.min(...all.map((g) => g.left));
  const top = Math.min(...all.map((g) => g.top));
  const right = Math.max(...all.map((g) => g.left + g.width));
  const bottom = Math.max(...all.map((g) => g.top + g.height));
  return { left, top, width: right - left, height: bottom - top };
}

const lastPointer = { x: 0, y: 0 };
window.addEventListener("pointermove", (e) => {
  lastPointer.x = e.clientX;
  lastPointer.y = e.clientY;
});

function monitorUnderPointer() {
  const { grids } = useDesk.getState();
  return gridAt(grids, lastPointer.x, lastPointer.y);
}

function useWheelPaging() {
  const acc = useRef(0);
  const lockUntil = useRef(0);
  return (e: React.WheelEvent) => {
    const st = useDesk.getState();
    if (st.panel || st.dialog || isDragging()) return;
    const g = gridAt(st.grids, e.clientX, e.clientY);
    if (!g) return;
    const now = performance.now();
    if (now < lockUntil.current) return;
    acc.current += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(acc.current) < 60) return;
    const dir = acc.current > 0 ? 1 : -1;
    acc.current = 0;
    const page = st.pages[g.monitorId] ?? 0;
    const next = page + dir;
    if (next >= 0 && next < pageCount(st.layout, g.monitorId)) {
      setPage(g.monitorId, next);
      lockUntil.current = now + 420;
    }
  };
}

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useDesk.getState();
      if (st.rename || st.dialog) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const sel = [...st.selection];

      if (e.key === "Escape") {
        if (st.panel) panelBack();
        else useDesk.setState({ selection: new Set() });
        return;
      }
      if (ctrl && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (ctrl && (e.key === "y" || e.key === "Y" || ((e.key === "z" || e.key === "Z") && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }
      if (ctrl && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        if (st.panel) {
          const f = st.panel.stack[st.panel.stack.length - 1];
          useDesk.setState({ selection: new Set(st.layout.folders[f]?.children ?? []) });
        } else {
          const ids = Object.entries(st.layout.placements)
            .filter(([, pl]) => pl.p === (st.pages[pl.m] ?? 0))
            .map(([id]) => id);
          useDesk.setState({ selection: new Set(ids) });
        }
        return;
      }
      if (e.key === "Delete") {
        if (sel.length) deleteIds(sel);
        return;
      }
      if (ctrl && e.shiftKey && (e.key === "n" || e.key === "N")) {
        // new group (Windows' own New menu stays untouched, so this lives here and in the tray menu)
        e.preventDefault();
        useDesk.setState({ panel: null });
        newEmptyFolder(null);
        return;
      }
      if (ctrl && (e.key === "e" || e.key === "E")) {
        // custom name / icon (items) or full settings (groups) for the selected icon
        if (sel.length === 1) {
          e.preventDefault();
          useDesk.setState({ dialog: { kind: "customize", id: sel[0] } });
        }
        return;
      }
      if (e.key === "F2") {
        if (sel.length === 1) startRename(sel[0]);
        return;
      }
      if (e.key === "F5") {
        e.preventDefault();
        refreshItems().catch(() => {});
        return;
      }
      if (e.key === "Enter") {
        if (sel.length === 1 && isFolderId(sel[0])) openFolder(sel[0]);
        else sel.filter((id) => !isFolderId(id)).forEach((id) => openId(id));
        return;
      }
      if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && !st.panel && sel.length === 0) {
        const g = monitorUnderPointer();
        if (!g) return;
        const page = st.pages[g.monitorId] ?? 0;
        const next = page + (e.key === "ArrowRight" ? 1 : -1);
        if (next >= 0 && next < pageCount(st.layout, g.monitorId)) setPage(g.monitorId, next);
        return;
      }
      if (
        st.settings.behavior.typeToSearch &&
        !ctrl &&
        !e.altKey &&
        e.key.length === 1 &&
        e.key.trim().length === 1
      ) {
        e.preventDefault();
        if (st.panel) closePanel();
        api.showSearch(e.key).catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
