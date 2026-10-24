import { animate, AnimatePresence, motion, useMotionValue } from "motion/react";
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { iconUrl, mediaUrl } from "../api";
import { t } from "../i18n";
import { ICON_TOP } from "../layout/grid";
import { isFolderId } from "../layout/model";
import { groupBoxParts, groupTileStyle, resolveGroupBox, resolveTheme, spring, type GroupBoxParts } from "../settings";
import { openId, showItemMenu, commitRename } from "./actions";
import { useShallow } from "zustand/react/shallow";
import { beginIconPointer, useBump, useDrag, type DropTarget } from "./dnd";
import { GlyphBadges, KindMinis, LockMark, showsOwnMinis } from "./GroupContent";
import { iconEls, takeFlyFrom } from "./registry";
import { nameIn, useAnimation, useDesk, useReducedMotion } from "./store";
import { usePackIcon } from "./iconPack";
import { hoverHandlers } from "./effects";
import { jigglePhase } from "./fx";
import { armLongPress, jiggling, JiggleBadge, useJiggle } from "./Jiggle";
import type { FolderLook } from "../types";

const darkScheme = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

/**
 * The drop feedback tile `id` shows: the kind of the current drop target when it points at this
 * tile. A string, so a drag only re-renders the tiles whose feedback changes.
 */
function dropOn(target: DropTarget, id: string): string | null {
  if (!target || target.kind === "cell" || target.kind === "reorder") return null;
  const at = "id" in target ? target.id : "folderId" in target ? target.folderId : null;
  return at === id ? target.kind : null;
}

const STD = [16, 24, 32, 48, 64, 96, 128, 192, 256];
export function iconPx(cssSize: number) {
  const need = cssSize * (window.devicePixelRatio || 1);
  return STD.find((s) => s >= need) ?? 256;
}

/**
 * Image for a real desktop item: its custom icon > the icon pack's > the shell icon. `plate` = drawn
 * on the icon plate (`.item-plate`, styled by `:root[data-plate]` from settings.icons).
 */
export function ItemImage({ id, size, plate }: { id: string; size: number; plate?: boolean }) {
  const it = useDesk((s) => s.itemMap.get(id));
  const custom = useDesk((s) => s.layout.custom[id]?.icon);
  const bust = useDesk((s) => s.iconBust);
  const packIcon = usePackIcon(custom ? undefined : it);
  // Some shell icons are "not ready yet" on the first request: retry a few times.
  const [attempt, setAttempt] = useState(0);
  const [brokenPack, setBrokenPack] = useState<string | null>(null);
  if (!it && !custom) return null;
  const pack = !custom && packIcon && packIcon !== brokenPack ? packIcon : null;
  const src = custom
    ? mediaUrl(custom)
    : pack
      ? mediaUrl(pack)
      : iconUrl(it!.parsingName, iconPx(size), `${it!.iconVersion}-${it!.recycleFull ? 1 : 0}-${bust}-${attempt}`);
  const img =
    attempt > 3 && !custom && !pack ? (
      <div style={{ width: "70%", height: "70%", borderRadius: 8, background: "rgba(255,255,255,.25)" }} />
    ) : (
      <img
        src={src}
        alt=""
        draggable={false}
        decoding="async"
        onError={() => (pack ? setBrokenPack(pack) : window.setTimeout(() => setAttempt((a) => a + 1), 800 * (attempt + 1)))}
      />
    );
  return plate ? <div className="item-plate">{img}</div> : img;
}

