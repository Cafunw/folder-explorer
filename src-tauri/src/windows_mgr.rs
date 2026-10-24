//! Search & settings windows, tray icon and the global search hotkey.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::utils::config::WindowEffectsConfig;
use tauri::window::{Effect, EffectsBuilder};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2_19, ICoreWebView2_3, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
};

use crate::{desktop_window, dlog, quiet, store, util};

pub const DEFAULT_HOTKEY: &str = "Ctrl+Space";

static PENDING_SEARCH: Mutex<Option<String>> = Mutex::new(None);
static CURRENT_HOTKEY: Mutex<Option<String>> = Mutex::new(None);

pub struct TrayState {
    pub lock: CheckMenuItem<Wry>,
    pub win_icons: CheckMenuItem<Wry>,
}

#[derive(Serialize, Clone)]
struct SearchOpen {
    initial: String,
}

#[derive(Serialize, Clone)]
struct TrayAction {
    action: &'static str,
}

fn effects(effect: Effect) -> WindowEffectsConfig {
    EffectsBuilder::new().effect(effect).build()
}

// ---------------------------------------------------------------- hidden webviews
//
// WebView2 does not notice when its window is hidden: a hidden menu or search window kept rendering
// state and all of its memory. Hidden, a webview is told so (IsVisible = false, which also stops its
// frames and timers) and gives memory back; it is told again before it is shown.
// * menus: memory target low only, no suspend — the right-click menu must open at once, and a frozen
//   renderer would first have to be thawed;
// * search: suspended (TrySuspend) a few seconds after it was hidden;
// * desktop: suspended while every monitor is covered by a fullscreen app or the Windows icons are on.

#[derive(Clone, Copy)]
enum Rest {
    /// IsVisible false + memory target low
    Light,
    /// IsVisible false + TrySuspend (script and timers stop too)
    Suspend,
}

static MENU_ACTIVE: AtomicBool = AtomicBool::new(true);
static SUB_ACTIVE: AtomicBool = AtomicBool::new(true);
static SEARCH_ACTIVE: AtomicBool = AtomicBool::new(true);
static DESKTOP_ACTIVE: AtomicBool = AtomicBool::new(true);
static SEARCH_REST_GEN: AtomicU64 = AtomicU64::new(0);
const SEARCH_SUSPEND_AFTER: std::time::Duration = std::time::Duration::from_secs(5);
/// A hidden search window waiting to be shown (its open number; 0 = none): the page asks for it
/// once the new query is painted (`reveal_search`), so a resumed webview never shows a blank /
/// stale acrylic frame first. Shown anyway after `SEARCH_REVEAL_FALLBACK`.
static SEARCH_REVEAL: AtomicU64 = AtomicU64::new(0);
static SEARCH_OPENS: AtomicU64 = AtomicU64::new(0);
const SEARCH_REVEAL_FALLBACK: std::time::Duration = std::time::Duration::from_millis(400);

fn active_flag(label: &str) -> &'static AtomicBool {
    match label {
        MENU => &MENU_ACTIVE,
        MENU_SUB => &SUB_ACTIVE,
        "search" => &SEARCH_ACTIVE,
        _ => &DESKTOP_ACTIVE,
    }
}

/// Tells webview `label` it is about to be shown (`active`) or was hidden. Runs on the main thread,
/// queued in order with tao's own show / hide and with events sent to the page.
fn set_webview_active(app: &AppHandle, label: &str, active: bool, rest: Rest) {
    if active_flag(label).swap(active, Ordering::SeqCst) == active {
        return;
    }
    let Some(win) = app.get_webview_window(label) else { return };
    let label = label.to_string();
    let _ = win.with_webview(move |wv| {
        // changed again before this ran: the later request wins
        if active_flag(&label).load(Ordering::SeqCst) != active {
            return;
        }
        unsafe { apply_active(&wv.controller(), active, rest) };
    });
}

