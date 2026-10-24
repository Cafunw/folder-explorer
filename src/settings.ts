import type { CSSProperties } from "react";
import type { FolderLook, IconShape, Settings, WallpaperSpec } from "./types";

const DEFAULT_WALLPAPER: WallpaperSpec = {
  source: "windows",
  image: null,
  color: "#1f2937",
  gradient: { from: "#1e3a8a", to: "#7c3aed", angle: 135 },
  blur: 0,
  dim: 0,
};

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  theme: "system",
  accent: "#3b82f6",
  wallpaper: {
    ...DEFAULT_WALLPAPER,
    perPage: {},
    dayNight: {
      enabled: false,
      dayStart: "07:00",
      nightStart: "19:00",
      night: { ...DEFAULT_WALLPAPER, source: "color", color: "#0b1020" },
    },
    accentFromWallpaper: false,
  },
  icons: { shape: "none", plateColor: null, plateOpacity: 0.9, inset: 0.18, pack: null },
  labels: { font: "", size: 12, weight: 400, color: null, shadow: 0.6, hoverOnly: false },
  groupBox: { borderWidth: 0, borderColor: null, borderOpacity: 0.25, shadow: 0, gradient: false, glow: 0 },
  pageIndicator: { style: "dots", position: "bottom" },
  selection: { color: null, style: "fill", marqueeRadius: 4 },
  search: { calculator: true, recentFiles: true, files: true, settingsPages: true, web: true },
  performance: { gameMode: true, batteryMode: "auto" },
  grid: {
    autoSize: true,
    iconSize: 48,
    iconScale: 1,
    cellWidth: 84,
    cellHeight: 96,
    labels: true,
    labelLines: 2,
    autoArrange: false,
  },
  folders: {
    style: "ios",
    preview: 3,
    radius: 0.26,
    panelColumns: 5,
    defaultColor: null,
  },
  transparency: {
    folderTile: 0.32,
    folderTileBlur: 16,
    panel: 0.42,
    panelBlur: 36,
    labelBg: 0,
    iconOpacity: 1,
  },
  animation: {
    speed: 1,
    reduceMotion: false,
    openStyle: "zoom",
    pageTransition: "slide",
    parallax: false,
    hover: "none",
    stiffness: 1,
    bounce: 1,
    sounds: false,
    soundVolume: 0.5,
  },
  behavior: {
    lockLayout: false,
    searchHotkey: "Ctrl+Space",
    startWithWindows: false,
    showSystemIcons: true,
    typeToSearch: true,
    showIcons: true,
    doubleClickHide: true,
    ctrlWheelZoom: true,
    quickLook: true,
    dropOnApp: true,
    newMenuEntry: true,
  },
};

export const ACCENTS = [
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#64748b",
];

export const FOLDER_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#64748b",
];

const clamp = (v: unknown, min: number, max: number, def: number) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : def;
  return Math.min(max, Math.max(min, n));
};
const str = (v: unknown, def: string) => (typeof v === "string" && v.length > 0 ? v : def);
const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);
const oneOf = <T extends string | number>(v: unknown, opts: readonly T[], def: T): T =>
  opts.includes(v as T) ? (v as T) : def;
const color = (v: unknown) => (typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v) ? v : null);
const time = (v: unknown, def: string) => (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : def);

function normalizeWallpaper(raw: unknown, d: WallpaperSpec): WallpaperSpec {
  const wp = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  return {
    source: oneOf(wp.source, ["windows", "image", "color", "gradient"] as const, d.source),
    image: typeof wp.image === "string" ? wp.image : null,
    color: str(wp.color, d.color),
    gradient: {
      from: str(wp.gradient?.from, d.gradient.from),
      to: str(wp.gradient?.to, d.gradient.to),
      angle: clamp(wp.gradient?.angle, 0, 360, d.gradient.angle),
    },
    blur: clamp(wp.blur, 0, 60, d.blur),
    dim: clamp(wp.dim, 0, 0.8, d.dim),
  };
}

