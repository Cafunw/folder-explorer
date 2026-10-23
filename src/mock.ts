// Browser-only preview data (used when the page runs outside Tauri, e.g. `npm run dev` in a browser).

import type { DesktopItem, Environment, PersistedState, StartApp, WallpaperInfo } from "./types";

const names = [
  "Bu Bilgisayar",
  "Geri Dönüşüm Kutusu",
  "Google Chrome",
  "Visual Studio Code",
  "Spotify",
  "Discord",
  "Steam",
  "Figma",
  "Notion",
  "Telegram",
  "OBS Studio",
  "Blender",
  "Projeler",
  "Fotoğraflar",
  "rapor.docx",
  "bütçe.xlsx",
  "WhatsApp",
  "Slack",
  "Zoom",
  "Postman",
];

const hues = names.map((_, i) => (i * 47) % 360);

export const mockItems: DesktopItem[] = names.map((name, i) => {
  const system = i < 2;
  const folder = name === "Projeler" || name === "Fotoğraflar";
  const path = system ? `::{mock-${i}}` : `C:\\Users\\demo\\Desktop\\${name}${folder || name.includes(".") ? "" : ".lnk"}`;
  return {
    id: path.toLowerCase(),
    kind: system ? "system" : folder ? "folder" : "file",
    path,
    parsingName: path,
    name,
    ext: folder || system ? "" : name.includes(".") ? name.slice(name.lastIndexOf(".")) : ".lnk",
    isShortcut: !folder && !system && !name.includes("."),
    isPublic: false,
    modified: Date.now() - i * 3600_000,
    size: i * 1000,
    iconVersion: "1",
  };
});

export function mockIcon(parsingName: string): string {
  const i = Math.max(0, mockItems.findIndex((m) => m.parsingName === parsingName));
  const name = mockItems[i]?.name ?? parsingName;
  const h = hues[i] ?? 200;
  const letter = name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1).toUpperCase() || "?";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},85%,62%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360},80%,48%)"/></linearGradient></defs><rect x="4" y="4" width="56" height="56" rx="14" fill="url(#g)"/><text x="32" y="42" font-family="Segoe UI" font-size="28" font-weight="700" fill="white" text-anchor="middle">${letter}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export const mockEnv = (): Environment => {
  const w = Math.round(window.innerWidth * devicePixelRatio);
  const h = Math.round(window.innerHeight * devicePixelRatio);
  return {
    monitors: [
      {
        id: "\\\\.\\DISPLAY1",
        primary: true,
        bounds: { x: 0, y: 0, width: w, height: h },
        work: { x: 0, y: 0, width: w, height: h - Math.round(48 * devicePixelRatio) },
        scale: devicePixelRatio,
      },
    ],
    windowOrigin: { x: 0, y: 0 },
    scaleFactor: devicePixelRatio,
    desktopDir: "C:\\Users\\demo\\Desktop",
    publicDesktopDir: "C:\\Users\\Public\\Desktop",
    isDev: true,
  };
};

const KEY = "fe-mock-state";
export function mockLoad(): PersistedState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { layout: null, settings: null };
}

export function mockSave(part: "layout" | "settings", value: unknown) {
  try {
    const cur = mockLoad();
    localStorage.setItem(KEY, JSON.stringify({ ...cur, [part]: value }));
  } catch {
    /* ignore */
  }
}

export const mockWallpapers = (): WallpaperInfo[] => [
  { monitorId: "\\\\.\\DISPLAY1", path: null, position: "fill", color: "#1e293b", version: "1" },
];

export const mockApps: StartApp[] = names.slice(2).map((n) => ({ name: n, parsingName: `shell:AppsFolder\\${n}` }));
