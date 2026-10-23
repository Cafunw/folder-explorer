import { animate, AnimatePresence, motion, useMotionValue } from "motion/react";
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { iconUrl, mediaUrl } from "../api";
import { ICON_TOP } from "../layout/grid";
import { isFolderId } from "../layout/model";
import { rgba, spring } from "../settings";
import { openId, showItemMenu, commitRename } from "./actions";
import { beginIconPointer, useBump, type DropTarget } from "./dnd";
import { iconEls, takeFlyFrom } from "./registry";
import { displayName, useDesk } from "./store";
import type { FolderLook } from "../types";

const STD = [16, 24, 32, 48, 64, 96, 128, 192, 256];
export function iconPx(cssSize: number) {
  const need = cssSize * (window.devicePixelRatio || 1);
  return STD.find((s) => s >= need) ?? 256;
}

/** Image for a real desktop item (or its custom icon). */
export function ItemImage({ id, size }: { id: string; size: number }) {
  const it = useDesk((s) => s.itemMap.get(id));
  const custom = useDesk((s) => s.layout.custom[id]?.icon);
  const bust = useDesk((s) => s.iconBust);
  // Some shell icons are "not ready yet" on the first request: retry a few times.
  const [attempt, setAttempt] = useState(0);
  if (!it && !custom) return null;
  const src = custom
    ? mediaUrl(custom)
    : iconUrl(it!.parsingName, iconPx(size), `${it!.iconVersion}-${it!.recycleFull ? 1 : 0}-${bust}-${attempt}`);
  if (attempt > 3 && !custom) return <div style={{ width: "70%", height: "70%", borderRadius: 8, background: "rgba(255,255,255,.25)" }} />;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      decoding="async"
      onError={() => window.setTimeout(() => setAttempt((a) => a + 1), 800 * (attempt + 1))}
    />
  );
}

/** A folder's look with its own overrides applied on top of the global settings. */
export function useFolderLook(folderId: string, override?: FolderLook) {
  const look = useDesk((s) => s.layout.folders[folderId]?.look);
  const s = useDesk((st) => st.settings);
  const l = override ?? look ?? {};
  return {
    opacity: l.opacity ?? s.transparency.folderTile,
    blur: l.blur ?? s.transparency.folderTileBlur,
    radius: l.radius ?? s.folders.radius,
    preview: l.preview ?? s.folders.preview,
    icon: l.icon,
    panelStyle: l.panelStyle ?? s.folders.style,
    panelOpacity: l.panelOpacity ?? s.transparency.panel,
  };
}

/** Phone-style folder preview (iOS 3×3 / Android 2×2), or the folder's own image. */
export const FolderGlyph = memo(function FolderGlyph({
  folderId,
  size,
  lookOverride,
  colorOverride,
}: {
  folderId: string;
  size: number;
  lookOverride?: FolderLook;
  colorOverride?: string | null;
}) {
  const folder = useDesk((s) => s.layout.folders[folderId]);
  const defaultColor = useDesk((s) => s.settings.folders.defaultColor);
  const look = useFolderLook(folderId, lookOverride);
  if (!folder) return null;
  const n = look.preview;
  const pad = size * (n === 3 ? 0.12 : 0.16);
  const gap = size * (n === 3 ? 0.055 : 0.08);
  const kids = folder.children.slice(0, n * n);
  const mini = (size - pad * 2 - gap * (n - 1)) / n;
  const color = (colorOverride !== undefined ? colorOverride : folder.color) ?? defaultColor;
  // At 0 % the tile disappears completely: no fill, border, shadow or blur.
  const o = look.opacity;
  const visible = o > 0.005;
  const edge = Math.min(1, o / 0.25);
  const radius = size * look.radius;

  if (look.icon) {
    return (
      <div className="folder-tile" style={{ borderRadius: radius, padding: 0, background: "none", border: "none", boxShadow: "none", backdropFilter: "none" }}>
        <img src={mediaUrl(look.icon)} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: radius }} />
      </div>
    );
  }
  return (
    <div
      className="folder-tile"
      style={{
        borderRadius: radius,
        padding: pad,
        gap,
        gridTemplateColumns: `repeat(${n}, ${mini}px)`,
        gridTemplateRows: `repeat(${n}, ${mini}px)`,
        background: color ? rgba(color, Math.min(1, o * 1.5)) : `rgba(255, 255, 255, ${o})`,
        border: `1px solid rgba(255, 255, 255, ${0.22 * edge})`,
        boxShadow: visible ? `inset 0 1px 0 rgba(255,255,255,${0.25 * edge}), 0 3px 10px rgba(0,0,0,${0.22 * edge})` : "none",
        backdropFilter: visible && look.blur > 0 ? `blur(${look.blur}px) saturate(1.6)` : "none",
      }}
    >
      {kids.map((k) => (
        <div className="mini" key={k} style={{ width: mini, height: mini }}>
          {isFolderId(k) ? <div className="mini-folder" /> : <ItemImage id={k} size={mini} />}
        </div>
      ))}
    </div>
  );
});

