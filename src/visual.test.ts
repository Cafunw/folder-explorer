import { describe, expect, it } from "vitest";
import { cellMetrics } from "./layout/grid";
import {
  DEFAULT_SETTINGS,
  groupBoxParts,
  groupBoxStyle,
  groupTileStyle,
  labelShadow,
  normalizeSettings,
  plateRadius,
  resolveGroupBox,
} from "./settings";
import type { DesktopItem, MonitorInfo } from "./types";
import {
  accentFromColors,
  dominantColor,
  isNight,
  msToNextSwitch,
  packMatch,
  packNames,
  parallaxStep,
  stemOf,
  wallpaperFor,
} from "./visual";

const at = (h: number, m = 0, s = 0) => new Date(2026, 9, 24, h, m, s);
const HOUR = 3600_000;

describe("day / night", () => {
  it("is night between nightStart and dayStart", () => {
    expect(isNight(at(6, 59), "07:00", "19:00")).toBe(true);
    expect(isNight(at(7, 0), "07:00", "19:00")).toBe(false);
    expect(isNight(at(18, 59, 59), "07:00", "19:00")).toBe(false);
    expect(isNight(at(19, 0), "07:00", "19:00")).toBe(true);
    expect(isNight(at(0, 0), "07:00", "19:00")).toBe(true);
  });

  it("handles a night that starts after midnight", () => {
    expect(isNight(at(0, 30), "09:00", "01:00")).toBe(false);
    expect(isNight(at(1, 0), "09:00", "01:00")).toBe(true);
    expect(isNight(at(8, 59), "09:00", "01:00")).toBe(true);
    expect(isNight(at(12, 0), "09:00", "01:00")).toBe(false);
  });

  it("never switches when both times are equal", () => {
    expect(isNight(at(3), "07:00", "07:00")).toBe(false);
    expect(msToNextSwitch(at(3), "07:00", "07:00")).toBe(Infinity);
  });

  it("finds the next switch time", () => {
    expect(msToNextSwitch(at(6), "07:00", "19:00")).toBe(HOUR);
    expect(msToNextSwitch(at(7), "07:00", "19:00")).toBe(12 * HOUR);
    expect(msToNextSwitch(at(12, 30), "07:00", "19:00")).toBe(6.5 * HOUR);
    expect(msToNextSwitch(at(20), "07:00", "19:00")).toBe(11 * HOUR);
    expect(msToNextSwitch(at(18, 59, 59), "07:00", "19:00")).toBe(1000);
  });
});

describe("wallpaper choice", () => {
  const s = normalizeSettings({
    wallpaper: {
      source: "color",
      color: "#112233",
      perPage: { "\\\\.\\DISPLAY1|1": { source: "gradient" } },
      dayNight: { enabled: true, night: { source: "color", color: "#000000" } },
    },
  });

  it("per page > night > main", () => {
    expect(wallpaperFor(s.wallpaper, "\\\\.\\DISPLAY1", 1, true).key).toBe("page:\\\\.\\DISPLAY1|1");
    expect(wallpaperFor(s.wallpaper, "\\\\.\\DISPLAY1", 1, true).spec.source).toBe("gradient");
    expect(wallpaperFor(s.wallpaper, "\\\\.\\DISPLAY1", 0, true)).toMatchObject({ key: "night", spec: { color: "#000000" } });
    expect(wallpaperFor(s.wallpaper, "\\\\.\\DISPLAY1", 0, false)).toMatchObject({ key: "main", spec: { color: "#112233" } });
    expect(wallpaperFor(s.wallpaper, "\\\\.\\DISPLAY2", 1, false).key).toBe("main");
  });

  it("ignores night when day / night is off", () => {
    const off = normalizeSettings({ ...s, wallpaper: { ...s.wallpaper, dayNight: { ...s.wallpaper.dayNight, enabled: false } } });
    expect(wallpaperFor(off.wallpaper, "x", 0, true).key).toBe("main");
  });

  it("parallax overscan stays within 30 %", () => {
    expect(parallaxStep(1000, 1)).toBe(0);
    expect(parallaxStep(1000, 2)).toBe(100);
    expect(parallaxStep(1000, 7) * 6).toBeCloseTo(300);
  });
});

