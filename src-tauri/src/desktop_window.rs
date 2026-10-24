//! The desktop-level window: creation, z-order rules, Win+D handling, hiding the
//! Windows icon view, the watchdog and capturing the original Windows icon layout.

use std::cell::{Cell, RefCell};
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use windows::core::{w, Interface, BOOL, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, COLORREF, HANDLE, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::Com::{CoCreateInstance, IServiceProvider, CLSCTX_ALL};
use windows::Win32::System::Console::SetConsoleCtrlHandler;
use windows::Win32::System::Power::RegisterPowerSettingNotification;
use windows::Win32::System::SystemServices::GUID_POWER_SAVING_STATUS;
use windows::Win32::System::Threading::{
    CreateEventW, CreateWaitableTimerExW, GetCurrentProcessId, OpenProcess, SetEvent, SetWaitableTimer,
    WaitForMultipleObjects, WaitForSingleObject, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, INFINITE, PROCESS_SYNCHRONIZE,
    TIMER_ALL_ACCESS,
};
use windows::Win32::System::Variant::{VARIANT, VT_I4};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::Shell::Common::{ITEMIDLIST, STRRET};
use windows::Win32::UI::Shell::{
    DefSubclassProc, IFolderView, IShellBrowser, IShellFolder, IShellWindows, SetWindowSubclass,
    ShellWindows, StrRetToStrW, SHGDN_FORPARSING, SID_STopLevelBrowser, SVGIO_ALLVIEW,
    SWC_DESKTOP, SWFO_NEEDDISPATCH,
};
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_EXCLUDED_FROM_PEEK};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::Media::{timeBeginPeriod, timeEndPeriod};
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::env::{self, Point, Rect};
use crate::{dlog, quiet, util, wallpaper};

const TIMER_ENV: usize = 0xFE01;

static DESKTOP: AtomicIsize = AtomicIsize::new(0);
static RAISED: AtomicBool = AtomicBool::new(false);
/// When we were last raised (ms since the first call); foreground changes right after are ignored.
static RAISED_AT: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    use std::sync::OnceLock;
    static START: OnceLock<std::time::Instant> = OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64 + 1
}
static ALLOW_Z: AtomicBool = AtomicBool::new(false);
static ALLOW_MOVE: AtomicBool = AtomicBool::new(false);
static HIDE_WANTED: AtomicBool = AtomicBool::new(false);
static REVEALED: AtomicBool = AtomicBool::new(false);
static WIN_ICONS_MODE: AtomicBool = AtomicBool::new(false);
static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);
static BOUNDS: Mutex<Rect> = Mutex::new(Rect { x: 0, y: 0, width: 0, height: 0 });
static LAYOUT: Mutex<Option<WindowsLayout>> = Mutex::new(None);

pub fn desktop_hwnd_value() -> isize {
    DESKTOP.load(Ordering::SeqCst)
}

pub fn desktop_hwnd() -> HWND {
    util::hwnd_from(desktop_hwnd_value())
}

pub fn is_raised() -> bool {
    RAISED.load(Ordering::SeqCst)
}

pub fn windows_icons_mode() -> bool {
    WIN_ICONS_MODE.load(Ordering::SeqCst)
}

// ---------------------------------------------------------------------------
// Windows icon view

pub(crate) fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

unsafe extern "system" fn find_defview_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if let Ok(dv) = FindWindowExW(Some(hwnd), None, w!("SHELLDLL_DefView"), None) {
        if !dv.is_invalid() {
            *(lparam.0 as *mut isize) = dv.0 as isize;
            return BOOL(0);
        }
    }
    BOOL(1)
}

pub(crate) fn find_defview() -> Option<HWND> {
    unsafe {
        if let Ok(progman) = FindWindowW(w!("Progman"), None) {
            if let Ok(dv) = FindWindowExW(Some(progman), None, w!("SHELLDLL_DefView"), None) {
                if !dv.is_invalid() {
                    return Some(dv);
                }
            }
        }
        let mut found: isize = 0;
        let _ = EnumWindows(Some(find_defview_proc), LPARAM(&mut found as *mut isize as isize));
        if found != 0 {
            Some(util::hwnd_from(found))
        } else {
            None
        }
    }
}

pub fn find_listview() -> Option<HWND> {
    let dv = find_defview()?;
    unsafe {
        FindWindowExW(Some(dv), None, w!("SysListView32"), None)
            .ok()
            .filter(|h| !h.is_invalid())
    }
}

