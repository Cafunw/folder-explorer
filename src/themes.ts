// Theme presets and theme files: patches over the visual settings only.
// Layout, behaviour, wallpaper, search and performance settings are never touched.

import { t } from "./i18n";
import { DEFAULT_SETTINGS, normalizeSettings } from "./settings";
import type { Settings } from "./types";

export type VisualSettings = {
  theme: Settings["theme"];
  accent: string;
  transparency: Settings["transparency"];
  folders: Pick<Settings["folders"], "style" | "preview" | "radius" | "defaultColor">;
  icons: Omit<Settings["icons"], "pack">;
  labels: Settings["labels"];
  groupBox: Settings["groupBox"];
  selection: Settings["selection"];
  pageIndicator: Settings["pageIndicator"];
  animation: Pick<Settings["animation"], "openStyle" | "pageTransition" | "hover">;
};

export type ThemePatch = {
  [K in keyof VisualSettings]?: VisualSettings[K] extends object ? Partial<VisualSettings[K]> : VisualSettings[K];
};

export type ThemePreset = { id: string; name: string; patch: ThemePatch };

export const THEME_FILE_FORMAT = "folder-explorer-theme";

export function visualSettings(s: Settings): VisualSettings {
  return {
    theme: s.theme,
    accent: s.accent,
    transparency: { ...s.transparency },
    folders: { style: s.folders.style, preview: s.folders.preview, radius: s.folders.radius, defaultColor: s.folders.defaultColor },
    icons: { shape: s.icons.shape, plateColor: s.icons.plateColor, plateOpacity: s.icons.plateOpacity, inset: s.icons.inset },
    labels: { ...s.labels },
    groupBox: { ...s.groupBox },
    selection: { ...s.selection },
    pageIndicator: { ...s.pageIndicator },
    animation: { openStyle: s.animation.openStyle, pageTransition: s.animation.pageTransition, hover: s.animation.hover },
  };
}

/** Presets are differences from Varsayılan, so switching between them never leaves leftovers. */
export const THEME_PRESETS: ThemePreset[] = [
  { id: "default", name: t.themeDefault, patch: {} },
  {
    id: "glass",
    name: t.themeGlass,
    patch: {
      accent: "#38bdf8",
      transparency: { folderTile: 0.18, folderTileBlur: 28, panel: 0.24, panelBlur: 64 },
      folders: { radius: 0.3 },
      icons: { shape: "squircle", plateColor: "#ffffff", plateOpacity: 0.22, inset: 0.2 },
      labels: { weight: 500, shadow: 0.8 },
      groupBox: { borderWidth: 1, borderColor: "#ffffff", borderOpacity: 0.45, shadow: 0.25, gradient: true },
      selection: { style: "glow", marqueeRadius: 8 },
      animation: { openStyle: "blur", hover: "lift" },
    },
  },
  {
    id: "neon",
    name: t.themeNeon,
    patch: {
      theme: "dark",
      accent: "#22d3ee",
      transparency: { folderTile: 0.14, panel: 0.6, panelBlur: 30 },
      icons: { shape: "circle", plateColor: "#0b0b1a", plateOpacity: 0.85, inset: 0.2 },
      labels: { font: "Bahnschrift", weight: 600, color: "#e0f7ff", shadow: 1 },
      groupBox: { borderWidth: 2, borderColor: "#22d3ee", borderOpacity: 0.9, shadow: 0.2, glow: 0.8 },
      selection: { color: "#f472b6", style: "glow", marqueeRadius: 2 },
      pageIndicator: { style: "line" },
      animation: { openStyle: "spring", pageTransition: "cube", hover: "glow" },
    },
  },
  {
    id: "minimal",
    name: t.themeMinimal,
    patch: {
      accent: "#64748b",
      transparency: { folderTile: 0.08, folderTileBlur: 6, panel: 0.85, panelBlur: 20 },
      folders: { radius: 0.18 },
      labels: { size: 11, shadow: 0.3 },
      selection: { style: "outline", marqueeRadius: 2 },
      pageIndicator: { style: "line" },
      animation: { openStyle: "fade", pageTransition: "fade" },
    },
  },
  {
    id: "macos",
    name: t.themeMac,
    patch: {
      accent: "#007aff",
      transparency: { folderTile: 0.3, folderTileBlur: 20, panel: 0.5, panelBlur: 50 },
      folders: { style: "ios", preview: 3, radius: 0.22 },
      icons: { shape: "squircle", plateOpacity: 0.95, inset: 0.16 },
      labels: { weight: 500, shadow: 0.7 },
      groupBox: { borderWidth: 1, borderOpacity: 0.2, shadow: 0.35 },
      selection: { marqueeRadius: 6 },
      animation: { openStyle: "zoom", pageTransition: "slide", hover: "magnify" },
    },
  },
  {
    id: "night",
    name: t.themeNight,
    patch: {
      theme: "dark",
      accent: "#8b5cf6",
      transparency: { folderTile: 0.4, panel: 0.65, panelBlur: 40, labelBg: 0.3, iconOpacity: 0.85 },
      labels: { color: "#cbd5e1", shadow: 0.9 },
      groupBox: { borderWidth: 1, borderColor: "#8b5cf6", borderOpacity: 0.35, shadow: 0.6, glow: 0.25 },
      selection: { style: "glow" },
      animation: { openStyle: "fade", pageTransition: "fade", hover: "glow" },
    },
  },
];

