//! Folder Explorer — Rust side. See docs/ARCHITECTURE.md.

mod commands;
mod desktop_window;
mod diag;
mod env;
mod icons;
mod items;
mod legacy;
mod passthrough;
mod selftest;
mod shell;
mod startup;
mod store;
mod util;
mod wallpaper;
mod windows_mgr;

use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

/// `folder-explorer.exe --watchdog <pid>`: wait for the main process and restore the icons.
pub fn watchdog(pid: Option<&String>) {
    if let Some(pid) = pid.and_then(|p| p.parse::<u32>().ok()) {
        desktop_window::run_watchdog(pid);
    }
}

/// `folder-explorer.exe --show-icons`: make the Windows desktop icons visible again.
pub fn show_icons() {
    desktop_window::restore_icons();
    std::thread::sleep(std::time::Duration::from_millis(300));
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

/// `folder-explorer.exe --selftest [outdir]` / `--fileops-test <dir>`: diagnostics without Tauri.
pub fn selftest(args: &[String]) {
    selftest::run(args);
}

pub fn run() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        desktop_window::restore_icons();
        default_hook(info);
    }));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args.iter().any(|a| a == "--autostart") {
                let _ = windows_mgr::open_settings(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let _ = windows_mgr::show_search(app, String::new());
                    }
                })
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol("fe", icons::protocol)
        .invoke_handler(tauri::generate_handler![
            commands::get_environment,
            commands::list_desktop_items,
            commands::get_windows_layout,
            commands::open_item,
            commands::show_shell_menu,
            commands::show_item_menu,
            commands::take_menu_request,
            commands::hide_menu,
            commands::clipboard_files,
            commands::copy_text,
            commands::show_properties,
            commands::run_as_admin,
            commands::set_input_regions,
            commands::debug_log,
            commands::recycle,
            commands::restore_from_recycle,
            commands::rename_item,
            commands::move_into_folder,
            commands::import_dropped,
            commands::start_drag_out,
            commands::cursor_over_foreign_window,
            commands::list_start_apps,
            commands::create_shortcut,
            commands::create_url_shortcut,
            commands::get_wallpapers,
            commands::load_state,
            commands::save_layout,
            commands::save_settings,
            commands::list_backups,
            commands::restore_backup,
            commands::export_state,
            commands::import_state,
            commands::import_media,
            commands::open_settings_window,
            commands::show_search,
            commands::take_search_initial,
            commands::hide_search,
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
                    desktop_window::restore_icons();
                    desktop_window::restart_after_explorer();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            util::set_app(handle.clone());
            store::init();
            // Remove what earlier versions wrote into Windows (New-menu entry, Run value).
            legacy::clean_up();
            // Must happen before the Windows icons are hidden.
            desktop_window::init_windows_layout();
            desktop_window::create(&handle)?;
            items::start_watcher();
            wallpaper::start_poll();
            let _ = wallpaper::get_wallpapers();
            windows_mgr::setup_tray(&handle)?;
            windows_mgr::prepare_menu(&handle);
            let settings = store::settings();
            windows_mgr::apply_settings(&handle, &settings);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Folder Explorer başlatılamadı");

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
