//! Search & settings windows, tray icon and the global search hotkey.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
/// Started by `--new-group` (Windows' Yeni ▸ menu while the app was not running).
static LAUNCH_NEW_GROUP: AtomicBool = AtomicBool::new(false);

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
// WebView2 does not notice when its window is hidden: a hidden search window kept rendering
// state and all of its memory. Hidden, a webview is told so (IsVisible = false, which also stops its
// frames and timers) and gives memory back; it is told again before it is shown.
// * search: suspended (TrySuspend) a few seconds after it was hidden;
// * desktop: suspended while every monitor is covered by a fullscreen app or the Windows icons are on.

#[derive(Clone, Copy)]
enum Rest {
    /// IsVisible false + memory target low
    Light,
    /// IsVisible false + TrySuspend (script and timers stop too)
    Suspend,
}

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

pub fn take_search_initial() -> String {
    PENDING_SEARCH.lock().unwrap().take().unwrap_or_default()
}

/// Tray "Yeni grup" and Windows' Yeni ▸ Folder Explorer grubu: the desktop comes to the front
/// with a new, empty group whose name is being edited.
pub fn new_group(app: &AppHandle) {
    desktop_window::set_raised(true, true);
    let _ = app.emit_to("desktop", "tray-action", TrayAction { action: "new-group" });
}

pub fn set_launch_new_group() {
    LAUNCH_NEW_GROUP.store(true, Ordering::SeqCst);
}

/// The desktop asks once it is ready; true = make the group now (the desktop is raised already).
pub fn take_launch_new_group() -> bool {
    let pending = LAUNCH_NEW_GROUP.swap(false, Ordering::SeqCst);
    if pending {
        desktop_window::set_raised(true, true);
    }
    pending
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
    let new_group_item = MenuItem::with_id(app, "newgroup", "Yeni grup", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&new_group_item, &add_app, &settings_item, &lock, &win_icons, &sep, &quit_item])
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
            "newgroup" => new_group(app),
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
    quiet::apply_settings(settings);
    // a dev build would point Windows' menu at target\debug, which needs the dev server
    if !cfg!(debug_assertions) {
        let entry = settings.pointer("/behavior/newMenuEntry").and_then(|v| v.as_bool()).unwrap_or(true);
        std::thread::spawn(move || crate::shell_new::sync(entry));
    }
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