const NULLABLE = new Set(["icons.plateColor", "labels.color", "groupBox.borderColor", "selection.color", "folders.defaultColor"]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Keeps only the visual keys of `raw` whose values have the right type (values are clamped later). */
export function pickVisual(raw: unknown): ThemePatch {
  if (!isObj(raw)) return {};
  const template = visualSettings(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(template)) {
    const v = raw[key];
    if (v === undefined) continue;
    if (!isObj(def)) {
      if (typeof v === typeof def) out[key] = v;
      continue;
    }
    if (!isObj(v)) continue;
    const group: Record<string, unknown> = {};
    for (const [k, d] of Object.entries(def)) {
      const x = v[k];
      if (x === undefined) continue;
      const ok = NULLABLE.has(`${key}.${k}`) ? x === null || typeof x === "string" : typeof x === typeof d;
      if (ok) group[k] = x;
    }
    if (Object.keys(group).length) out[key] = group;
  }
  return out as ThemePatch;
}

function merge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
  return out as T;
}

/** Applies the visual keys of `patch` over `cur`; everything else stays as it is. */
export function applyThemePatch(cur: Settings, patch: unknown): Settings {
  return normalizeSettings(merge(cur, pickVisual(patch)));
}

export function applyPreset(cur: Settings, preset: ThemePreset): Settings {
  return applyThemePatch(applyThemePatch(cur, visualSettings(DEFAULT_SETTINGS)), preset.patch);
}

export function isPresetActive(cur: Settings, preset: ThemePreset): boolean {
  return JSON.stringify(visualSettings(applyPreset(cur, preset))) === JSON.stringify(visualSettings(cur));
}

/** applyPreset for a click: a look that matches no preset is kept in customLook first, so it can be restored. */
export function choosePreset(cur: Settings, preset: ThemePreset): Settings {
  const out = applyPreset(cur, preset);
  return THEME_PRESETS.some((p) => isPresetActive(cur, p)) ? out : { ...out, customLook: visualSettings(cur) };
}

/** The saved custom look as full settings, or null when there is none or it is already the current look. */
export function customLookSettings(cur: Settings): Settings | null {
  if (!cur.customLook) return null;
  const out = applyThemePatch(cur, cur.customLook);
  return JSON.stringify(visualSettings(out)) === JSON.stringify(visualSettings(cur)) ? null : out;
}

export function themeFile(s: Settings) {
  return { format: THEME_FILE_FORMAT, version: 1, settings: visualSettings(s) };
}

/** A theme file, or a full state export (its settings); null when nothing usable is in it. */
export function readThemeFile(raw: unknown): ThemePatch | null {
  if (!isObj(raw)) return null;
  const patch = pickVisual(isObj(raw.settings) ? raw.settings : raw);
  return Object.keys(patch).length ? patch : null;
}
