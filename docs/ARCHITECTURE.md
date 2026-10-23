# Folder Explorer — architecture & IPC contract

Folder Explorer replaces the Windows desktop icon layer with its own window so that
icons can be merged into phone-style (iOS/Android) folders.

* `src-tauri/` — Rust. Owns everything Win32: the desktop-level window, hiding the
  Windows icon view, enumerating desktop items, icons, shell menus, file operations,
  wallpaper, persistence on disk, tray, global hotkey, extra windows.
* `src/` — React + TypeScript + Motion. Owns all UI and **all layout logic**
  (grid placement, folders, undo/redo, reconciliation with the item list).
  The backend stores the layout and settings as opaque JSON.

UI language: Turkish. All UI strings live in `src/i18n.ts`.

## Core rule: Windows is never modified

This is the foundation of the architecture; everything else follows from it.

* **Windows' real desktop, Explorer and the right-click menu are not touched.** The desktop menu
  (Refresh, View, Sort, New ▸ Folder / Shortcut / …, Display settings, Personalize), selection,
  renaming, drops from other apps and every other built-in action keep working exactly as without
  Folder Explorer, because Windows itself receives them: right-click on an empty spot is handled by
  Explorer, natively (see *Input pass-through*). Nothing is forwarded, faked, injected or hooked.
* **No registry changes, no Explorer process changes, no hooks on system menus.** The app writes no
  registry values (the "start with Windows" option is a shortcut in the Startup folder), registers no
  shell extensions, never injects into or patches Explorer and never hooks its menus. The only
  system-wide listener is a passive `WinEventHook` for foreground changes (observe-only, runs in our
  own process) that keeps our window directly above the desktop. Entries that *earlier versions*
  wrote (the "Yeni ▸ Grup" New-menu entry, a Run value) are removed once at startup
  (`legacy.rs`) and by the uninstaller, so Windows is back to normal.
* **Our own context menu is only for our own objects.** Right-click on one of our icons opens the
  shell's item menu through the public `IContextMenu` API (`show_shell_menu`), a group opens its
  settings window, and anything we draw ourselves (folder panels, dialogs) may have its own menus.
  Nothing of ours ever opens on the Windows desktop itself.
* **When the app is closed or disabled the Windows desktop is completely normal.** The one thing
  the product needs is to hide Windows' *icon list* while we show our own icons (otherwise every
  icon would appear twice). That is a single reversible `ShowWindow(SW_HIDE)` on the
  `SysListView32`; it is undone on quit, crash, Ctrl+C, log-off, "Windows simgelerine dön" in the
  tray, and by a watchdog process, and an Explorer restart or reboot always brings the icons back.
  Reading the original icon positions (`IFolderView::GetItemPosition`) is read-only.

The previous implementation (forwarding menus to Explorer's hidden desktop view, a "Yeni ▸ Grup"
registry entry) broke this rule and was removed; a copy is archived in
`docs/archive/before-core-rule-explorer-forwarding.zip`.

### Input pass-through (`passthrough.rs`, `src/desktop/passthrough.ts`)
The transparent desktop window covers the whole screen, but it takes the mouse only where it has
something of its own: icon tiles (icon + label), page dots and toasts, plus the whole window while
a panel, dialog, drag or name box is open. The UI measures those rectangles (`[data-hit]`) and sends
them with `set_input_regions`. A poller thread (`fe-passthrough`, 10 ms; cursor position and button
state only) flips the window's `WS_EX_TRANSPARENT` bit: over nothing of ours the window is
click-through, so the click lands on Windows' own desktop. The window is layered for good
(`enforce_exstyle`) and only that one bit changes — switching `WS_EX_LAYERED` as well (Tauri's
`set_ignore_cursor_events` does) makes Windows hide and re-show the window each time, which made the
icons blink whenever the mouse moved. While an app window is in front of the point, the state is
left alone. A press that started on one of our
objects stays ours until released (so drags work); a press that started elsewhere follows the cursor
(so a file dragged in from another app can be dropped on one of our tiles).

