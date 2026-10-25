// Quick Look (Space on a selected icon): a preview card over the desktop. ←/→ walk the icons of the
// same page (reading order) or of the open group, Enter opens, Space / Esc close.

import { X } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api, iconUrl, previewUrl, thumbUrl } from "../api";
import { t } from "../i18n";
import { fenceOf } from "../layout/blocks";
import { primaryGrid } from "../layout/grid";
import { isFolderId } from "../layout/model";
import { DEFAULT_FREQUENT_LIMIT, frequentItems } from "../layout/smart";
import { spring, tween } from "../settings";
import type { DesktopItem, DirPreview, ShortcutInfo } from "../types";
import { useDialogFocus } from "../ui/dialog";
import { openId } from "./actions";
import { LiveImage, useFrequentIds } from "./GroupContent";
import { liveItem, liveSiblings, useLive, useLiveItem } from "./live";
import { useContentHidden } from "./locks";
import { panelGrid, rectOf } from "./registry";
import { dirName, displayName, useDesk } from "./store";
import { FolderGlyph, iconPx, ItemImage } from "./Tile";
import "./quicklook.css";

type View = "image" | "video" | "audio" | "text" | "pdf" | "dir" | "group" | "info";

const IMAGE = /\.(png|jpe?g|jfif|gif|webp|bmp|svg|ico|avif)$/i;
const VIDEO = /\.(mp4|m4v|webm|mkv|mov|ogv)$/i;
const AUDIO = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac)$/i;
const PDF = /\.pdf$/i;
/** The extensions icons.rs serves as text/plain. */
const TEXT = new Set(
  (
    "txt md markdown log csv tsv json jsonc xml yaml yml toml ini cfg conf env properties gitignore editorconfig html htm css " +
    "scss less js mjs cjs jsx ts tsx vue svelte rs py rb php java kt kts go c h cpp cc hpp cs fs swift lua sh bash zsh bat " +
    "cmd ps1 psm1 sql r dart scala pl gradle srt vtt nfo reg"
  ).split(" "),
);
const TEXT_LIMIT = 256 * 1024;
const EMPTY: string[] = [];

function viewOf(id: string, it: DesktopItem | undefined): View {
  if (isFolderId(id)) return "group";
  if (!it || it.kind === "system") return "info";
  if (it.kind === "folder") return "dir";
  if (IMAGE.test(it.path)) return "image";
  if (VIDEO.test(it.path)) return "video";
  if (AUDIO.test(it.path)) return "audio";
  if (PDF.test(it.path)) return "pdf";
  if (TEXT.has(it.ext.replace(/^\./, ""))) return "text";
  return "info";
}

function typeLabel(id: string, it: DesktopItem | undefined) {
  if (isFolderId(id)) return t.ql.group;
  if (!it) return "";
  if (it.kind === "system") return t.ql.systemItem;
  if (it.kind === "folder") return t.fileFolder;
  if (it.ext === ".lnk") return t.ql.shortcut;
  if (it.ext === ".url") return t.ql.internetShortcut;
  return t.ql.fileOfType(it.ext.replace(/^\./, ""));
}