unsafe fn apply_active(c: &ICoreWebView2Controller, active: bool, rest: Rest) {
    use windows::core::{Interface, BOOL};
    let wv = c.CoreWebView2().ok();
    let v3 = wv.as_ref().and_then(|w| w.cast::<ICoreWebView2_3>().ok());
    let v19 = wv.as_ref().and_then(|w| w.cast::<ICoreWebView2_19>().ok());
    if active {
        if let Some(v3) = &v3 {
            let mut suspended = BOOL(0);
            if v3.IsSuspended(&mut suspended).is_ok() && suspended.as_bool() {
                let _ = v3.Resume();
            }
        }
        let _ = c.SetIsVisible(true);
        if let Some(v19) = &v19 {
            let _ = v19.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL);
        }
    } else {
        let _ = c.SetIsVisible(false);
        match rest {
            Rest::Light => {
                if let Some(v19) = &v19 {
                    let _ = v19.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW);
                }
            }
            Rest::Suspend => {
                if let Some(v3) = &v3 {
                    let done = webview2_com::TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(())));
                    let _ = v3.TrySuspend(&done);
                }
            }
        }
    }
}

/// The desktop webview runs unless the Windows icons are shown instead or fullscreen apps cover
/// every monitor.
pub fn sync_desktop_webview() {
    let Some(app) = util::app() else { return };
    let run = !desktop_window::windows_icons_mode() && !quiet::desktop_asleep();
    set_webview_active(app, "desktop", run, Rest::Suspend);
}

fn rest_search(app: &AppHandle) {
    set_webview_active(app, "search", false, Rest::Light);
    // Frozen only after a moment: an invoke still on its way back must reach the page first, or its
    // continuation (which may hide the window) would run when the search is shown the next time.
    let gen = SEARCH_REST_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SEARCH_SUSPEND_AFTER);
        if SEARCH_REST_GEN.load(Ordering::SeqCst) != gen || SEARCH_ACTIVE.load(Ordering::SeqCst) {
            return;
        }
        if let Some(win) = app.get_webview_window("search") {
            let _ = win.with_webview(move |wv| {
                if SEARCH_REST_GEN.load(Ordering::SeqCst) == gen && !SEARCH_ACTIVE.load(Ordering::SeqCst) {
                    unsafe { apply_active(&wv.controller(), false, Rest::Suspend) };
                }
            });
        }
    });
}

fn round_corners(hwnd: isize) {
    unsafe {
        let pref = DWMWCP_ROUND;
        let _ = DwmSetWindowAttribute(
            util::hwnd_from(hwnd),
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const _ as *const _,
            std::mem::size_of_val(&pref) as u32,
        );
    }
}

/// Physical rect of the work area of the monitor under the cursor + its scale.
fn cursor_monitor() -> (i32, i32, i32, i32, f64) {
    unsafe {
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let _ = GetMonitorInfoW(hmon, &mut mi);
        let (mut dx, mut dy) = (96u32, 96u32);
        let _ = GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
        let r = mi.rcWork;
        (r.left, r.top, r.right - r.left, r.bottom - r.top, dx as f64 / 96.0)
    }
}

pub fn show_search(app: &AppHandle, initial: String) -> Result<(), String> {
    *PENDING_SEARCH.lock().unwrap() = Some(initial.clone());
    let win = match app.get_webview_window("search") {
        Some(w) => w,
        None => {
            let w = WebviewWindowBuilder::new(app, "search", WebviewUrl::App("index.html?view=search".into()))
                .title("Folder Explorer Arama")
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .shadow(true)
                .visible(false)
                .inner_size(680.0, 480.0)
                .effects(effects(Effect::Acrylic))
                .initialization_script("window.__FE_VIEW__ = 'search';")
                .on_page_load(|w, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        let initial = PENDING_SEARCH.lock().unwrap().clone().unwrap_or_default();
                        let _ = w.emit_to("search", "search-open", SearchOpen { initial });
                    }
                })
                .build()
                .map_err(|e| e.to_string())?;
            if let Ok(h) = w.hwnd() {
                round_corners(h.0 as isize);
            }
            w
        }
    };
    let (x, y, width, height, scale) = cursor_monitor();
    let w = (680.0 * scale).round() as i32;
    let h = (480.0 * scale).round() as i32;
    let _ = win.set_size(PhysicalSize::new(w as u32, h as u32));
    let _ = win.set_position(PhysicalPosition::new(x + (width - w) / 2, y + (height as f64 * 0.16) as i32));
    SEARCH_REST_GEN.fetch_add(1, Ordering::SeqCst);
    set_webview_active(app, "search", true, Rest::Light);
    if win.is_visible().unwrap_or(false) {
        let _ = win.set_focus();
    } else {
        let open = SEARCH_OPENS.fetch_add(1, Ordering::SeqCst) + 1;
        SEARCH_REVEAL.store(open, Ordering::SeqCst);
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(SEARCH_REVEAL_FALLBACK);
            if SEARCH_REVEAL.compare_exchange(open, 0, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                show_search_now(&app);
            }
        });
    }
    let _ = app.emit_to("search", "search-open", SearchOpen { initial });
    Ok(())
}