/** A folder's look with its own overrides applied on top of the global settings. */
export function useFolderLook(folderId: string, override?: FolderLook) {
  const look = useDesk((s) => s.layout.folders[folderId]?.look);
  // only the values used here: other settings changes don't re-render every group tile
  const s = useDesk(
    useShallow((st) => ({
      folderTile: st.settings.transparency.folderTile,
      folderTileBlur: st.settings.transparency.folderTileBlur,
      panel: st.settings.transparency.panel,
      radius: st.settings.folders.radius,
      preview: st.settings.folders.preview,
      style: st.settings.folders.style,
      dark: st.settings.theme === "system" ? !!darkScheme?.matches : resolveTheme(st.settings.theme) === "dark",
    })),
  );
  const groupBox = useDesk(useShallow((st) => st.settings.groupBox));
  const l = override ?? look ?? {};
  return {
    opacity: l.opacity ?? s.folderTile,
    blur: l.blur ?? s.folderTileBlur,
    radius: l.radius ?? s.radius,
    preview: l.preview ?? s.preview,
    icon: l.icon,
    panelStyle: l.panelStyle ?? s.style,
    panelOpacity: l.panelOpacity ?? s.panel,
    box: resolveGroupBox(groupBox, l),
    dark: s.dark,
  };
}

/**
 * Group-box effects (border, drop shadow, gradient, inner glow) of a group for boxes drawn as that
 * group — fences, the open panel: `style={{ ...own, ...groupBoxStyle(useGroupBox(id), ownShadow) }}`.
 */
export function useGroupBox(folderId: string, override?: FolderLook): GroupBoxParts {
  const look = useFolderLook(folderId, override);
  const color = useDesk((s) => s.layout.folders[folderId]?.color ?? s.settings.folders.defaultColor);
  return groupBoxParts(look.box, { tint: color ?? "var(--accent)", dark: look.dark });
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
  // At 0 % the tile disappears completely: no fill, border, shadow or blur (unless the group box asks).
  const o = look.opacity;
  const visible = o > 0.005;
  const box = groupTileStyle({ color, opacity: o, box: look.box, dark: look.dark });
  const radius = size * look.radius;

  if (look.icon) {
    return (
      <div className="folder-tile" style={{ borderRadius: radius, padding: 0, background: "none", border: "none", boxShadow: "none", backdropFilter: "none" }}>
        <img src={mediaUrl(look.icon)} alt="" draggable={false} decoding="async" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: radius }} />
        <GlyphBadges folder={folder} size={size} radius={radius} />
      </div>
    );
  }
  return (
    <div
      className="folder-tile"
      style={{
        borderRadius: radius,
        padding: Math.max(0, pad - box.borderPx),
        gap,
        gridTemplateColumns: `repeat(${n}, ${mini}px)`,
        gridTemplateRows: `repeat(${n}, ${mini}px)`,
        ...box.style,
        backdropFilter: visible && look.blur > 0 ? `blur(${look.blur}px) saturate(1.6)` : "none",
      }}
    >
      {folder.lock ? (
        <LockMark folderId={folderId} size={size} />
      ) : showsOwnMinis(folder) ? (
        <KindMinis folder={folder} count={n * n} mini={mini} />
      ) : (
        kids.map((k) => (
          <div className="mini" key={k} style={{ width: mini, height: mini }}>
            {isFolderId(k) ? <div className="mini-folder" /> : <ItemImage id={k} size={mini} />}
          </div>
        ))
      )}
      <GlyphBadges folder={folder} size={size} radius={radius} />
    </div>
  );
});

type TileProps = {
  id: string;
  cellW: number;
  cellH: number;
  size: number;
  where: "desktop" | "panel";
  hidden?: boolean;
};

/**
 * One icon cell: image (or folder glyph) + label, selection and drop feedback. Memoized and
 * subscribed to its own slices only (selection, name, drop feedback, the few settings it draws),
 * so a store update or a drag re-renders just the tiles it changes.
 */