/// Explorer owns and draws this menu, including Windows 11's modern menu and its New submenu.
/// The hidden icon view's selection must be cleared so a previous Explorer selection cannot
/// turn an empty-desktop click into an unrelated file menu.
pub fn show_context_menu(at: POINT) -> Result<(), String> {
    crate::explorer_menu::cancel_observer();
    util::run_sta(move || unsafe {
        let dv = find_defview().ok_or("Windows masaüstü görünümü bulunamadı")?;
        let lv = find_listview().ok_or("Windows masaüstü simge görünümü bulunamadı")?;
        let sw: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL).map_err(|e| e.message())?;
        let mut loc = VARIANT::default();
        (*loc.Anonymous.Anonymous).vt = VT_I4;
        let mut hwnd_i = 0i32;
        let disp = sw.FindWindowSW(&loc, &VARIANT::default(), SWC_DESKTOP, &mut hwnd_i, SWFO_NEEDDISPATCH)
            .map_err(|e| e.message())?;
        let sp: IServiceProvider = disp.cast().map_err(|e| e.message())?;
        let browser: IShellBrowser = sp.QueryService(&SID_STopLevelBrowser).map_err(|e| e.message())?;
        let view = browser.QueryActiveShellView().map_err(|e| e.message())?;
        view.SelectItem(std::ptr::null(), windows::Win32::UI::Shell::SVSI_DESELECTOTHERS.0 as u32)
            .map_err(|e| e.message())?;

        let mut pid = 0u32;
        GetWindowThreadProcessId(dv, Some(&mut pid));
        let _ = AllowSetForegroundWindow(pid);
        let root = GetAncestor(dv, GA_ROOT);
        if !root.is_invalid() {
            let _ = SetForegroundWindow(root);
            let _ = SetWindowPos(root, Some(HWND_BOTTOM), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
        // WM_CONTEXTMENU packs signed screen coordinates into two 16-bit words.
        let position = ((at.x as u32 & 0xffff) | ((at.y as u32 & 0xffff) << 16)) as i32 as isize;
        PostMessageW(Some(dv), WM_CONTEXTMENU, WPARAM(lv.0 as usize), LPARAM(position))
            .map_err(|e| e.message())
    })?
}

fn set_windows_icons_visible(visible: bool) {
    if visible { crate::explorer_menu::restore_view(); }
    if let Some(lv) = find_listview() {
        if !visible && crate::explorer_menu::is_staged(lv) { return; }
        unsafe {
            let is_visible = IsWindowVisible(lv).as_bool();
            if is_visible != visible {
                let _ = ShowWindowAsync(lv, if visible { SW_SHOW } else { SW_HIDE });
            }
        }
    }
}

/// Popup menus owned by our window follow the Windows app theme (dark/light) like Explorer's.
/// Uses uxtheme's long-stable ordinals: SetPreferredAppMode (135), AllowDarkModeForWindow (133),
/// FlushMenuThemes (136).
fn enable_dark_menus(hwnd: HWND) {
    use windows::core::PCSTR;
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    unsafe {
        let Ok(ux) = LoadLibraryW(w!("uxtheme.dll")) else { return };
        if let Some(f) = GetProcAddress(ux, PCSTR(135 as *const u8)) {
            let f: unsafe extern "system" fn(i32) -> i32 = std::mem::transmute(f);
            f(1); // AllowDark: follow the system app theme
        }
        if let Some(f) = GetProcAddress(ux, PCSTR(133 as *const u8)) {
            let f: unsafe extern "system" fn(HWND, BOOL) -> BOOL = std::mem::transmute(f);
            let _ = f(hwnd, BOOL(1));
        }
        if let Some(f) = GetProcAddress(ux, PCSTR(136 as *const u8)) {
            let f: unsafe extern "system" fn() = std::mem::transmute(f);
            f();
        }
    }
}

/// Private message: "close gracefully" (sent by `--quit`, e.g. from the uninstaller).
const WM_FE_QUIT: u32 = WM_APP + 0x2F;
/// Windows' Yeni ▸ Folder Explorer grubu runs `--new-group`, which posts this to the running desktop.
const WM_FE_NEWGROUP: u32 = WM_APP + 0x30;
const DESKTOP_TITLE: windows::core::PCWSTR = w!("Folder Explorer Masaüstü");

/// `--new-group`: ask the running desktop for a new group. False when Folder Explorer is not running.
pub fn post_new_group() -> bool {
    unsafe {
        let Ok(h) = FindWindowW(None, DESKTOP_TITLE) else { return false };
        if h.is_invalid() {
            return false;
        }
        // Started from Explorer's menu we may pass the foreground on; the running desktop needs it
        // to show the group's name box in front of the Explorer window.
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, Some(&mut pid));
        let _ = AllowSetForegroundWindow(pid);
        PostMessageW(Some(h), WM_FE_NEWGROUP, WPARAM(0), LPARAM(0)).is_ok()
    }
}

/// Ask a running instance to quit, wait up to 6 s for it, then make sure icons are visible.
pub fn quit_running_instance() {
    unsafe {
        if let Ok(h) = FindWindowW(None, DESKTOP_TITLE) {
            if !h.is_invalid() {
                let mut pid = 0u32;
                GetWindowThreadProcessId(h, Some(&mut pid));
                let proc = OpenProcess(PROCESS_SYNCHRONIZE, false, pid).ok();
                let _ = PostMessageW(Some(h), WM_FE_QUIT, WPARAM(0), LPARAM(0));
                // Wait for the whole process to end (WebView2 teardown takes a moment),
                // so installers don't find it still running.
                if let Some(p) = proc {
                    WaitForSingleObject(p, 10_000);
                    let _ = CloseHandle(p);
                } else {
                    for _ in 0..60 {
                        std::thread::sleep(Duration::from_millis(100));
                        if !IsWindow(Some(h)).as_bool() {
                            break;
                        }
                    }
                }
                // its watchdog exits ~300 ms after the main process
                std::thread::sleep(Duration::from_millis(900));
            }
        }
    }
    set_windows_icons_visible(true);
    std::thread::sleep(Duration::from_millis(200));
}


/// The desktop window was destroyed without us asking (its owner, Windows' desktop window, died: Explorer
/// restarted). Start a fresh copy a few seconds from now, once the old process has exited. Not when the
/// app had only just started, so a problem at startup can never turn into a restart loop.
pub fn restart_after_explorer() {
    static STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let started = *STARTED.get_or_init(std::time::Instant::now);
    if started.elapsed() < Duration::from_secs(20) {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let _ = std::process::Command::new(exe)
        .args(["--delayed-start", "4", "--autostart"])
        .creation_flags(DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB)
        .spawn();
}

/// Always safe to call; brings the Windows desktop icons back.
pub fn restore_icons() {
    HIDE_WANTED.store(false, Ordering::SeqCst);
    set_windows_icons_visible(true);
}

pub fn run_watchdog(pid: u32) {
    unsafe {
        if let Ok(h) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            WaitForSingleObject(h, INFINITE);
            let _ = CloseHandle(h);
        }
    }
    std::thread::sleep(Duration::from_millis(300));
    set_windows_icons_visible(true);
}

/// The watchdog has to outlive "kill the process tree" (Task Manager's End process tree, a dev tool
/// stopping `tauri dev`), which walks parent → child. So it is not our child: a launcher starts it
/// and exits at once, leaving the watchdog outside our tree.
fn spawn_watchdog() {
    spawn_self(&["--watchdog-launch", &std::process::id().to_string()]);
}

/// `--watchdog-launch <pid>`: start the real watchdog and return immediately.
pub fn launch_watchdog(pid: &str) {
    spawn_self(&["--watchdog", pid]);
}

fn spawn_self(args: &[&str]) {
    let Ok(exe) = std::env::current_exe() else { return };
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let first = std::process::Command::new(&exe)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB)
        .spawn();
    if first.is_err() {
        let _ = std::process::Command::new(&exe).args(args).creation_flags(CREATE_NO_WINDOW).spawn();
    }
}

unsafe extern "system" fn console_ctrl(_ctrl: u32) -> BOOL {
    restore_icons();
    BOOL(0)
}

// ---------------------------------------------------------------------------
// Original Windows layout

