import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  theme: "system",
  accent: "#3b82f6",
  wallpaper: {
    source: "windows",
    image: null,
    color: "#1f2937",
    gradient: { from: "#1e3a8a", to: "#7c3aed", angle: 135 },
    blur: 0,
    dim: 0,
  },
  grid: {
    iconSize: 48,
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
  animation: { speed: 1, reduceMotion: false },
  behavior: {
    lockLayout: false,
    searchHotkey: "Ctrl+Space",
    startWithWindows: false,
    showSystemIcons: true,
    typeToSearch: true,
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
  return {
    version: 1,
    theme: oneOf(r.theme, ["system", "light", "dark"] as const, d.theme),
    accent: str(r.accent, d.accent),
    wallpaper: {
      source: oneOf(wp.source, ["windows", "image", "color", "gradient"] as const, d.wallpaper.source),
      image: typeof wp.image === "string" ? wp.image : null,
      color: str(wp.color, d.wallpaper.color),
      gradient: {
        from: str(wp.gradient?.from, d.wallpaper.gradient.from),
        to: str(wp.gradient?.to, d.wallpaper.gradient.to),
        angle: clamp(wp.gradient?.angle, 0, 360, d.wallpaper.gradient.angle),
      },
      blur: clamp(wp.blur, 0, 60, d.wallpaper.blur),
      dim: clamp(wp.dim, 0, 0.8, d.wallpaper.dim),
    },
    grid: {
      iconSize: clamp(g.iconSize, 24, 128, d.grid.iconSize),
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
    },
    behavior: {
      lockLayout: bool(be.lockLayout, d.behavior.lockLayout),
      searchHotkey: str(be.searchHotkey, d.behavior.searchHotkey),
      startWithWindows: bool(be.startWithWindows, d.behavior.startWithWindows),
      showSystemIcons: bool(be.showSystemIcons, d.behavior.showSystemIcons),
      typeToSearch: bool(be.typeToSearch, d.behavior.typeToSearch),
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

/** Push theme-related CSS variables onto :root. */
export function applyTheme(s: Settings) {
  const root = document.documentElement;
  const theme = resolveTheme(s.theme);
  root.dataset.theme = theme;
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  set("--accent", s.accent);
  set("--accent-soft", rgba(s.accent, 0.28));
  set("--accent-softer", rgba(s.accent, 0.16));
  const glassBase = theme === "dark" ? "24, 24, 28" : "250, 250, 252";
  set("--glass-rgb", glassBase);
  set("--panel-alpha", String(s.transparency.panel));
  set("--panel-blur", `${s.transparency.panelBlur}px`);
  set("--tile-alpha", String(s.transparency.folderTile));
  set("--tile-blur", `${s.transparency.folderTileBlur}px`);
  set("--label-bg", `rgba(0, 0, 0, ${s.transparency.labelBg * 0.6})`);
  set("--icon-opacity", String(s.transparency.iconOpacity));
}

/** Spring transition honouring the animation speed setting. */
export function spring(s: Settings, base = 0.42, bounce = 0.18) {
  if (s.animation.reduceMotion) return { duration: 0 };
  return { type: "spring" as const, duration: base / s.animation.speed, bounce };
}

export function tween(s: Settings, base = 0.2) {
  if (s.animation.reduceMotion) return { duration: 0 };
  return { duration: base / s.animation.speed, ease: [0.2, 0.8, 0.2, 1] as const };
}
