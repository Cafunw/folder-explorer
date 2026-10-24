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

* **Windows' real desktop and Explorer are not touched.** The desktop window takes the mouse
  everywhere, including the empty desktop, and draws its own right-click menus that look and behave
  exactly like Windows 11's (same entries, words, shortcuts, metrics, acrylic). Every entry runs the
  same Windows action through public shell APIs (`IContextMenu` verbs, Windows' own New menu
  `CLSID_NewMenu`, `SHAssocEnumHandlers`, `SHOpenWithDialog`, `ms-settings:`), and
  "Daha fazla seçenek göster" opens **Windows' own classic menu** (see *Context menus*). Nothing is
  forwarded, faked, injected or hooked.
* **No registry changes, no Explorer process changes, no hooks on system menus.** The app writes no
  registry values (the "start with Windows" option is a shortcut in the Startup folder), registers no
  shell extensions, never injects into or patches Explorer and never hooks its menus. The only
  listeners are passive, out-of-context `WinEventHook`s (observe-only, callbacks run in our own
  process: foreground changes; windows Explorer shows and top-level z-order changes it makes; in
  game mode move/size ends, minimize start/end and location changes of the foreground window's
  process) that keep our window directly above the desktop and detect fullscreen apps, a shell
  change notification (`SHChangeNotifyRegister`) for the Recycle Bin and a power-setting
  notification (battery saver) — subscriptions of our windows that end with the process. Entries that *earlier versions*
  wrote (the "Yeni ▸ Grup" New-menu entry, a Run value) are removed once at startup
  (`legacy.rs`) and by the uninstaller, so Windows is back to normal.
* **Menus are built on demand, never registered.** The classic menus come from the public
  `IContextMenu` API of the items (or of the desktop folder's view object for the background) on our
  own STA thread; nothing is added to Windows' menus.
* **When the app is closed or disabled the Windows desktop is completely normal.** The one thing
  the product needs is to hide Windows' *icon list* while we show our own icons (otherwise every
  icon would appear twice). That is a single reversible `ShowWindow(SW_HIDE)` on the
  `SysListView32`; it is undone on quit, crash, Ctrl+C, log-off, "Windows simgelerine dön" in the
  tray, and by a watchdog process, and an Explorer restart or reboot always brings the icons back.
  Reading the original icon positions (`IFolderView::GetItemPosition`) is read-only.

The previous implementations broke or bent this rule and were removed: forwarding menus to
Explorer's hidden desktop view and a "Yeni ▸ Grup" registry entry (archived in
`docs/archive/before-core-rule-explorer-forwarding.zip`), then an input pass-through that let clicks
on the empty desktop fall through to Explorer (its menus took a second to open).

### Input
The transparent desktop window covers the whole screen and takes all input (`enforce_exstyle` keeps
it layered and strips `WS_EX_TRANSPARENT`). A press on the empty desktop starts the rubber-band
selection, a right-click there opens our desktop menu. Files dropped from other apps are handled by
Tauri's drag-drop events (`externalDrop.ts`); other dropped data (links, text) is not taken.

Wiring in `src/desktop/interaction.ts`, the pure parts (geometry, timing, zoom maths, copy / move
rule) in `src/desktop/input.ts` (tested):
* **Double-click on the empty desktop** (`behavior.doubleClickHide`) toggles `behavior.showIcons`
  (`saveSettings`). Only two plain clicks count (no modifier, not on a tile / block / `[data-hit]`,
  no marquee that moved, ≤ 500 ms and ≤ 4 px apart); `dnd.ts`'s marquee release reports them
  (`notePlainClick`). Hidden icons fade out (220 ms ÷ animation speed, instant with reduced motion /
  quiet) and then become `visibility: hidden`; while hidden, a double-click anywhere on the desktop
  brings them back, marquee / Ctrl+A / arrows select nothing, right-click menus still work, and a
  toast offers "Göster".
* **Ctrl+wheel** (`behavior.ctrlWheelZoom`): one non-passive capture `wheel` listener on the window.
  With Ctrl it always calls `preventDefault` (WebView2 page zoom stays off); with the setting on it
  scales `grid.iconScale` by 1.1 per notch (`wheelPixels` normalises line / page deltas), clamped
  0.5–3, rounded to 0.01, applied at once (rAF → `applySettings`) and saved 250 ms after the last
  notch; our own `settings-changed` echo inside that window does not undo the local value
  (`keepLocalZoom`). It also works over an open panel (its icons follow the grid), not over dialogs,
  Quick Look or during a drag. Without Ctrl (or with the setting off) the wheel pages as before.
* **Arrow keys** (`handleNavKey`, before the other desktop keys): on the desktop the nearest icon in
  that direction on the same monitor page by cell geometry (`neighbour`: blocks / spans are one
  target, an icon in the same row / column band wins), past the page edge the nearest icon of the
  next / previous page; Shift extends a box range (same page, never pages); Home / End = first / last
  icon in column order; PageUp / PageDown turn the page (and clear the selection). With nothing
  selected an arrow / Home selects the first icon (End: the last) of the page under the pointer;
  ←/→ on an empty page still turn it.
  A fence: ↓ on the selected fence enters its first child, inside it the fence's grid (`gridStep`),
  ↑ from its first row selects the fence, the other edges leave it; the body scrolls the child into
  view. An open panel: its grid (`panelGrid.cols`, `panelGrid.shown` = the shown entry ids, live
  entries via their own selection), Shift = list range. The stack fan has no arrow keys.