#[derive(Serialize, Clone, Debug, Default)]
pub struct LayoutItem {
    pub id: String,
    pub x: i32,
    pub y: i32,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct WindowsLayout {
    pub spacing: Option<Point>,
    pub items: Vec<LayoutItem>,
}

/// Reads the current Windows desktop icon positions (screen coords). Needs STA.
pub fn capture_windows_layout_sta() -> Result<WindowsLayout, String> {
    unsafe {
        let sw: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL).map_err(|e| e.message())?;
        let mut loc = VARIANT::default();
        (*loc.Anonymous.Anonymous).vt = VT_I4; // CSIDL_DESKTOP == 0
        let empty = VARIANT::default();
        let mut hwnd_i: i32 = 0;
        let disp = sw
            .FindWindowSW(&loc, &empty, SWC_DESKTOP, &mut hwnd_i, SWFO_NEEDDISPATCH)
            .map_err(|e| e.message())?;
        let sp: IServiceProvider = disp.cast().map_err(|e| e.message())?;
        let browser: IShellBrowser = sp.QueryService(&SID_STopLevelBrowser).map_err(|e| e.message())?;
        let view = browser.QueryActiveShellView().map_err(|e| e.message())?;
        let fv: IFolderView = view.cast().map_err(|e| e.message())?;
        let mut spacing_pt = POINT::default();
        let spacing = fv.GetSpacing(&mut spacing_pt).ok().map(|_| Point { x: spacing_pt.x, y: spacing_pt.y });
        let folder: IShellFolder = fv.GetFolder().map_err(|e| e.message())?;
        let en: windows::Win32::UI::Shell::IEnumIDList = fv.Items(SVGIO_ALLVIEW).map_err(|e| e.message())?;
        let mut origin = POINT::default();
        if let Some(lv) = find_listview() {
            let _ = ClientToScreen(lv, &mut origin);
        }
        let mut items = Vec::new();
        loop {
            let mut arr: [*mut ITEMIDLIST; 1] = [std::ptr::null_mut()];
            let mut fetched = 0u32;
            let hr = en.Next(&mut arr, Some(&mut fetched));
            if hr.is_err() || fetched == 0 || arr[0].is_null() {
                break;
            }
            let pidl = arr[0];
            if let Ok(pt) = fv.GetItemPosition(pidl) {
                let mut sr = STRRET::default();
                if folder.GetDisplayNameOf(pidl, SHGDN_FORPARSING, &mut sr).is_ok() {
                    let mut pw = windows::core::PWSTR::null();
                    if StrRetToStrW(&mut sr, Some(pidl), &mut pw).is_ok() {
                        let path = util::take_pwstr(pw);
                        items.push(LayoutItem { id: path.to_lowercase(), x: pt.x + origin.x, y: pt.y + origin.y });
                    }
                }
            }
            windows::Win32::System::Com::CoTaskMemFree(Some(pidl as *const _));
        }
        Ok(WindowsLayout { spacing, items })
    }
}

pub fn init_windows_layout() {
    match util::run_sta(capture_windows_layout_sta) {
        Ok(Ok(l)) => {
            dlog!("captured {} windows icon positions", l.items.len());
            *LAYOUT.lock().unwrap() = Some(l);
        }
        Ok(Err(e)) | Err(e) => dlog!("layout capture failed: {e}"),
    }
}

