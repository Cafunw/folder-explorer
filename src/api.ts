import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  BackupInfo,
  DesktopItem,
  Environment,
  PersistedState,
  StartApp,
  WallpaperInfo,
  WindowsLayout,
} from "./types";
import * as mock from "./mock";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const realApi = {
  getEnvironment: () => invoke<Environment>("get_environment"),
  listDesktopItems: () => invoke<DesktopItem[]>("list_desktop_items"),
  getWindowsLayout: () => invoke<WindowsLayout>("get_windows_layout"),
  openItem: (path: string) => invoke<void>("open_item", { path }),
  showShellMenu: (paths: string[], at?: [number, number]) => invoke<string | null>("show_shell_menu", { paths, at }),
  showItemMenu: (request: unknown, width: number, height: number) =>
    invoke<void>("show_item_menu", { request, width, height }),
  takeMenuRequest: () => invoke<unknown>("take_menu_request"),
  hideMenu: () => invoke<void>("hide_menu"),
  clipboardFiles: (paths: string[], cut: boolean) => invoke<void>("clipboard_files", { paths, cut }),
  copyText: (text: string) => invoke<void>("copy_text", { text }),
  showProperties: (path: string) => invoke<void>("show_properties", { path }),
  runAsAdmin: (path: string) => invoke<void>("run_as_admin", { path }),
  debugLog: (line: string) => invoke<void>("debug_log", { line }),
  setInputRegions: (all: boolean, rects: number[][]) => invoke<void>("set_input_regions", { all, rects }),
  recycle: (paths: string[]) => invoke<void>("recycle", { paths }),
  restoreFromRecycle: (paths: string[]) => invoke<string[]>("restore_from_recycle", { paths }),
  renameItem: (path: string, newName: string) => invoke<string>("rename_item", { path, newName }),
  moveIntoFolder: (paths: string[], targetDir: string) =>
    invoke<void>("move_into_folder", { paths, targetDir }),
  importDropped: (paths: string[], copy: boolean) =>
    invoke<string[]>("import_dropped", { paths, copy }),
  startDragOut: (paths: string[]) => invoke<string>("start_drag_out", { paths }),
  cursorOverForeignWindow: () => invoke<boolean>("cursor_over_foreign_window"),
  listStartApps: () => invoke<StartApp[]>("list_start_apps"),
  createShortcut: (parsingName: string, name: string) =>
    invoke<string>("create_shortcut", { parsingName, name }),
  createUrlShortcut: (url: string, name: string) =>
    invoke<string>("create_url_shortcut", { url, name }),
  getWallpapers: () => invoke<WallpaperInfo[]>("get_wallpapers"),
  loadState: () => invoke<PersistedState>("load_state"),
  saveLayout: (layout: unknown) => invoke<void>("save_layout", { layout }),
  saveSettings: (settings: unknown) => invoke<void>("save_settings", { settings }),
  listBackups: () => invoke<BackupInfo[]>("list_backups"),
  restoreBackup: (name: string) => invoke<PersistedState>("restore_backup", { name }),
  exportState: (path: string) => invoke<void>("export_state", { path }),
  importState: (path: string) => invoke<PersistedState>("import_state", { path }),
  importMedia: (path: string, kind: "icon" | "wallpaper") =>
    invoke<string>("import_media", { path, kind }),
  openSettingsWindow: () => invoke<void>("open_settings_window"),
  showSearch: (initial?: string) => invoke<void>("show_search", { initial: initial ?? "" }),
  hideSearch: () => invoke<void>("hide_search"),
  takeSearchInitial: () => invoke<string>("take_search_initial"),
  raiseDesktop: (raised: boolean) => invoke<void>("raise_desktop", { raised }),
  setWindowsIconsMode: (enabled: boolean) => invoke<void>("set_windows_icons_mode", { enabled }),
  quitApp: () => invoke<void>("quit_app"),
};

// Browser preview (outside Tauri): fake data so the UI can be developed in a normal browser.
const noop = async () => {};
const mockApi: typeof realApi = {
  ...(Object.fromEntries(Object.keys(realApi).map((k) => [k, noop])) as unknown as typeof realApi),
  getEnvironment: async () => mock.mockEnv(),
  listDesktopItems: async () => mock.mockItems,
  getWindowsLayout: async () => ({ spacing: null, items: [] }),
  loadState: async () => mock.mockLoad(),
  saveLayout: async (l: unknown) => mock.mockSave("layout", l),
  saveSettings: async (s: unknown) => mock.mockSave("settings", s),
  getWallpapers: async () => mock.mockWallpapers(),
  listStartApps: async () => mock.mockApps,
  listBackups: async () => [],
  cursorOverForeignWindow: async () => false,
  showShellMenu: async () => null,
  restoreFromRecycle: async () => [],
  importDropped: async (p: string[]) => p,
  renameItem: async (p: string, n: string) => p.replace(/[^\\]+$/, n),
};

export const api = isTauri ? realApi : mockApi;

export function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!isTauri) return Promise.resolve(() => {});
  return listen<T>(event, (e) => handler(e.payload));
}

export function emitToWindow(label: string, event: string, payload: unknown) {
  if (!isTauri) return Promise.resolve();
  return emitTo(label, event, payload);
}

const feBase = (route: string) => (isTauri ? convertFileSrc(route, "fe") : `/__fe/${route}`);

export function iconUrl(parsingName: string, sizePx: number, version: string) {
  if (!isTauri) return mock.mockIcon(parsingName);
  const s = Math.max(16, Math.min(256, Math.round(sizePx)));
  return `${feBase("icon")}?p=${encodeURIComponent(parsingName)}&s=${s}&v=${encodeURIComponent(version)}`;
}

export function wallpaperUrl(monitorId: string, version: string) {
  return `${feBase("wallpaper")}?m=${encodeURIComponent(monitorId)}&v=${encodeURIComponent(version)}`;
}

export function mediaUrl(path: string) {
  return `${feBase("media")}?p=${encodeURIComponent(path)}`;
}