* **Drop on an app** (`behavior.dropOnApp`): files dragged onto an `.exe` / `.bat` / `.cmd` / `.com`
  or a `.lnk` / `.url` that points to one get the target `{ kind: "app", id }` (accent ring + "<App>
  ile aç" label under the icon) instead of a merge; Shift (or the setting off) = a new group as
  before. Groups, system items, headings and fences are never handed to an app. `dropKindOf` reads
  `shortcut_target` once per shortcut version (3 at a time, cached for the session; warmed when a
  drag starts), a `.lnk` to a folder is a real-folder target. The drop is `drop_on_item`: what
  Explorer does (the app's `IDropTarget`, usually it opens the files); the files stay where they
  are. External files dropped on an app tile do the same (Shift: group).
* **External files into a real folder** (a folder / folder-shortcut icon, a live group): like
  Explorer, the same volume moves and another copies, Ctrl copies, Shift moves (Tauri's drop event
  has no modifiers, so `key_state` asks Windows). Moves are one undo step (`FileOp move`), copies
  cannot be undone. Internal drags onto a folder always move (undoable) as before.

## Windows

| label      | url                         | notes |
|------------|-----------------------------|-------|
| `desktop`  | `index.html?view=desktop`   | Created by Rust at startup. Covers the bounding box of all monitors (physical px). No decorations, **transparent** (the real wallpaper — incl. slideshows and Wallpaper Engine — shows through), `WS_EX_TOOLWINDOW`, kept directly above the shell desktop (Progman) in z-order. The UI only paints a wallpaper when the user picks a custom one (image/colour/gradient). |
| `menu`     | `index.html?view=menu`      | Created hidden 2 s after start (so the first right-click is instant). The right-click menu (`src/menu/MenuView.tsx`): frameless, DWM acrylic (`DWMSBT_TRANSIENTWINDOW`, also while inactive), rounded corners + shadow, always-on-top, skip taskbar, theme = the app's. It measures itself and calls `place_menu` (at the cursor, flipped to stay inside the work area); it has the keyboard; it hides on focus loss / Esc. It tells the desktop window what was chosen (`menu-action`); it has no access to the desktop's state. Its webview rests while hidden (see *Hidden webviews*). |
| `menusub`  | `index.html?view=menusub`   | Same look; the open submenu, beside its entry. Never takes the focus (`focusable(false)` → `WS_EX_NOACTIVATE`), so the menu keeps the keyboard; it only draws and reports the mouse to `menu`. Windows plays no opening animation for a window shown without activation, so it fades in itself (`WS_EX_LAYERED` opacity, 150 ms). |
| `search`   | `index.html?view=search`    | Created lazily. Frameless, transparent + acrylic, always-on-top, skip taskbar, ~680x480 logical, centered on the monitor under the cursor. Hidden (not closed) when dismissed; its webview is then suspended (see *Hidden webviews*). |
| `settings` | `index.html?view=settings`  | Created lazily. Normal decorated window ~1000x700 logical, mica. Closing it destroys it. |

### Desktop window z-order rules (Rust)
* Always anchored **directly above Progman** (`WM_WINDOWPOSCHANGING` forces `hwndInsertAfter`
  to the window right above Progman, or `HWND_TOP` when Progman is on top / that window is
  topmost). Normally Progman is at the bottom, so we are too — even when activated.
* **Our window is owned by Progman** (`own_by_progman`, `GWLP_HWNDPARENT`): Windows keeps an owned
  window above its owner and moves it along when the owner is raised. When Progman is activated
  (Win+D, "Show desktop") Windows lifts it for a moment; without ownership it went over our window and covered every icon for a frame
  (a visible blink on each click). Ownership is a property of OUR window only; nothing in Explorer is
  changed. It is re-applied by the keep-alive and after `TaskbarCreated`. Because an owned window is destroyed
  with its owner, an Explorer restart destroys the desktop window; the app then starts a fresh copy
  (`--delayed-start 4`, only when it had run for 20 s, never when it is closing on purpose: tray, installer,
  log-off).
* An event-driven guard fixes both directions of drift (`misplaced` → `place_bottom`): Progman
  above us (Win+D / "Show desktop" lifts it) and a visible, non-minimized window between us and
  Progman (we drifted over app windows). It also re-shows us if we were hidden or minimized.
  Nothing polls: the `fe-zguard` thread sleeps on an event without a timeout. It is woken by the
  `fe-events` thread's WinEventHooks (foreground change — Progman / WorkerW coming to the front is
  "Show desktop"; a top-level z-order change or Progman / WorkerW shown by Explorer) and by our own
  window's messages (`WM_ACTIVATE`, z-order changes in `WM_WINDOWPOSCHANGED`, being hidden or
  minimized). Woken, it checks at once and then every 2 ms for a short burst (Progman / WorkerW in
  front: 400 ms, then every 16 ms up to 1.2 s; any other foreground change: 100 ms; whenever it had to
  put the window back: 300 ms more), because the shell raises Progman more than once while it shows
  the desktop and a missed raise covers every icon for a frame (the blink). The 2 ms ticks come from
  a high-resolution waitable timer (`CREATE_WAITABLE_TIMER_HIGH_RESOLUTION`), so the system timer
  resolution is not raised; only without it (old Windows) `timeBeginPeriod(1)` / `timeEndPeriod(1)`
  bracket each burst. The guard rests in Windows-icons mode and while every monitor is covered by a
  fullscreen app.