pub fn get_windows_layout() -> WindowsLayout {
    LAYOUT.lock().unwrap().clone().unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Z-order

/// Pixels the window stays short of the monitors' edge (right and bottom). Wallpaper Engine
/// pauses for any window that is monitor-sized, even a transparent one; this keeps us under
/// that. Only the empty taskbar strip / outer cell padding is lost.
const FIT_INSET: i32 = 6;

fn window_bounds() -> Rect {
    let b = env::virtual_bounds();
    Rect { x: b.x, y: b.y, width: (b.width - FIT_INSET).max(1), height: (b.height - FIT_INSET).max(1) }
}

static PROGMAN: AtomicIsize = AtomicIsize::new(0);

/// Windows' shell desktop window (cached: the z-order guard asks for it on every check).
fn progman() -> HWND {
    unsafe {
        let cached = util::hwnd_from(PROGMAN.load(Ordering::Relaxed));
        if !cached.is_invalid() && IsWindow(Some(cached)).as_bool() {
            return cached;
        }
        match FindWindowW(w!("Progman"), None) {
            Ok(h) if !h.is_invalid() => {
                PROGMAN.store(h.0 as isize, Ordering::Relaxed);
                h
            }
            _ => HWND::default(),
        }
    }
}

/// Our window is OWNED by Progman (the shell desktop window): Windows keeps an owned window above
/// its owner and moves it along whenever the owner is raised. Clicking the empty desktop activates
/// Progman, and Windows lifts it for a moment — without ownership it went over our window and
/// covered every icon for a frame. This changes a property of OUR window only; nothing in Explorer.
/// Idempotent; also repairs the link after an Explorer restart (new Progman).
fn own_by_progman() {
    unsafe {
        let me = desktop_hwnd();
        let pm = progman();
        if me.is_invalid() || pm.is_invalid() {
            return;
        }
        if GetWindow(me, GW_OWNER).unwrap_or_default() != pm {
            SetWindowLongPtrW(me, GWLP_HWNDPARENT, pm.0 as isize);
        }
    }
}

static QUITTING: AtomicBool = AtomicBool::new(false);

/// Set when the app is being closed on purpose (tray, installer, log-off); an owned window dies with
/// its owner, so without this flag a closing desktop window means "Explorer restarted".
pub fn mark_quitting(quitting: bool) {
    QUITTING.store(quitting, Ordering::SeqCst);
}

pub fn is_quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

/// Where our window goes in the z-order: directly above Progman (the shell desktop).
/// Normally Progman is at the bottom, so this is "bottom"; during "Show desktop" (Win+D)
/// the shell lifts Progman to the top, and we follow it.
fn bottom_anchor() -> HWND {
    unsafe {
        let me = desktop_hwnd();
        let pm = progman();
        if pm.is_invalid() {
            return HWND_BOTTOM;
        }
        let mut prev = GetWindow(pm, GW_HWNDPREV).unwrap_or_default();
        while !prev.is_invalid() && prev == me {
            prev = GetWindow(prev, GW_HWNDPREV).unwrap_or_default();
        }
        if prev.is_invalid() {
            return HWND_TOP;
        }
        // Never slot in under a topmost window: that would make us topmost too.
        let ex = GetWindowLongPtrW(prev, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOPMOST.0 != 0 {
            return HWND_TOP;
        }
        prev
    }
}

/// True when we are not directly above Progman: Progman is above us (after Win+D), or some
/// visible window lies between us and Progman (we drifted too high, e.g. over app windows).
fn misplaced() -> bool {
    unsafe {
        let me = desktop_hwnd();
        let pm = progman();
        if pm.is_invalid() || me.is_invalid() {
            return false;
        }
        let mut h = GetWindow(me, GW_HWNDNEXT).unwrap_or_default();
        let mut guard = 0;
        while !h.is_invalid() && guard < 4000 {
            if h == pm {
                return false;
            }
            if IsWindowVisible(h).as_bool() && !IsIconic(h).as_bool() {
                return true;
            }
            h = GetWindow(h, GW_HWNDNEXT).unwrap_or_default();
            guard += 1;
        }
        true // Progman is not below us
    }
}

/// Put us back directly above Progman if we are anywhere else.
pub fn ensure_z() {
    if !guard_active() || is_raised() {
        return;
    }
    if misplaced() {
        place_bottom(desktop_hwnd());
    }
}

/// The z-order only matters while our desktop is shown and some monitor shows it.
fn guard_active() -> bool {
    REVEALED.load(Ordering::SeqCst) && !windows_icons_mode() && !quiet::all_covered() && !is_quitting()
}

fn place_bottom(hwnd: HWND) {
    crate::diag!("z   place_bottom");
    ALLOW_Z.store(true, Ordering::SeqCst);
    unsafe {
        let _ = SetWindowPos(hwnd, Some(bottom_anchor()), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
    ALLOW_Z.store(false, Ordering::SeqCst);
}

pub fn set_raised(raised: bool, focus: bool) {
    let h = desktop_hwnd();
    if h.is_invalid() || windows_icons_mode() {
        return;
    }
    RAISED.store(raised, Ordering::SeqCst);
    if raised {
        RAISED_AT.store(now_ms(), Ordering::SeqCst);
    }
    unsafe {
        if raised {
            ALLOW_Z.store(true, Ordering::SeqCst);
            let _ = SetWindowPos(h, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
            ALLOW_Z.store(false, Ordering::SeqCst);
            if focus {
                let _ = SetForegroundWindow(h);
            }
        } else {
            place_bottom(h);
        }
    }
    // raised over a fullscreen app: the desktop is in front again (and must be awake)
    request_game_eval(0);
    if let Some(app) = util::app() {
        #[derive(Serialize, Clone)]
        struct Raised {
            raised: bool,
        }
        let _ = app.emit("desktop-raised", Raised { raised });
    }
}

const SHELL_UI_CLASSES: &[&str] = &[
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "Windows.UI.Core.CoreWindow",
    "XamlExplorerHostIslandWindow",
    "TopLevelWindowForOverflowXamlIsland",
    "NotifyIconOverflowWindow",
    "Shell_InputSwitchTopLevelWindow",
    "ForegroundStaging",
    "MultitaskingViewFrame",
    "TaskSwitcherWnd",
    "#32768",
    // Windows Hello / credential prompt (a locked group asks over our raised window)
    "Credential Dialog Xaml Host",
];

/// Start menu, taskbar, Alt+Tab, Windows' own context menus…
pub(crate) fn is_shell_ui_class(class: &str) -> bool {
    SHELL_UI_CLASSES.contains(&class) || class.starts_with("XamlExplorerHostIslandWindow")
}

fn is_own_window(hwnd: HWND) -> bool {
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        pid == GetCurrentProcessId()
    }
}

// ---------------------------------------------------------------------------
// Z-order guard and system events, without polling
//
// "Show desktop" (Win+D), Explorer and other apps shuffle the z-order; when the shell lifts Progman
// over our window every icon is covered until we are back above it (a visible blink if that takes
// longer than a frame). Two threads keep that from happening while idling at zero CPU:
// * `fe-events` owns passive, out-of-context WinEventHooks (foreground changes system-wide; windows
//   Explorer shows and top-level z-order changes Explorer makes; in game mode size / minimize changes
//   of the foreground window) plus the recycle-bin change notification. Callbacks only note what
//   happened.
// * `fe-zguard` sleeps on an event without a timeout. Woken, it checks (and fixes) the order at once,
//   then keeps checking every 2 ms for a short burst: the shell raises Progman more than once while it
//   shows the desktop, and a missed raise would blink. The 2 ms ticks come from a high-resolution
//   waitable timer, so the system timer resolution is never raised (fallback: `timeBeginPeriod(1)`
//   strictly for the duration of a burst).
// Our own window's messages (activation, z-order changes, being hidden) wake the guard too, and
// `WM_WINDOWPOSCHANGING` keeps anchoring every z-order change of our window directly above Progman.

const FAST_TICK_MS: u64 = 2;
const TAIL_TICK_MS: u64 = 16;
/// Keep checking closely this long after the guard had to put the window back.
const FIGHT_MS: u64 = 300;

static GUARD_EVENT: AtomicIsize = AtomicIsize::new(0);
/// Check every FAST_TICK_MS until FAST_UNTIL, then every TAIL_TICK_MS until TAIL_UNTIL (`now_ms` clock).
static FAST_UNTIL: AtomicU64 = AtomicU64::new(0);
static TAIL_UNTIL: AtomicU64 = AtomicU64::new(0);
static CHECK_NOW: AtomicBool = AtomicBool::new(false);
/// When game mode is to be re-evaluated (0 = not scheduled).
static GAME_EVAL_AT: AtomicU64 = AtomicU64::new(0);
static HOOKS_OK: AtomicBool = AtomicBool::new(false);
static EVENTS_HWND: AtomicIsize = AtomicIsize::new(0);
/// The foreground window as last reported.
static FOREGROUND: AtomicIsize = AtomicIsize::new(0);

const WM_FE_GAME_HOOKS: u32 = WM_APP + 0x30;
const WM_FE_SHELL_HOOK: u32 = WM_APP + 0x31;
const WM_FE_RECYCLE: u32 = WM_APP + 0x32;

fn wake_guard() {
    let ev = GUARD_EVENT.load(Ordering::SeqCst);
    if ev != 0 {
        unsafe {
            let _ = SetEvent(HANDLE(ev as *mut _));
        }
    }
}

/// Check the z-order now, then every 2 ms for `fast_ms` and every 16 ms until `tail_ms`.
pub fn kick(fast_ms: u64, tail_ms: u64) {
    let now = now_ms();
    if fast_ms > 0 {
        FAST_UNTIL.fetch_max(now + fast_ms, Ordering::SeqCst);
    }
    if tail_ms > 0 {
        TAIL_UNTIL.fetch_max(now + tail_ms, Ordering::SeqCst);
    }
    CHECK_NOW.store(true, Ordering::SeqCst);
    wake_guard();
}

/// Re-evaluate game mode within `delay_ms` (an earlier pending request stays earlier).
pub fn request_game_eval(delay_ms: u64) {
    let at = now_ms() + delay_ms;
    let _ = GAME_EVAL_AT.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |cur| {
        Some(if cur == 0 { at } else { cur.min(at) })
    });
    wake_guard();
}

fn post_events(msg: u32) {
    let h = EVENTS_HWND.load(Ordering::SeqCst);
    if h != 0 {
        unsafe {
            let _ = PostMessageW(Some(util::hwnd_from(h)), msg, WPARAM(0), LPARAM(0));
        }
    }
}

/// `performance.gameMode` changed: (un)install the hooks that only game mode needs.
pub fn game_hooks_changed() {
    post_events(WM_FE_GAME_HOOKS);
}

#[derive(Default)]
struct Fixes {
    bad_since: Option<std::time::Instant>,
    window_start: u64,
    count: u32,
}

/// One check: shown, not minimized, directly above Progman.
fn guard_tick(fixes: &mut Fixes) {
    if !guard_active() {
        return;
    }
    let h = desktop_hwnd();
    if h.is_invalid() {
        return;
    }
    unsafe {
        if IsIconic(h).as_bool() || !IsWindowVisible(h).as_bool() {
            let _ = ShowWindowAsync(h, SW_SHOWNOACTIVATE);
        }
    }
    if !is_raised() && misplaced() {
        if cfg!(debug_assertions) {
            fixes.bad_since.get_or_insert_with(std::time::Instant::now);
        }
        place_bottom(h);
        let now = now_ms();
        if now.saturating_sub(fixes.window_start) > 1000 {
            fixes.window_start = now;
            fixes.count = 0;
        }
        fixes.count += 1;
        // Another program that wants the same spot would turn this into an endless 2 ms fight:
        // after 20 fixes in a second the burst is no longer extended (the next event starts anew).
        if fixes.count <= 20 {
            FAST_UNTIL.fetch_max(now + FIGHT_MS, Ordering::SeqCst);
        }
    } else if let Some(t) = fixes.bad_since.take() {
        crate::diag!("z   covered for {:.1} ms", t.elapsed().as_secs_f64() * 1000.0);
    }
}

fn run_guard() {
    unsafe {
        let Ok(event) = CreateEventW(None, false, false, PCWSTR::null()) else { return };
        GUARD_EVENT.store(event.0 as isize, Ordering::SeqCst);
        let timer = CreateWaitableTimerExW(None, PCWSTR::null(), CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS.0).ok();
        let mut period = false;
        let mut fixes = Fixes::default();
        loop {
            let now = now_ms();
            let active = guard_active();
            let fast = active && FAST_UNTIL.load(Ordering::SeqCst) > now;
            let tail = active && TAIL_UNTIL.load(Ordering::SeqCst) > now;
            let mut wait = if fast { Some(FAST_TICK_MS) } else if tail { Some(TAIL_TICK_MS) } else { None };
            let eval_at = GAME_EVAL_AT.load(Ordering::SeqCst);
            if eval_at != 0 {
                let d = eval_at.saturating_sub(now);
                wait = Some(wait.map_or(d, |w| w.min(d)));
            }
            if timer.is_none() && fast != period {
                if fast {
                    timeBeginPeriod(1);
                } else {
                    timeEndPeriod(1);
                }
                period = fast;
            }
            match (wait, timer) {
                (Some(ms), Some(t)) => {
                    let due = -((ms.max(1) as i64) * 10_000);
                    if SetWaitableTimer(t, &due, 0, None, None, false).is_ok() {
                        WaitForMultipleObjects(&[event, t], false, INFINITE);
                    } else {
                        WaitForSingleObject(event, ms as u32);
                    }
                }
                (Some(ms), None) => {
                    WaitForSingleObject(event, ms as u32);
                }
                (None, _) => {
                    WaitForSingleObject(event, INFINITE);
                }
            }
            let now = now_ms();
            let eval_at = GAME_EVAL_AT.load(Ordering::SeqCst);
            if eval_at != 0
                && eval_at <= now
                && GAME_EVAL_AT.compare_exchange(eval_at, 0, Ordering::SeqCst, Ordering::SeqCst).is_ok()
            {
                quiet::evaluate_game();
            }
            if CHECK_NOW.swap(false, Ordering::SeqCst)
                || FAST_UNTIL.load(Ordering::SeqCst) > now
                || TAIL_UNTIL.load(Ordering::SeqCst) > now
            {
                guard_tick(&mut fixes);
            }
        }
    }
}

fn hook(event_min: u32, event_max: u32, pid: u32) -> HWINEVENTHOOK {
    unsafe {
        SetWinEventHook(
            event_min,
            event_max,
            None,
            Some(on_win_event),
            pid,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        )
    }
}

fn unhook(h: isize) {
    if h != 0 {
        unsafe {
            let _ = UnhookWinEvent(HWINEVENTHOOK(h as *mut _));
        }
    }
}

thread_local! {
    /// (hook, Explorer's process id): windows Explorer shows (its icon view, Progman, WorkerW) and
    /// top-level z-order changes it makes.
    static SHELL_HOOK: Cell<(isize, u32)> = const { Cell::new((0, 0)) };
    /// game mode: move/size ends and minimize start/end, system-wide (rare events)
    static GAME_HOOKS: RefCell<Vec<isize>> = const { RefCell::new(Vec::new()) };
    /// game mode: (hook, process id) for location changes of the foreground window's process
    static LOCATION_HOOK: Cell<(isize, u32)> = const { Cell::new((0, 0)) };
}

fn install_shell_hook() {
    let pm = progman();
    let mut pid = 0u32;
    if !pm.is_invalid() {
        unsafe {
            GetWindowThreadProcessId(pm, Some(&mut pid));
        }
    }
    SHELL_HOOK.with(|c| {
        let (old, old_pid) = c.get();
        if old != 0 && old_pid == pid {
            return;
        }
        unhook(old);
        // show, hide, reorder: hide is filtered out in the callback
        let h = if pid != 0 { hook(EVENT_OBJECT_SHOW, EVENT_OBJECT_REORDER, pid).0 as isize } else { 0 };
        c.set((h, pid));
    });
}

fn sync_game_hooks() {
    let on = quiet::game_mode_enabled();
    GAME_HOOKS.with(|g| {
        let mut g = g.borrow_mut();
        if on && g.is_empty() {
            g.push(hook(EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZEEND, 0).0 as isize);
            g.push(hook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, 0).0 as isize);
        } else if !on {
            g.drain(..).for_each(unhook);
        }
    });
    let fg = if on { util::hwnd_from(FOREGROUND.load(Ordering::SeqCst)) } else { HWND::default() };
    watch_location(fg);
    if on {
        request_game_eval(0);
    }
}

/// F11, borderless ↔ windowed and the like resize the foreground window without any other event:
/// listen to location changes of that window's process only (re-targeted on each foreground change,
/// nothing for the shell or our own windows).
fn watch_location(fg: HWND) {
    let mut pid = 0u32;
    if !fg.is_invalid() && !is_own_window(fg) {
        let class = class_name(fg);
        if !(is_shell_ui_class(&class) || class == "Progman" || class == "WorkerW") {
            unsafe {
                GetWindowThreadProcessId(fg, Some(&mut pid));
            }
        }
    }
    LOCATION_HOOK.with(|c| {
        let (old, old_pid) = c.get();
        if old_pid == pid && (old != 0 || pid == 0) {
            return;
        }
        unhook(old);
        let h = if pid != 0 { hook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, pid).0 as isize } else { 0 };
        c.set((h, pid));
    });
}

unsafe extern "system" fn on_win_event(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    id_child: i32,
    _thread: u32,
    _time: u32,
) {
    match event {
        EVENT_SYSTEM_FOREGROUND => on_foreground(hwnd, id_object),
        EVENT_OBJECT_REORDER => {
            // Explorer changed the z-order of top-level windows (lifting Progman, putting it back)
            if hwnd.is_invalid() || hwnd == GetDesktopWindow() {
                kick(0, 0);
            }
        }
        EVENT_OBJECT_SHOW => {
            if id_object == OBJID_WINDOW.0 && id_child == 0 {
                on_shell_show(hwnd);
            }
        }
        EVENT_OBJECT_LOCATIONCHANGE => {
            if id_object == OBJID_WINDOW.0 && hwnd.0 as isize == FOREGROUND.load(Ordering::Relaxed) {
                request_game_eval(150);
            }
        }
        EVENT_SYSTEM_MOVESIZEEND | EVENT_SYSTEM_MINIMIZESTART | EVENT_SYSTEM_MINIMIZEEND => request_game_eval(150),
        _ => {}
    }
}

fn on_foreground(hwnd: HWND, id_object: i32) {
    if id_object != OBJID_WINDOW.0 || hwnd.is_invalid() {
        return;
    }
    FOREGROUND.store(hwnd.0 as isize, Ordering::SeqCst);
    if quiet::game_mode_enabled() {
        watch_location(hwnd);
        request_game_eval(0);
    }
    if is_own_window(hwnd) {
        return;
    }
    let class = class_name(hwnd);
    crate::diag!("fg  {class} z_misplaced={}", misplaced());
    if class == "WorkerW" || class == "Progman" {
        // "Show desktop": the shell lifts Progman while it minimizes windows, sometimes more than
        // once: follow it now and keep watching closely for a moment.
        kick(400, 1200);
    } else if is_shell_ui_class(&class) {
        // Start menu, taskbar, Alt+Tab, Windows' own context menu… keep the current state.
        kick(0, 0);
    } else {
        // Windows hands the foreground around for a moment when a menu closes; give a fresh raise
        // time to settle before treating another window in front as "the user moved on".
        if is_raised() && now_ms().saturating_sub(RAISED_AT.load(Ordering::SeqCst)) > 1500 {
            set_raised(false, false);
        }
        kick(100, 0);
    }
}

fn on_shell_show(hwnd: HWND) {
    let class = class_name(hwnd);
    match class.as_str() {
        // Explorer showed its icon view again (refresh, settings change): hide it at once.
        "SysListView32" => {
            if HIDE_WANTED.load(Ordering::SeqCst) && !windows_icons_mode() && find_listview() == Some(hwnd) {
                set_windows_icons_visible(false);
            }
        }
        "Progman" | "WorkerW" => kick(FIGHT_MS, 0),
        _ => {}
    }
}

unsafe extern "system" fn events_wndproc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    match m {
        WM_FE_GAME_HOOKS => sync_game_hooks(),
        WM_FE_SHELL_HOOK => install_shell_hook(),
        WM_FE_RECYCLE => crate::items::on_recycle_notify(w, l),
        _ => return DefWindowProcW(h, m, w, l),
    }
    LRESULT(0)
}

