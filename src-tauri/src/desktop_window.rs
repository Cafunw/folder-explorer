//! The desktop-level window: creation, z-order rules, Win+D handling, hiding the
//! Windows icon view, the watchdog and capturing the original Windows icon layout.

use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use windows::core::{w, Interface, BOOL};
use windows::Win32::Foundation::{CloseHandle, COLORREF, HANDLE, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::Com::{CoCreateInstance, IServiceProvider, CLSCTX_ALL};
use windows::Win32::System::Console::SetConsoleCtrlHandler;
use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE};
use windows::Win32::System::Variant::{VARIANT, VT_I4};
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::Shell::Common::{ITEMIDLIST, STRRET};
use windows::Win32::UI::Shell::{
    DefSubclassProc, IFolderView, IShellBrowser, IShellFolder, IShellWindows, SetWindowSubclass,
    ShellWindows, StrRetToStrW, SHGDN_FORPARSING, SID_STopLevelBrowser, SVGIO_ALLVIEW,
    SWC_DESKTOP, SWFO_NEEDDISPATCH,
};
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_EXCLUDED_FROM_PEEK};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::Media::timeBeginPeriod;
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::env::{self, Point, Rect};
use crate::{dlog, shell, util, wallpaper};

const TIMER_ENV: usize = 0xFE01;
const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;
const WINEVENT_OUTOFCONTEXT: u32 = 0x0000;
const WINEVENT_SKIPOWNPROCESS: u32 = 0x0002;

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

pub fn class_of(hwnd: HWND) -> String {
    class_name(hwnd)
}

/// True while our window is shown over the desktop (not in "Windows icons" mode, not still starting).
pub fn is_active() -> bool {
    REVEALED.load(Ordering::SeqCst) && !windows_icons_mode() && !desktop_hwnd().is_invalid()
}

/// Our window's rectangle in screen pixels.
pub fn window_rect() -> Rect {
    *BOUNDS.lock().unwrap()
}

