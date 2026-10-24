// Small live previews for the settings window: plain DOM + CSS, no timers, nothing animates while idle.

import type { CSSProperties, ReactNode } from "react";
import { mediaUrl } from "../api";
import { t } from "../i18n";
import { fontStack, groupTileStyle, labelShadow, plateColor, plateRadius, resolveTheme, rgba } from "../settings";
import type { Settings, WallpaperSpec } from "../types";

export { fontStack, plateRadius };

const GLYPHS: ReactNode[] = [
  <svg viewBox="0 0 48 48" key="folder">
    <path d="M4 12a4 4 0 0 1 4-4h11l4 4h17a4 4 0 0 1 4 4v20a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="#f2b632" />
    <path d="M4 18h40v18a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="#ffd45e" />
  </svg>,
  <svg viewBox="0 0 48 48" key="app">
    <defs>
      <linearGradient id="fe-sample-app" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#5b8cff" />
        <stop offset="1" stopColor="#a855f7" />
      </linearGradient>
    </defs>
    <rect x="4" y="4" width="40" height="40" rx="11" fill="url(#fe-sample-app)" />
    <path d="M19 15l14 9-14 9z" fill="#fff" />
  </svg>,
  <svg viewBox="0 0 48 48" key="doc">
    <path d="M11 4h18l10 10v28a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="#f8fafc" />
    <path d="M29 4v8a2 2 0 0 0 2 2h8z" fill="#cbd5e1" />
    <path d="M15 22h18M15 28h18M15 34h12" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" />
  </svg>,
];

export function selectionStyle(s: Settings): CSSProperties {
  const c = s.selection.color ?? s.accent;
  if (s.selection.style === "outline") return { boxShadow: `inset 0 0 0 2px ${rgba(c, 0.9)}` };
  if (s.selection.style === "glow") return { background: rgba(c, 0.14), boxShadow: `0 0 0 1px ${rgba(c, 0.55)}, 0 0 16px ${rgba(c, 0.6)}` };
  return { background: rgba(c, 0.3) };
}

export function labelStyle(s: Settings, scale = 1): CSSProperties {
  const lb = s.labels;
  return {
    fontFamily: fontStack(lb.font),
    fontSize: lb.size * scale,
    fontWeight: lb.weight,
    color: lb.color ?? "#ffffff",
    textShadow: labelShadow(lb.shadow, lb.color),
    background: `rgba(0,0,0,${s.transparency.labelBg * 0.6})`,
    WebkitLineClamp: s.grid.labelLines,
  };
}

/** One desktop icon as the settings would draw it: plate, inset, label, selection, hover effect. */
export function IconSample({
  s,
  glyph,
  label,
  size = 48,
  labelScale = 1,
  selected,
  hover,
}: {
  s: Settings;
  glyph: number;
  label?: string;
  size?: number;
  labelScale?: number;
  selected?: boolean;
  hover?: Settings["animation"]["hover"];
}) {
  const ic = s.icons;
  const plate = ic.shape !== "none";
  const inner = plate ? size * (1 - 2 * ic.inset) : size;
  return (
    <div
      className="sample"
      data-hover={hover}
      data-label-hover={(s.labels.hoverOnly && !!label) || undefined}
      style={{ width: Math.max(size + 36, 84 * labelScale), ...(selected ? selectionStyle(s) : null) }}
    >
      <div
        className="sample-icon"
        style={{
          width: size,
          height: size,
          borderRadius: plate ? plateRadius(ic.shape) : undefined,
          background: plate ? plateColor(s, resolveTheme(s.theme)) : undefined,
          opacity: s.transparency.iconOpacity,
        }}
      >
        <div style={{ width: inner, height: inner }}>{GLYPHS[glyph % GLYPHS.length]}</div>
      </div>
      {label && s.grid.labels && (
        <span className="sample-label" style={labelStyle(s, labelScale)}>
          {label}
        </span>
      )}
    </div>
  );
}