While the window is click-through the poller also *observes* presses on the empty desktop (only when
Windows' own desktop is the window under the cursor, not an app in front) and tells the UI
(`empty-press` / `empty-drag` / `empty-release` / `empty-rclick`), which uses them for the
rubber-band selection and to place a new item (Windows' New ▸ Folder…) where the user right-clicked.

Consequences worth knowing: a folder created through Windows' New menu starts Windows' own in-place
rename inside Explorer's hidden list (invisible); it simply keeps its default name and is renamed
with F2 in our UI. "Yeni grup" lives in the tray menu and on Ctrl+Shift+N, not in Windows' New menu.

## Windows

| label      | url                         | notes |
|------------|-----------------------------|-------|
| `desktop`  | `index.html?view=desktop`   | Created by Rust at startup. Covers the bounding box of all monitors (physical px). No decorations, **transparent** (the real wallpaper — incl. slideshows and Wallpaper Engine — shows through), `WS_EX_TOOLWINDOW`, kept directly above the shell desktop (Progman) in z-order. The UI only paints a wallpaper when the user picks a custom one (image/colour/gradient). |
| `menu`     | `index.html?view=menu`      | Created hidden 2 s after start (so the first right-click is instant). The Windows 11 style popup for a right-click on one of OUR icons (`src/menu`): frameless, acrylic, always-on-top, skip taskbar, positioned at the cursor and flipped to stay on screen, hides when it loses focus / Esc. It tells the desktop window what was chosen (`menu-action`); it has no access to the desktop's state. |
| `search`   | `index.html?view=search`    | Created lazily. Frameless, transparent + acrylic, always-on-top, skip taskbar, ~680x480 logical, centered on the monitor under the cursor. Hidden (not closed) when dismissed. |
| `settings` | `index.html?view=settings`  | Created lazily. Normal decorated window ~1000x700 logical, mica. Closing it destroys it. |

### Desktop window z-order rules (Rust)
* Always anchored **directly above Progman** (`WM_WINDOWPOSCHANGING` forces `hwndInsertAfter`
  to the window right above Progman, or `HWND_TOP` when Progman is on top / that window is
  topmost). Normally Progman is at the bottom, so we are too — even when activated.
* **Our window is owned by Progman** (`own_by_progman`, `GWLP_HWNDPARENT`): Windows keeps an owned
  window above its owner and moves it along when the owner is raised. Clicking the empty desktop
  activates Progman (Windows' own desktop handles the click, see *Input pass-through*) and Windows
  lifts it for a moment; without ownership it went over our window and covered every icon for a frame
  (a visible blink on each click). Ownership is a property of OUR window only; nothing in Explorer is
  changed. It is re-applied every second and after `TaskbarCreated`. Because an owned window is destroyed
  with its owner, an Explorer restart destroys the desktop window; the app then starts a fresh copy
  (`--delayed-start 4`, only when it had run for 20 s, never when it is closing on purpose: tray, installer,
  log-off).
* A guard thread (`fe-zguard`, every millisecond with `timeBeginPeriod(1)`, Progman handle cached) fixes both directions of drift (`ensure_z`): Progman
  above us (Win+D / "Show desktop" lifts it) and a visible, non-minimized window between us and
  Progman (we drifted over app windows). It also re-shows us if we were hidden or minimized. In
  traces this puts the window back ~20 ms after Progman is raised, so the icons never blink.
* The window is excluded from Aero Peek (`DWMWA_EXCLUDED_FROM_PEEK`) and kept 6 px short of the
  monitors' right/bottom edge (`FIT_INSET`).
* Wallpaper Engine pauses for fullscreen / maximized windows by user setting; with nothing
  maximized it keeps playing with our window present.
* `raise_desktop(true)` enters raised mode on demand until another window becomes foreground (a
  1.5 s grace period after the raise ignores the foreground churn when a menu closes). The UI
  raises whenever a folder panel or settings dialog opens (any way: click, group right-click, tray,
  Ctrl+Shift+N, search) and lowers again when the last one closes.
* Non-client area is suppressed (`WM_NCCALCSIZE`/`WM_NCPAINT`/`WM_NCACTIVATE`), otherwise
  Windows paints a caption into the transparent window on activation.
* Never minimizable (strip `WS_MINIMIZEBOX`, ignore `SC_MINIMIZE`).
* `SetPropW(hwnd, "NonRudeHWND", 1)` so the taskbar does not treat it as a fullscreen app.

### Hiding the Windows icons
* `SysListView32` inside `SHELLDLL_DefView` gets `ShowWindow(SW_HIDE)` (non-persistent:
  an Explorer restart/reboot always brings icons back). Re-checked every 2 s and after
  `TaskbarCreated` (Explorer restart).
* Restored on quit, panic, console Ctrl+C, `WM_ENDSESSION`, and by a watchdog: the app
  spawns itself as `folder-explorer.exe --watchdog <pid>`; that process waits for the
  parent to exit and then shows the icons again. `main()` handles `--watchdog` before Tauri starts.
* Before hiding for the first time, the current Windows icon positions are captured via
  `IShellWindows::FindWindowSW(CSIDL_DESKTOP)` → `IFolderView::GetItemPosition` (+ `GetSpacing`).

## Coordinates
All rects coming from Rust are **physical screen pixels**. The frontend converts with
`css = (screen - windowOrigin) / scaleFactor`, where `windowOrigin` and `scaleFactor`
come from `get_environment`. (Mixed-DPI multi-monitor setups are approximated with
the window's scale factor.)

## Types (TS ⇄ Rust, camelCase JSON)

```ts
type Rect = { x: number; y: number; width: number; height: number };

type MonitorInfo = {
  id: string;            // device name, e.g. "\\\\.\\DISPLAY1"
  primary: boolean;
  bounds: Rect;          // physical, screen coords
  work: Rect;            // physical, screen coords (excludes taskbar)
  scale: number;         // monitor DPI / 96
};

type Environment = {
  monitors: MonitorInfo[];
  windowOrigin: { x: number; y: number }; // physical screen pos of desktop window client (0,0)
  scaleFactor: number;                     // desktop window scale factor
  desktopDir: string;
  publicDesktopDir: string;
  isDev: boolean;
};

type DesktopItem = {
  id: string;            // files: full path lowercased; system items: "::{clsid}" lowercased
  kind: "file" | "folder" | "system";   // folder = real directory on disk
  path: string;          // full path (original case) or "::{CLSID}"
  parsingName: string;   // what SHCreateItemFromParsingName accepts (== path for files)
  name: string;          // shell display name (SHGetFileInfo SHGFI_DISPLAYNAME)
  ext: string;           // lowercase ".lnk", ".txt", "" for dirs/system
  isShortcut: boolean;   // .lnk / .url
  isPublic: boolean;     // lives in the Public desktop
  modified: number;      // ms since epoch (0 for system)
  size: number;          // bytes (0 for dirs/system)
  iconVersion: string;   // changes when the icon may have changed (e.g. mtime)
  recycleFull?: boolean; // only for the Recycle Bin item
};

type WindowsLayout = {
  spacing: { x: number; y: number } | null;   // physical px, IFolderView::GetSpacing
  items: { id: string; x: number; y: number }[]; // physical screen coords of icon top-left
};

type WallpaperInfo = {
  monitorId: string;
  path: string | null;   // image path, null when solid colour
  position: "fill" | "fit" | "stretch" | "tile" | "center" | "span";
  color: string;         // "#rrggbb" background colour
  version: string;       // changes when the wallpaper changes
};

type StartApp = { name: string; parsingName: string /* "shell:AppsFolder\\<AUMID>" */ };

type PersistedState = { layout: unknown | null; settings: unknown | null };
type BackupInfo = { name: string; createdAt: number; size: number };
```

## Commands (`invoke(name, args)`; args camelCase)

| command | args | returns | notes |
|---|---|---|---|
| `get_environment` | – | `Environment` | |
| `list_desktop_items` | – | `DesktopItem[]` | user desktop + public desktop (skip hidden/system files and `desktop.ini`) + visible system icons (Recycle Bin, This PC, User files, Network, Control Panel per `HideDesktopIcons\NewStartPanel`) |
| `get_windows_layout` | – | `WindowsLayout` | snapshot captured at startup before hiding icons |
| `open_item` | `{ path }` | `()` | `ShellExecuteExW` "open"; system items via `explorer.exe shell:::{CLSID}` |
| `show_item_menu` | `{ request, width, height }` | `()` | shows the `menu` popup at the cursor; `request` = `{ ids, paths, system, canRunAs }` (opaque to Rust), size in CSS px |
| `take_menu_request` / `hide_menu` | – | `request \| null` / `()` | the popup pulls the request it was opened with (the event can arrive before it listens) / hides itself |
| `clipboard_files` | `{ paths, cut }` | `()` | Explorer's Copy / Cut: the shell data object on the clipboard (`OleSetClipboard` + flush; cut adds `Preferred DropEffect` = move). No shell extensions, so instant. |
| `copy_text` | `{ text }` | `()` | text to the clipboard ("Yol olarak kopyala") |
| `show_properties` / `run_as_admin` | `{ path }` | `()` | `SHObjectProperties` / `ShellExecuteEx` verb `runas` |
| `show_shell_menu` | `{ paths: string[], at?: [x, y] }` | `string \| null` | the shell's FULL classic item menu (public `IContextMenu` API: loads every shell extension, so it takes a moment) for one of OUR icons, at `at` (physical px) or the cursor; only used for "Daha fazla seçenek göster"; `paths[0]` is the clicked one (IContextMenu2/3 messages forwarded). If the user picks **rename** or **delete**, the verb is NOT invoked; returns `"rename"`/`"delete"` so the UI handles it (undoable). Otherwise invokes and returns the verb or `null`. |
| `set_input_regions` | `{ all: boolean, rects: [x, y, w, h][] }` | `()` | where the UI's own objects are (CSS px of the desktop window); `all` = a panel / dialog / drag is open. Everywhere else the window is click-through (see *Input pass-through*). |
| `recycle` | `{ paths }` | `()` | IFileOperation + FOFX_RECYCLEONDELETE / FOF_ALLOWUNDO |
| `restore_from_recycle` | `{ paths }` | `string[]` | restores the most recently deleted entries with these original paths ("undelete" verb); returns restored paths |
| `rename_item` | `{ path, newName }` | `string` (new path) | `newName` is a display name; keeps a hidden extension (.lnk, known types) |
| `move_into_folder` | `{ paths, targetDir }` | `()` | real move via IFileOperation (shows Windows conflict UI) |
| `import_dropped` | `{ paths, copy?: boolean }` | `string[]` | copy/move external files into the user desktop (default like Explorer: same drive moves, other drive copies; name collisions get a new name); returns the real new paths. Files already on a desktop are returned unchanged. |
| `start_drag_out` | `{ paths }` | `string` | native OLE drag (`SHDoDragDrop`), call while the mouse button is down; returns `"copy" \| "move" \| "link" \| "none"` |
| `cursor_over_foreign_window` | – | `boolean` | true when the top-level window under the cursor is not the desktop window (another app, taskbar…) |
| `list_start_apps` | – | `StartApp[]` | enumerate `FOLDERID_AppsFolder` |
| `create_shortcut` | `{ parsingName, name }` | `string` (path) | `.lnk` on the user desktop via IShellLinkW::SetIDList |
| `create_url_shortcut` | `{ url, name }` | `string` | `.url` file on the user desktop |
| `get_wallpapers` | – | `WallpaperInfo[]` | IDesktopWallpaper |
| `load_state` | – | `PersistedState` | `%APPDATA%\Folder Explorer\state.json` |
| `save_layout` | `{ layout }` | `()` | atomic write (temp + rename), debounced by the UI |
| `save_settings` | `{ settings }` | `()` | persists, emits `settings-changed` to all windows, re-registers the search hotkey from `settings.behavior.searchHotkey`, applies `settings.behavior.lockLayout` to the tray check item |
| `list_backups` / `restore_backup` | `{ name }` | `BackupInfo[]` / `PersistedState` | backups in `…\backups\`, keep 10; one on startup and at most every 15 min while changed |
| `export_state` / `import_state` | `{ path }` | `()` / `PersistedState` | |
| `import_media` | `{ path, kind: "icon" \| "wallpaper" }` | `string` | copies into `…\media\`, returns stored path |
| `open_settings_window` | – | `()` | |
| `show_search` | `{ initial?: string }` | `()` | show/focus search window, emits `search-open { initial }` to it |
| `take_search_initial` | – | `string` | the search window calls it on mount (first `search-open` may fire before it listens) |
| `hide_search` | – | `()` | |
| `raise_desktop` | `{ raised: boolean }` | `()` | |
| `set_windows_icons_mode` | `{ enabled: boolean }` | `()` | true = hide our desktop window and show the Windows icons again (tray toggle) |
| `quit_app` | – | `()` | restores icons, exits |

## Custom protocol `fe`
Served via `register_asynchronous_uri_scheme_protocol("fe", …)`. From JS use
`convertFileSrc("<route>", "fe")` → `http://fe.localhost/<route>` and append a query string.

* `fe://icon?p=<parsingName>&s=<px>&v=<version>` → PNG (IShellItemImageFactory, thumbnails allowed,
  rendered on a dedicated STA worker thread, cached in memory by (p,s,v)). `s` is physical px.
* `fe://wallpaper?m=<monitorId>&v=<version>` → the Windows wallpaper image bytes for that monitor.
* `fe://media?p=<path>` → files inside `%APPDATA%\Folder Explorer\media\` only.

## Events (Rust → JS)

| event | payload | |
|---|---|---|
| `desktop-changed` | `{ renames: { from: string; to: string }[] }` | debounced (~250 ms) file-system change on either desktop folder; ids in renames are lowercased paths. UI re-fetches `list_desktop_items`. |
| `environment-changed` | – | monitors / DPI / work area changed |
| `wallpaper-changed` | – | |
| `settings-changed` | `{ settings }` | |
| `desktop-raised` | `{ raised: boolean }` | |
| `empty-press` / `empty-drag` / `empty-release` | `{ x, y, ctrl }` | window CSS px; left button on the EMPTY desktop (handled by Windows; we only watch) — drives the rubber band |
| `empty-rclick` | `{ x, y, ctrl }` | right button on the empty desktop (Windows opens its own menu) — new items appear near it |
| `search-open` | `{ initial: string }` | to the search window |
| `open-virtual-folder` | `{ folderId: string }` | from search to the desktop window (desktop also gets raised) |
| `tray-action` | `{ action: "toggle-lock" | "add-app" | "new-group" }` | `add-app` / `new-group` also raise the desktop window (tray menu) |\| "add-app" \| "new-group" }` | `add-app` / `new-group` also raise the desktop window |

File drops from Explorer use Tauri's own `onDragDropEvent` on the desktop webview.

## Persisted JSON (owned by the UI)

```ts
type Placement = { m: string; p: number; c: number; r: number }; // monitor, page, col, row
type FolderLook = { opacity?: number; blur?: number; radius?: number; preview?: 2 | 3; icon?: string;
                   panelStyle?: "ios" | "android"; panelOpacity?: number }; // unset = global setting
type Layout = {
  version: 1;
  folders: Record<string, { id: string; name: string; color: string | null; children: string[]; look?: FolderLook }>;
  placements: Record<string, Placement>;   // top-level desktop items (files, system items, virtual folders)
  custom: Record<string, { name?: string; icon?: string }>;
  remembered: Record<string, { at: number; placement?: Placement; folder?: string; index?: number }>;
  home: Record<string, { placement: Placement; at: number }>;
  importedFromWindows: boolean;
};
```
`home` protects the layout from temporary screen changes (a game switching resolution, a
monitor turning off, DPI / taskbar changes): when an item's cell no longer exists, `reconcile`
shows it in the nearest free cell but keeps its real cell in `home`, and moves it back as soon as
that cell exists again and is free. A user action that moves the item (`commit` → `forgetHomes`)
or puts it in a folder drops the entry; entries expire after 30 days.
Virtual folder ids start with `v:`. Every item is either in `placements` or in exactly one
folder's `children`.

## Notes
* Each window also gets `window.__FE_VIEW__` via an initialization script, in case the query
  string is lost.
* Tauri's native drag-drop handler is on (for files from Explorer), so HTML5 drag & drop does
  not work inside the webview; all icon dragging is pointer-event based (`src/desktop/dnd.ts`).
* When the app is started from an MSIX-packaged parent (e.g. a sandboxed terminal), `%APPDATA%`
  may be virtualized; the state then lives under that package's `LocalCache\Roaming`.

## Command-line flags (`folder-explorer.exe`)
| flag | what it does |
|---|---|
| `--quit` | posts a private message to a running instance's desktop window, which quits gracefully (restoring the Windows icons); waits for the process to exit. Used by the installer hooks. |
| `--clean-legacy` | removes what earlier versions wrote into Windows (the "Yeni ▸ Grup" New-menu keys, a Run value that points to our exe), prints what it found. Also runs in the background at every start. |
| `--delayed-start <s>` | internal: sleep `<s>` seconds before starting (the app restarts itself this way after an Explorer restart). |
| `--show-icons` | makes the Windows desktop icons visible again and exits (safety net). |
| `--watchdog <pid>` | internal: waits for `<pid>` to exit, then shows the Windows icons. |
| `--autostart` | passed by the "start with Windows" Startup-folder shortcut; a second instance launched with it stays silent. |
| `--selftest [dir]` | diagnostics without UI (monitors, items, Windows icon layout per column, wallpapers, an icon PNG). |

## Installer
`npm run tauri build` → `src-tauri/target/release/bundle/nsis/Folder Explorer_<ver>_x64-setup.exe`
(per-user install, Turkish UI). `src-tauri/installer-hooks.nsh` runs `--quit` before installing
over / uninstalling a running copy and `--show-icons` on uninstall. It writes nothing into Windows'
shell. On uninstall it removes the Startup shortcut and, for older versions, the entries they added
(Run value, "Yeni ▸ Grup" keys). "Start with Windows" (`behavior.startWithWindows`, off by default)
is a shortcut `Folder Explorer.lnk` in the user's Startup folder (`startup.rs`), never a registry
value; dev builds never create it.

## Context menus
* Empty desktop (right-click, New, Refresh, View, Sort, Personalize…): **Windows' own**, handled by
  Explorer because the click passes through our window. The app adds nothing to it.
* One of our icons (file, folder, shortcut, system icon): a Windows 11 style popup drawn by the app in its
  own window (`menu`; Cut / Copy / Rename / Delete, Open, Run as administrator, Copy as path, Properties).
  It opens instantly. "Daha fazla seçenek göster" then builds the shell's full classic menu
  (`show_shell_menu`, `IContextMenu`: Share, pin, WinRAR, Git… — loading every shell extension takes
  a moment, so it is built only on request, exactly like Windows 11 does). Rename and Delete are carried
  out by the UI so they can be undone.
* A group (virtual folder): its settings window (name, colour, look, "Grubu dağıt", "İçindekilerle
  birlikte sil"). Ctrl+E opens the same window for the selected icon (custom name / icon for files).
* Right-click inside an open group panel does nothing for now; the panel is our own surface, so an
  own menu may be added there later, but never on Windows' desktop.
