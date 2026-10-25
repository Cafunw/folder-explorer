// Shared types. Must match docs/ARCHITECTURE.md and the Rust side.

export type Rect = { x: number; y: number; width: number; height: number };

export type MonitorInfo = {
  id: string;
  primary: boolean;
  bounds: Rect;
  work: Rect;
  scale: number;
  sizeMm?: { width: number; height: number } | null; // physical size (EDID); null when unknown
};

export type Environment = {
  monitors: MonitorInfo[];
  windowOrigin: { x: number; y: number };
  scaleFactor: number;
  desktopDir: string;
  publicDesktopDir: string;
  isDev: boolean;
};

/** Quiet modes (`quiet-changed` / `get_quiet`): game = a fullscreen app covers a monitor. */
export type Quiet = {
  game: boolean;
  battery: boolean;
  covered: string[]; // MonitorInfo.id of the covered monitors
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

/** Quick Look / search lookups (shell.rs, read-only). */
export type DirEntryInfo = { name: string; path: string; isDir: boolean; size: number; modified: number };
export type DirPreview = { entries: DirEntryInfo[]; total: number };
export type ShortcutInfo = { target: string; args: string; workDir: string; description: string; isDir?: boolean };
export type RecentFile = { name: string; path: string; modified: number };
export type FoundFile = { name: string; path: string; parsingName: string; isDir: boolean };

export type PersistedState = { layout: unknown | null; settings: unknown | null };
export type BackupInfo = { name: string; createdAt: number; size: number };

// ---------- Layout (owned by the UI, persisted as JSON) ----------

/** w × h = cells covered (fences, headings); unset = 1 × 1 */
export type Placement = { m: string; p: number; c: number; r: number; w?: number; h?: number };

/** Per-folder look; anything left out follows the global settings. */
export type FolderLook = {
  opacity?: number; // tile background 0..1 (0 = fully transparent)
  blur?: number; // px
  radius?: number; // 0..0.5 of the tile size
  preview?: 2 | 3;
  icon?: string; // custom image (media path) instead of the mini-icon preview
  panelStyle?: "ios" | "android";
  panelOpacity?: number; // open folder background 0..1
  borderWidth?: number; // px 0..4
  borderColor?: string;
  shadow?: number; // 0..1
  gradient?: boolean;
  glow?: number; // 0..1
  openStyle?: OpenStyle;
};

/** Where a group's content comes from. */
export type GroupKind =
  | "group" // the user's own items (default)
  | "smart" // collects the loose desktop items matching `rule`
  | "live" // shows a real folder on disk (`source`), live
  | "frequent" // shows the most opened items (a view, items stay where they are)
  | "temp"; // items older than `tempDays` are offered to move to an archive group

/** How a group is shown. */
export type GroupDisplay =
  | "panel" // opens as a panel (default)
  | "fence" // always open box on the desktop, spans placement.w × h cells
  | "stack" // fans out from its tile
  | "tabs"; // child groups are tabs

export type SmartCondition =
  | { field: "ext"; value: string[] } // [".png", ".jpg"]
  | { field: "name"; op: "contains" | "startsWith"; value: string }
  | { field: "type"; value: SmartType }
  | { field: "age"; op: "newerThan" | "olderThan"; days: number };

export type SmartType = "shortcut" | "folder" | "file" | "document" | "image" | "video" | "audio" | "archive" | "game";

export type SmartRule = { all: boolean; conditions: SmartCondition[] };

/** Privacy lock: the group's content is hidden until verified (files stay visible in Explorer). */
export type GroupLock = { method: "pin" | "hello"; hash: string | null; salt: string | null };

export type VirtualFolder = {
  id: string;
  name: string;
  color: string | null;
  children: string[];
  look?: FolderLook;
  kind?: GroupKind;
  display?: GroupDisplay;
  rule?: SmartRule; // smart
  exclude?: string[]; // smart: items the user took out, never collected again
  source?: string; // live: directory path
  limit?: number; // frequent: how many items
  tempDays?: number; // temp
  added?: Record<string, number>; // temp: when each child came in (ms)
  activeTab?: string; // tabs: the open child group
  lock?: GroupLock;
  collapsed?: boolean; // fence: only the title bar is shown (its cells stay reserved)
};

/** A text heading or divider line on the desktop grid (id "h:<uuid>"). */
export type Heading = { id: string; text: string; style: "title" | "divider"; align: "left" | "center"; underline?: boolean };

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
  headings: Record<string, Heading>;
  /** how often / when each item was opened (frequent groups) */
  usage: Record<string, { n: number; last: number }>;
};

