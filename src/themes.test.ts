import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "./settings";
import { applyPreset, applyThemePatch, isPresetActive, pickVisual, readThemeFile, THEME_PRESETS, themeFile, visualSettings } from "./themes";
import type { Settings } from "./types";

/** A user with non-default everything outside the visual groups. */
function customized(): Settings {
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    behavior: { ...DEFAULT_SETTINGS.behavior, searchHotkey: "Alt+K", lockLayout: true, doubleClickHide: false, quickLook: false },
    grid: { ...DEFAULT_SETTINGS.grid, iconScale: 1.7, autoArrange: true },
    folders: { ...DEFAULT_SETTINGS.folders, panelColumns: 7 },
    search: { ...DEFAULT_SETTINGS.search, web: false },
    performance: { gameMode: false, batteryMode: "off" },
    wallpaper: { ...DEFAULT_SETTINGS.wallpaper, source: "color", color: "#123456", perPage: { "M1|2": { ...DEFAULT_SETTINGS.wallpaper.dayNight.night } } },
    icons: { ...DEFAULT_SETTINGS.icons, shape: "circle", pack: { name: "Paket", map: { chrome: "C:\\media\\chrome.png" } } },
    animation: { ...DEFAULT_SETTINGS.animation, speed: 1.5, sounds: true, soundVolume: 0.3, stiffness: 1.4 },
  });
}

const nonVisual = (s: Settings) => ({
  version: s.version,
  wallpaper: s.wallpaper,
  search: s.search,
  performance: s.performance,
  grid: s.grid,
  behavior: s.behavior,
  pack: s.icons.pack,
  panelColumns: s.folders.panelColumns,
  animation: { speed: s.animation.speed, reduceMotion: s.animation.reduceMotion, parallax: s.animation.parallax, stiffness: s.animation.stiffness, bounce: s.animation.bounce, sounds: s.animation.sounds, soundVolume: s.animation.soundVolume },
});

describe("theme presets", () => {
  it("has the six presets with unique ids", () => {
    expect(THEME_PRESETS.map((p) => p.id)).toEqual(["default", "glass", "neon", "minimal", "macos", "night"]);
  });

  for (const preset of THEME_PRESETS) {
    it(`${preset.id} normalizes to valid settings and keeps its values`, () => {
      const out = applyPreset(customized(), preset);
      expect(normalizeSettings(out)).toEqual(out);
      const vis = visualSettings(out) as unknown as Record<string, unknown>;
      for (const [group, value] of Object.entries(preset.patch)) {
        if (value && typeof value === "object") expect(vis[group]).toMatchObject(value);
        else expect(vis[group]).toBe(value);
      }
    });

    it(`${preset.id} does not touch non-visual settings`, () => {
      const cur = customized();
      const out = applyPreset(cur, preset);
      expect(nonVisual(out)).toEqual(nonVisual(cur));
      expect(out.behavior.searchHotkey).toBe("Alt+K");
    });

    it(`${preset.id} is active right after applying it`, () => {
      const out = applyPreset(customized(), preset);
      expect(isPresetActive(out, preset)).toBe(true);
      const others = THEME_PRESETS.filter((p) => p.id !== preset.id && isPresetActive(out, p));
      expect(others).toEqual([]);
    });
  }

  it("presets reset what the previous preset changed", () => {
    const neon = THEME_PRESETS.find((p) => p.id === "neon")!;
    const minimal = THEME_PRESETS.find((p) => p.id === "minimal")!;
    const out = applyPreset(applyPreset(DEFAULT_SETTINGS, neon), minimal);
    expect(out.labels.font).toBe(DEFAULT_SETTINGS.labels.font);
    expect(out.groupBox.glow).toBe(0);
    expect(out.theme).toBe(DEFAULT_SETTINGS.theme);
  });

  it("the default preset restores the default look", () => {
    const def = THEME_PRESETS.find((p) => p.id === "default")!;
    expect(visualSettings(applyPreset(customized(), def))).toEqual(visualSettings(DEFAULT_SETTINGS));
  });
});

describe("theme files", () => {
  it("round-trips the visual settings", () => {
    const night = THEME_PRESETS.find((p) => p.id === "night")!;
    const src = applyPreset(DEFAULT_SETTINGS, night);
    const file = JSON.parse(JSON.stringify(themeFile(src)));
    expect(file.format).toBe("folder-explorer-theme");
    const patch = readThemeFile(file);
    expect(patch).not.toBeNull();
    const out = applyThemePatch(customized(), patch);
    expect(visualSettings(out)).toEqual(visualSettings(src));
    expect(nonVisual(out)).toEqual(nonVisual(customized()));
  });

  it("ignores non-visual keys, the icon pack and wrongly typed values", () => {
    const patch = pickVisual({
      behavior: { searchHotkey: "Ctrl+X" },
      grid: { iconScale: 3 },
      wallpaper: { source: "image" },
      icons: { shape: "square", pack: { name: "x", map: { a: "b" } }, inset: "big" },
      labels: { color: null, size: "12", weight: 600 },
      accent: 12,
      theme: "dark",
    });
    expect(patch).toEqual({ icons: { shape: "square" }, labels: { color: null, weight: 600 }, theme: "dark" });
  });

  it("accepts a full state export and rejects junk", () => {
    expect(readThemeFile({ layout: {}, settings: { accent: "#ff0000", behavior: { lockLayout: true } } })).toEqual({ accent: "#ff0000" });
    expect(readThemeFile({ hello: 1 })).toBeNull();
    expect(readThemeFile("nope")).toBeNull();
    expect(readThemeFile(null)).toBeNull();
  });

  it("out-of-range values are clamped, not taken over", () => {
    const out = applyThemePatch(DEFAULT_SETTINGS, { transparency: { panel: 9 }, labels: { size: 100 } });
    expect(out.transparency.panel).toBe(1);
    expect(out.labels.size).toBe(18);
  });
});