fn run_events() {
    let _com = util::ComApartment::sta();
    unsafe {
        let hinst = windows::Win32::System::LibraryLoader::GetModuleHandleW(None).unwrap_or_default();
        let class = w!("FolderExplorerEvents");
        let wc = WNDCLASSW { lpfnWndProc: Some(events_wndproc), hInstance: hinst.into(), lpszClassName: class, ..Default::default() };
        RegisterClassW(&wc);
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!(""),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(hinst.into()),
            None,
        )
        .unwrap_or_default();
        EVENTS_HWND.store(hwnd.0 as isize, Ordering::SeqCst);
        let fg = hook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, 0);
        HOOKS_OK.store(!fg.is_invalid(), Ordering::SeqCst);
        FOREGROUND.store(GetForegroundWindow().0 as isize, Ordering::SeqCst);
        install_shell_hook();
        sync_game_hooks();
        if !hwnd.is_invalid() {
            crate::items::watch_recycle_bin(hwnd, WM_FE_RECYCLE);
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

// ---------------------------------------------------------------------------
// Subclass

fn enforce_style(s: u32) -> u32 {
    let remove = (WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_BORDER | WS_DLGFRAME).0;
    (s & !remove) | (WS_POPUP | WS_CLIPCHILDREN).0
}

/// Layered for good (switching it makes Windows hide and re-show the window for a moment) and
/// never click-through: the whole desktop, empty spots included, belongs to the app.
fn enforce_exstyle(s: u32) -> u32 {
    (s | WS_EX_TOOLWINDOW.0 | WS_EX_LAYERED.0) & !(WS_EX_APPWINDOW.0 | WS_EX_TRANSPARENT.0)
}

fn apply_bounds(hwnd: HWND) {
    let b = window_bounds();
    *BOUNDS.lock().unwrap() = b;
    ALLOW_MOVE.store(true, Ordering::SeqCst);
    unsafe {
        let _ = SetWindowPos(hwnd, None, b.x, b.y, b.width, b.height, SWP_NOZORDER | SWP_NOACTIVATE);
    }
    ALLOW_MOVE.store(false, Ordering::SeqCst);
}

pub fn window_origin() -> Point {
    let b = *BOUNDS.lock().unwrap();
    Point { x: b.x, y: b.y }
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    match msg {
        // No non-client area at all: otherwise Windows paints a caption bar into the
        // (transparent) window when it gets activated.
        WM_NCCALCSIZE if wparam.0 != 0 => return LRESULT(0),
        WM_NCPAINT => return LRESULT(0),
        WM_NCACTIVATE => return LRESULT(1),
        WM_WINDOWPOSCHANGING => {
            let wp = &mut *(lparam.0 as *mut WINDOWPOS);
            if (wp.flags & SWP_NOZORDER).0 == 0 && !RAISED.load(Ordering::SeqCst) && !ALLOW_Z.load(Ordering::SeqCst) {
                wp.hwndInsertAfter = bottom_anchor();
            }
            if !ALLOW_MOVE.load(Ordering::SeqCst) {
                let b = *BOUNDS.lock().unwrap();
                if b.width > 0 {
                    if (wp.flags & SWP_NOMOVE).0 == 0 {
                        wp.x = b.x;
                        wp.y = b.y;
                    }
                    if (wp.flags & SWP_NOSIZE).0 == 0 {
                        wp.cx = b.width;
                        wp.cy = b.height;
                    }
                }
            }
        }
        // Our z-order changed (not by us) or we are being hidden: the shell may lift Progman right
        // after (activation), so the guard watches for a moment.
        WM_WINDOWPOSCHANGED => {
            let wp = &*(lparam.0 as *const WINDOWPOS);
            let z = (wp.flags & SWP_NOZORDER).0 == 0 && !ALLOW_Z.load(Ordering::SeqCst);
            if z || (wp.flags & SWP_HIDEWINDOW).0 != 0 {
                kick(150, 0);
            }
        }
        WM_ACTIVATE if (wparam.0 & 0xFFFF) as u32 != WA_INACTIVE => kick(FIGHT_MS, 0),
        WM_SHOWWINDOW if wparam.0 == 0 => kick(50, 0),
        WM_SIZE if wparam.0 as u32 == SIZE_MINIMIZED => kick(50, 0),
        // AC ↔ battery, battery saver (PBT_POWERSETTINGCHANGE), resume from sleep
        WM_POWERBROADCAST => {
            quiet::on_power_change();
            if wparam.0 as u32 == PBT_APMRESUMEAUTOMATIC {
                request_game_eval(500);
                kick(FIGHT_MS, 0);
            }
        }
        WM_SYSCOMMAND => {
            let cmd = (wparam.0 & 0xFFF0) as u32;
            if cmd == SC_MINIMIZE || cmd == SC_MAXIMIZE || cmd == SC_MOVE || cmd == SC_SIZE || cmd == SC_CLOSE {
                return LRESULT(0);
            }
        }
        WM_STYLECHANGING => {
            let ss = &mut *(lparam.0 as *mut STYLESTRUCT);
            let which = wparam.0 as i32;
            if which == GWL_STYLE.0 {
                ss.styleNew = enforce_style(ss.styleNew);
            } else if which == GWL_EXSTYLE.0 {
                ss.styleNew = enforce_exstyle(ss.styleNew);
            }
        }
        WM_DISPLAYCHANGE | WM_DPICHANGED => {
            SetTimer(Some(hwnd), TIMER_ENV, 700, None);
            // an exclusive-fullscreen game switching the display mode
            request_game_eval(1000);
        }
        WM_SETTINGCHANGE => {
            if wparam.0 as u32 == SPI_SETDESKWALLPAPER.0 {
                std::thread::spawn(|| {
                    std::thread::sleep(Duration::from_millis(400));
                    wallpaper::emit_changed();
                });
            } else if wparam.0 as u32 == SPI_SETWORKAREA.0 {
                SetTimer(Some(hwnd), TIMER_ENV, 700, None);
            }
        }
        WM_TIMER if wparam.0 == TIMER_ENV => {
            let _ = KillTimer(Some(hwnd), TIMER_ENV);
            apply_bounds(hwnd);
            if let Some(app) = util::app() {
                let _ = app.emit("environment-changed", ());
            }
            return LRESULT(0);
        }
        WM_QUERYENDSESSION => mark_quitting(true),
        WM_ENDSESSION => {
            if wparam.0 != 0 {
                restore_icons();
            } else {
                mark_quitting(false); // log-off was cancelled
            }
        }
        WM_CLOSE => return LRESULT(0),
        WM_FE_QUIT => {
            if let Some(app) = util::app() {
                crate::windows_mgr::quit(&app);
            }
            return LRESULT(0);
        }
        WM_FE_NEWGROUP => {
            if let Some(app) = util::app() {
                crate::windows_mgr::new_group(&app);
            }
            return LRESULT(0);
        }
        _ => {
            let tc = TASKBAR_CREATED.load(Ordering::SeqCst);
            if tc != 0 && msg == tc {
                // Explorer restarted: new Progman / icon view.
                let hv = hwnd.0 as isize;
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1500));
                    own_by_progman();
                    post_events(WM_FE_SHELL_HOOK);
                    if HIDE_WANTED.load(Ordering::SeqCst) {
                        set_windows_icons_visible(false);
                    }
                    if !is_raised() {
                        place_bottom(util::hwnd_from(hv));
                    }
                });
            }
        }
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