/** Merge unknown persisted JSON with defaults and clamp every value. */
export function normalizeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const wp = r.wallpaper ?? {};
  const g = r.grid ?? {};
  const f = r.folders ?? {};
  const tr = r.transparency ?? {};
  const an = r.animation ?? {};
  const be = r.behavior ?? {};
  const ic = r.icons ?? {};
  const lb = r.labels ?? {};
  const gb = r.groupBox ?? {};
  const pi = r.pageIndicator ?? {};
  const se = r.selection ?? {};
  const sr = r.search ?? {};
  const pf = r.performance ?? {};
  const dn = wp.dayNight ?? {};
  const perPage: Record<string, WallpaperSpec> = {};
  if (wp.perPage && typeof wp.perPage === "object") {
    for (const [k, v] of Object.entries<unknown>(wp.perPage)) {
      if (/^.+\|\d+$/.test(k) && v && typeof v === "object") perPage[k] = normalizeWallpaper(v, DEFAULT_WALLPAPER);
    }
  }
  const packMap: Record<string, string> = {};
  if (ic.pack && typeof ic.pack === "object" && ic.pack.map && typeof ic.pack.map === "object") {
    for (const [k, v] of Object.entries<unknown>(ic.pack.map)) if (typeof v === "string" && v) packMap[k.toLowerCase()] = v;
  }
  return {
    version: 1,
    theme: oneOf(r.theme, ["system", "light", "dark"] as const, d.theme),
    accent: str(r.accent, d.accent),
    wallpaper: {
      ...normalizeWallpaper(wp, DEFAULT_WALLPAPER),
      perPage,
      dayNight: {
        enabled: bool(dn.enabled, d.wallpaper.dayNight.enabled),
        dayStart: time(dn.dayStart, d.wallpaper.dayNight.dayStart),
        nightStart: time(dn.nightStart, d.wallpaper.dayNight.nightStart),
        night: normalizeWallpaper(dn.night, d.wallpaper.dayNight.night),
      },
      accentFromWallpaper: bool(wp.accentFromWallpaper, d.wallpaper.accentFromWallpaper),
    },
    icons: {
      shape: oneOf(ic.shape, ["none", "circle", "squircle", "square", "teardrop"] as const, d.icons.shape),
      plateColor: color(ic.plateColor),
      plateOpacity: clamp(ic.plateOpacity, 0, 1, d.icons.plateOpacity),
      inset: clamp(ic.inset, 0, 0.35, d.icons.inset),
      pack: Object.keys(packMap).length ? { name: str(ic.pack.name, "Simge paketi"), map: packMap } : null,
    },
    labels: {
      font: typeof lb.font === "string" ? lb.font : d.labels.font,
      size: clamp(lb.size, 10, 18, d.labels.size),
      weight: oneOf(lb.weight, [400, 500, 600, 700] as const, d.labels.weight),
      color: color(lb.color),
      shadow: clamp(lb.shadow, 0, 1, d.labels.shadow),
      hoverOnly: bool(lb.hoverOnly, d.labels.hoverOnly),
    },
    groupBox: {
      borderWidth: clamp(gb.borderWidth, 0, 4, d.groupBox.borderWidth),
      borderColor: color(gb.borderColor),
      borderOpacity: clamp(gb.borderOpacity, 0, 1, d.groupBox.borderOpacity),
      shadow: clamp(gb.shadow, 0, 1, d.groupBox.shadow),
      gradient: bool(gb.gradient, d.groupBox.gradient),
      glow: clamp(gb.glow, 0, 1, d.groupBox.glow),
    },
    pageIndicator: {
      style: oneOf(pi.style, ["dots", "line", "numbers", "hidden"] as const, d.pageIndicator.style),
      position: oneOf(pi.position, ["bottom", "top", "left", "right"] as const, d.pageIndicator.position),
    },
    selection: {
      color: color(se.color),
      style: oneOf(se.style, ["fill", "outline", "glow"] as const, d.selection.style),
      marqueeRadius: clamp(se.marqueeRadius, 0, 12, d.selection.marqueeRadius),
    },
    search: {
      calculator: bool(sr.calculator, d.search.calculator),
      recentFiles: bool(sr.recentFiles, d.search.recentFiles),
      files: bool(sr.files, d.search.files),
      settingsPages: bool(sr.settingsPages, d.search.settingsPages),
      web: bool(sr.web, d.search.web),
    },
    performance: {
      gameMode: bool(pf.gameMode, d.performance.gameMode),
      batteryMode: oneOf(pf.batteryMode, ["auto", "always", "off"] as const, d.performance.batteryMode),
    },
    grid: {
      autoSize: bool(g.autoSize, d.grid.autoSize),
      iconSize: clamp(g.iconSize, 24, 128, d.grid.iconSize),
      iconScale: Math.round(clamp(g.iconScale, 0.5, 3, d.grid.iconScale) * 100) / 100,
      cellWidth: clamp(g.cellWidth, 56, 200, d.grid.cellWidth),
      cellHeight: clamp(g.cellHeight, 56, 220, d.grid.cellHeight),
      labels: bool(g.labels, d.grid.labels),
      labelLines: oneOf(g.labelLines, [1, 2, 3] as const, d.grid.labelLines),
      autoArrange: bool(g.autoArrange, d.grid.autoArrange),
    },
    folders: {
      style: oneOf(f.style, ["ios", "android"] as const, d.folders.style),
      preview: oneOf(f.preview, [2, 3] as const, d.folders.preview),
      radius: clamp(f.radius, 0, 0.5, d.folders.radius),
      panelColumns: Math.round(clamp(f.panelColumns, 3, 8, d.folders.panelColumns)),
      defaultColor: typeof f.defaultColor === "string" ? f.defaultColor : null,
    },
    transparency: {
      folderTile: clamp(tr.folderTile, 0, 1, d.transparency.folderTile),
      folderTileBlur: clamp(tr.folderTileBlur, 0, 40, d.transparency.folderTileBlur),
      panel: clamp(tr.panel, 0, 1, d.transparency.panel),
      panelBlur: clamp(tr.panelBlur, 0, 80, d.transparency.panelBlur),
      labelBg: clamp(tr.labelBg, 0, 1, d.transparency.labelBg),
      iconOpacity: clamp(tr.iconOpacity, 0.2, 1, d.transparency.iconOpacity),
    },
    animation: {
      speed: clamp(an.speed, 0.25, 3, d.animation.speed),
      reduceMotion: bool(an.reduceMotion, d.animation.reduceMotion),
      openStyle: oneOf(an.openStyle, ["zoom", "spring", "flip", "blur", "fade"] as const, d.animation.openStyle),
      pageTransition: oneOf(an.pageTransition, ["slide", "cube", "cards", "fade"] as const, d.animation.pageTransition),
      parallax: bool(an.parallax, d.animation.parallax),
      hover: oneOf(an.hover, ["none", "lift", "grow", "tilt", "glow", "bounce", "magnify"] as const, d.animation.hover),
      stiffness: clamp(an.stiffness, 0.5, 2, d.animation.stiffness),
      bounce: clamp(an.bounce, 0, 2, d.animation.bounce),
      sounds: bool(an.sounds, d.animation.sounds),
      soundVolume: clamp(an.soundVolume, 0, 1, d.animation.soundVolume),
    },
    behavior: {
      lockLayout: bool(be.lockLayout, d.behavior.lockLayout),
      searchHotkey: str(be.searchHotkey, d.behavior.searchHotkey),
      startWithWindows: bool(be.startWithWindows, d.behavior.startWithWindows),
      showSystemIcons: bool(be.showSystemIcons, d.behavior.showSystemIcons),
      typeToSearch: bool(be.typeToSearch, d.behavior.typeToSearch),
      showIcons: bool(be.showIcons, d.behavior.showIcons),
      doubleClickHide: bool(be.doubleClickHide, d.behavior.doubleClickHide),
      ctrlWheelZoom: bool(be.ctrlWheelZoom, d.behavior.ctrlWheelZoom),
      quickLook: bool(be.quickLook, d.behavior.quickLook),
      dropOnApp: bool(be.dropOnApp, d.behavior.dropOnApp),
      newMenuEntry: bool(be.newMenuEntry, d.behavior.newMenuEntry),
    },
  };
}

