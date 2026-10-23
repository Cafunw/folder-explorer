//! Search & settings windows, tray icon and the global search hotkey.

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

use crate::{desktop_window, dlog, store, util};

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
    win.show().map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    let _ = app.emit_to("search", "search-open", SearchOpen { initial });
    Ok(())
}

// ---------------------------------------------------------------- item popup menu

static PENDING_MENU: Mutex<Option<serde_json::Value>> = Mutex::new(None);

fn menu_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(w) = app.get_webview_window("menu") {
        return Ok(w);
    }
    let w = WebviewWindowBuilder::new(app, "menu", WebviewUrl::App("index.html?view=menu".into()))
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
        .inner_size(272.0, 200.0)
        .effects(effects(Effect::Acrylic))
        .initialization_script("window.__FE_VIEW__ = 'menu';")
        .build()
        .map_err(|e| e.to_string())?;
    if let Ok(h) = w.hwnd() {
        round_corners(h.0 as isize);
    }
    Ok(w)
}

/// Creates the (hidden) popup window ahead of time, so the first right-click is just as fast.
pub fn prepare_menu(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(2));
        if let Err(e) = menu_window(&app) {
            dlog!("menu window: {e}");
        }
    });
}

/// Shows the popup at the cursor, flipped to stay inside the screen like a Windows menu.
pub fn show_item_menu(app: &AppHandle, mut request: serde_json::Value, width: f64, height: f64) -> Result<(), String> {
    let (wx, wy, ww, wh, scale) = cursor_monitor();
    let mut pt = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut pt);
    }
    let (pw, ph) = ((width * scale).round() as i32, (height * scale).round() as i32);
    let px = if pt.x + pw > wx + ww { (pt.x - pw).max(wx) } else { pt.x };
    let py = if pt.y + ph > wy + wh { (pt.y - ph).max(wy) } else { pt.y };
    request["x"] = pt.x.into();
    request["y"] = pt.y.into();
    *PENDING_MENU.lock().unwrap() = Some(request.clone());
    let win = menu_window(app)?;
    let _ = app.emit_to("menu", "menu-open", request);
    let _ = win.set_size(PhysicalSize::new(pw as u32, ph as u32));
    let _ = win.set_position(PhysicalPosition::new(px, py));
    win.show().map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    Ok(())
}

pub fn take_menu_request() -> serde_json::Value {
    PENDING_MENU.lock().unwrap().take().unwrap_or(serde_json::Value::Null)
}

pub fn hide_menu(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("menu") {
        let _ = w.hide();
    }
}

pub fn take_search_initial() -> String {
    PENDING_SEARCH.lock().unwrap().take().unwrap_or_default()
}

pub fn hide_search(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("search") {
        let _ = w.hide();
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
