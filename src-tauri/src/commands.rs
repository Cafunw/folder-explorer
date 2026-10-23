//! Tauri command wrappers. All commands are async so that blocking work never runs
//! on the UI thread (sync commands run on the main thread in Tauri 2).

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::env::{self, Environment};
use crate::items::{self, DesktopItem};
use crate::shell::{self, StartApp};
use crate::store::{self, BackupInfo, PersistedState};
use crate::wallpaper::{self, WallpaperInfo};
use crate::{desktop_window, util, windows_mgr};

type R<T> = Result<T, String>;

async fn blocking<T, F>(f: F) -> R<T>
where
    T: Send + 'static,
    F: FnOnce() -> R<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_environment(app: AppHandle) -> R<Environment> {
    let scale = desktop_window::scale_factor(&app);
    blocking(move || Ok(env::environment(desktop_window::window_origin(), scale))).await
}

#[tauri::command]
pub async fn list_desktop_items() -> R<Vec<DesktopItem>> {
    blocking(items::list_desktop_items).await
}

#[tauri::command]
pub async fn get_windows_layout() -> R<desktop_window::WindowsLayout> {
    Ok(desktop_window::get_windows_layout())
}

#[tauri::command]
pub async fn open_item(path: String) -> R<()> {
    blocking(move || shell::open_item(path)).await
}

#[tauri::command]
pub async fn show_shell_menu(paths: Vec<String>, at: Option<[i32; 2]>) -> R<Option<String>> {
    let at = at.filter(|a| a[0] != 0 || a[1] != 0).map(|a| windows::Win32::Foundation::POINT { x: a[0], y: a[1] });
    blocking(move || util::on_main(move || shell::shell_menu_main(paths, at))?).await
}

/// The Windows 11 style popup for one of our icons (own window, opens instantly).
#[tauri::command]
pub async fn show_item_menu(app: AppHandle, request: Value, width: f64, height: f64) -> R<()> {
    blocking(move || windows_mgr::show_item_menu(&app, request, width, height)).await
}

#[tauri::command]
pub async fn take_menu_request() -> R<Value> {
    Ok(windows_mgr::take_menu_request())
}

#[tauri::command]
pub async fn hide_menu(app: AppHandle) -> R<()> {
    windows_mgr::hide_menu(&app);
    Ok(())
}

#[tauri::command]
pub async fn clipboard_files(paths: Vec<String>, cut: bool) -> R<()> {
    blocking(move || shell::clipboard_files(paths, cut)).await
}

#[tauri::command]
pub async fn copy_text(text: String) -> R<()> {
    blocking(move || shell::copy_text(text)).await
}

#[tauri::command]
pub async fn show_properties(path: String) -> R<()> {
    blocking(move || shell::show_properties(path)).await
}

#[tauri::command]
pub async fn run_as_admin(path: String) -> R<()> {
    blocking(move || shell::run_as_admin(path)).await
}

/// TEMPORARY: the UI writes diagnostics lines (see diag.rs).
#[tauri::command]
pub async fn debug_log(line: String) -> R<()> {
    crate::diag::log(&format!("ui  {line}"));
    Ok(())
}

/// The UI reports where its own objects are; everywhere else the mouse passes through to Windows.
#[tauri::command]
pub async fn set_input_regions(all: bool, rects: Vec<[f64; 4]>) -> R<()> {
    crate::passthrough::set_regions(all, rects);
    Ok(())
}

#[tauri::command]
pub async fn recycle(paths: Vec<String>) -> R<()> {
    blocking(move || shell::recycle(paths)).await
}

#[tauri::command]
pub async fn restore_from_recycle(paths: Vec<String>) -> R<Vec<String>> {
    blocking(move || shell::restore_from_recycle(paths)).await
}

#[tauri::command]
pub async fn rename_item(path: String, new_name: String) -> R<String> {
    blocking(move || shell::rename_item(path, new_name)).await
}

#[tauri::command]
pub async fn move_into_folder(paths: Vec<String>, target_dir: String) -> R<()> {
    blocking(move || shell::move_into_folder(paths, target_dir)).await
}