// ---------------------------------------------------------------------------
// Creation

fn reveal() {
    if REVEALED.swap(true, Ordering::SeqCst) || windows_icons_mode() {
        return;
    }
    let h = desktop_hwnd();
    unsafe {
        let _ = ShowWindowAsync(h, SW_SHOWNOACTIVATE);
    }
    place_bottom(h);
    HIDE_WANTED.store(true, Ordering::SeqCst);
    set_windows_icons_visible(false);
    dlog!("desktop window revealed");
}

pub fn create(app: &AppHandle) -> Result<(), String> {
    let bounds = window_bounds();
    *BOUNDS.lock().unwrap() = bounds;

    let win = WebviewWindowBuilder::new(app, "desktop", WebviewUrl::App("index.html?view=desktop".into()))
        .title("Folder Explorer Masaüstü") // keep in sync with DESKTOP_TITLE
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .focused(false)
        // Transparent: the real desktop (Windows wallpaper, slideshow, Wallpaper Engine…)
        // shows through; the UI draws its own wallpaper only when the user picks one.
        .transparent(true)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .initialization_script("window.__FE_VIEW__ = 'desktop';")
        .on_page_load(|_w, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                std::thread::spawn(|| {
                    std::thread::sleep(Duration::from_millis(250));
                    reveal();
                });
            }
        })
        .build()
        .map_err(|e| e.to_string())?;

    let hwnd = HWND(win.hwnd().map_err(|e| e.to_string())?.0 as *mut _);
    DESKTOP.store(hwnd.0 as isize, Ordering::SeqCst);
    enable_dark_menus(hwnd);

    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        SetWindowLongPtrW(hwnd, GWL_STYLE, enforce_style(style) as isize);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, enforce_exstyle(ex) as isize);
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
        let _ = SetPropW(hwnd, w!("NonRudeHWND"), Some(HANDLE(1 as *mut _)));
        // "Show desktop" peek hides every window except those excluded from it: we stay visible.
        let excluded: i32 = 1;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_EXCLUDED_FROM_PEEK,
            &excluded as *const i32 as *const std::ffi::c_void,
            std::mem::size_of::<i32>() as u32,
        );
        let _ = SetWindowSubclass(hwnd, Some(subclass_proc), 0xFE, 0);
        own_by_progman();
        TASKBAR_CREATED.store(RegisterWindowMessageW(w!("TaskbarCreated")), Ordering::SeqCst);
        ALLOW_MOVE.store(true, Ordering::SeqCst);
        let _ = SetWindowPos(
            hwnd,
            Some(bottom_anchor()),
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
        ALLOW_MOVE.store(false, Ordering::SeqCst);
        // AC/battery changes arrive as WM_POWERBROADCAST anyway; battery saver needs this subscription.
        let _ = RegisterPowerSettingNotification(HANDLE(hwnd.0), &GUID_POWER_SAVING_STATUS, DEVICE_NOTIFY_WINDOW_HANDLE);
        let _ = SetConsoleCtrlHandler(Some(console_ctrl), true);
    }

    spawn_watchdog();

    // Fallback reveal in case the page-load event never fires.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(10));
        reveal();
    });

    // Event-driven z-order guard (see "Z-order guard and system events").
    std::thread::Builder::new().name("fe-zguard".into()).spawn(run_guard).ok();
    std::thread::Builder::new().name("fe-events".into()).spawn(run_events).ok();

    // Keep-alive, a safety net behind the events: owner link, z-order, Windows icons hidden, our
    // window shown, covering windows still there. Every 5 s; every second if the hooks failed.
    std::thread::Builder::new()
        .name("fe-keepalive".into())
        .spawn(|| loop {
            let secs = if HOOKS_OK.load(Ordering::SeqCst) { 5 } else { 1 };
            std::thread::sleep(Duration::from_secs(secs));
            own_by_progman();
            ensure_z();
            if HIDE_WANTED.load(Ordering::SeqCst) {
                set_windows_icons_visible(false);
            }
            let h = desktop_hwnd();
            if REVEALED.load(Ordering::SeqCst) && !windows_icons_mode() && !h.is_invalid() {
                unsafe {
                    if IsIconic(h).as_bool() || !IsWindowVisible(h).as_bool() {
                        let _ = ShowWindowAsync(h, SW_SHOWNOACTIVATE);
                    }
                }
            }
            quiet::revalidate();
        })
        .ok();
    Ok(())
}

