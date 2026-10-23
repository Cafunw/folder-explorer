// Shared types. Must match docs/ARCHITECTURE.md and the Rust side.

export type Rect = { x: number; y: number; width: number; height: number };

export type MonitorInfo = {
  id: string;
  primary: boolean;
  bounds: Rect;
  work: Rect;
  scale: number;
};

export type Environment = {
  monitors: MonitorInfo[];
  windowOrigin: { x: number; y: number };
  scaleFactor: number;
  desktopDir: string;
  publicDesktopDir: string;
  isDev: boolean;
};

export type DesktopItem = {
  id: string;
  kind: "file" | "folder" | "system";
  path: string;
  parsingName: string;
  name: string;
  ext: string;
  isShortcut: boolean;
  isPublic: boolean;
  modified: number;
  size: number;
  iconVersion: string;
  recycleFull?: boolean;
};

export type WindowsLayout = {
  spacing: { x: number; y: number } | null;
  items: { id: string; x: number; y: number }[];
};

export type WallpaperInfo = {
  monitorId: string;
  path: string | null;
  position: "fill" | "fit" | "stretch" | "tile" | "center" | "span";
  color: string;
  version: string;
};

export type StartApp = { name: string; parsingName: string };

export type PersistedState = { layout: unknown | null; settings: unknown | null };
export type BackupInfo = { name: string; createdAt: number; size: number };

// ---------- Layout (owned by the UI, persisted as JSON) ----------

export type Placement = { m: string; p: number; c: number; r: number };

/** Per-folder look; anything left out follows the global settings. */
export type FolderLook = {
  opacity?: number; // tile background 0..1 (0 = fully transparent)
  blur?: number; // px
  radius?: number; // 0..0.5 of the tile size
  preview?: 2 | 3;
  icon?: string; // custom image (media path) instead of the mini-icon preview
  panelStyle?: "ios" | "android";
  panelOpacity?: number; // open folder background 0..1
};

export type VirtualFolder = {
  id: string;
  name: string;
  color: string | null;
  children: string[];
  look?: FolderLook;
};

export type Remembered = {
  at: number;
  placement?: Placement;
  folder?: string;
  index?: number;
};

export type Layout = {
  version: 1;
  folders: Record<string, VirtualFolder>;
  placements: Record<string, Placement>;
  custom: Record<string, { name?: string; icon?: string }>;
  remembered: Record<string, Remembered>;
  /**
   * Where an item really belongs when the screen pushed it elsewhere (resolution / DPI /
   * work-area change, missing monitor). It returns there as soon as that cell exists again.
   */
  home: Record<string, { placement: Placement; at: number }>;
  importedFromWindows: boolean;
};

// ---------- Settings ----------

export type ThemeMode = "system" | "light" | "dark";
export type FolderStyle = "ios" | "android";
export type WallpaperSource = "windows" | "image" | "color" | "gradient";

export type Settings = {
  version: 1;
  theme: ThemeMode;
  accent: string;
  wallpaper: {
    source: WallpaperSource;
    image: string | null;
    color: string;
    gradient: { from: string; to: string; angle: number };
    blur: number; // px
    dim: number; // 0..0.8
  };
  grid: {
    iconSize: number; // css px
    cellWidth: number;
    cellHeight: number;
    labels: boolean;
    labelLines: 1 | 2 | 3;
    autoArrange: boolean;
  };
  folders: {
    style: FolderStyle;
    preview: 2 | 3;
    radius: number; // 0..0.5 (fraction of the tile size)
    panelColumns: number;
    defaultColor: string | null;
  };
  transparency: {
    folderTile: number; // 0..1 background opacity of the folder tile
    folderTileBlur: number; // px
    panel: number; // 0..1 background opacity of an open folder
    panelBlur: number; // px
    labelBg: number; // 0..1 label pill opacity
    iconOpacity: number; // 0.2..1
  };
  animation: { speed: number; reduceMotion: boolean };
  behavior: {
    lockLayout: boolean;
    searchHotkey: string;
    startWithWindows: boolean;
    showSystemIcons: boolean;
    typeToSearch: boolean;
  };
};
