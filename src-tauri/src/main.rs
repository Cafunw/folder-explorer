// No console window, dev builds included: Windows starts the exe from the New menu (`--new-group`)
// and at sign-in. `tauri dev` / `cargo run` still get its output through the handles they pass in.
#![windows_subsystem = "windows"]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // Started again after Explorer restarted: give the old process time to exit first.
    if let Some(i) = args.iter().position(|a| a == "--delayed-start") {
        let secs: u64 = args.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(3);
        std::thread::sleep(std::time::Duration::from_secs(secs));
    }
    if let Some(i) = args.iter().position(|a| a == "--watchdog-launch") {
        folder_explorer_lib::launch_watchdog(args.get(i + 1));
        return;
    }
    if let Some(i) = args.iter().position(|a| a == "--watchdog") {
        folder_explorer_lib::watchdog(args.get(i + 1));
        return;
    }
    // Used by the installer/uninstaller: bring the Windows desktop icons back, no UI.
    if args.iter().any(|a| a == "--quit") {
        folder_explorer_lib::quit_running();
        return;
    }
    // Windows' Yeni ▸ Folder Explorer grubu: the running desktop makes the group. A dev build never
    // starts from it: its UI comes from the dev server, so alone it would cover the desktop blank.
    if args.iter().any(|a| a == "--new-group") && (folder_explorer_lib::new_group() || cfg!(debug_assertions)) {
        return;
    }
    // Installer, after copying the files (the app is not running then): its "start with Windows" and language choices.
    if let Some(i) = args.iter().position(|a| a == "--start-with-windows") {
        let language = args.iter().position(|a| a == "--language").and_then(|j| args.get(j + 1)).map(String::as_str);
        folder_explorer_lib::set_start_with_windows(args.get(i + 1).map(String::as_str) == Some("on"), language);
        return;
    }
    if args.iter().any(|a| a == "--show-icons") {
        folder_explorer_lib::show_icons();
        return;
    }
    folder_explorer_lib::run()
}