const sizeFormat = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });
export function formatBytes(n: number) {
  if (n < 1024) return t.ql.bytes(n);
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${sizeFormat.format(v)} ${units[i]}`;
}

const formatDate = (ms: number) => (ms ? new Date(ms).toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" }) : "");

/** What ←/→ walk through: the open group's children, else the icons of the item's monitor page. */
function siblings(id: string): string[] {
  const live = liveSiblings(id);
  if (live) return live;
  const { panel, layout, itemMap } = useDesk.getState();
  const real = (x: string) => (isFolderId(x) ? !!layout.folders[x] : itemMap.has(x));
  if (panel) {
    const f = layout.folders[panelGrid.folderId ?? panel.stack[panel.stack.length - 1]];
    if (panelGrid.items?.includes(id)) return panelGrid.items.filter(real);
    if (f?.kind === "frequent") {
      const ids = frequentItems(layout, itemMap, f.limit ?? DEFAULT_FREQUENT_LIMIT);
      if (ids.includes(id)) return ids;
    }
    if (f?.children.includes(id)) return f.children.filter(real);
  }
  // a fence's child: the fence's children, in the order shown
  const fence = fenceOf(layout, id);
  if (fence) return layout.folders[fence].children.filter(real);
  const pl = layout.placements[id];
  if (!pl) return [id];
  return Object.entries(layout.placements)
    .filter(([x, p]) => p.m === pl.m && p.p === pl.p && real(x))
    .sort(([, a], [, b]) => a.r - b.r || a.c - b.c)
    .map(([x]) => x);
}

const close = () => useDesk.setState({ dialog: null });

function step(id: string, d: number) {
  const list = siblings(id);
  const next = list[list.indexOf(id) + d];
  if (!next) return;
  if (liveItem(next)) {
    useLive.setState({ sel: next });
    useDesk.setState({ dialog: { kind: "quicklook", id: next } });
  } else useDesk.setState({ dialog: { kind: "quicklook", id: next }, selection: new Set([next]) });
}

export function QuickLook() {
  const id = useDesk((s) => (s.dialog?.kind === "quicklook" ? s.dialog.id : null));
  return <AnimatePresence>{id && <Card key="quicklook" id={id} />}</AnimatePresence>;
}

function Card({ id }: { id: string }) {
  const settings = useDesk((s) => s.settings);
  const quiet = useDesk((s) => s.quiet.game || s.quiet.battery);
  const desktopItem = useDesk((s) => s.itemMap.get(id));
  const liveEntry = useLiveItem(desktopItem ? null : id);
  const item = desktopItem ?? liveEntry;
  const locked = useContentHidden(id);
  const grids = useDesk((s) => s.grids);
  const monitorId = useDesk((s) => s.layout.placements[id]?.m ?? s.panel?.monitorId);
  const [failed, setFailed] = useState<string | null>(null);
  const view: View = failed === id ? "info" : viewOf(id, item);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Escape") {
        if (!e.repeat) close();
      } else if (e.key === "ArrowLeft") step(id, -1);
      else if (e.key === "ArrowRight") step(id, 1);
      else if (e.key === "Enter") {
        close();
        openId(id);
      } else return;
      // before the desktop's own shortcuts and the focused <video> / <audio>
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [id]);
  const box = useRef<HTMLDivElement>(null);
  useDialogFocus(box, useIsPresent());

  const g = (monitorId && grids[monitorId]) || primaryGrid(grids);
  if (!g) return null;
  const big = view !== "info" && view !== "audio";
  const W = Math.round(big ? Math.min(980, g.workWidth * 0.74) : Math.min(560, g.workWidth * 0.9));
  const H = Math.round(big ? Math.min(740, g.workHeight * 0.82) : Math.min(480, g.workHeight * 0.86));
  const left = Math.round(g.left + g.workLeft + (g.workWidth - W) / 2);
  const top = Math.round(g.top + g.workTop + (g.workHeight - H) / 2);
  // grows out of the icon and shrinks back into it
  const r = quiet ? null : rectOf(id);
  const from = r
    ? { x: r.left + r.width / 2 - (left + W / 2), y: r.top + r.height / 2 - (top + H / 2), scale: Math.max(0.06, r.width / W) }
    : { x: 0, y: 10, scale: 0.96 };
  const sub = [
    typeLabel(id, item),
    item && item.kind === "file" ? formatBytes(item.size) : "",
    item?.modified ? formatDate(item.modified) : "",
  ].filter(Boolean);
  const name = liveEntry ? liveEntry.name : displayName(id);

  return (
    <>
      <motion.div
        className="ql-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={tween(settings, 0.18)}
        onPointerDown={(e) => {
          e.stopPropagation();
          close();
        }}
        onContextMenu={(e) => e.preventDefault()}
      />
      <motion.div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={name}
        className="ql-card"
        initial={{ opacity: 0, ...from, left, top, width: W, height: H }}
        animate={{ opacity: 1, x: 0, y: 0, scale: 1, left, top, width: W, height: H }}
        exit={{ opacity: 0, ...from, transition: tween(settings, 0.18) }}
        transition={spring(settings, 0.36, 0.12)}
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="ql-head">
          <span className="ql-head-icon">
            {isFolderId(id) ? (
              <FolderGlyph folderId={id} size={30} />
            ) : liveEntry ? (
              <LiveImage item={liveEntry} size={30} />
            ) : (
              <ItemImage id={id} size={30} />
            )}
          </span>
          <div className="ql-title">
            <div className="ql-name">{name}</div>
            <div className="ql-sub">{sub.join(" · ")}</div>
          </div>
          <button
            className="ql-btn"
            onClick={() => {
              close();
              openId(id);
            }}
          >
            {t.ql.open}
          </button>
          <button className="ql-btn icon" title={t.ql.close} aria-label={t.ql.close} onClick={close}>
            <X size={16} strokeWidth={2} />
          </button>
        </div>
        <motion.div className="ql-body" key={id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={tween(settings, 0.16)}>
          {locked ? (
            <div className="ql-center">{t.ql.locked}</div>
          ) : (
            <Body id={id} item={item} view={view} onFail={() => setFailed(id)} />
          )}
        </motion.div>
        <div className="ql-foot">{t.ql.hint}</div>
      </motion.div>
    </>
  );
}

/**
 * A <video> / <audio> that stops as the card starts closing and frees its decoder and buffers as
 * soon as it goes away (an element only removed from the page keeps them until it is collected).
 * A new item remounts it (`.ql-body` is keyed by the id).
 */
function useMedia<T extends HTMLMediaElement>() {
  const ref = useRef<T>(null);
  const present = useIsPresent();
  useEffect(() => {
    if (!present) ref.current?.pause();
  }, [present]);
  useEffect(() => {
    const el = ref.current;
    return () => {
      if (!el) return;
      el.pause();
      el.removeAttribute("src");
      el.load();
    };
  }, []);
  return ref;
}

function Video({ src, onFail }: { src: string; onFail: () => void }) {
  const ref = useMedia<HTMLVideoElement>();
  return <video ref={ref} className="ql-fill" src={src} controls autoPlay onError={onFail} />;
}

function Audio({ src, onFail }: { src: string; onFail: () => void }) {
  const ref = useMedia<HTMLAudioElement>();
  return <audio ref={ref} src={src} controls autoPlay onError={onFail} />;
}

function Body({ id, item, view, onFail }: { id: string; item: DesktopItem | undefined; view: View; onFail: () => void }) {
  const path = item?.path ?? "";
  switch (view) {
    case "image":
      return <img className="ql-fill" src={previewUrl(path)} alt="" draggable={false} onError={onFail} />;
    case "video":
      return <Video src={previewUrl(path)} onFail={onFail} />;
    case "audio":
      return (
        <div className="ql-audio">
          <Thumb item={item!} />
          <Audio src={previewUrl(path)} onFail={onFail} />
        </div>
      );
    case "pdf":
      return <iframe className="ql-frame" src={previewUrl(path)} title={item?.name ?? ""} />;
    case "text":
      return <TextPreview path={path} onFail={onFail} />;
    case "dir":
      return <DirList path={path} />;
    case "group":
      return <GroupGrid folderId={id} />;
    default:
      return <Info id={id} item={item} />;
  }
}

/** Large shell thumbnail (system items: their icon); the small icon when there is none. */
function Thumb({ item }: { item: DesktopItem }) {
  const [broken, setBroken] = useState(false);
  if (broken) return useDesk.getState().itemMap.has(item.id) ? <ItemImage id={item.id} size={128} /> : <LiveImage item={item} size={128} />;
  const px = Math.min(1024, Math.round(256 * (window.devicePixelRatio || 1)));
  const src = item.kind === "system" ? iconUrl(item.parsingName, 256, item.iconVersion) : thumbUrl(item.path, px, item.iconVersion);
  return <img src={src} alt="" draggable={false} onError={() => setBroken(true)} />;
}

function Info({ id, item }: { id: string; item: DesktopItem | undefined }) {
  const [link, setLink] = useState<ShortcutInfo | null>(null);
  const path = item?.isShortcut ? item.path : null;
  useEffect(() => {
    setLink(null);
    if (!path) return;
    let live = true;
    api
      .shortcutTarget(path)
      .then((l) => live && setLink(l))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [path]);
  const rows: [string, string][] = [[t.ql.type, typeLabel(id, item)]];
  if (item?.kind === "file") rows.push([t.ql.size, formatBytes(item.size)]);
  if (item?.modified) rows.push([t.ql.modified, formatDate(item.modified)]);
  if (item && item.kind !== "system") rows.push([t.ql.location, dirName(item.path)]);
  if (link?.target) rows.push([t.ql.target, link.target]);
  if (link?.args) rows.push([t.ql.args, link.args]);
  if (link?.workDir) rows.push([t.ql.startIn, link.workDir]);
  if (link?.description) rows.push([t.ql.comment, link.description]);
  return (
    <div className="ql-info">
      <div className="ql-thumb">{item ? <Thumb item={item} /> : <FolderGlyph folderId={id} size={160} />}</div>
      <dl className="ql-props">
        {rows.map(([k, v]) => (
          <div key={k} className="ql-prop">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function decodeText(buf: Uint8Array): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  try {
    // stream: a multi-byte character cut at the 256 KB boundary is not an error
    return new TextDecoder("utf-8", { fatal: true }).decode(buf, { stream: true });
  } catch {
    return new TextDecoder("windows-1254").decode(buf);
  }
}

function TextPreview({ path, onFail }: { path: string; onFail: () => void }) {
  const [text, setText] = useState<{ body: string; truncated: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const res = await fetch(previewUrl(path), { headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` } });
      if (!res.ok) throw new Error(String(res.status));
      const buf = new Uint8Array(await res.arrayBuffer());
      const total = Number(res.headers.get("Content-Range")?.split("/")[1] ?? buf.length);
      if (live) setText({ body: decodeText(buf), truncated: total > buf.length });
    })().catch(() => live && onFail());
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  if (!text) return <div className="ql-center">{t.loading}</div>;
  return (
    <div className="ql-textwrap">
      <pre className="ql-text">{text.body}</pre>
      {text.truncated && <div className="ql-more">{t.ql.truncated}</div>}
    </div>
  );
}