/// The search page painted what `show_search` asked for: show the window now.
pub fn reveal_search(app: &AppHandle) {
    if SEARCH_REVEAL.swap(0, Ordering::SeqCst) != 0 {
        show_search_now(app);
    }
}

fn show_search_now(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("search") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

// ---------------------------------------------------------------- right-click menus
//
// Two small always-on-top windows draw our Windows 11 style menus (src/menu): "menu" is the menu
// itself, "menusub" a submenu next to it. Both have the acrylic backdrop and rounded corners of
// Windows' own menus. The submenu never takes the focus, so the keyboard stays with the menu.

pub const MENU: &str = "menu";
pub const MENU_SUB: &str = "menusub";

static PENDING_MENU: Mutex<Option<serde_json::Value>> = Mutex::new(None);
/// Bumped whenever the submenu is shown or hidden: a running fade-in stops.
static SUB_FADE: AtomicU32 = AtomicU32::new(0);
const SUB_FADE_MS: f64 = 150.0;

fn menu_window(app: &AppHandle, label: &str) -> Result<tauri::WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(label) {
        return Ok(w);
    }
    let w = WebviewWindowBuilder::new(app, label, WebviewUrl::App(format!("index.html?view={label}").into()))
        .title("Folder Explorer Menü")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .shadow(true)
        .visible(false)
        .focused(false)
        .focusable(label == MENU)
        .inner_size(240.0, 160.0)
        .effects(effects(Effect::Acrylic))
        .theme(menu_theme(&store::settings()))
        .initialization_script(&format!("window.__FE_VIEW__ = '{label}';"))
        .build()
        .map_err(|e| e.to_string())?;
    if let Ok(h) = w.hwnd() {
        round_corners(h.0 as isize);
    }
    Ok(w)
}

/// The acrylic backdrop follows the window's light/dark theme: the app's theme setting.
fn menu_theme(settings: &serde_json::Value) -> Option<tauri::Theme> {
    match settings.pointer("/theme").and_then(|v| v.as_str()) {
        Some("dark") => Some(tauri::Theme::Dark),
        Some("light") => Some(tauri::Theme::Light),
        _ => None,
    }
}

pub fn prepare_menu(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(2));
        for label in [MENU, MENU_SUB] {
            if app.get_webview_window(label).is_some() {
                continue; // a right-click came first and created it
            }
            match menu_window(&app, label) {
                Ok(_) => set_webview_active(&app, label, false, Rest::Light),
                Err(e) => dlog!("menu window: {e}"),
            }
        }
    });
}

/// Work area (physical px) and scale of the monitor containing `pt`.
fn monitor_at(pt: POINT) -> (i32, i32, i32, i32, f64) {
    unsafe {
        let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let _ = GetMonitorInfoW(hmon, &mut mi);
        let (mut dx, mut dy) = (96u32, 96u32);
        let _ = GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
        let r = mi.rcWork;
        (r.left, r.top, r.right - r.left, r.bottom - r.top, dx as f64 / 96.0)
    }
}

