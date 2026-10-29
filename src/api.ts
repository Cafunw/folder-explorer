import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  BackupInfo,
  DesktopItem,
  DirPreview,
  Environment,
  FoundFile,
  PersistedState,
  Quiet,
  RecentFile,
  ShortcutInfo,
  StartApp,
  WallpaperInfo,
  WindowsLayout,
} from "./types";

export const api = {
  getEnvironment: () => invoke<Environment>("get_environment"),
  listDesktopItems: () => invoke<DesktopItem[]>("list_desktop_items"),
  getWindowsLayout: () => invoke<WindowsLayout>("get_windows_layout"),
  openItem: (path: string) => invoke<void>("open_item", { path }),
  desktopContextMenu: (at: [number, number]) => invoke<void>("desktop_context_menu", { at }),
  itemContextMenu: (paths: string[], at: [number, number] | null) => invoke<void>("item_context_menu", { paths, at }),
  mirrorSelection: (paths: string[]) => invoke<void>("mirror_selection", { paths }),
  nativeMenu: (items: unknown[], at: [number, number] | null) => invoke<string | null>("native_menu", { items, at }),
  classicMenu: (paths: string[], at: [number, number] | null) =>
    invoke<string | null>("classic_menu", { paths, at }),
  shellVerb: (paths: string[], verbs: string[]) => invoke<boolean>("shell_verb", { paths, verbs }),
  newItem: (id: number) => invoke<void>("new_item", { id }),
  openWith: (paths: string[], index: number | null) => invoke<void>("open_with", { paths, index }),
  openVerb: (path: string, verbs: string[]) => invoke<void>("open_verb", { path, verbs }),
  openTerminal: (dir: string) => invoke<void>("open_terminal", { dir }),
  compress: (paths: string[], format: string) => invoke<string>("compress", { paths, format }),
  pasteFiles: (shortcuts: boolean) => invoke<string[]>("paste_files", { shortcuts }),
  clipboardFiles: (paths: string[], cut: boolean) => invoke<void>("clipboard_files", { paths, cut }),
  copyText: (text: string) => invoke<void>("copy_text", { text }),
  showProperties: (path: string) => invoke<void>("show_properties", { path }),
  runAsAdmin: (path: string) => invoke<void>("run_as_admin", { path }),
  debugLog: (line: string) => invoke<void>("debug_log", { line }),
  recycle: (paths: string[]) => invoke<void>("recycle", { paths }),
  restoreFromRecycle: (paths: string[]) => invoke<string[]>("restore_from_recycle", { paths }),
  /** `exact`: `newName` is the whole file name; otherwise a hidden extension (.lnk) is kept. */
  renameItem: (path: string, newName: string, exact = false) =>
    invoke<string>("rename_item", { path, newName, exact }),
  /** Each path's new place, in order; `null` where it did not move (skipped in Windows' conflict dialog). */
  moveIntoFolder: (paths: string[], targetDir: string) =>
    invoke<(string | null)[]>("move_into_folder", { paths, targetDir }),
  copyIntoFolder: (paths: string[], targetDir: string) =>
    invoke<void>("copy_into_folder", { paths, targetDir }),
  dropOnItem: (target: string, paths: string[]) => invoke<string>("drop_on_item", { target, paths }),
  importDropped: (paths: string[], copy: boolean) =>
    invoke<string[]>("import_dropped", { paths, copy }),
  startDragOut: (paths: string[]) => invoke<string>("start_drag_out", { paths }),
  cursorOverForeignWindow: () => invoke<boolean>("cursor_over_foreign_window"),
  listStartApps: () => invoke<StartApp[]>("list_start_apps"),
  listDirPreview: (path: string, limit?: number) => invoke<DirPreview>("list_dir_preview", { path, limit }),
  listFolder: (dir: string) => invoke<DesktopItem[]>("list_folder", { dir }),
  watchFolder: (dir: string) => invoke<void>("watch_folder", { dir }),
  unwatchFolder: (dir: string) => invoke<void>("unwatch_folder", { dir }),
  knownFolders: () =>
    invoke<{ downloads: string | null; documents: string | null; pictures: string | null }>("known_folders"),
  helloAvailable: () => invoke<boolean>("hello_available"),
  helloVerify: (message: string) => invoke<boolean>("hello_verify", { message }),
  shortcutTarget: (path: string) => invoke<ShortcutInfo | null>("shortcut_target", { path }),
  listRecent: (limit?: number) => invoke<RecentFile[]>("list_recent", { limit }),
  searchFiles: (query: string, limit?: number) => invoke<FoundFile[]>("search_files", { query, limit }),
  createShortcut: (parsingName: string, name: string) =>
    invoke<string>("create_shortcut", { parsingName, name }),
  createUrlShortcut: (url: string, name: string) =>
    invoke<string>("create_url_shortcut", { url, name }),
  getWallpapers: () => invoke<WallpaperInfo[]>("get_wallpapers"),
  getQuiet: () => invoke<Quiet>("get_quiet"),
  loadState: () => invoke<PersistedState>("load_state"),
  saveLayout: (layout: unknown) => invoke<void>("save_layout", { layout }),
  saveSettings: (settings: unknown) => invoke<void>("save_settings", { settings }),
  listBackups: () => invoke<BackupInfo[]>("list_backups"),
  restoreBackup: (name: string) => invoke<PersistedState>("restore_backup", { name }),
  exportState: (path: string) => invoke<void>("export_state", { path }),
  importState: (path: string) => invoke<PersistedState>("import_state", { path }),
  importMedia: (path: string, kind: "icon" | "wallpaper") =>
    invoke<string>("import_media", { path, kind }),
  importIconPack: (dir: string) => invoke<{ name: string; map: Record<string, string> }>("import_icon_pack", { dir }),
  exportTheme: (path: string, theme: unknown) => invoke<void>("export_theme", { path, theme }),
  importTheme: (path: string) => invoke<unknown>("import_theme", { path }),
  openSettingsWindow: () => invoke<void>("open_settings_window"),
  showSearch: (initial?: string) => invoke<void>("show_search", { initial: initial ?? "" }),
  hideSearch: () => invoke<void>("hide_search"),
  revealSearch: () => invoke<void>("reveal_search"),
  takeSearchInitial: () => invoke<string>("take_search_initial"),
  takeLaunchNewGroup: () => invoke<boolean>("take_launch_new_group"),
  raiseDesktop: (raised: boolean) => invoke<void>("raise_desktop", { raised }),
  setWindowsIconsMode: (enabled: boolean) => invoke<void>("set_windows_icons_mode", { enabled }),
  quitApp: () => invoke<void>("quit_app"),
  checkUpdate: () => invoke<{ version: string } | null>("check_update"),
  /** On success the app exits and the installer starts the new version. */
  installUpdate: () => invoke<void>("install_update"),
};

