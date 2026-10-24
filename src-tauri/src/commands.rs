//! Tauri command wrappers. All commands are async so that blocking work never runs
//! on the UI thread (sync commands run on the main thread in Tauri 2).

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::env::{self, Environment};
use crate::items::{self, DesktopItem};
use crate::shell::{self, StartApp};
use crate::store::{self, BackupInfo, PersistedState};
use crate::wallpaper::{self, WallpaperInfo};
use crate::{archive, ctxmenu, desktop_window, util, windows_mgr};

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

fn point(at: Option<[i32; 2]>) -> Option<windows::Win32::Foundation::POINT> {
    at.map(|a| windows::Win32::Foundation::POINT { x: a[0], y: a[1] })
}

/// Our right-click menu (`request` is built by the desktop; `at` = screen point, default the
/// cursor). While it is on screen the shell's side is prepared: Open with ▸ / New ▸ first, then
/// the classic menu, each reported to the menu as "menu-extra".
#[tauri::command]
pub async fn open_menu(app: AppHandle, request: Value, at: Option<[i32; 2]>) -> R<()> {
    let paths: Vec<String> = request
        .get("paths")
        .and_then(|p| p.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let shown = {
        let app = app.clone();
        blocking(move || windows_mgr::open_menu(&app, request, point(at))).await
    };
    std::thread::spawn(move || {
        for full in [false, true] {
            let extra = if full { ctxmenu::prepare_full(paths.clone()) } else { ctxmenu::prepare_quick(paths.clone()) };
            match extra {
                Ok(x) => {
                    let _ = app.emit_to(windows_mgr::MENU, "menu-extra", x);
                }
                Err(e) => crate::dlog!("menu prepare: {e}"),
            }
        }
    });
    shown
}

#[tauri::command]
pub async fn place_menu(app: AppHandle, label: String, x: i32, y: i32, w: u32, h: u32, fade: Option<bool>) -> R<()> {
    windows_mgr::place_menu(&app, &label, x, y, w, h, fade.unwrap_or(false))
}

#[tauri::command]
pub async fn take_menu_request() -> R<Value> {
    Ok(windows_mgr::take_menu_request())
}

#[tauri::command]
pub async fn hide_menu(app: AppHandle, label: Option<String>) -> R<()> {
    windows_mgr::hide_menu(&app, label.as_deref());
    Ok(())
}

/// Windows' classic menu ("Daha fazla seçenek göster"); see `ctxmenu::show`.
#[tauri::command]
pub async fn classic_menu(paths: Vec<String>, at: Option<[i32; 2]>, own: Option<Vec<ctxmenu::OwnItem>>) -> R<Option<String>> {
    blocking(move || ctxmenu::show(paths, point(at), own.unwrap_or_default())).await
}

/// Runs the first of `verbs` the shell offers for `paths` (empty = the desktop); false = none.
#[tauri::command]
pub async fn shell_verb(paths: Vec<String>, verbs: Vec<String>) -> R<bool> {
    blocking(move || ctxmenu::invoke_verb(paths, verbs)).await
}

#[tauri::command]
pub async fn new_item(id: u32) -> R<()> {
    blocking(move || ctxmenu::invoke_new(id)).await
}

#[tauri::command]
pub async fn open_with(paths: Vec<String>, index: Option<usize>) -> R<()> {
    blocking(move || ctxmenu::open_with(paths, index)).await
}

#[tauri::command]
pub async fn open_verb(path: String, verbs: Vec<String>) -> R<()> {
    blocking(move || shell::open_with_verb(path, verbs)).await
}

#[tauri::command]
pub async fn open_terminal(dir: String) -> R<()> {
    blocking(move || shell::open_terminal(dir)).await
}

#[tauri::command]
pub async fn compress(paths: Vec<String>, format: String) -> R<String> {
    blocking(move || archive::compress(paths, format)).await
}

#[tauri::command]
pub async fn paste_files(shortcuts: Option<bool>) -> R<Vec<String>> {
    blocking(move || shell::paste(shortcuts.unwrap_or(false))).await
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
    crate::diag!("ui  {line}");
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
pub async fn copy_into_folder(paths: Vec<String>, target_dir: String) -> R<()> {
    blocking(move || shell::copy_into_folder(paths, target_dir)).await
}

/// Explorer's drop of files onto an item (an app opens them); see `shell::drop_on_item`.
#[tauri::command]
pub async fn drop_on_item(target: String, paths: Vec<String>) -> R<String> {
    blocking(move || shell::drop_on_item(target, paths)).await
}

#[tauri::command]
pub async fn key_state() -> R<shell::KeyState> {
    Ok(shell::key_state())
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
pub async fn list_dir_preview(path: String, limit: Option<usize>) -> R<shell::DirPreview> {
    blocking(move || shell::list_dir_preview(path, limit.unwrap_or(200))).await
}

/// Live groups: the newest entries of a real folder (see live.rs).
#[tauri::command]
pub async fn list_folder(dir: String) -> R<Vec<DesktopItem>> {
    blocking(move || crate::live::list_folder(dir)).await
}

#[tauri::command]
pub async fn watch_folder(dir: String) -> R<()> {
    blocking(move || crate::live::watch(dir)).await
}

#[tauri::command]
pub async fn unwatch_folder(dir: String) -> R<()> {
    blocking(move || {
        crate::live::unwatch(dir);
        Ok(())
    })
    .await
}

#[derive(serde::Serialize)]
pub struct KnownFolders {
    downloads: Option<String>,
    documents: Option<String>,
    pictures: Option<String>,
}

/// Quick choices of the live group picker.
#[tauri::command]
pub async fn known_folders() -> R<KnownFolders> {
    use windows::Win32::UI::Shell::{FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Pictures};
    blocking(|| {
        Ok(KnownFolders {
            downloads: util::known_folder(&FOLDERID_Downloads),
            documents: util::known_folder(&FOLDERID_Documents),
            pictures: util::known_folder(&FOLDERID_Pictures),
        })
    })
    .await
}

/// Locked groups: is Windows Hello set up for this user?
#[tauri::command]
pub async fn hello_available() -> R<bool> {
    blocking(|| Ok(crate::hello::available())).await
}

/// Locked groups: Windows' Hello prompt over the desktop window; true = verified.
#[tauri::command]
pub async fn hello_verify(message: String) -> R<bool> {
    blocking(move || crate::hello::verify(message)).await
}

#[tauri::command]
pub async fn shortcut_target(path: String) -> R<Option<shell::ShortcutInfo>> {
    blocking(move || shell::shortcut_target(path)).await
}

#[tauri::command]
pub async fn list_recent(limit: Option<usize>) -> R<Vec<shell::RecentFile>> {
    blocking(move || shell::list_recent(limit.unwrap_or(50))).await
}

#[tauri::command]
pub async fn search_files(query: String, limit: Option<usize>) -> R<Vec<shell::FoundFile>> {
    blocking(move || Ok(shell::search_files(query, limit.unwrap_or(20)))).await
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

/// Game / battery quiet state (the same as the `quiet-changed` event).
#[tauri::command]
pub async fn get_quiet() -> R<crate::quiet::Quiet> {
    Ok(crate::quiet::current())
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
pub async fn import_icon_pack(dir: String) -> R<store::IconPack> {
    blocking(move || store::import_icon_pack(&dir)).await
}

#[tauri::command]
pub async fn export_theme(path: String, theme: Value) -> R<()> {
    blocking(move || store::export_theme(&path, &theme)).await
}

#[tauri::command]
pub async fn import_theme(path: String) -> R<Value> {
    blocking(move || store::import_theme(&path)).await
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
pub async fn reveal_search(app: AppHandle) -> R<()> {
    windows_mgr::reveal_search(&app);
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