/// Windows' accent palette: the colour its menus use for icon details, in dark and light mode.
fn accent_colors() -> (String, String) {
    use windows::core::w;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_BINARY};
    let mut buf = [0u8; 32];
    let mut size = buf.len() as u32;
    let ok = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Accent"),
            w!("AccentPalette"),
            RRF_RT_REG_BINARY,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut size),
        ) == ERROR_SUCCESS
    };
    if !ok || size < 32 {
        return ("#4cc2ff".into(), "#005fb8".into());
    }
    let hex = |i: usize| format!("#{:02x}{:02x}{:02x}", buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2]);
    // entries: light 3, 2, 1, base, dark 1, 2, 3
    (hex(1), hex(4))
}

/// Opens our menu for `request` (built by the desktop). It gets where the user right-clicked, the
/// work area and scale of that monitor and a few facts about the system; the menu window then
/// renders, measures itself and calls `place_menu`.
pub fn open_menu(app: &AppHandle, mut request: serde_json::Value, at: Option<POINT>) -> Result<(), String> {
    let pt = at.unwrap_or_else(|| {
        let mut p = POINT::default();
        unsafe {
            let _ = GetCursorPos(&mut p);
        }
        p
    });
    let (wx, wy, ww, wh, scale) = monitor_at(pt);
    let (dark, light) = accent_colors();
    request["at"] = serde_json::json!([pt.x, pt.y]);
    request["work"] = serde_json::json!([wx, wy, ww, wh]);
    request["scale"] = scale.into();
    request["accent"] = serde_json::json!({ "dark": dark, "light": light });
    request["canPaste"] = crate::shell::can_paste().into();
    request["hasTerminal"] = crate::shell::has_terminal().into();
    request["terminalIcon"] = serde_json::json!(crate::shell::terminal_app());
    *PENDING_MENU.lock().unwrap() = Some(request.clone());
    hide_menu(app, Some(MENU_SUB));
    menu_window(app, MENU)?;
    menu_window(app, MENU_SUB)?;
    // awake before the page hears about the menu (queued in order on the main thread); the
    // submenu too, it opens while the menu is up
    set_webview_active(app, MENU, true, Rest::Light);
    set_webview_active(app, MENU_SUB, true, Rest::Light);
    app.emit_to(MENU, "menu-open", request).map_err(|e| e.to_string())
}

fn hwnd_of(win: &tauri::WebviewWindow) -> Result<windows::Win32::Foundation::HWND, String> {
    Ok(util::hwnd_from(win.hwnd().map_err(|e| e.to_string())?.0 as isize))
}

/// Shows menu window `label` at x, y with size w × h (physical px). The menu takes the focus, a
/// submenu does not; with `fade` a submenu fades in, as Windows' own do.
pub fn place_menu(app: &AppHandle, label: &str, x: i32, y: i32, w: u32, h: u32, fade: bool) -> Result<(), String> {
    use windows::Win32::Foundation::{LPARAM, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClientRect, GetWindowRect, IsWindowVisible, SendMessageW, SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE,
        SWP_NOOWNERZORDER, SW_HIDE, SW_SHOWNOACTIVATE, WM_NCACTIVATE,
    };

    let win = app.get_webview_window(label).ok_or("menü penceresi yok")?;
    let hwnd = hwnd_of(&win)?;
    let sub = label == MENU_SUB;
    // normally already awake since open_menu; a late hide of the previous menu may have come between
    set_webview_active(app, label, true, Rest::Light);
    let (w, h) = (w.max(1) as i32, h.max(1) as i32);
    // tao sizes an undecorated window as if it had a caption, so its client area (the webview)
    // comes out taller and shifted: place the window so that exactly the client area is (x, y, w, h).
    // Moved first, so the frame is measured at the target monitor's DPI.
    let flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER;
    unsafe {
        // another submenu still open: it goes before this one moves in
        if sub && fade && IsWindowVisible(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, w, h, flags);
        let (mut wr, mut cr) = (RECT::default(), RECT::default());
        let mut origin = POINT::default();
        if GetWindowRect(hwnd, &mut wr).is_ok() && GetClientRect(hwnd, &mut cr).is_ok() && ClientToScreen(hwnd, &mut origin).as_bool() {
            let (dl, dt) = (origin.x - wr.left, origin.y - wr.top);
            let (dw, dh) = ((wr.right - wr.left) - cr.right, (wr.bottom - wr.top) - cr.bottom);
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x - dl, y - dt, w + dw, h + dh, flags);
        }
        // The submenu is shown here, without activation: tao's show() would activate it (its "not
        // focused" flag only applies at creation) and the menu would lose the focus and close.
        if sub {
            // Never activated, it would get Windows' grey "inactive" backdrop instead of acrylic:
            // let it look active (only the frame state; the focus stays in the menu).
            let _ = SendMessageW(hwnd, WM_NCACTIVATE, Some(WPARAM(1)), Some(LPARAM(0)));
            if fade {
                fade_in(hwnd);
            } else {
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
        }
    }
    if !sub {
        win.show().map_err(|e| e.to_string())?;
        let _ = win.set_focus();
    }
    Ok(())
}