export function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}

export function emitToWindow(label: string, event: string, payload: unknown) {
  return emitTo(label, event, payload);
}

const feBase = (route: string) => convertFileSrc(route, "fe");

export function iconUrl(parsingName: string, sizePx: number, version: string) {
  const s = Math.max(16, Math.min(256, Math.round(sizePx)));
  // r: bumped when the backend renders icons differently, so the webview cache drops old PNGs
  return `${feBase("icon")}?p=${encodeURIComponent(parsingName)}&s=${s}&v=${encodeURIComponent(version)}&r=2`;
}

export function wallpaperUrl(monitorId: string, version: string) {
  return `${feBase("wallpaper")}?m=${encodeURIComponent(monitorId)}&v=${encodeURIComponent(version)}`;
}

export function mediaUrl(path: string) {
  return `${feBase("media")}?p=${encodeURIComponent(path)}`;
}

/** A file below a desktop folder (or a root registered with `icons::allow_root`), with Range support. */
export function previewUrl(path: string) {
  return `${feBase("preview")}?p=${encodeURIComponent(path)}`;
}

/** Large shell thumbnail (physical px, up to 1024). */
export function thumbUrl(path: string, sizePx: number, version: string) {
  const s = Math.max(16, Math.min(1024, Math.round(sizePx)));
  return `${feBase("thumb")}?p=${encodeURIComponent(path)}&s=${s}&v=${encodeURIComponent(version)}`;
}
