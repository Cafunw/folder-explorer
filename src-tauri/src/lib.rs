//! Folder Explorer — Rust side. See docs/ARCHITECTURE.md.

mod archive;
mod commands;
mod ctxmenu;
mod desktop_window;
mod diag;
mod env;
mod explorer_menu;
mod hello;
mod icons;
mod items;
mod lang;
mod legacy;
mod live;
mod quiet;
mod selftest;
mod shell;
mod shell_new;
mod startup;
mod store;
mod util;
mod wallpaper;
mod windows_mgr;

use tauri::{Manager, RunEvent, WindowEvent};

/// `folder-explorer.exe --watchdog <pid>`: wait for the main process and restore the icons.
pub fn watchdog(pid: Option<&String>) {
    if let Some(pid) = pid.and_then(|p| p.parse::<u32>().ok()) {
        desktop_window::run_watchdog(pid);
    }
}

/// `folder-explorer.exe --watchdog-launch <pid>`: start the watchdog outside the caller's process tree.
pub fn launch_watchdog(pid: Option<&String>) {
    if let Some(pid) = pid.filter(|p| p.parse::<u32>().is_ok()) {
        desktop_window::launch_watchdog(pid);
    }
}

/// `folder-explorer.exe --show-icons`: make the Windows desktop icons visible again.
pub fn show_icons() {
    desktop_window::restore_icons();
    std::thread::sleep(std::time::Duration::from_millis(300));
}

/// `folder-explorer.exe --start-with-windows on|off [--language en|tr]` (installer): stores
/// `behavior.startWithWindows` like Settings ▸ Behavior does, makes the Startup shortcut match, and
/// takes the installer's language as the UI language.
pub fn set_start_with_windows(on: bool, language: Option<&str>) {
    let mut s = store::settings();
    if !s.is_object() {
        s = serde_json::json!({});
    }
    if !s["behavior"].is_object() {
        s["behavior"] = serde_json::json!({});
    }
    s["behavior"]["startWithWindows"] = serde_json::Value::Bool(on);
    if let Some(l @ ("en" | "tr")) = language {
        s["language"] = l.into();
    }
    let _ = store::save_settings(s);
    let _ = startup::set(on);
}

/// `folder-explorer.exe --clean-legacy`: remove what earlier versions wrote into Windows, print what was found.
pub fn clean_legacy() {
    let removed = legacy::run();
    if removed.is_empty() {
        println!("nothing of Folder Explorer found in the registry");
    }
    for r in removed {
        println!("removed: {r}");
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
}

/// `folder-explorer.exe --quit`: ask a running instance to close gracefully (it restores the
/// Windows icons on the way out), wait for it, then make sure the icons are visible.
pub fn quit_running() {
    desktop_window::quit_running_instance();
}

/// `folder-explorer.exe --new-group` (Windows' Yeni ▸ Folder Explorer grubu): hand over to the
/// running desktop. False when it is not running (then the app starts and makes the group itself).
pub fn new_group() -> bool {
    desktop_window::post_new_group()
}

/// `folder-explorer.exe --selftest [outdir]` / `--fileops-test <dir>`: diagnostics without Tauri.
pub fn selftest(args: &[String]) {
    selftest::run(args);
}

/// A panic on the main thread (Tauri's event loop) ends the app; one on a worker thread is caught
/// (spawn_blocking, run_sta) and becomes an error, so the Windows icons must stay hidden. A worker
/// panic that aborts the process is covered by the watchdog.
fn panic_ends_app(thread_name: Option<&str>) -> bool {
    thread_name == Some("main")
}

pub fn run() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if panic_ends_app(std::thread::current().name()) {
            desktop_window::restore_icons();
        }
        default_hook(info);
    }));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == "--new-group") {
                windows_mgr::new_group(app);
            } else if !args.iter().any(|a| a == "--autostart") {
                let _ = windows_mgr::open_settings(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("fe", icons::protocol)
        .invoke_handler(tauri::generate_handler![
            commands::get_environment,
            commands::list_desktop_items,
            commands::get_windows_layout,
            commands::open_item,
            commands::desktop_context_menu,
            commands::item_context_menu,
            commands::mirror_selection,
            commands::native_menu,
            commands::classic_menu,
            commands::shell_verb,
            commands::new_item,
            commands::open_with,
            commands::open_verb,
            commands::open_terminal,
            commands::compress,
            commands::paste_files,
            commands::clipboard_files,
            commands::copy_text,
            commands::show_properties,
            commands::run_as_admin,
            commands::debug_log,
            commands::recycle,
            commands::restore_from_recycle,
            commands::rename_item,
            commands::move_into_folder,
            commands::copy_into_folder,
            commands::drop_on_item,
            commands::key_state,
            commands::import_dropped,
            commands::start_drag_out,
            commands::cursor_over_foreign_window,
            commands::list_start_apps,
            commands::list_dir_preview,
            commands::list_folder,
            commands::watch_folder,
            commands::unwatch_folder,
            commands::known_folders,
            commands::hello_available,
            commands::hello_verify,
            commands::shortcut_target,
            commands::list_recent,
            commands::search_files,
            commands::create_shortcut,
            commands::create_url_shortcut,
            commands::get_wallpapers,
            commands::get_quiet,
            commands::load_state,
            commands::save_layout,
            commands::save_settings,
            commands::list_backups,
            commands::restore_backup,
            commands::export_state,
            commands::import_state,
            commands::import_media,
            commands::import_icon_pack,
            commands::export_theme,
            commands::import_theme,
            commands::open_settings_window,
            commands::show_search,
            commands::take_search_initial,
            commands::take_launch_new_group,
            commands::hide_search,
            commands::reveal_search,
            commands::raise_desktop,
            commands::set_windows_icons_mode,
            commands::quit_app,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "desktop" {
                    api.prevent_close();
                }
            }
            // The desktop window is owned by Windows' desktop window, so it is destroyed with it when
            // Explorer restarts (crash, "Restart" in Task Manager). Start again once Explorer is back.
            if let WindowEvent::Destroyed = event {
                if window.label() == "desktop" && !desktop_window::is_quitting() {
                    // A hidden search or settings window would keep this process alive without a desktop,
                    // and single-instance would hand the fresh copy's launch to it: leave now.
                    desktop_window::restart_and_exit(window.app_handle());
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            util::set_app(handle.clone());
            store::init();
            // Remove what earlier versions wrote into Windows (Run value).
            legacy::clean_up();
            if std::env::args().any(|a| a == "--new-group") {
                windows_mgr::set_launch_new_group();
            }
            // Must happen before the Windows icons are hidden.
            desktop_window::init_windows_layout();
            desktop_window::create(&handle)?;
            items::start_watcher();
            wallpaper::start_watch();
            let _ = wallpaper::get_wallpapers();
            windows_mgr::setup_tray(&handle)?;
            let settings = store::settings();
            windows_mgr::apply_settings(&handle, &settings);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Folder Explorer failed to start");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            // Closing the last secondary window must not quit; only an explicit exit does.
            if code.is_none() && app.get_webview_window("desktop").is_some() {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => desktop_window::restore_icons(),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_main_thread_panic_restores_the_icons() {
        assert!(panic_ends_app(Some("main")));
        assert!(!panic_ends_app(Some("fe-sta")));
        assert!(!panic_ends_app(Some("tokio-runtime-worker")));
        assert!(!panic_ends_app(None));
    }
}