type TileProps = {
  id: string;
  cellW: number;
  cellH: number;
  where: "desktop" | "panel";
  hidden?: boolean;
  dropTarget?: DropTarget;
};

/** One icon cell: image (or folder glyph) + label, selection and drop feedback. */
export const Tile = memo(function Tile({ id, cellW, cellH, where, hidden, dropTarget }: TileProps) {
  const selected = useDesk((s) => s.selection.has(id));
  const renaming = useDesk((s) => s.rename?.id === id);
  const settings = useDesk((s) => s.settings);
  // displayName reads the latest state; zustand re-renders when the returned string changes
  const name = useDesk(() => displayName(id));
  const bump = useBump((b) => (b.id === id ? b.n : 0));
  const size = settings.grid.iconSize;
  const isFolder = isFolderId(id);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    iconEls.set(id, el);
    return () => {
      if (iconEls.get(id) === el) iconEls.delete(id);
    };
  }, [id]);

  const merge = dropTarget?.kind === "merge" && dropTarget.id === id;
  const into = dropTarget?.kind === "into" && dropTarget.folderId === id;
  const real = dropTarget?.kind === "real" && dropTarget.id === id;
  const recycle = dropTarget?.kind === "recycle" && dropTarget.id === id;

  return (
    <div
      ref={ref}
      className="tile"
      data-hit="tile"
      data-selected={selected}
      style={{ width: cellW, height: cellH, opacity: hidden ? 0 : 1 }}
      onPointerDown={(e) => {
        e.stopPropagation();
        beginIconPointer(e, id, where === "panel");
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!isFolder) openId(id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        showItemMenu(id);
      }}
    >
      <div className="tile-bg" />
      <motion.div
        className="tile-icon"
        style={{ width: size, height: size, marginTop: ICON_TOP }}
        animate={{ scale: merge ? 1.14 : into || real || recycle ? 1.12 : 1 }}
        transition={spring(settings, 0.35, 0.35)}
      >
        <AnimatePresence>
          {merge && (
            <motion.div
              className="merge-plate"
              style={{ borderRadius: size * 1.32 * settings.folders.radius }}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              transition={spring(settings, 0.3, 0.3)}
            />
          )}
        </AnimatePresence>
        {(into || real || recycle) && <div className={recycle ? "drop-ring danger" : "drop-ring"} />}
        <BumpWrap n={bump} enabled={!settings.animation.reduceMotion}>
          {isFolder ? <FolderGlyph folderId={id} size={size} /> : <ItemImage id={id} size={size} />}
        </BumpWrap>
      </motion.div>
      {renaming ? (
        <RenameBox id={id} initial={name} />
      ) : (
        settings.grid.labels && (
          <div className="tile-label" style={{ WebkitLineClamp: settings.grid.labelLines }}>
            {name}
          </div>
        )
      )}
    </div>
  );
});

function BumpWrap({ n, enabled, children }: { n: number; enabled: boolean; children: ReactNode }) {
  return (
    <motion.div
      key={enabled ? n : 0}
      style={{ width: "100%", height: "100%", display: "grid", placeItems: "center" }}
      initial={n && enabled ? { scale: 1.18 } : false}
      animate={{ scale: 1 }}
      transition={{ type: "spring", duration: 0.45, bounce: 0.5 }}
    >
      {children}
    </motion.div>
  );
}

function RenameBox({ id, initial }: { id: string; initial: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // select the name without its extension
    const dot = isFolderId(id) ? -1 : initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [id, initial]);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) commitRename(id, ref.current?.value ?? initial);
    else useDesk.setState({ rename: null });
  };
  return (
    <textarea
      ref={ref}
      className="rename-box"
      defaultValue={initial}
      spellCheck={false}
      rows={1}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onInput={(e) => {
        const el = e.currentTarget;
        el.style.height = "0px";
        el.style.height = `${el.scrollHeight}px`;
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

/**
 * Absolutely positioned wrapper that springs to (x, y) and, when the item was just dropped,
 * flies in from the drop point.
 */
export function Positioned({ id, x, y, z, children }: { id: string; x: number; y: number; z?: number; children: ReactNode }) {
  const settings = useDesk((s) => s.settings);
  const mx = useMotionValue(x);
  const my = useMotionValue(y);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const fly = takeFlyFrom(id);
    const parent = ref.current?.parentElement;
    if (fly && parent) {
      const pr = parent.getBoundingClientRect();
      mx.jump(fly.x - pr.left);
      my.jump(fly.y - pr.top);
    }
    const tr = spring(settings, 0.45, 0.16);
    const a = animate(mx, x, tr);
    const b = animate(my, y, tr);
    return () => {
      a.stop();
      b.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y]);
  return (
    <motion.div ref={ref} className="positioned" style={{ x: mx, y: my, zIndex: z }}>
      {children}
    </motion.div>
  );
}