// ---------- Settings ----------

export type ThemeMode = "system" | "light" | "dark";
export type FolderStyle = "ios" | "android";
export type WallpaperSource = "windows" | "image" | "color" | "gradient";
export type IconShape = "none" | "circle" | "squircle" | "square" | "teardrop";
export type OpenStyle = "zoom" | "spring" | "flip" | "blur" | "fade";
export type PageTransition = "slide" | "cube" | "cards" | "fade";
export type HoverEffect = "none" | "lift" | "grow" | "tilt" | "glow" | "bounce" | "magnify";

export type WallpaperSpec = {
  source: WallpaperSource;
  image: string | null;
  color: string;
  gradient: { from: string; to: string; angle: number };
  blur: number; // px
  dim: number; // 0..0.8
};

export type Settings = {
  version: 1;
  theme: ThemeMode;
  accent: string;
  wallpaper: WallpaperSpec & {
    /** own wallpaper for a page, key `${monitorId}|${page}` */
    perPage: Record<string, WallpaperSpec>;
    /** a second wallpaper between nightStart and dayStart ("HH:MM", local time) */
    dayNight: { enabled: boolean; dayStart: string; nightStart: string; night: WallpaperSpec };
    /** the accent colour follows the wallpaper's dominant colour */
    accentFromWallpaper: boolean;
  };
  icons: {
    shape: IconShape; // a plate behind every icon ("none" = the icons as they are)
    plateColor: string | null; // null = follows the theme
    plateOpacity: number; // 0..1
    inset: number; // 0..0.35 icon margin inside the plate (fraction of the size)
    /** imported icon pack: lowercased item name or exe name → media path */
    pack: { name: string; map: Record<string, string> } | null;
  };
  labels: {
    font: string; // "" = system font
    size: number; // px 10..18
    weight: 400 | 500 | 600 | 700;
    color: string | null; // null = automatic
    shadow: number; // 0..1
    hoverOnly: boolean;
  };
  groupBox: {
    borderWidth: number; // px 0..4
    borderColor: string | null; // null = white / black by theme
    borderOpacity: number; // 0..1
    shadow: number; // 0..1
    gradient: boolean;
    glow: number; // 0..1
  };
  pageIndicator: { style: "dots" | "line" | "numbers" | "hidden"; position: "bottom" | "top" | "left" | "right" };
  selection: { color: string | null; style: "fill" | "outline" | "glow"; marqueeRadius: number };
  search: { calculator: boolean; recentFiles: boolean; files: boolean; settingsPages: boolean; web: boolean };
  performance: {
    gameMode: boolean; // fullscreen / borderless fullscreen app in front → quiet
    batteryMode: "auto" | "always" | "off"; // fewer effects on battery
  };
  grid: {
    autoSize: boolean; // icon + cell size follow each monitor's physical size and resolution
    iconSize: number; // css px, used when autoSize is off
    iconScale: number; // 0.5..3; View ▸ Large (2) / Medium (1) / Small (0.67), Ctrl+wheel in between
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
  animation: {
    speed: number;
    reduceMotion: boolean;
    openStyle: OpenStyle; // how a group panel opens
    pageTransition: PageTransition;
    parallax: boolean; // a custom wallpaper drifts with the page
    hover: HoverEffect;
    stiffness: number; // 0.5..2, springs get faster / slower
    bounce: number; // 0..2, multiplies every spring's bounce
    sounds: boolean;
    soundVolume: number; // 0..1
  };
  behavior: {
    lockLayout: boolean;
    startWithWindows: boolean;
    showSystemIcons: boolean;
    typeToSearch: boolean;
    showIcons: boolean; // View ▸ Show desktop icons
    doubleClickHide: boolean; // double-click on the empty desktop toggles showIcons
    longPressEdit: boolean; // holding an icon ~600 ms starts edit (jiggle) mode
    ctrlWheelZoom: boolean; // Ctrl+wheel changes grid.iconScale
    quickLook: boolean; // Space previews the selected item
    dropOnApp: boolean; // files dropped on an app open with it
    newMenuEntry: boolean; // "Folder Explorer grubu" in Windows' Yeni ▸ menu (per-user registry entry)
  };
  /** the user's own look (visual settings, see themes.ts) kept when a theme preset replaced it; read through applyThemePatch */
  customLook: Record<string, unknown> | null;
};