/// Windows plays no opening animation for a window shown without activation: fade the whole
/// window in (acrylic included) through its layered-window opacity.
fn fade_in(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::Foundation::COLORREF;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, ShowWindow, GWL_EXSTYLE, LWA_ALPHA, SW_SHOWNOACTIVATE,
        WS_EX_LAYERED,
    };
    let gen = SUB_FADE.fetch_add(1, Ordering::SeqCst) + 1;
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if ex & WS_EX_LAYERED.0 as isize == 0 {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED.0 as isize);
        }
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 0, LWA_ALPHA);
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    let h = hwnd.0 as isize;
    std::thread::spawn(move || {
        let hwnd = util::hwnd_from(h);
        let start = std::time::Instant::now();
        loop {
            if SUB_FADE.load(Ordering::SeqCst) != gen {
                return;
            }
            let t = (start.elapsed().as_secs_f64() * 1000.0 / SUB_FADE_MS).min(1.0);
            let a = 1.0 - (1.0 - t).powi(3);
            unsafe {
                let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), (a * 255.0).round() as u8, LWA_ALPHA);
            }
            if t >= 1.0 {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(7));
        }
    });
}

/// The submenu window got the focus anyway (a click into its webview): the menu keeps it.
pub fn menu_sub_focused(app: &AppHandle) {
    if let Some(menu) = app.get_webview_window(MENU) {
        if menu.is_visible().unwrap_or(false) {
            let _ = menu.set_focus();
        }
    }
}

pub fn take_menu_request() -> serde_json::Value {
    PENDING_MENU.lock().unwrap().take().unwrap_or(serde_json::Value::Null)
}

pub fn hide_menu(app: &AppHandle, label: Option<&str>) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    for l in [MENU_SUB, MENU] {
        if label.is_none_or(|x| x == l) {
            if let Some(w) = app.get_webview_window(l) {
                if l == MENU_SUB {
                    SUB_FADE.fetch_add(1, Ordering::SeqCst);
                    // shown without tao (place_menu), so hidden without it too
                    if let Ok(h) = hwnd_of(&w) {
                        unsafe {
                            let _ = ShowWindow(h, SW_HIDE);
                        }
                    }
                } else {
                    let _ = w.hide();
                }
            }
        }
    }
    // The menu closed: both rest until the next right-click (a submenu alone closing keeps its
    // webview awake, another one may open any moment).
    if label.is_none_or(|x| x == MENU) {
        set_webview_active(app, MENU, false, Rest::Light);
        set_webview_active(app, MENU_SUB, false, Rest::Light);
    }
}

pub fn take_search_initial() -> String {
    PENDING_SEARCH.lock().unwrap().take().unwrap_or_default()
}