/// Tray toggle: true = show the real Windows icons and hide our desktop window.
pub fn set_windows_icons_mode(enabled: bool) {
    WIN_ICONS_MODE.store(enabled, Ordering::SeqCst);
    let h = desktop_hwnd();
    if enabled {
        RAISED.store(false, Ordering::SeqCst);
        HIDE_WANTED.store(false, Ordering::SeqCst);
        unsafe {
            if !h.is_invalid() {
                let _ = ShowWindowAsync(h, SW_HIDE);
            }
        }
        set_windows_icons_visible(true);
    } else {
        if !h.is_invalid() && REVEALED.load(Ordering::SeqCst) {
            unsafe {
                let _ = ShowWindowAsync(h, SW_SHOWNOACTIVATE);
            }
            place_bottom(h);
            HIDE_WANTED.store(true, Ordering::SeqCst);
            set_windows_icons_visible(false);
        } else {
            REVEALED.store(false, Ordering::SeqCst);
            reveal();
        }
        kick(FIGHT_MS, 0);
    }
    // hidden desktop window: its webview sleeps too
    crate::windows_mgr::sync_desktop_webview();
}

pub fn scale_factor(app: &AppHandle) -> f64 {
    app.get_webview_window("desktop").and_then(|w| w.scale_factor().ok()).unwrap_or(1.0)
}