export function MockFolder({ s, size = 76, label = true }: { s: Settings; size?: number; label?: boolean }) {
  const n = s.folders.preview;
  const pad = size * (n === 3 ? 0.12 : 0.16);
  const gap = size * (n === 3 ? 0.055 : 0.08);
  const mini = (size - pad * 2 - gap * (n - 1)) / n;
  const colors = ["#ff6b6b", "#ffd25a", "#4ade9b", "#5b8cff", "#c084fc", "#f97316", "#22d3ee", "#f472b6", "#a3e635"];
  const tr = s.transparency;
  const visible = tr.folderTile > 0.005;
  const box = groupTileStyle({ color: s.folders.defaultColor, opacity: tr.folderTile, box: s.groupBox, dark: resolveTheme(s.theme) === "dark" });
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, ["--accent" as string]: s.accent }}>
      <div
        style={{
          width: size,
          height: size,
          borderRadius: size * s.folders.radius,
          padding: Math.max(0, pad - box.borderPx),
          display: "grid",
          gap,
          gridTemplateColumns: `repeat(${n}, ${mini}px)`,
          gridTemplateRows: `repeat(${n}, ${mini}px)`,
          backdropFilter: visible ? `blur(${tr.folderTileBlur}px) saturate(1.6)` : "none",
          ...box.style,
        }}
      >
        {colors.slice(0, n * n).map((c) => (
          <div key={c} style={{ borderRadius: mini * 0.26, background: c, opacity: tr.iconOpacity }} />
        ))}
      </div>
      {label && (
        <span className="sample-label" style={{ ...labelStyle(s), fontSize: 12 }}>
          {t.newFolderName}
        </span>
      )}
    </div>
  );
}

/** Page indicator inside a `.preview-strip` (the strip stands in for the screen). */
export function PageIndicator({ s, small }: { s: Settings; small?: boolean }) {
  const { style, position } = s.pageIndicator;
  if (style === "hidden") return null;
  return (
    <div className="pi" data-pos={position} data-style={style} data-small={small || undefined}>
      {style === "numbers" ? <span>2 / 3</span> : [0, 1, 2].map((i) => <i key={i} data-active={i === 1} />)}
    </div>
  );
}

export function wallpaperBackground(spec: WallpaperSpec): string {
  if (spec.source === "image" && spec.image) return `center / cover no-repeat url("${mediaUrl(spec.image)}")`;
  if (spec.source === "color") return spec.color;
  if (spec.source === "gradient") return `linear-gradient(${spec.gradient.angle}deg, ${spec.gradient.from}, ${spec.gradient.to})`;
  return "linear-gradient(135deg, #0e7490, #1e3a8a 55%, #312e81)";
}

export function WallpaperThumb({ spec }: { spec: WallpaperSpec }) {
  return (
    <div className="wp-thumb">
      <div style={{ position: "absolute", inset: spec.blur ? -6 : 0, background: wallpaperBackground(spec), filter: spec.blur ? `blur(${spec.blur * 0.15}px)` : undefined }} />
      {spec.dim > 0 && <div style={{ position: "absolute", inset: 0, background: `rgba(0,0,0,${spec.dim})` }} />}
      {spec.source === "windows" && <span>Windows</span>}
    </div>
  );
}

export function ThemeThumb({ s }: { s: Settings }) {
  const dark = resolveTheme(s.theme) === "dark";
  return (
    <div className="theme-thumb preview-strip" style={{ background: dark ? "linear-gradient(135deg, #0f172a, #3b0764)" : "linear-gradient(135deg, #7dd3fc, #c4b5fd)" }}>
      <MockFolder s={s} size={40} label={false} />
      <IconSample s={s} glyph={1} size={30} label={t.sampleNames[1]} labelScale={0.75} selected />
      <IconSample s={s} glyph={2} size={30} label={t.sampleNames[2]} labelScale={0.75} />
      <PageIndicator s={s} small />
    </div>
  );
}