pub fn hide_search(app: &AppHandle) {
    SEARCH_REVEAL.store(0, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("search") {
        let _ = w.hide();
        rest_search(app);
    }
}

pub fn open_settings(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let w = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html?view=settings".into()))
        .title("Folder Explorer — Ayarlar")
        .inner_size(1000.0, 700.0)
        .min_inner_size(820.0, 560.0)
        .center()
        .transparent(true)
        .effects(effects(Effect::Mica))
        .initialization_script("window.__FE_VIEW__ = 'settings';")
        .visible(true)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = w.set_focus();
    Ok(())
}

pub fn quit(app: &AppHandle) {
    desktop_window::mark_quitting(true);
    desktop_window::restore_icons();
    app.exit(0);
}

pub fn setup_tray(app: &AppHandle) -> Result<(), String> {
    let settings_item = MenuItem::with_id(app, "settings", "Ayarlar", true, None::<&str>).map_err(|e| e.to_string())?;
    let locked = store::settings()
        .pointer("/behavior/lockLayout")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let lock = CheckMenuItem::with_id(app, "lock", "Düzeni kilitle", true, locked, None::<&str>).map_err(|e| e.to_string())?;
    let win_icons = CheckMenuItem::with_id(app, "winicons", "Windows simgelerine dön", true, false, None::<&str>)
        .map_err(|e| e.to_string())?;
    let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let quit_item = MenuItem::with_id(app, "quit", "Çıkış", true, None::<&str>).map_err(|e| e.to_string())?;
    let add_app = MenuItem::with_id(app, "addapp", "Uygulama ekle…", true, None::<&str>).map_err(|e| e.to_string())?;
    let new_group = MenuItem::with_id(app, "newgroup", "Yeni grup", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&new_group, &add_app, &settings_item, &lock, &win_icons, &sep, &quit_item])
        .map_err(|e| e.to_string())?;

    app.manage(TrayState { lock: lock.clone(), win_icons: win_icons.clone() });

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Folder Explorer")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "settings" => {
                let _ = open_settings(app);
            }
            "newgroup" => {
                desktop_window::set_raised(true, true);
                let _ = app.emit_to("desktop", "tray-action", TrayAction { action: "new-group" });
            }
            "addapp" => {
                // shown in the desktop window, which comes to the front for it
                desktop_window::set_raised(true, true);
                let _ = app.emit_to("desktop", "tray-action", TrayAction { action: "add-app" });
            }
            "lock" => {
                // The UI owns the setting; it toggles it and calls save_settings, which re-syncs the check.
                let _ = app.emit_to("desktop", "tray-action", TrayAction { action: "toggle-lock" });
            }
            "winicons" => {
                let enabled = !desktop_window::windows_icons_mode();
                desktop_window::set_windows_icons_mode(enabled);
                if let Some(st) = app.try_state::<TrayState>() {
                    let _ = st.win_icons.set_checked(enabled);
                }
            }
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let _ = open_settings(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app).map_err(|e| e.to_string())?;
    Ok(())
}

/// Applies settings that live on the Rust side (hotkey, tray check state).
pub fn apply_settings(app: &AppHandle, settings: &serde_json::Value) {
    let hotkey = settings
        .pointer("/behavior/searchHotkey")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_HOTKEY)
        .to_string();
    register_hotkey(app, &hotkey);
    // "Windows ile başlat" = a shortcut in the Startup folder (opt-in; never for dev builds)
    if !cfg!(debug_assertions) {
        let autostart = settings.pointer("/behavior/startWithWindows").and_then(|v| v.as_bool()).unwrap_or(false);
        std::thread::spawn(move || {
            let _ = crate::startup::set(autostart);
        });
    }
    if let Some(st) = app.try_state::<TrayState>() {
        let locked = settings.pointer("/behavior/lockLayout").and_then(|v| v.as_bool()).unwrap_or(false);
        let _ = st.lock.set_checked(locked);
    }
    for label in [MENU, MENU_SUB] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.set_theme(menu_theme(settings));
        }
    }
    quiet::apply_settings(settings);
}

pub fn register_hotkey(app: &AppHandle, accel: &str) {
    let mut cur = CURRENT_HOTKEY.lock().unwrap();
    if cur.as_deref() == Some(accel) {
        return;
    }
    let gs = app.global_shortcut();
    if let Some(old) = cur.take() {
        let _ = gs.unregister(old.as_str());
    }
    match gs.register(accel) {
        Ok(_) => {
            dlog!("hotkey registered: {accel}");
            *cur = Some(accel.to_string());
        }
        Err(e) => dlog!("hotkey {accel} failed: {e}"),
    }
}