#[tauri::command]
pub async fn import_dropped(paths: Vec<String>, copy: Option<bool>) -> R<Vec<String>> {
    blocking(move || shell::import_dropped(paths, copy.unwrap_or(false))).await
}

#[tauri::command]
pub async fn start_drag_out(paths: Vec<String>) -> R<String> {
    blocking(move || util::on_main(move || shell::drag_out_main(paths))?).await
}

#[tauri::command]
pub async fn cursor_over_foreign_window() -> R<bool> {
    Ok(shell::cursor_over_foreign_window())
}

#[tauri::command]
pub async fn list_start_apps() -> R<Vec<StartApp>> {
    blocking(shell::list_start_apps).await
}

#[tauri::command]
pub async fn create_shortcut(parsing_name: String, name: String) -> R<String> {
    blocking(move || shell::create_shortcut(parsing_name, name)).await
}

#[tauri::command]
pub async fn create_url_shortcut(url: String, name: String) -> R<String> {
    blocking(move || shell::create_url_shortcut(url, name)).await
}

#[tauri::command]
pub async fn get_wallpapers() -> R<Vec<WallpaperInfo>> {
    blocking(wallpaper::get_wallpapers).await
}

#[tauri::command]
pub async fn load_state() -> R<PersistedState> {
    Ok(store::load_state())
}

#[tauri::command]
pub async fn save_layout(layout: Value) -> R<()> {
    blocking(move || store::save_layout(layout)).await
}

#[derive(serde::Serialize, Clone)]
struct SettingsChanged {
    settings: Value,
}

fn broadcast_settings(app: &AppHandle, settings: &Value) {
    windows_mgr::apply_settings(app, settings);
    let _ = app.emit("settings-changed", SettingsChanged { settings: settings.clone() });
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, settings: Value) -> R<()> {
    let s2 = settings.clone();
    blocking(move || store::save_settings(s2)).await?;
    broadcast_settings(&app, &settings);
    Ok(())
}

#[tauri::command]
pub async fn list_backups() -> R<Vec<BackupInfo>> {
    Ok(store::list_backups())
}

#[tauri::command]
pub async fn restore_backup(app: AppHandle, name: String) -> R<PersistedState> {
    let st = blocking(move || store::restore_backup(&name)).await?;
    if !st.settings.is_null() {
        broadcast_settings(&app, &st.settings);
    }
    Ok(st)
}

#[tauri::command]
pub async fn export_state(path: String) -> R<()> {
    blocking(move || store::export_state(&path)).await
}

#[tauri::command]
pub async fn import_state(app: AppHandle, path: String) -> R<PersistedState> {
    let st = blocking(move || store::import_state(&path)).await?;
    if !st.settings.is_null() {
        broadcast_settings(&app, &st.settings);
    }
    Ok(st)
}

#[tauri::command]
pub async fn import_media(path: String, kind: String) -> R<String> {
    blocking(move || store::import_media(&path, &kind)).await
}

#[tauri::command]
pub async fn open_settings_window(app: AppHandle) -> R<()> {
    windows_mgr::open_settings(&app)
}

#[tauri::command]
pub async fn show_search(app: AppHandle, initial: Option<String>) -> R<()> {
    windows_mgr::show_search(&app, initial.unwrap_or_default())
}

#[tauri::command]
pub async fn take_search_initial() -> R<String> {
    Ok(windows_mgr::take_search_initial())
}

#[tauri::command]
pub async fn hide_search(app: AppHandle) -> R<()> {
    windows_mgr::hide_search(&app);
    Ok(())
}

#[tauri::command]
pub async fn raise_desktop(raised: bool) -> R<()> {
    blocking(move || {
        desktop_window::set_raised(raised, raised);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn set_windows_icons_mode(app: AppHandle, enabled: bool) -> R<()> {
    desktop_window::set_windows_icons_mode(enabled);
    if let Some(st) = app.try_state::<windows_mgr::TrayState>() {
        let _ = st.win_icons.set_checked(enabled);
    }
    Ok(())
}

#[tauri::command]
pub async fn quit_app(app: AppHandle) -> R<()> {
    windows_mgr::quit(&app);
    Ok(())
}