const fill = (rgba: number[], n: number) => Array.from({ length: n }, () => rgba).flat();
const hue = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};

describe("dominant colour", () => {
  it("picks the vivid hue over grey", () => {
    const c = dominantColor([...fill([220, 30, 30, 255], 100), ...fill([128, 128, 128, 255], 300)]);
    expect(c).not.toBeNull();
    expect(hue(c!)).toBeLessThan(15);
  });

  it("weighs area against vividness", () => {
    const c = dominantColor([...fill([20, 40, 110, 255], 100), ...fill([250, 230, 20, 255], 30)]);
    expect(hue(c!)).toBeGreaterThan(200);
    expect(hue(c!)).toBeLessThan(240);
  });

  it("returns null for grey, black or white pictures", () => {
    expect(dominantColor(fill([128, 128, 128, 255], 50))).toBeNull();
    expect(dominantColor([...fill([0, 0, 0, 255], 50), ...fill([255, 255, 255, 255], 50)])).toBeNull();
    expect(dominantColor([])).toBeNull();
  });

  it("ignores transparent pixels", () => {
    const c = dominantColor([...fill([0, 200, 0, 0], 500), ...fill([40, 90, 230, 255], 10)]);
    expect(hue(c!)).toBeGreaterThan(200);
  });

  it("keeps the accent readable", () => {
    const c = dominantColor(fill([255, 240, 245, 255], 10)); // very light pink
    if (c) {
      const n = parseInt(c.slice(1), 16);
      const l = (Math.max((n >> 16) & 255, (n >> 8) & 255, n & 255) + Math.min((n >> 16) & 255, (n >> 8) & 255, n & 255)) / 510;
      expect(l).toBeLessThanOrEqual(0.61);
    }
    expect(accentFromColors(["#1e3a8a", "#7c3aed"])).toMatch(/^#[0-9a-f]{6}$/);
    expect(accentFromColors(["#808080"])).toBeNull();
  });
});

describe("icon pack", () => {
  const map = { "google chrome": "C:\\p\\google chrome.png", "visual-studio-code": "C:\\p\\vsc.svg", spotify: "C:\\p\\spotify.png", trash: "C:\\p\\trash.png", "user-trash-full": "C:\\p\\trash-full.png" };
  const item = (p: Partial<DesktopItem>): DesktopItem => ({
    id: "x",
    kind: "file",
    path: "C:\\Users\\a\\Desktop\\x.lnk",
    parsingName: "",
    name: "x",
    ext: ".lnk",
    isShortcut: true,
    isPublic: false,
    modified: 0,
    size: 0,
    iconVersion: "1",
    ...p,
  });

  it("matches the display name, exact or loose", () => {
    expect(packMatch(map, packNames(item({ name: "Google Chrome" })))).toBe(map["google chrome"]);
    expect(packMatch(map, packNames(item({ name: "Visual Studio Code" })))).toBe(map["visual-studio-code"]);
  });

  it("falls back to the file stem, then to later names", () => {
    expect(packMatch(map, packNames(item({ name: "Müzik", path: "C:\\Users\\a\\Desktop\\Spotify.lnk" })))).toBe(map.spotify);
    expect(packMatch(map, [null, "nothing", "SPOTIFY"])).toBe(map.spotify);
    expect(packMatch(map, packNames(item({ name: "Belge" })))).toBeNull();
    expect(packMatch(map, ["constructor", "toString", "__proto__"])).toBeNull();
  });

  it("knows the system icons by their usual pack names", () => {
    const bin = item({ id: "::{645ff040-5081-101b-9f08-00aa002f954e}", kind: "system", path: "::{645FF040-5081-101B-9F08-00AA002F954E}", name: "Geri Dönüşüm Kutusu" });
    expect(packMatch(map, packNames(bin))).toBe(map.trash);
    expect(packMatch(map, packNames({ ...bin, recycleFull: true }))).toBe(map["user-trash-full"]);
  });

  it("stems paths", () => {
    expect(stemOf("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")).toBe("chrome");
    expect(stemOf("C:\\a\\.hidden")).toBe(".hidden");
    expect(stemOf("C:\\a\\Klasör\\")).toBe("Klasör");
  });
});

describe("visual css helpers", () => {
  it("plate radius per shape", () => {
    expect(plateRadius("none")).toBe("0");
    expect(plateRadius("circle")).toBe("50%");
    expect(plateRadius("teardrop")).toContain("14%");
  });

  it("label shadow: none at 0, the classic look at 0.6, a light halo for dark text", () => {
    expect(labelShadow(0, null)).toBe("none");
    expect(labelShadow(0.6, null)).toBe("0 1px 2.2px rgba(0, 0, 0, 0.85), 0 0 6.2px rgba(0, 0, 0, 0.45)");
    expect(labelShadow(0.6, "#111111")).toContain("rgba(255, 255, 255");
  });

  it("group box: defaults change nothing, per-group look wins", () => {
    const off = groupBoxParts(DEFAULT_SETTINGS.groupBox, { tint: "#ff0000", dark: true });
    expect(off).toEqual({ border: null, drop: null, glow: null, gradient: null });
    expect(groupBoxStyle(off, "var(--shadow-lg)")).toEqual({});
    const box = resolveGroupBox(DEFAULT_SETTINGS.groupBox, { borderWidth: 2, glow: 0.5, gradient: true });
    const p = groupBoxParts(box, { tint: "var(--accent)", dark: false });
    expect(p.border).toBe("2px solid rgba(0, 0, 0, 0.25)");
    expect(p.glow).toContain("color-mix(in srgb, var(--accent)");
    expect(p.gradient).toContain("linear-gradient");
    expect(groupBoxStyle(p, "var(--shadow-lg)").boxShadow).toBe(`var(--shadow-lg), ${p.glow}`);
  });

  it("group tile keeps the default look and drops it at 0 % opacity", () => {
    const def = groupTileStyle({ color: null, opacity: 0.32, box: DEFAULT_SETTINGS.groupBox, dark: true });
    expect(def.borderPx).toBe(1);
    expect(def.style.background).toBe("rgba(255, 255, 255, 0.32)");
    expect(def.style.boxShadow).toContain("0 3px 10px");
    const gone = groupTileStyle({ color: "#ff0000", opacity: 0, box: DEFAULT_SETTINGS.groupBox, dark: true });
    expect(gone.style.boxShadow).toBe("none");
    const framed = groupTileStyle({ color: null, opacity: 0, box: { ...DEFAULT_SETTINGS.groupBox, borderWidth: 3, shadow: 1 }, dark: true });
    expect(framed.borderPx).toBe(3);
    expect(framed.style.border).toMatch(/^3px solid/);
    expect(framed.style.boxShadow).toContain("rgba(0, 0, 0, 0.58)");
  });
});

describe("label size and the grid", () => {
  const laptop: MonitorInfo = {
    id: "m",
    primary: true,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    work: { x: 0, y: 0, width: 1920, height: 1032 },
    scale: 1.25,
  };

  it("bigger labels make taller and wider cells", () => {
    const base = cellMetrics(laptop, 1.25, DEFAULT_SETTINGS, 48);
    const big = cellMetrics(laptop, 1.25, normalizeSettings({ labels: { size: 16 } }), 48);
    expect(big.iconSize).toBe(base.iconSize);
    expect(big.cellH - base.cellH).toBe(Math.round(2 * 4 * 1.28));
    expect(base.cellW).toBe(78);
    expect(big.cellW).toBe(101);
    const small = cellMetrics(laptop, 1.25, normalizeSettings({ labels: { size: 10 } }), 48);
    expect(small.cellW).toBe(78);
  });
});