export const Tile = memo(function Tile({ id, cellW, cellH, size, where, hidden }: TileProps) {
  const selected = useDesk((s) => s.selection.has(id));
  const renaming = useDesk((s) => s.rename?.id === id);
  const labels = useDesk((s) => s.settings.grid.labels);
  const labelLines = useDesk((s) => s.settings.grid.labelLines);
  const folderRadius = useDesk((s) => s.settings.folders.radius);
  const animation = useAnimation();
  const reduced = useReducedMotion();
  const name = useDesk((s) => nameIn(s, id));
  const drop = useDrag((d) => dropOn(d.drag?.target ?? d.external, id));
  const bump = useBump((b) => (b.id === id ? b.n : 0));
  const jiggle = useJiggle((j) => j.on);
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

  const merge = drop === "merge";
  const into = drop === "into";
  const real = drop === "real";
  const recycle = drop === "recycle";
  const app = drop === "app";
  const phase = jiggle ? jigglePhase(id) : null;

  return (
    <div
      ref={ref}
      className="tile"
      data-hit="tile"
      data-selected={selected}
      data-wiggle={jiggle || undefined}
      style={{
        width: cellW,
        height: cellH,
        opacity: hidden ? 0 : 1,
        ...(phase && { ["--jd" as string]: phase.delay, ["--jt" as string]: phase.duration }),
      }}
      {...hoverHandlers}
      onPointerDown={(e) => {
        e.stopPropagation();
        armLongPress(e, id);
        beginIconPointer(e, id, where === "panel");
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        // edit mode: a click never launches a file
        if (!isFolder && !jiggling()) openId(id);
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
        animate={{ scale: merge ? 1.14 : into || real || recycle || app ? 1.12 : 1 }}
        transition={spring({ animation }, 0.35, 0.35)}
      >
        <AnimatePresence>
          {merge && (
            <motion.div
              className="merge-plate"
              style={{ borderRadius: size * 1.32 * folderRadius }}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              transition={spring({ animation }, 0.3, 0.3)}
            />
          )}
        </AnimatePresence>
        {(into || real || recycle) && <div className={recycle ? "drop-ring danger" : "drop-ring"} />}
        {app && (
          <>
            <div className="drop-ring app" />
            <DropLabel text={t.openWithApp(name)} />
          </>
        )}
        <BumpWrap n={bump} enabled={!reduced}>
          {isFolder ? <FolderGlyph folderId={id} size={size} /> : <ItemImage id={id} size={size} plate />}
        </BumpWrap>
        {jiggle && <JiggleBadge id={id} />}
      </motion.div>
      {renaming ? (
        <RenameBox id={id} initial={name} />
      ) : (
        labels && (
          <div className="tile-label" style={{ WebkitLineClamp: labelLines }}>
            {name}
          </div>
        )
      )}
    </div>
  );
});

/** "<App> ile aç" under an app's icon while files hover it, kept inside its monitor. */
function DropLabel({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.closest(".monitor")?.getBoundingClientRect() ?? { left: 0, right: window.innerWidth };
    const r = el.getBoundingClientRect();
    const pad = 10; // the icon still grows a little after this
    const dx = r.left < box.left + pad ? box.left + pad - r.left : r.right > box.right - pad ? box.right - pad - r.right : 0;
    el.style.marginLeft = dx ? `${dx}px` : "";
  }, [text]);
  return (
    <div ref={ref} className="drop-label">
      {text}
    </div>
  );
}

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
 * flies in from the drop point. It gets a compositor layer (`will-change`) only while it moves.
 */
export function Positioned({ id, x, y, z, children }: { id: string; x: number; y: number; z?: number; children: ReactNode }) {
  const animation = useAnimation();
  const reduced = useReducedMotion();
  const mx = useMotionValue(x);
  const my = useMotionValue(y);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const fly = takeFlyFrom(id);
    const parent = el?.parentElement;
    if (fly && parent && !reduced) {
      const pr = parent.getBoundingClientRect();
      mx.jump(fly.x - pr.left);
      my.jump(fly.y - pr.top);
    }
    if (reduced) {
      mx.jump(x);
      my.jump(y);
      return;
    }
    if (mx.get() === x && my.get() === y) return;
    let alive = true;
    if (el) el.style.willChange = "transform";
    const tr = spring({ animation }, 0.45, 0.16);
    const a = animate(mx, x, tr);
    const b = animate(my, y, tr);
    Promise.all([a, b]).then(() => {
      if (alive && el) el.style.willChange = "";
    });
    return () => {
      alive = false;
      a.stop();
      b.stop();
      if (el) el.style.willChange = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y]);
  return (
    <motion.div ref={ref} className="positioned" style={{ x: mx, y: my, zIndex: z }}>
      {children}
    </motion.div>
  );
}