function DirList({ path }: { path: string }) {
  const [data, setData] = useState<DirPreview | null>(null);
  useEffect(() => {
    let live = true;
    api
      .listDirPreview(path, 200)
      .then((d) => live && setData(d))
      .catch(() => live && setData({ entries: [], total: 0 }));
    return () => {
      live = false;
    };
  }, [path]);
  if (!data) return <div className="ql-center">{t.loading}</div>;
  if (!data.total) return <div className="ql-center">{t.ql.emptyFolder}</div>;
  const px = iconPx(20);
  return (
    <div className="ql-list">
      <div className="ql-count">{t.ql.items(data.total)}</div>
      {data.entries.map((e) => (
        <div
          className="ql-row"
          key={e.path}
          onDoubleClick={() => {
            close();
            api.openItem(e.path).catch(() => {});
          }}
        >
          <img src={iconUrl(e.path, px, String(e.modified))} alt="" loading="lazy" draggable={false} />
          <span className="ql-row-name">{e.name}</span>
          <span className="ql-row-meta">{e.isDir ? "" : formatBytes(e.size)}</span>
          <span className="ql-row-meta">{formatDate(e.modified)}</span>
        </div>
      ))}
      {data.total > data.entries.length && <div className="ql-more">{t.ql.more(data.total - data.entries.length)}</div>}
    </div>
  );
}

const GROUP_MAX = 120;

function GroupGrid({ folderId }: { folderId: string }) {
  const folder = useDesk((s) => s.layout.folders[folderId]);
  const freq = useFrequentIds(folder);
  if (folder?.kind === "live") return folder.source ? <DirList path={folder.source} /> : <div className="ql-center">{t.grp.liveNoSource}</div>;
  const children = folder?.kind === "frequent" ? freq : folder?.children ?? EMPTY;
  if (!children.length) return <div className="ql-center">{t.ql.emptyGroup}</div>;
  return (
    <div className="ql-grid">
      {children.slice(0, GROUP_MAX).map((c) => (
        <div
          className="ql-cell"
          key={c}
          onDoubleClick={() => {
            close();
            openId(c);
          }}
        >
          <div className="ql-cell-icon">{isFolderId(c) ? <FolderGlyph folderId={c} size={56} /> : <ItemImage id={c} size={56} />}</div>
          <div className="ql-cell-name">{displayName(c)}</div>
        </div>
      ))}
      {children.length > GROUP_MAX && <div className="ql-more">{t.ql.more(children.length - GROUP_MAX)}</div>}
    </div>
  );
}
