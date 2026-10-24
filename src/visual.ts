// Pure helpers for the visual settings on the desktop: wallpaper choice, day / night clock,
// accent from the wallpaper, icon pack lookup. No DOM, unit-tested in visual.test.ts.

import type { DesktopItem, Settings, WallpaperSpec } from "./types";

// ---------------------------------------------------------------- day / night

const minutesOf = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Night = from `nightStart` up to `dayStart` (local time); equal times = never night. */
export function isNight(now: Date, dayStart: string, nightStart: string): boolean {
  const d = minutesOf(dayStart);
  const n = minutesOf(nightStart);
  if (d === n) return false;
  const m = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  return n > d ? m >= n || m < d : m >= n && m < d;
}

/** Milliseconds until the next day ↔ night switch (local time, DST-safe); Infinity when there is none. */
export function msToNextSwitch(now: Date, dayStart: string, nightStart: string): number {
  if (minutesOf(dayStart) === minutesOf(nightStart)) return Infinity;
  let best = Infinity;
  for (const hm of [dayStart, nightStart]) {
    const m = minutesOf(hm);
    const at = new Date(now);
    at.setHours(Math.floor(m / 60), m % 60, 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    best = Math.min(best, at.getTime() - now.getTime());
  }
  return best;
}

// ---------------------------------------------------------------- wallpaper choice

export type WallpaperChoice = { key: string; spec: WallpaperSpec };

/** The wallpaper of a monitor's page: its own (per page) > the night one (at night) > the main one. */
export function wallpaperFor(wp: Settings["wallpaper"], monitorId: string, page: number, night: boolean): WallpaperChoice {
  const pk = `${monitorId}|${page}`;
  const own = wp.perPage[pk];
  if (own) return { key: `page:${pk}`, spec: own };
  if (night && wp.dayNight.enabled) return { key: "night", spec: wp.dayNight.night };
  return { key: "main", spec: wp };
}

/** We paint this wallpaper ourselves (else the transparent window shows Windows' own, no parallax). */
export const drawsWallpaper = (spec: WallpaperSpec) => spec.source !== "windows";

/** Parallax shift per page (px): a tenth of the width, less with many pages (overscan ≤ 30 %). */
export function parallaxStep(width: number, pages: number) {
  return pages > 1 ? width * Math.min(0.1, 0.3 / (pages - 1)) : 0;
}

// ---------------------------------------------------------------- accent from the wallpaper

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max / 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return [h < 0 ? h + 360 : h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

const BUCKETS = 36;

/**
 * A usable accent from RGBA pixel data: the hue that covers the most vivid area wins (saturation ×
 * brightness weighs each pixel), then it is brought into a readable saturation / lightness range.
 * Null for a grey / black / white picture.
 */
export function dominantColor(px: ArrayLike<number>): string | null {
  const w = new Float64Array(BUCKETS);
  const sum = new Float64Array(BUCKETS * 3);
  let count = 0;
  let vivid = 0;
  for (let i = 0; i + 3 < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    count++;
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const [h, s, v] = rgbToHsv(r, g, b);
    if (s < 0.15 || v < 0.15) continue;
    const weight = s * v;
    const k = Math.floor(h / (360 / BUCKETS)) % BUCKETS;
    w[k] += weight;
    sum[k * 3] += r * weight;
    sum[k * 3 + 1] += g * weight;
    sum[k * 3 + 2] += b * weight;
    vivid += weight;
  }
  if (!count || vivid / count < 0.02) return null;
  let best = 0;
  let bestScore = -1;
  for (let k = 0; k < BUCKETS; k++) {
    const score = w[k] + 0.5 * (w[(k + BUCKETS - 1) % BUCKETS] + w[(k + 1) % BUCKETS]);
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  let tw = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const k of [best - 1, best, best + 1]) {
    const j = (k + BUCKETS) % BUCKETS;
    tw += w[j];
    r += sum[j * 3];
    g += sum[j * 3 + 1];
    b += sum[j * 3 + 2];
  }
  const [h, s, l] = rgbToHsl(r / tw, g / tw, b / tw);
  return hslToHex(h, Math.min(0.85, Math.max(0.45, s)), Math.min(0.6, Math.max(0.45, l)));
}

/** dominantColor of a few solid colours ("#rrggbb"), e.g. a colour or gradient wallpaper. */
export function accentFromColors(colors: string[]): string | null {
  const px: number[] = [];
  for (const c of colors) {
    const h = c.replace("#", "");
    const full = h.length === 3 ? h.split("").map((x) => x + x).join("") : h.padEnd(6, "0");
    const n = parseInt(full.slice(0, 6), 16);
    if (Number.isNaN(n)) continue;
    px.push((n >> 16) & 255, (n >> 8) & 255, n & 255, 255);
  }
  return dominantColor(px);
}

// ---------------------------------------------------------------- icon pack

/** Loose key: lowercase letters and digits only ("Google-Chrome" ≡ "google chrome" ≡ "googlechrome"). */
export const looseKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const indexes = new WeakMap<Record<string, string>, Map<string, string>>();

function packIndex(map: Record<string, string>) {
  let idx = indexes.get(map);
  if (!idx) {
    idx = new Map();
    for (const [k, v] of Object.entries(map)) {
      const lk = looseKey(k);
      if (lk && !idx.has(lk)) idx.set(lk, v);
    }
    indexes.set(map, idx);
  }
  return idx;
}

/** First candidate name that the pack has an icon for (exact lowercased key, then loose key). */
export function packMatch(map: Record<string, string>, names: (string | null | undefined)[]): string | null {
  const idx = packIndex(map);
  for (const n of names) {
    if (!n) continue;
    const k = n.toLowerCase();
    if (Object.hasOwn(map, k) && map[k]) return map[k];
    const loose = idx.get(looseKey(n));
    if (loose) return loose;
  }
  return null;
}

/** File name without folder and extension. */
export function stemOf(path: string): string {
  const base = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Common icon-pack names of the system icons (their shell names are localized). */
const SYSTEM_NAMES: Record<string, string[]> = {
  "::{20d04fe0-3aea-1069-a2d8-08002b30309d}": ["this pc", "computer", "my computer"],
  "::{645ff040-5081-101b-9f08-00aa002f954e}": ["recycle bin", "trash", "user trash"],
  "::{f02c1a0d-be21-4350-88b0-7367fc96ef3c}": ["network"],
  "::{5399e694-6ce5-4d6c-8fce-1d8870fdcba0}": ["control panel"],
  "::{26ee0668-a00a-44d7-9371-beb064c98683}": ["control panel"],
  "::{59031a47-3f72-44a7-89c5-5595fe6b30ee}": ["user files", "user", "home"],
};

const nameCache = new WeakMap<DesktopItem, string[]>();

/** Names an icon pack may use for an item, best first: shell display name, file stem, system aliases. */
export function packNames(item: DesktopItem): string[] {
  let names = nameCache.get(item);
  if (!names) {
    const sys = SYSTEM_NAMES[item.id];
    if (sys) {
      const full = item.recycleFull ? sys.map((n) => `${n} full`) : [];
      names = [...full, item.name, ...sys];
    } else names = [item.name, stemOf(item.path)];
    nameCache.set(item, names);
  }
  return names;
}