fn class_name(hwnd: HWND) -> String {
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

fn find_defview() -> Option<HWND> {
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

fn set_windows_icons_visible(visible: bool) {
    if let Some(lv) = find_listview() {
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
const DESKTOP_TITLE: windows::core::PCWSTR = w!("Folder Explorer Masaüstü");

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

fn spawn_watchdog() {
    let Ok(exe) = std::env::current_exe() else { return };
    let pid = std::process::id().to_string();
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let first = std::process::Command::new(&exe)
        .args(["--watchdog", &pid])
        .creation_flags(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB)
        .spawn();
    if first.is_err() {
        let _ = std::process::Command::new(&exe)
            .args(["--watchdog", &pid])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
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

/// Windows' shell desktop window (cached: the z-order guard asks for it a thousand times a second).
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
    if !REVEALED.load(Ordering::SeqCst) || windows_icons_mode() || is_raised() {
        return;
    }
    if misplaced() {
        place_bottom(desktop_hwnd());
    }
}

fn place_bottom(hwnd: HWND) {
    crate::diag::log("z   place_bottom");
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
];

unsafe extern "system" fn foreground_hook(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    if id_object != 0 || hwnd.is_invalid() {
        return;
    }
    let class = class_name(hwnd);
    crate::diag::log(&format!("fg  {class} z_misplaced={}", misplaced()));
    if class == "WorkerW" || class == "Progman" {
        // "Show desktop": the shell lifts Progman while it minimizes windows (sometimes more
        // than once), so follow it now and again shortly after.
        ensure_z();
        std::thread::spawn(|| {
            for ms in [120u64, 350, 800] {
                std::thread::sleep(Duration::from_millis(ms));
                ensure_z();
            }
        });
    } else if SHELL_UI_CLASSES.contains(&class.as_str()) || class.starts_with("XamlExplorerHostIslandWindow") {
        // Start menu, taskbar, Alt+Tab, Windows' own context menu… keep the current state.
    } else if is_raised() {
        // Windows hands the foreground around for a moment when a menu closes; give a fresh raise
        // time to settle before treating another window in front as "the user moved on".
        if now_ms().saturating_sub(RAISED_AT.load(Ordering::SeqCst)) > 1500 {
            set_raised(false, false);
        }
    }
}

// ---------------------------------------------------------------------------
// Subclass

fn enforce_style(s: u32) -> u32 {
    let remove = (WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_BORDER | WS_DLGFRAME).0;
    (s & !remove) | (WS_POPUP | WS_CLIPCHILDREN).0
}

/// Layered for good: the pass-through (`passthrough.rs`) then only flips `WS_EX_TRANSPARENT`, which
/// does not make Windows hide and re-show the window.
fn enforce_exstyle(s: u32) -> u32 {
    (s | WS_EX_TOOLWINDOW.0 | WS_EX_LAYERED.0) & !WS_EX_APPWINDOW.0
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
        WM_INITMENUPOPUP | WM_DRAWITEM | WM_MEASUREITEM | WM_MENUCHAR => {
            if let Some(r) = shell::forward_menu_msg(msg, wparam, lparam) {
                return r;
            }
        }
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
        _ => {
            let tc = TASKBAR_CREATED.load(Ordering::SeqCst);
            if tc != 0 && msg == tc {
                // Explorer restarted: new Progman / icon view.
                let hv = hwnd.0 as isize;
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1500));
                    own_by_progman();
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
        SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(foreground_hook),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        let _ = SetConsoleCtrlHandler(Some(console_ctrl), true);
    }

    spawn_watchdog();
    crate::passthrough::start();

    // Fallback reveal in case the page-load event never fires.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(10));
        reveal();
    });

    // Guard: "Show desktop", Win+D, Explorer and other apps shuffle the z-order or hide us; put the
    // window back within a frame or two (a 1 s keep-alive made the icons visibly blink).
    //
    // It runs every millisecond: clicking the empty desktop activates Progman, Windows lifts it above
    // our window for a moment, and until we are back on top every icon is covered — at 40 ms that was
    // a visible blink on each click. Progman is cached and the check is a couple of GetWindow calls.
    std::thread::Builder::new()
        .name("fe-zguard".into())
        .spawn(|| {
            unsafe { timeBeginPeriod(1) };
            let mut n = 0u32;
            let mut bad_since: Option<std::time::Instant> = None;
            loop {
                std::thread::sleep(Duration::from_millis(1));
                let h = desktop_hwnd();
                if !(REVEALED.load(Ordering::SeqCst) && !windows_icons_mode() && !h.is_invalid()) {
                    continue;
                }
                n = n.wrapping_add(1);
                if n % 40 == 0 {
                    unsafe {
                        if IsIconic(h).as_bool() || !IsWindowVisible(h).as_bool() {
                            let _ = ShowWindowAsync(h, SW_SHOWNOACTIVATE);
                        }
                    }
                }
                if !is_raised() && misplaced() {
                    bad_since.get_or_insert_with(std::time::Instant::now);
                    place_bottom(h);
                } else if let Some(t) = bad_since.take() {
                    crate::diag::log(&format!("z   covered for {:.1} ms", t.elapsed().as_secs_f64() * 1000.0));
                }
            }
        })
        .ok();

    // Keep-alive: re-hide the Windows icons, keep our window shown.
    std::thread::Builder::new()
        .name("fe-keepalive".into())
        .spawn(|| loop {
            std::thread::sleep(Duration::from_secs(1));
            own_by_progman();
            ensure_z();
            if HIDE_WANTED.load(Ordering::SeqCst) {
                set_windows_icons_visible(false);
            }
            let h = desktop_hwnd();
            if REVEALED.load(Ordering::SeqCst) && !windows_icons_mode() && !h.is_invalid() {
                unsafe {
                    if IsIconic(h).as_bool() {
                        let _ = ShowWindowAsync(h, SW_SHOWNOACTIVATE);
                    } else if !IsWindowVisible(h).as_bool() {
                        let _ = ShowWindowAsync(h, SW_SHOWNOACTIVATE);
                    }
                }
            }
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
    }
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