* `fe-keepalive` (every 5 s; every second if the hooks could not be installed) is the safety net:
  owner link, z-order, Windows icons hidden, our window shown, covering windows still there.
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
  an Explorer restart/reboot always brings icons back). Hidden again at once when Explorer shows it
  (`EVENT_OBJECT_SHOW` hook on Explorer's process), by the keep-alive and after `TaskbarCreated`
  (Explorer restart).
* Restored on quit, panic, console Ctrl+C, `WM_ENDSESSION`, and by a watchdog
  (`folder-explorer.exe --watchdog <pid>`) that waits for the app to exit and then shows the icons
  again. It is started through `--watchdog-launch <pid>`, which exits at once, so the watchdog is not
  a child of the app and survives "kill the process tree" (Task Manager, a dev tool stopping
  `tauri dev`). `main()` handles both flags before Tauri starts.
* Before hiding for the first time, the current Windows icon positions are captured via
  `IShellWindows::FindWindowSW(CSIDL_DESKTOP)` → `IFolderView::GetItemPosition` (+ `GetSpacing`).

### Quiet modes (`quiet.rs`)
* **Game mode** (`performance.gameMode`, on by default): a foreground window that fills its whole
  monitor (DWM frame bounds ⊇ `rcMonitor`, so a maximized window with a visible taskbar does not
  count; or `SHQueryUserNotificationState` = `QUNS_RUNNING_D3D_FULL_SCREEN` / `QUNS_BUSY` with the
  window rect covering the monitor) makes that monitor *covered*. Never counted: the shell (Progman, WorkerW,
  taskbar, Start, Alt+Tab…), our own windows, tool / cloaked / hidden / minimized windows. The
  desktop in front (Win+D) uncovers everything, an ordinary window uncovers the monitors it overlaps,
  and a recorded covering window that closed, minimized, went windowed or moved is dropped; other
  monitors keep their state. Presentation mode (`QUNS_PRESENTATION_MODE`) counts as game too.
  Re-evaluated only on events: foreground changes (at once), location changes of the foreground
  window (hook on its process only, re-targeted on every foreground change; F11 / borderless ↔
  windowed), move/size end and minimize start/end (150 ms debounce), display changes, raise / lower.
  While game-quiet: the UI drops animations and effects, the recycle-bin safety check and wallpaper
  refreshes wait. **Every monitor covered for 2 s → the desktop webview is suspended**
  (`SetIsVisible(false)` + `TrySuspend`), and the z-order guard rests; resumed (`Resume` +
  `SetIsVisible(true)`) as soon as one monitor is uncovered (the icons can take a moment to appear).
* **Battery mode** (`performance.batteryMode`: `auto` = on battery or battery / energy saver on,
  `always`, `off`): `GetSystemPowerStatus` on `WM_POWERBROADCAST` (AC ↔ battery; battery saver via
  `RegisterPowerSettingNotification(GUID_POWER_SAVING_STATUS)`).
* Both are announced with `quiet-changed` and `get_quiet`. The desktop sets
  `document.documentElement.dataset.quiet` = `"game"` / `"battery"` (game wins; the attribute is
  removed when not quiet, so CSS can use `:root[data-quiet]`), the store field `quiet`, and
  `MotionConfig reducedMotion="always"`.

### Hidden webviews (`windows_mgr.rs`)
WebView2 does not notice when its window is hidden. Hidden webviews are told (`with_webview` →
`ICoreWebView2Controller`, crate `webview2-com`), queued in order with tao's show / hide and with the
events sent to the page:
* `menu` / `menusub`: `SetIsVisible(false)` + memory target low (`ICoreWebView2_19`) when the menu
  closes (and right after they are created); `SetIsVisible(true)` + normal in `open_menu`, before
  `menu-open` is sent, and again in `place_menu`. No `TrySuspend`, so the menu opens without thawing a
  frozen renderer. The submenu fade-in is unaffected (the native window's layered alpha).
* `search`: `SetIsVisible(false)` + memory low when hidden, `TrySuspend` 5 s later (a pending invoke
  reaches the page first); `Resume` + `SetIsVisible(true)` before it is shown. Like the menu (which
  shows itself with `place_menu` after measuring), the window itself appears only when the page
  says it painted (`reveal_search`, after a rAF + task; fallback 400 ms in Rust, 120 ms in JS).
* `desktop`: suspended while every monitor is covered (game mode) or the Windows icons are shown
  instead (tray toggle).

### Background threads and idle cost
| thread | wakes |
|---|---|
| `fe-zguard` | only when woken (events, our window's messages); 2 ms ticks during a burst |
| `fe-events` | WinEvent callbacks, the Recycle Bin notification (message-only window) |
| `fe-keepalive` | every 5 s (1 s without hooks) |
| `fe-recycle` | Recycle Bin notifications (400 ms debounce); safety check every 60 s, not while game-quiet |
| `fe-watch` | desktop folders changed (`notify`) |
| `fe-live` | only while a live group is on screen: its folders changed (`notify`, non-recursive, 250 ms debounce); ends when the last one is unwatched |
| wallpaper | `notify` on `%APPDATA%\Microsoft\Windows\Themes` (`Transcoded*` rewritten by every wallpaper change, slideshows and Spotlight included); `WM_SETTINGCHANGE` too. No polling. |

Diagnostics (`diag.rs` → `fe-debug.log`, `src/desktop/diag.ts`) exist in debug / dev builds only;
the heavy JS monitors (rAF gap, 50 ms tile check) only with `localStorage["fe.diag"] = "1"`.

### Frontend cost (rules for contributors)
* **One bundle per window.** `src/main.tsx` dynamic-imports only the view of its window
  (`?view=`), so the menu / search / settings webviews never parse the desktop (or settings) code.
  Vite build, JS per window (CSS): desktop 602 KB (33 KB), settings 432 KB (25 KB), search 316 KB
  (17 KB), menu 287 KB (19 KB) — before, every window loaded all 674 KB (48 KB). Keep cross-view
  imports small (a view importing from another view's folder pulls that code into its chunk). The
  menu is pre-created, so its one extra chunk request happens long before the first right-click.
* **Narrow store subscriptions.** Per-tile components (`Tile`, `Positioned`, `FolderGlyph` /
  `useFolderLook`, `ItemImage`, `EntryTile`, `Fence`) select primitives or `useShallow` slices,
  never `s.settings` / `s.layout` / `d.drag` as a whole (normalizeSettings makes new objects on every
  `settings-changed`). Helpers in `store.ts`: `useAnimation()` (shallow `settings.animation`, for
  `spring({ animation }, …)` / `tween(…)`), `useReducedMotion()` (setting ∨ quiet ∨ Windows'
  "Animation effects" off), `nameIn(state, id)` for name selectors. A tile reads its own drop
  feedback (`dropOn(target, id)` → kind string) and `MonitorSurface` renders memoized `DeskTile`s,
  so a drag target change re-renders only the old and the new target tile. Measured in the browser
  mock (15 icons, React commit walk): a drag across 10 tiles 1489 → 204 component renders, an
  unrelated settings change 144 → 12, drag start / end 44 / 127 → 19 / 26.
* **Compositor layers only while something moves.** No permanent `will-change`: `Positioned` sets
  it while it springs, a page while it is between positions, the wallpaper while it drifts
  (`.wallpaper[data-moving]`); the drag ghost exists only during a drag. Icon drop shadows are
  painted once into the page layer, none under a plate or in quiet modes.
* **No backdrop blur that blurs nothing.** `:root[data-bare]` (applyTheme: no wallpaper painted by
  us, the window is transparent over Windows' own) removes it from group tiles, fences, the merge
  plate and the page indicator on the desktop surface (a pixel diff showed only 3 anti-aliased
  corner pixels changing). Panels, dialogs, toasts and the ghost keep theirs (icons are beneath).
* **Quiet CSS** (`styles.css`, end): `:root[data-quiet="game"]` — no transitions, keyframe
  animations or backdrop filters anywhere; `battery` — no backdrop filters, transitions ≤ 60 ms
  (hover effects are off via `:root[data-hover]`); `prefers-reduced-motion` — 1 ms transitions /
  animations. `MotionConfig reducedMotion` = `"always"` when reduced, else `"user"`.
* **Media.** Quick Look's `<video>` / `<audio>` pause when the card starts closing and drop their
  `src` (+ `load()`) on unmount, so decoders and buffers go at once, not at GC.

## Coordinates
All rects coming from Rust are **physical screen pixels**. The frontend converts with
`css = (screen - windowOrigin) / scaleFactor`, where `windowOrigin` and `scaleFactor`
come from `get_environment`. (Mixed-DPI multi-monitor setups are approximated with
the window's scale factor.)

Icon / cell size (`settings.grid.autoSize`, on by default) is computed per monitor in
`cellMetrics` (`src/layout/grid.ts`): the icon gets a physical edge that grows with the screen
diagonal (`autoIconMm`, ~9 mm on 16"), converted with the monitor's own px/mm from `sizeMm`;
without EDID it is 40 Windows-logical px at that monitor's scale. When a grid gets more / fewer
cells, `anchorToEdges` keeps right / bottom runs against their edge.

## Types (TS ⇄ Rust, camelCase JSON)

```ts
type Rect = { x: number; y: number; width: number; height: number };

type MonitorInfo = {
  id: string;            // device name, e.g. "\\\\.\\DISPLAY1"
  primary: boolean;
  bounds: Rect;          // physical, screen coords
  work: Rect;            // physical, screen coords (excludes taskbar)
  scale: number;         // monitor DPI / 96
  sizeMm: { width: number; height: number } | null; // physical size from EDID (read-only registry), null if unknown
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

// Quick Look / search lookups (shell.rs, read-only)
type DirEntryInfo = { name: string; path: string; isDir: boolean; size: number; modified: number };
type DirPreview = { entries: DirEntryInfo[]; total: number };   // total = all visible entries
type ShortcutInfo = { target: string; args: string; workDir: string; description: string;
                      isDir: boolean /* a local target that is a folder; network targets: false */ };
type KeyState = { ctrl: boolean; shift: boolean; alt: boolean };
type RecentFile = { name: string; path: string; modified: number /* last use */ };
type FoundFile = { name: string; path: string; parsingName: string; isDir: boolean };

type Quiet = { game: boolean; battery: boolean; covered: string[] /* MonitorInfo.id */ };

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
| `open_menu` | `{ request, at?: [x, y] }` | `()` | opens the `menu` window; `request` = `{ target: "items" \| "desktop", ids, paths, cell, spec }` (`src/menu/model.ts`), Rust adds `at` (physical px, default the cursor), `work`, `scale`, `accent { dark, light }` (system accent, `AccentPalette`), `canPaste`, `hasTerminal`. Then prepares the shell side on the menu thread and emits `menu-extra` twice: Open with ▸ / New ▸ first, then the classic menu (built in the background, so "Daha fazla" opens at once). |
| `place_menu` | `{ label, x, y, w, h, fade? }` | `()` | the menu windows place themselves: client area exactly at x, y, w × h (physical px; `SetWindowPos`, since tao would add a caption's height) and show (`menu` focused, `menusub` not; `fade` = a newly opened submenu fades in) |
| `take_menu_request` / `hide_menu` | – / `{ label? }` | `request \| null` / `()` | the menu pulls the request it was opened with (the event can arrive before it listens) / hides one or both menu windows |
| `classic_menu` | `{ paths, at, own? }` | `string \| null` | Windows' classic menu ("Daha fazla seçenek göster") for `paths` (empty = the desktop background), with `own` entries on top (the desktop's View ▸ / Sort by ▸ / Refresh / Paste). Returns `"own:<id>"`, `"rename"` / `"delete"` (NOT invoked, the UI does them so they can be undone), or the verb it ran. |
| `shell_verb` | `{ paths, verbs }` | `boolean` | runs the first of `verbs` (`pintohome`, `pintohomefile`, `PinToStartScreen`, `Windows.ModernShare`, `empty`, `properties`, `runas`, `opencontaining`…) the item's classic menu offers; false = none |
| `new_item` | `{ id }` | `()` | an entry of Windows' New ▸ list (`menu-extra.newItems`), on the desktop |
| `open_with` | `{ paths, index }` | `()` | Open with ▸ app `index` (`menu-extra.openWith`), `null` = Windows' "Başka bir uygulama seçin" dialog |
| `open_verb` | `{ path, verbs }` | `()` | `ShellExecuteEx` with the first verb that works (`opennewtab`, `opennewwindow`) |
| `open_terminal` | `{ dir }` | `()` | Windows Terminal (`wt.exe -d`) in `dir`, else cmd |
| `compress` | `{ paths, format: "zip" \| "7z" \| "tar" }` | `string` | "Şuna sıkıştır…": an archive next to the first item, via Windows' own libarchive (`archiveint.dll`, UTF-8 names); returns its path |
| `paste_files` | `{ shortcuts?: boolean }` | `string[]` | Paste / Paste shortcut onto the desktop from the clipboard (`CF_HDROP` + `Preferred DropEffect`), through `IFileOperation` |
| `clipboard_files` | `{ paths, cut }` | `()` | Explorer's Copy / Cut: the shell data object on the clipboard (`OleSetClipboard` + flush; cut adds `Preferred DropEffect` = move). No shell extensions, so instant. |
| `copy_text` | `{ text }` | `()` | text to the clipboard ("Yol olarak kopyala") |
| `show_properties` / `run_as_admin` | `{ path }` | `()` | `SHObjectProperties` / `ShellExecuteEx` verb `runas` |
| `recycle` | `{ paths }` | `()` | IFileOperation + FOFX_RECYCLEONDELETE / FOF_ALLOWUNDO |
| `restore_from_recycle` | `{ paths }` | `string[]` | restores the most recently deleted entries with these original paths ("undelete" verb); returns restored paths |
| `rename_item` | `{ path, newName }` | `string` (new path) | `newName` is a display name; keeps a hidden extension (.lnk, known types) |
| `move_into_folder` | `{ paths, targetDir }` | `()` | real move via IFileOperation (shows Windows conflict UI) |
| `copy_into_folder` | `{ paths, targetDir }` | `()` | the same as a copy (external files dropped into a real folder from another volume / with Ctrl) |
| `import_dropped` | `{ paths, copy?: boolean }` | `string[]` | copy/move external files into the user desktop (default like Explorer: same drive moves, other drive copies; name collisions get a new name); returns the real new paths. Files already on a desktop are returned unchanged. |
| `start_drag_out` | `{ paths }` | `string` | native OLE drag (`SHDoDragDrop`), call while the mouse button is down; returns `"copy" \| "move" \| "link" \| "none"` |
| `drop_on_item` | `{ target, paths }` | `string` | Explorer's drop of `paths` onto the item `target` (an app: it opens them): its `IDropTarget` (`GetUIObjectOf` from the parent folder), the shell data object of the files, `DragEnter` / `DragOver` / `Drop` with the left button and copy / move / link allowed, at the cursor. Own STA thread (`fe-drop`, `OleInitialize`) that pumps messages until 1.5 s quiet (max 60 s) for targets that finish asynchronously. Returns the effect like `start_drag_out`. |
| `key_state` | – | `KeyState` | Ctrl / Shift / Alt held now (`GetAsyncKeyState`, read-only); Tauri's file-drop events carry no modifiers |
| `cursor_over_foreign_window` | – | `boolean` | true when the top-level window under the cursor is not the desktop window (another app, taskbar…) |
| `list_start_apps` | – | `StartApp[]` | enumerate `FOLDERID_AppsFolder` |
| `list_dir_preview` | `{ path, limit? = 200 }` | `DirPreview` | Quick Look of a real folder: folders first, then by name; hidden / system entries left out |
| `list_folder` | `{ dir }` | `DesktopItem[]` | a live group's entries: like `list_desktop_items` for one folder (STA; hidden / system entries left out), newest first, at most 500; registers `dir` with `icons::allow_root` (thumbnails / Quick Look). Error "Klasör bulunamadı" when missing. |
| `watch_folder` / `unwatch_folder` | `{ dir }` | `()` | refcounted per folder (case-insensitive); the first watch starts the `fe-live` watcher, the last unwatch drops it. Changes → `folder-changed` |
| `known_folders` | – | `{ downloads, documents, pictures }` | `string \| null` each (`SHGetKnownFolderPath`), the live group picker's quick buttons |
| `hello_available` | – | `boolean` | `UserConsentVerifier::CheckAvailabilityAsync` = Available (read-only) |
| `hello_verify` | `{ message }` | `boolean` | Windows Hello prompt (`IUserConsentVerifierInterop::RequestVerificationForWindowAsync` on the desktop window, off the UI thread); true only for `Verified`. The prompt's window class is in `SHELL_UI_CLASSES`, so it does not lower the raised desktop. |
| `shortcut_target` | `{ path }` | `ShortcutInfo \| null` | `.lnk` via `IShellLinkW` + `IPersistFile::Load(STGM_READ)` (never resolved or saved; apps: the ID list's name), `.url` from its `URL=` line; null for other files |
| `list_recent` | `{ limit? = 50 }` | `RecentFile[]` | the `.lnk` files of `FOLDERID_Recent`, newest first, read like `shortcut_target`; missing targets, folders and network paths (UNC / remote drives) skipped |
| `search_files` | `{ query, limit? = 20 }` | `FoundFile[]` | Windows Search index under `%USERPROFILE%`: a shell search folder (`ISearchFolderItemFactory`, condition = every query word is a word-prefix of `System.ItemNameDisplay`, sorted by date modified). ≥ 3 characters; waits at most 1.5 s (returns what it has), a newer search stops older ones, max 2 at a time; build / cache / package folders (`.git`, `node_modules`, `AppData`, `target\debug`…) filtered out; empty when the `WSearch` service is disabled (read-only registry check). |
| `create_shortcut` | `{ parsingName, name }` | `string` (path) | `.lnk` on the user desktop via IShellLinkW::SetIDList |
| `create_url_shortcut` | `{ url, name }` | `string` | `.url` file on the user desktop |
| `get_wallpapers` | – | `WallpaperInfo[]` | IDesktopWallpaper, on demand |
| `get_quiet` | – | `Quiet` | game / battery quiet state (same as `quiet-changed`) |
| `load_state` | – | `PersistedState` | `%APPDATA%\Folder Explorer\state.json` |
| `save_layout` | `{ layout }` | `()` | atomic write (temp + rename), debounced by the UI |
| `save_settings` | `{ settings }` | `()` | persists, emits `settings-changed` to all windows, re-registers the search hotkey from `settings.behavior.searchHotkey`, applies `settings.behavior.lockLayout` to the tray check item |
| `list_backups` / `restore_backup` | `{ name }` | `BackupInfo[]` / `PersistedState` | backups in `…\backups\`, keep 10; one on startup and at most every 15 min while changed |
| `export_state` / `import_state` | `{ path }` | `()` / `PersistedState` | |
| `import_media` | `{ path, kind: "icon" \| "wallpaper" }` | `string` | copies into `…\media\`, returns stored path |
| `import_icon_pack` | `{ dir }` | `{ name, map }` | copies the PNG / ICO / SVG files of `dir` (subfolders up to 4 deep, max 2000 icons, ≤ 8 MB each) into `…\media\iconpacks\<folder name>\`; `name` = the folder's name, `map` = lowercased file stem → stored path (one file per stem: SVG first, else the biggest). Built in a staging folder, then replaces an earlier pack of the same name. The UI stores it as `settings.icons.pack`; "Kaldır" only clears the setting. |
| `export_theme` / `import_theme` | `{ path, theme }` / `{ path }` | `()` / `object` | writes / reads a theme JSON file (path from the dialog plugin, like `export_state`); import rejects non-objects and files > 4 MB. Merging is done by `src/themes.ts`. |
| `open_settings_window` | – | `()` | |
| `show_search` | `{ initial?: string }` | `()` | positions / resumes the search window and emits `search-open { initial }` to it; a hidden window is shown by `reveal_search` (or after 400 ms), an open one is focused |
| `reveal_search` | – | `()` | the search page painted the new query (after `search-open` / on mount): show + focus the window. Without it a webview just resumed from `TrySuspend` showed 1–2 blank acrylic frames. |
| `take_search_initial` | – | `string` | the search window calls it on mount (first `search-open` may fire before it listens) |
| `hide_search` | – | `()` | |
| `raise_desktop` | `{ raised: boolean }` | `()` | |
| `set_windows_icons_mode` | `{ enabled: boolean }` | `()` | true = hide our desktop window and show the Windows icons again (tray toggle) |
| `quit_app` | – | `()` | restores icons, exits |

## Custom protocol `fe`
Served via `register_asynchronous_uri_scheme_protocol("fe", …)`. From JS use
`convertFileSrc("<route>", "fe")` → `http://fe.localhost/<route>` and append a query string.

Requests (with their headers) are answered by a fixed pool of 4 threads (`fe-proto-*`); shell images
are rendered by 3 STA workers (`fe-icon-*`) and kept in a 24 MB byte-bounded LRU cache (shared
buffers, least recently used out first). `OPTIONS` preflights get `Access-Control-Allow-Headers: Range`.

* `fe://icon?p=<parsingName>&s=<px>&v=<version>` → PNG (IShellItemImageFactory, thumbnails allowed,
  cached by (p,s,v)). `s` is physical px, 16–512.
* `fe://thumb?p=<path>&s=<px>&v=<version>` → large shell thumbnail PNG for Quick Look, `s` 16–1024,
  cached by (p,s,mtime+length). Only allowed roots (below).
* `fe://preview?p=<path>` → the file itself for Quick Look with a `Content-Type` by extension (images,
  PDF, video, audio; text / code / HTML as `text/plain; charset=utf-8`, so nothing runs), `Accept-Ranges`,
  `X-Content-Type-Options: nosniff`, never cached. `Range: bytes=…` → 206 + `Content-Range`, only that
  slice is read (open ranges at most 4 MB, others 16 MB per response); unsatisfiable → 416; without a
  Range header the whole file up to 64 MB (else 413).
  **Allowed roots** for `thumb` / `preview`: the path is canonicalized and must lie below the user or
  public desktop folder or a directory registered with `icons::allow_root(dir)` (live folders); else 403.
* `fe://wallpaper?m=<monitorId>&v=<version>` → the Windows wallpaper image bytes for that monitor.
* `fe://media?p=<path>` → files inside `%APPDATA%\Folder Explorer\media\` only.

## Events (Rust → JS)

| event | payload | |
|---|---|---|
| `desktop-changed` | `{ renames: { from: string; to: string }[] }` | debounced (~250 ms) file-system change on either desktop folder; ids in renames are lowercased paths. UI re-fetches `list_desktop_items`. Also sent (no renames) when the Recycle Bin turns full / empty. |
| `environment-changed` | – | monitors / DPI / work area changed |
| `folder-changed` | `{ dir: string }` | to `desktop`: a watched live folder changed (debounced ~250 ms, at most 1 s late); `dir` as passed to `watch_folder`. UI re-fetches `list_folder`. |
| `wallpaper-changed` | – | `WM_SETTINGCHANGE` (SPI_SETDESKWALLPAPER) or Windows' transcoded wallpaper rewritten (slideshow, Spotlight); deferred while game-quiet |
| `quiet-changed` | `Quiet` | to all windows when game / battery quiet state or the covered monitors change |
| `settings-changed` | `{ settings }` | |
| `desktop-raised` | `{ raised: boolean }` | |
| `menu-open` | `MenuRequest` | to `menu` (see `open_menu`) |
| `menu-extra` | `{ key, verbs?, newItems?, openWith? }` | to `menu`: what the shell offers for the open menu (`key` = `menuKey(paths)`) |
| `search-open` | `{ initial: string }` | to the search window |
| `open-virtual-folder` | `{ folderId: string }` | from search to the desktop window (desktop also gets raised) |
| `tray-action` | `{ action: "toggle-lock" | "add-app" | "new-group" }` | `add-app` / `new-group` also raise the desktop window (tray menu) |\| "add-app" \| "new-group" }` | `add-app` / `new-group` also raise the desktop window |

Between windows (JS → JS, `emitTo`): `item-opened` (`{ id }`, search → desktop: an item was opened,
counts for frequent groups), `menu-action` (`MenuPick`, menu → desktop; the search window's command
palette sends it too, with `target: "desktop"`, no ids and `cell: null` = the primary monitor),
`palette-action` (`{ id: "undo" | "redo" | "toggle-lock" | "add-app" | "new-group" }`, search →
desktop: palette commands that are not menu entries), `menu-sub-open` /
`menu-sub-close` / `menu-sub-hover-set` (menu → menusub), `menu-sub-hover` / `menu-sub-pick`
(menusub → menu).

File drops from Explorer use Tauri's own `onDragDropEvent` on the desktop webview.

## Persisted JSON (owned by the UI)

```ts
// monitor, page, col, row of the top-left cell; w × h cells covered (fences, headings), unset = 1 × 1
type Placement = { m: string; p: number; c: number; r: number; w?: number; h?: number };
type FolderLook = { opacity?: number; blur?: number; radius?: number; preview?: 2 | 3; icon?: string;
                   panelStyle?: "ios" | "android"; panelOpacity?: number; borderWidth?: number /*0..4*/;
                   borderColor?: string; shadow?: number; gradient?: boolean; glow?: number;
                   openStyle?: OpenStyle }; // unset = global setting
type VirtualFolder = {
  id: string; name: string; color: string | null; children: string[]; look?: FolderLook;
  kind?: "smart" | "live" | "frequent" | "temp";   // unset = "group" (the user's own items)
  display?: "fence" | "stack" | "tabs";            // unset = "panel"
  rule?: { all: boolean; conditions: SmartCondition[] }; // smart: ext[] / name contains|startsWith /
                                                   //   type (shortcut, folder, file, document, image,
                                                   //   video, audio, archive, game) / age newer|olderThan days
  exclude?: string[];              // smart: items the user took out (never collected again)
  source?: string;                 // live: directory
  limit?: number;                  // frequent: 1..50
  tempDays?: number;               // temp: 1..365
  added?: Record<string, number>;  // temp: when each child came in (ms); keys = children
  activeTab?: string;              // tabs: a child group id or "general"
  lock?: { method: "pin" | "hello"; hash: string | null; salt: string | null };
  collapsed?: true;                // fence: folded to its title bar (its cells stay reserved)
};
type Layout = {
  version: 1;
  folders: Record<string, VirtualFolder>;
  placements: Record<string, Placement>;   // top-level desktop entries (files, system items, groups, headings)
  custom: Record<string, { name?: string; icon?: string }>;
  remembered: Record<string, { at: number; placement?: Placement; folder?: string; index?: number }>;
  home: Record<string, { placement: Placement; at: number }>;
  importedFromWindows: boolean;
  headings: Record<string, { id: string; text: string; style: "title" | "divider"; align: "left" | "center";
                             underline?: true }>;
  usage: Record<string, { n: number; last: number }>; // opens per item (frequent groups), max 500
};
```
`home` protects the layout from temporary screen changes (a game switching resolution, a
monitor turning off, DPI / taskbar changes): when an item's cell no longer exists, `reconcile`
shows it in the nearest free cell but keeps its real cell in `home`, and moves it back as soon as
that cell exists again and is free. A user action that moves the item (`commit` → `forgetHomes`)
or puts it in a folder drops the entry; entries expire after 30 days.
Virtual folder ids start with `v:`, heading ids with `h:`. Every item is either in `placements` or
in exactly one folder's `children`. `normalizeLayout` drops anything invalid silently and clamps
numbers; `w` / `h` are stored only when > 1.

Layout logic lives in `src/layout/model.ts` (geometry, operations, `reconcile`) and
`src/layout/smart.ts` (group kinds), both pure and unit-tested:
* **Spans.** An entry covers `w × h` cells; `occupancy`, the free-cell search, moves, `reconcile`,
  `home`, auto-arrange / sort and `anchorToEdges` all work on whole blocks. Fences and headings
  are *anchored*: they win collisions and keep their cells when icons are re-flowed; an icon never
  lands on a covered cell (it goes to the nearest free one), and a block is only displaced to a
  spot where it fits whole. A block too big for the current screen is shown smaller and its real
  size kept in `home`.
* **Headings** exist without a desktop item: `reconcile` keeps the `h:` placements that are in
  `headings` and drops the others; they never go into groups.
* **Fences and headings on screen** (`src/layout/blocks.ts`, pure + tested; `Fence.tsx`,
  `Heading.tsx`, `fence.css`): a *block* is a heading or a group with display `"fence"` that has a
  placement. `MonitorSurface` draws blocks over their w × h cells instead of a tile. A fence =
  inset box (`fenceGeometry`: title bar, then a scrolling grid of its children with one column per
  covered cell, the desktop's icon size), styled from the group tile's opacity / blur / roundness
  and `useGroupBox` (border, shadow, gradient, glow); no backdrop blur under `:root[data-quiet]`.
  A locked group shows only a lock (`useContentHidden`), a frequent one its `frequentItems`.
  Blocks are moved / resized by their own pointer session in `dnd.ts` (`beginBlockPointer`: fence
  title bar or heading = move, fence corner = resize, heading right edge = width only): snapped to
  whole cells (`snapMove` = the cell the held corner is nearest, else the nearest spot where the
  whole block fits — exactly what `moveToCell` does on the drop; `snapResize` refuses sizes that
  would cover something), previewed live in `useDrag.block` (dashed outline at the landing spot /
  the fence drawn at its new size), committed once on release (one undo step); 650 ms at a
  monitor's left / right edge turns the page. `behavior.lockLayout` blocks both (toast) and hides
  the handles. Icon drags never take blocks along (they are left out of the dragged selection).
  **Hit testing**: every cell of a fence resolves to the fence (`occupancy` maps all covered cells),
  never to "merge": its title bar (and a folded body) = `into` (append), its body = `reorder` with a
  gap like an open panel (`slotAt`; the gap starts at the end when the pointer comes in, at the
  icon's own place when the drag started in that fence), a child's icon = into / real / app / merge
  like in a panel; live fences = `into` (file move), frequent = nothing. A heading's cells give the
  nearest free cell. External file drops: a fence = `into`, a heading = a free cell nearby.
  Children dragged out of a fence go to the desktop (`moveToCell`); Ctrl-click / several work as on
  the desktop. **Marquee**: a fence is selected when the rectangle touches its title bar (its
  children are not), a heading by its whole block. Delete removes headings (`deleteIds` →
  `removeIds`) and dissolves fences like any group; F2 / Ctrl+E / double-click edit a heading's
  text in place, F2 / double-click on a fence title rename it. Creation: `createFenceAt` (the
  first of 3×2, 2×2, 2×1 that fits with the right-clicked cell inside it, shifted left / up at the
  grid's edge, else the nearest free 3×2) and `createHeadingNear` (title 3 cells, divider the free
  run to the right up to 6; shorter when less is free), then the title / text is edited at once
  (not from the command palette: the desktop has no keyboard focus then).
* **Smart** groups collect *loose* desktop items matching `rule` (never items inside groups,
  groups, headings, system items or `exclude`): the items that newly appear (`applyItems`, start;
  not ones the user just created / dropped at a cell), and all loose items when a group becomes
  smart or its rule changes (`commit`, same undo step). Taking an item out of a smart group adds it
  to `exclude`; putting it back removes it.
* **Frequent** groups are a view of `usage` (count fading with a 3-week half-life; items in locked
  groups left out); `recordOpen` counts opens (`openId`, and `item-opened` from the search window),
  outside the undo history. **Frequent and live** groups hold no children (`acceptsDrops` false; a
  drop on a live group is a real file move into `source`).
* **Temp** groups keep `added` in step with their children; `staleItems` lists the expired ones.
* **Tabs**: `tabsOf` = a "Genel" tab for the loose children, then one per child group.

Group kinds / displays in the UI (`src/desktop/`):
* `kinds.ts` (pure + tested): the customize draft (`draftOf` / `patchOf` → one `updateFolder` in the
  same `commit` as name / look = one undo step), the rule editor rows (`ruleDraft` / `ruleOf`,
  `smartMatchCount` = "N öğe toplanacak"), PIN hashing, `fanLayout` / `bubbleCols`,
  `displayToChildIndex`, `archiveStale`. `GroupDialogs.tsx`: the Tür / Gösterim / Kilit part of the
  group dialog and the unlock dialog. Yeni ▸ Akıllı grup / Canlı klasör / En çok kullanılanlar
  (`newKindFolder`): a smart one opens the dialog on the rule editor, a live one on the folder picker.
* **Tile glyph** (`GroupContent.tsx`): kind badge top right (smart / live / frequent / temp), a
  stack / tabs mark bottom left, the stale count top left (temp; re-rendered by one timeout at the
  next expiry). Live / frequent tiles preview their entries (`KindMinis`); a locked group shows a
  lock only (an open one while unlocked) — no child images.
* **Panel** (`FolderPanel.tsx`) grows out of the group's tile; a group opened from a fence grows out
  of its own tile in the fence (`PanelState.from`), not the fence's title bar. It shows `Entry`s: `child` (normal `Tile`, full dnd), `ref` (frequent:
  a desktop item shown elsewhere; opens / previews, dragging only toasts), `live` (a live folder's
  entry; `useLive` selection, Enter / Space / F2 / Delete, the classic menu, a drag = native OLE
  drag `start_drag_out` after closing the panel, so dropping it on our desktop moves the file
  there). Tabs: a tab bar over the grid; a click = `setActiveTab` (`replaceLayout`, no undo step),
  "+" = a new child group tab (`commit`), double-click = rename, a drop / hover on a tab header =
  into / switch to that tab. Temp: a notice row with "Arşive taşı" (`archiveStale`, one commit).
  Live: the folder path (opens it) and the 500 cap note. **Stack**: ≤ `FAN_MAX` (9) entries open as
  a fan from the tile (`StackView.tsx`; dragging an entry closes it, so the drop lands on the
  desktop), more as the panel card anchored above the tile (`bubbleCols`).
* **dnd contract** (`registry.panelGrid`): besides the grid geometry, `folderId` = the group the grid
  drops into (a tabs group's open child tab), `items` = the shown ids when they are not exactly
  that group's children ("Genel" tab; reorder indexes go through `displayToChildIndex`), `tabs` =
  the tab header elements (`tabsOwner` = the tabs group). `groupTarget` decides what a group under
  the pointer accepts: frequent nothing, live only real files (a file move into `source`, undoable),
  springing open after a dwell only for panel groups that are not locked.
* **Live folders** (`live.ts`): `useLiveItems(dir)` refcounts a folder while any tile / panel / Quick
  Look shows it (`watch_folder` once, `unwatch_folder` + cache dropped 3 s after the last user);
  `folder-changed` → one coalesced `list_folder`. Live entries are never in the layout, the
  desktop selection or the undo history (Delete = recycle with an undo toast that restores it).
* **Locks** (`locks.ts`): `useUnlocked` (memory only, so a restart locks everything). Opening a
  locked group (or a group inside one) goes through `requestUnlock` → dialog `{ kind: "unlock", id }`:
  Windows Hello when `lock.method === "hello"` and `hello_available`, else / on failure the PIN pad
  (SHA-256 of salt + PIN, 5 wrong PINs → 30 s wait). The continuation opens the panel before the
  dialog closes, so the desktop stays raised. An unlocked group locks again 5 min after its panel
  closed. Locked content is hidden from tiles, panels, fences (`useContentHidden`), Quick Look and
  search (`buildEntries` skips a locked group's children). Removing a lock needs the same
  verification. The lock only hides content in this app.

## Notes
* Each window also gets `window.__FE_VIEW__` via an initialization script, in case the query
  string is lost.
* Themes (`src/themes.ts`): a theme touches only the visual settings — `theme`, `accent`,
  `transparency`, `folders` (style, preview, radius, defaultColor), `icons` (without `pack`),
  `labels`, `groupBox`, `selection`, `pageIndicator`, `animation` (openStyle, pageTransition,
  hover). Presets (Varsayılan, Cam, Neon, Minimal, macOS, Gece) are patches over Varsayılan, so
  switching never leaves leftovers; an imported file is patched over the current settings. Both go
  through `pickVisual` (only these keys, right types) and `normalizeSettings`. Theme file:
  `{ "format": "folder-explorer-theme", "version": 1, "settings": <visual settings> }`; a full
  `export_state` file is accepted too (its visual settings are used).
* Settings window (`src/settings/`): `SettingsView.tsx` (sections, rendered only when open),
  `controls.tsx` (Row / Toggle / Seg / Slider / Colors / AutoColor / HotkeyInput),
  `previews.tsx` (CSS-only live previews: icon plate + label, selection, page indicator, group
  box, theme thumbnails), `WallpaperEditor.tsx` (edits one `WallpaperSpec`: main, night, per page).
  The previews and the desktop share the CSS helpers in `src/settings.ts` (`plateRadius`,
  `plateColor`, `fontStack`, `labelShadow`, `groupTileStyle`), so they look the same.
* Visual settings on the desktop are CSS, set once per settings change by `applyTheme`
  (`src/settings.ts`); memoized tiles do not re-render for them:
  * `:root[data-plate="circle|squircle|square|teardrop"]` (absent = none) + `--plate-bg`,
    `--plate-radius`, `--plate-pad` style `.item-plate`, the wrapper `ItemImage` draws with `plate`
    (desktop / panel / fence tiles and the drag ghost; not the mini previews inside group tiles).
  * Labels: `--label-font`, `--label-size`, `--label-weight`, `--label-color`, `--label-shadow` on
    `.tile-label` and `.rename-box`; `:root[data-label-hover]` hides labels (opacity, layout kept)
    unless the tile is hovered or selected. `labels.size` is part of the grid: `cellMetrics` uses it
    for the cell height and, with automatic size, for the minimum cell width (76 px at 12 px).
  * Selection: `--sel` (selection colour or the effective accent), `:root[data-sel="fill|outline|glow"]`
    on `.tile[data-selected] .tile-bg`; `.marquee` uses `--sel` and `--marquee-radius`.
  * Accent: `effectiveAccent(s)` = the wallpaper accent (`setWallpaperAccent`) when
    `wallpaper.accentFromWallpaper`, else `settings.accent`; `--accent*` and `--sel` follow it.
* Group box (`settings.groupBox`, per group `look.borderWidth / borderColor / shadow / gradient / glow`):
  `resolveGroupBox` + `groupBoxParts` (border, drop shadow, gradient sheen, inner glow tinted with
  the border colour, else the group colour, else `var(--accent)`). Group tiles: `groupTileStyle`
  in `FolderGlyph` (explicit effects stay visible at 0 % tile opacity). Boxes drawn as a group
  (fences, the open panel card): `style={{ ...own, ...groupBoxStyle(useGroupBox(id), ownShadow) }}`
  — set the own fill as `backgroundColor` (not `background`), so the gradient longhand survives
  React style updates.
* Icon pack (`src/desktop/iconPack.ts`, `src/visual.ts`): custom icon > pack > shell icon. Pack
  keys are matched exactly (lowercased) and loosely (letters / digits only) against the shell name,
  the file stem, the usual pack names of system icons (this pc, recycle bin / trash [+ full],
  network, control panel, user files) and, for `.lnk` without a match, the stem of the target
  (`shortcut_target`, asked once per shortcut version, 2 at a time, cached for the session). A pack
  image that fails to load falls back to the shell icon.
* Page indicator (`MonitorSurface.tsx` → `PageIndicator`, `.page-dots[data-style][data-pos]`):
  dots / line / "‹ n / m ›" (arrows on hover) / hidden; bottom / top / left / right of the work area,
  centred in the free band right of / below the grid when it is ≥ 28 px; `data-hit` keeps the
  desktop menu off it.
* Wallpaper (`Wallpaper.tsx`): per monitor, the spec of its current page — `perPage["<id>|<page>"]`
  > night (`dayNight`) > main (`wallpaperFor`). A changed spec cross-fades (the old picture stays under
  the new one until that is opaque; instant in quiet modes / reduced motion). Parallax: painted
  wallpapers (not "windows") are `parallaxStep` (≤ 10 % of the width per page, ≤ 30 % in all) wider
  and follow the monitor's page position `pagePos` (see *Motion*), so they move with every page
  transition (slide, cube, cards, fade) and jump with it when motion is reduced. Blur: an image is blurred once on an `OffscreenCanvas` at
  reduced size (blur hides it) and shown as a plain blob image, so no live `filter: blur()`; only
  while that copy is being made (or if it failed) a CSS filter, never in quiet modes. `WallpaperSync`
  (rendered once): the day / night clock is one `setTimeout` to the next switch (`msToNextSwitch`),
  re-armed when it fires, on settings change, `visibilitychange` / focus and environment / wallpaper /
  quiet changes (wake-ups after sleep); the accent is computed once per source (64 × 64 canvas →
  `dominantColor`; "windows" reads `fe://wallpaper?m=<primary>`, colour / gradient wallpapers their
  colours) and applied with `applyTheme`.
* Search window (`src/search/SearchView.tsx`): rows grouped as Hesap makinesi, Masaüstü,
  Uygulamalar, Ayarlar, Son kullanılanlar, Dosyalar, Web (sources gated by `settings.search.*`).
  Only scoring runs per keystroke: desktop items / groups and Start apps (loaded on open), Windows
  Settings pages (`settingsPages.ts`, Turkish names + keywords → `ms-settings:` URIs), recent files
  (`list_recent`, fetched on every open and kept for the session). The calculator (`calc.ts`: own
  tokenizer + recursive-descent parser, no eval) answers on top; Enter copies the result
  (`copy_text`) and the window stays open. Index results (`search_files`) are debounced 250 ms, only
  for ≥ 3 characters, and only the newest answer is used; they merge in below without moving the
  selection (it follows the row's key). The last row opens a Google search in the default browser.
  A query starting with `>` lists app commands instead (command palette; Ctrl+Shift+P on the desktop
  when no icon is selected — with a selection it stays "Yol olarak kopyala"). Opening a desktop item
  sends `item-opened`.
* Quick Look (`src/desktop/QuickLook.tsx`, dialog `{ kind: "quicklook", id }`, so the desktop is
  raised while it is open): Space on the selection (`behavior.quickLook`; the first selected icon);
  Space / Esc / a click outside closes, ←/→ walk the open group's children, a fence child's fence, or
  the icons of the same monitor page in reading order (row, then column) and move the selection along, Enter opens. Images
  (`<img>`), video / audio (`<video>` / `<audio>` with Range requests), PDF (`<iframe>`, WebView2's
  viewer), text / code (first 256 KB with a Range request; UTF-8, UTF-16 with BOM, else
  windows-1254), real folders (`list_dir_preview`), groups (their children, a frequent group's picks, a
  live group's folder; locked groups show nothing until unlocked), live entries (←/→ walk their
  folder), anything else a large `fe://thumb` + type, size, date, location and the shortcut target
  (`shortcut_target`). A preview that fails falls back to that view. The card grows out of the icon
  (`spring()`), only fades in quiet modes, and has no backdrop blur there.
* **Motion** (`src/desktop/fx.ts` pure + tested, `effects.ts`, `Jiggle.tsx`, `sounds.ts`, `fx.css`).
  Every animation goes through `spring()` / `tween()` (speed, stiffness, bounce; duration 0 with
  `animation.reduceMotion`). `reducedMotion(s)` (store) = the setting, a quiet mode or Windows'
  "Animation effects" off; `MotionConfig` then drops transform animations.
  * **Open styles** (`animation.openStyle`, a group's own `look.openStyle` first — the group dialog's
    "Açılış animasyonu"; `openStyleOf`): `panelMotion` gives the panel card's hidden / shown / exit
    targets and transitions — zoom = grows out of the tile (shared-element scale + offset + radius),
    spring = the same with a bouncy spring, flip = `rotateY` ±110° / `rotateX` 16° from the tile with
    `transformPerspective` and the back face hidden, blur = `blur(18px)` + 0.92 scale to sharp
    (`transitionEnd: filter none`, so no filter stays on the card and its backdrop blur keeps
    working), fade = opacity + 0.96 scale. Closing plays the same targets back. Quiet modes always
    use fade (no blur filter, no 3D). Stack fans use `fanMotion` (the same five, staggered). The
    nested-group slide inside a panel is unchanged.
  * **Page transitions** (`animation.pageTransition`): one MotionValue per monitor,
    `pagePos(monitorId)` (registry.ts), is animated by `MonitorSurface` to the current page
    (`pageTransition`: springs, a tween for fade; a jump when motion is reduced). Each `Page`
    writes `pageLook(mode, page − pos, width)` straight to its element on change: slide =
    `translateX`; cube = `translateZ(−back) rotateY(rel·90°) translateZ(w/2)` with `perspective`
    1.5·w on the track, pushed back by w/2·(sin θ + cos θ − 1) so the shared edge stays at screen
    depth; cards = the right page slides over while the left one scales to 0.88 and fades; fade =
    opacity. Pages a whole page away are `visibility: hidden`; `will-change` is set only while a
    page is between positions. Paging by wheel, keys, dots, drag-to-edge (icons and blocks) all
    just change `pages[m]`, so every mode works with every input, per monitor, with fences and
    headings (they are page content). The wallpaper parallax follows the same value.
  * **Hover** (`animation.hover`): `installEffects` keeps `:root[data-hover]` = the effect that may
    run now; it is removed in quiet modes / reduced motion, while dragging (`useDrag` drag, block,
    marquee), renaming or in the edit mode, so CSS (`fx.css`) never checks those. Effects use the
    individual `translate` / `scale` / `rotate` properties, which compose with the transform
    Motion writes on `.tile-icon`: lift (−3 px, deeper drop shadow, contact shadow), grow (1.08),
    tilt (`rotate: x y 0 a` from `--tilt-*`), glow (accent halo pseudo-element), bounce (one CSS
    hop), magnify (`--mag`). Tilt and magnify read the pointer only on the hovered tile
    (`hoverHandlers` on `Tile` / `EntryTile`, rAF-throttled): tilt = `tiltOf` (the edge under the
    pointer is pressed away, ≤ 14°); magnify = on enter the row of the same grid container (same
    top, ≤ 2.5 cells: `rowNeighbours`) is measured once, then `magnifyScale` (cosine fall-off, 1.3 →
    1 at 2 cells) per neighbour on pointer moves. Nothing runs while the pointer is still.
  * **Edit mode** (`Jiggle.tsx`, `useJiggle`): desktop menu "Simgeleri düzenle" (`editicons`),
    the palette, or a 600 ms press on an icon without moving (`armLongPress`; that release does not
    open the group, `takeLongPress`). `:root[data-jiggle="wiggle" | "still"]` (still with reduced
    motion / quiet); tiles get `data-wiggle` + a per-id phase (`jigglePhase` → `--jd` / `--jt`) for a
    CSS `rotate` keyframe that only exists while the mode is on. A badge per item (`JiggleBadge`): ×
    on files = `deleteIds` (Recycle Bin + undo toast), − on groups (dissolve) / fences / headings;
    none on system icons. Drags start after 2 px, double-click does not launch files (groups still
    open on click, iOS-like). Esc (when no panel / dialog), a press on the empty desktop or "Bitti"
    (`JiggleDone`, top of each monitor) ends it; `behavior.lockLayout` refuses it (toast) and ends it.
  * **Sounds** (`sounds.ts`, `settings.animation.sounds` / `soundVolume`, off by default):
    synthesized with WebAudio (oscillators + a noise buffer, no files): open, close, drop, merge,
    delete, page, jiggleOn / jiggleOff, error, at `openFolder` / `closePanel`, `endDrag` results and
    `moveToDir`, `deleteIds`, `setPage`, the edit mode, refused drops. One `AudioContext`, created on
    the first sound, suspended after 10 s of silence and closed after 60 s; muted while game-quiet
    (`setSoundConfig` from `installEffects`). The settings window's "Dinle" uses `previewSound`.
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
| `--watchdog-launch <pid>` | internal: starts `--watchdog <pid>` and exits, so the watchdog is outside the app's process tree. |
| `--autostart` | passed by the "start with Windows" Startup-folder shortcut; a second instance launched with it stays silent. |
| `--selftest [dir]` | diagnostics without UI (monitors, items, Windows icon layout per column, wallpapers, an icon PNG). |
| `--menutest [paths…]` | prints the classic menu (entries + verbs), New ▸ and Open with ▸ for `paths` (none = the desktop background). |

## Installer
`npm run tauri build` → `src-tauri/target/release/bundle/nsis/Folder Explorer_<ver>_x64-setup.exe`
(per-user install, Turkish UI). `src-tauri/installer-hooks.nsh` runs `--quit` before installing
over / uninstalling a running copy and `--show-icons` on uninstall. It writes nothing into Windows'
shell. On uninstall it removes the Startup shortcut and, for older versions, the entries they added
(Run value, "Yeni ▸ Grup" keys). "Start with Windows" (`behavior.startWithWindows`, off by default)
is a shortcut `Folder Explorer.lnk` in the user's Startup folder (`startup.rs`), never a registry
value; dev builds never create it.

## Context menus
Both menus are drawn by the app (`src/menu`: `model.ts` says what is in them, `MenuView.tsx` draws
them, `actions.ts → runMenuAction` does what was chosen), entry for entry like Windows 11's own in
Turkish, measured at 125 %: entries 28 px + 2 px margins, separators 9 px, command bar 70 px, the
shortcut hints in one left-aligned column, Segoe Fluent Icons with the accent-coloured parts,
submenus after 250 ms, full keyboard (arrows, Enter, Esc, Home/End).

* **Empty desktop:** command bar Yapıştır (only with files on the clipboard); Görünüm ▸ (Büyük /
  Orta boyutlu / Küçük simgeler = `grid.iconScale` 2 / 1 / 0.67, checked only at that size (a
  Ctrl+wheel size in between checks none), Simgeleri otomatik düzenle,
  Simgeleri kılavuza hizala (always on), Masaüstü simgelerini göster = `behavior.showIcons`),
  Sıralama ölçütü ▸ (Ad, Boyut, Öğe türü, Değiştirme tarihi; that monitor), Yenile, Simgeleri
  düzenle (ours: the icon edit mode, `editicons`; also in the command palette), Yeni ▸ (Windows'
  own list with its icons, plus our Grup), Görüntü ayarları, Kişiselleştir, Terminalde Aç (when
  Windows Terminal is installed), Daha fazla seçenek göster. New items land in the right-clicked
  cell and start being renamed.
* **Our icons** (file, folder, shortcut, system icon, several at once): command bar Kes, Kopyala,
  Yeniden adlandır (one item), Paylaş (files only), Sil; then Aç, Birlikte aç ▸ (Windows' apps for
  the type + "Başka bir uygulama seçin"), Yeni sekmede / pencerede aç, Hızlı erişime / Başlangıç'a
  sabitle, Yönetici olarak çalıştır, Dosya konumunu aç, Sık Kullanılanlara ekle, Şuna sıkıştır ▸
  (ZIP / 7z / TAR), Yol olarak kopyala, Özellikler, Terminalde Aç, Geri Dönüşüm Kutusu'nu Boşalt —
  each only where Windows shows it. Rename and Delete are done by the UI so they can be undone.
* **"Daha fazla seçenek göster"** opens Windows' own classic menu (`classic_menu`): every shell
  extension (WinRAR, Git, Notepad++…), Telefonuma Gönder, Şununla paylaş ▸. It is built while our
  menu is on screen, so it opens at once. Entries of other apps are only there, not in our menu.
* **A group** (virtual folder): its settings window (name, colour, look, "Grubu dağıt",
  "İçindekilerle birlikte sil"). Ctrl+E opens the same window for the selected icon. A fence: the
  same window from its title bar / empty body (right-click) or its edit button; its children have
  their normal item menus.
* **A heading / divider** (`headingMenu`, target `"items"` with the `h:` id and no paths; entry ids
  `heading:*`): command bar Düzenle, Sil; Düzenle (F2), Hizala ▸ Sol / Orta, Biçim ▸ Başlık / Ayraç,
  Altı çizili (titles), Sil.
* **Yeni ▸** also has Kutu (Fences), Başlık, Ayraç (`newfence`, `newheading`, `newdivider`; the
  command palette has them too: Yeni kutu / başlık / ayraç, placed on the primary monitor's page).
* Keyboard on the desktop: Shift+F10 / menu key, Alt+Enter (Özellikler), Ctrl+C / X / V,
  Ctrl+Shift+C (Yol olarak kopyala), F2, Delete, F5, arrows / Home / End / PageUp / PageDown (see
  *Input*).