export function resolveTheme(mode: Settings["theme"]): "light" | "dark" {
  if (mode !== "system") return mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0");
  const n = parseInt(full.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex: string, a: number) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** A colour at an alpha: hex through rgba(), anything else (e.g. `var(--accent)`) through color-mix. */
export function withAlpha(c: string, a: number) {
  return c.startsWith("#") ? rgba(c, a) : `color-mix(in srgb, ${c} ${Math.round(a * 100)}%, transparent)`;
}

export function plateRadius(shape: IconShape): string {
  switch (shape) {
    case "circle":
      return "50%";
    case "squircle":
      return "31%";
    case "square":
      return "12%";
    case "teardrop":
      return "50% 50% 14% 50%";
    default:
      return "0";
  }
}

export const plateColor = (s: Settings, theme: "light" | "dark") =>
  rgba(s.icons.plateColor ?? (theme === "dark" ? "#26262c" : "#ffffff"), s.icons.plateOpacity);

export const fontStack = (font: string) => (font ? `"${font.replace(/["\\]/g, "")}", var(--font)` : undefined);

const isDarkColor = (hex: string) => {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110;
};

/** Label text shadow for a strength 0..1 (0.6 = the classic desktop look); dark text gets a light halo. */
export function labelShadow(strength: number, color: string | null): string {
  if (strength <= 0) return "none";
  const c = color && isDarkColor(color) ? "255, 255, 255" : "0, 0, 0";
  const f = (n: number) => +n.toFixed(2);
  return `0 1px ${f(1 + 2 * strength)}px rgba(${c}, ${f(Math.min(1, 1.42 * strength))}), 0 0 ${f(2 + 7 * strength)}px rgba(${c}, ${f(0.75 * strength)})`;
}

export type GroupBox = Settings["groupBox"];

/** The global group box with a group's own look on top. */
export function resolveGroupBox(g: GroupBox, look?: FolderLook): GroupBox {
  return {
    borderWidth: look?.borderWidth ?? g.borderWidth,
    borderColor: look?.borderColor ?? g.borderColor,
    borderOpacity: g.borderOpacity,
    shadow: look?.shadow ?? g.shadow,
    gradient: look?.gradient ?? g.gradient,
    glow: look?.glow ?? g.glow,
  };
}

export type GroupBoxParts = { border: string | null; drop: string | null; glow: string | null; gradient: string | null };

/**
 * CSS pieces of a group box; null = that effect is off (keep the element's own default).
 * `tint` = the group's colour or `var(--accent)` (inner glow without a border colour).
 */
export function groupBoxParts(box: GroupBox, o: { tint: string; dark: boolean }): GroupBoxParts {
  const f = (n: number) => +n.toFixed(2);
  return {
    border: box.borderWidth > 0 ? `${box.borderWidth}px solid ${withAlpha(box.borderColor ?? (o.dark ? "#ffffff" : "#000000"), box.borderOpacity)}` : null,
    drop: box.shadow > 0 ? `0 ${f(2 + 10 * box.shadow)}px ${f(6 + 24 * box.shadow)}px rgba(0, 0, 0, ${f(0.18 + 0.4 * box.shadow)})` : null,
    glow: box.glow > 0 ? `inset 0 0 ${f(6 + 14 * box.glow)}px ${withAlpha(box.borderColor ?? o.tint, f(0.25 + 0.6 * box.glow))}` : null,
    gradient: box.gradient ? "linear-gradient(180deg, rgba(255, 255, 255, 0.32), rgba(255, 255, 255, 0) 65%)" : null,
  };
}

/**
 * Fill, border and shadows of a group tile (desktop FolderGlyph and the settings preview).
 * At 0 % opacity the default fill, edge and shadow vanish; explicit group-box effects stay.
 */
export function groupTileStyle(o: { color: string | null; opacity: number; box: GroupBox; dark: boolean }) {
  const f = (n: number) => +n.toFixed(3);
  const op = o.opacity;
  const visible = op > 0.005;
  const edge = Math.min(1, op / 0.25);
  const p = groupBoxParts(o.box, { tint: o.color ?? "var(--accent)", dark: o.dark });
  const base = o.color ? rgba(o.color, Math.min(1, op * 1.5)) : `rgba(255, 255, 255, ${op})`;
  const shadows = [
    visible ? `inset 0 1px 0 rgba(255, 255, 255, ${f(0.25 * edge)})` : null,
    p.drop ?? (visible ? `0 3px 10px rgba(0, 0, 0, ${f(0.22 * edge)})` : null),
    p.glow,
  ].filter(Boolean);
  return {
    borderPx: p.border ? o.box.borderWidth : 1,
    style: {
      background: p.gradient ? `${p.gradient}, ${base}` : base,
      border: p.border ?? `1px solid rgba(255, 255, 255, ${f(0.22 * edge)})`,
      boxShadow: shadows.length ? shadows.join(", ") : "none",
    } satisfies CSSProperties,
  };
}

/**
 * Inline style for a box drawn as a group (fence, open panel): only the active effects, spread it
 * last. `baseShadow` = the element's own shadow, kept when the group box has no drop shadow.
 */
export function groupBoxStyle(p: GroupBoxParts, baseShadow?: string): CSSProperties {
  const out: CSSProperties = {};
  if (p.border) out.border = p.border;
  const shadows = [p.drop ?? baseShadow, p.glow].filter(Boolean);
  if (p.drop || p.glow) out.boxShadow = shadows.join(", ");
  if (p.gradient) out.backgroundImage = p.gradient;
  return out;
}

let wallpaperAccent: string | null = null;

/** The desktop's accent taken from the wallpaper (`wallpaper.accentFromWallpaper`); null = none yet. */
export function setWallpaperAccent(c: string | null) {
  wallpaperAccent = c;
}

export function effectiveAccent(s: Settings) {
  return (s.wallpaper.accentFromWallpaper && wallpaperAccent) || s.accent;
}

/** Push theme-related CSS variables onto :root. */
export function applyTheme(s: Settings) {
  const root = document.documentElement;
  const theme = resolveTheme(s.theme);
  root.dataset.theme = theme;
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  const flag = (k: string, v: string | null) => (v == null ? delete root.dataset[k] : (root.dataset[k] = v));
  const accent = effectiveAccent(s);
  set("--accent", accent);
  set("--accent-soft", rgba(accent, 0.28));
  set("--accent-softer", rgba(accent, 0.16));
  const glassBase = theme === "dark" ? "24, 24, 28" : "250, 250, 252";
  set("--glass-rgb", glassBase);
  set("--panel-alpha", String(s.transparency.panel));
  set("--panel-blur", `${s.transparency.panelBlur}px`);
  set("--tile-alpha", String(s.transparency.folderTile));
  set("--tile-blur", `${s.transparency.folderTileBlur}px`);
  set("--label-bg", `rgba(0, 0, 0, ${s.transparency.labelBg * 0.6})`);
  set("--icon-opacity", String(s.transparency.iconOpacity));

  flag("plate", s.icons.shape === "none" ? null : s.icons.shape);
  set("--plate-bg", plateColor(s, theme));
  set("--plate-radius", plateRadius(s.icons.shape));
  set("--plate-pad", `${+(s.icons.inset * 100).toFixed(2)}%`);

  const lb = s.labels;
  set("--label-font", fontStack(lb.font) ?? "var(--font)");
  set("--label-size", `${lb.size}px`);
  set("--label-weight", String(lb.weight));
  set("--label-color", lb.color ?? "#ffffff");
  set("--label-shadow", labelShadow(lb.shadow, lb.color));
  flag("labelHover", lb.hoverOnly ? "" : null);

  set("--sel", s.selection.color ?? accent);
  flag("sel", s.selection.style);
  set("--marquee-radius", `${s.selection.marqueeRadius}px`);

  // nothing painted under the desktop icons: a backdrop blur there has nothing to blur (styles.css)
  flag("bare", paintsWallpaper(s.wallpaper) ? null : "");
}

/** Some wallpaper (main, night or a page's own) is painted by us, not Windows' own shown through. */
export const paintsWallpaper = (wp: Settings["wallpaper"]) =>
  [wp, ...(wp.dayNight.enabled ? [wp.dayNight.night] : []), ...Object.values(wp.perPage)].some((x) => x.source !== "windows");

/** Spring transition honouring the animation speed, stiffness and bounce settings. */
export function spring(s: Pick<Settings, "animation">, base = 0.42, bounce = 0.18) {
  if (s.animation.reduceMotion) return { duration: 0 };
  const a = s.animation;
  return { type: "spring" as const, duration: base / (a.speed * a.stiffness), bounce: Math.min(0.9, bounce * a.bounce) };
}

export function tween(s: Pick<Settings, "animation">, base = 0.2) {
  if (s.animation.reduceMotion) return { duration: 0 };
  return { duration: base / s.animation.speed, ease: [0.2, 0.8, 0.2, 1] as const };
}
