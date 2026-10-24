// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
    if args.iter().any(|a| a == "--clean-legacy") {
        folder_explorer_lib::clean_legacy();
        return;
    }
    if args.iter().any(|a| a == "--show-icons") {
        folder_explorer_lib::show_icons();
        return;
    }
    if args.iter().any(|a| a == "--selftest" || a == "--fileops-test" || a == "--ztest" || a == "--restore" || a == "--store-test" || a == "--menutest") {
        folder_explorer_lib::selftest(&args);
        return;
    }
    folder_explorer_lib::run()
}