// ---------------------------------------------------------------------------
// Diagnostics for --selftest

unsafe extern "system" fn ztest_wndproc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    DefWindowProcW(h, m, w, l)
}

/// Creates a tiny throw-away window, puts it at HWND_BOTTOM and reports where it lands
/// relative to Progman / WorkerW in the z-order.
pub fn ztest() -> String {
    unsafe {
        let class = w!("FolderExplorerZTest");
        let hinst = windows::Win32::System::LibraryLoader::GetModuleHandleW(None).unwrap_or_default();
        let wc = WNDCLASSW {
            lpfnWndProc: Some(ztest_wndproc),
            hInstance: hinst.into(),
            lpszClassName: class,
            ..Default::default()
        };
        RegisterClassW(&wc);
        let Ok(h) = CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class,
            w!("ztest"),
            WS_POPUP | WS_VISIBLE,
            0,
            0,
            1,
            1,
            None,
            None,
            Some(hinst.into()),
            None,
        ) else {
            return "ztest: CreateWindowEx failed".into();
        };
        let _ = SetWindowPos(h, Some(HWND_BOTTOM), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        let shell = GetShellWindow();
        let mut idx = 0;
        let mut ours = -1i32;
        let mut shell_idx = -1i32;
        let mut workers = Vec::new();
        let mut cur = GetTopWindow(None).ok();
        while let Some(w) = cur {
            if w.is_invalid() {
                break;
            }
            if w == h {
                ours = idx;
            }
            if w == shell {
                shell_idx = idx;
            }
            if class_name(w) == "WorkerW" && IsWindowVisible(w).as_bool() {
                workers.push(idx);
            }
            idx += 1;
            cur = GetWindow(w, GW_HWNDNEXT).ok();
        }
        let _ = DestroyWindow(h);
        format!(
            "ztest: total={idx} ours={ours} shell(Progman)={shell_idx} visibleWorkerW={workers:?} => ours {} Progman",
            if ours >= 0 && shell_idx >= 0 && ours < shell_idx { "ABOVE" } else { "BELOW/unknown" }
        )
    }
}
