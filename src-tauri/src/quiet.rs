//! Quiet modes, announced to every window as `quiet-changed` (`get_quiet` returns the same).
//!
//! * Game mode (`performance.gameMode`): a foreground window that fills its whole monitor —
//!   exclusive or borderless fullscreen, not the shell, the desktop or our own windows — makes that
//!   monitor "covered". Any covered monitor: the UI drops animations and effects. Every monitor
//!   covered (for a moment): the desktop webview is suspended. Re-evaluated on events only
//!   (foreground change, the foreground window resizing / minimizing, display changes), see
//!   `desktop_window`'s event thread.
//! * Battery mode (`performance.batteryMode`): "auto" = on battery or battery / energy saver,
//!   "always", "off". Re-read on `WM_POWERBROADCAST`.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::Emitter;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITORINFOEXW, MONITOR_DEFAULTTONULL};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUERY_USER_NOTIFICATION_STATE, QUNS_BUSY, QUNS_PRESENTATION_MODE,
    QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetDesktopWindow, GetForegroundWindow, GetShellWindow, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId,
    IsIconic, IsWindow, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

use crate::{desktop_window, env, util, wallpaper, windows_mgr};

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Quiet {
    pub game: bool,
    pub battery: bool,
    /// ids (`MonitorInfo.id`) of the monitors a fullscreen app covers
    pub covered: Vec<String>,
}

#[derive(Clone, Copy, PartialEq)]
enum BatteryMode {
    Auto,
    Always,
    Off,
}

struct State {
    game_mode: bool,
    battery_mode: BatteryMode,
    /// on battery, or battery / energy saver on
    on_battery: bool,
    presentation: bool,
    /// monitor id → the fullscreen window covering it
    covered: BTreeMap<String, isize>,
    published: Option<Quiet>,
}

static STATE: Mutex<State> = Mutex::new(State {
    game_mode: true,
    battery_mode: BatteryMode::Auto,
    on_battery: false,
    presentation: false,
    covered: BTreeMap::new(),
    published: None,
});
static GAME_MODE: AtomicBool = AtomicBool::new(true);
static GAME: AtomicBool = AtomicBool::new(false);
static ALL_COVERED: AtomicBool = AtomicBool::new(false);
static DESKTOP_ASLEEP: AtomicBool = AtomicBool::new(false);
static SLEEP_GEN: AtomicU64 = AtomicU64::new(0);

/// A fullscreen app that comes and goes at once (a loading screen, a video toggled) must not make the
/// icons disappear and pop back: the desktop webview sleeps only after every monitor stayed covered.
const SLEEP_AFTER: Duration = Duration::from_secs(2);

pub fn game_mode_enabled() -> bool {
    GAME_MODE.load(Ordering::SeqCst)
}

/// Some monitor is covered by a fullscreen app (or presentation mode is on): background work waits.
pub fn game_quiet() -> bool {
    GAME.load(Ordering::SeqCst)
}

/// Every monitor is covered: nothing of the desktop is visible.
pub fn all_covered() -> bool {
    ALL_COVERED.load(Ordering::SeqCst)
}

/// The desktop webview should be suspended (every monitor covered for a moment).
pub fn desktop_asleep() -> bool {
    DESKTOP_ASLEEP.load(Ordering::SeqCst)
}

pub fn current() -> Quiet {
    compute(&STATE.lock().unwrap()).0
}

/// `performance.gameMode` / `performance.batteryMode` from the settings JSON.
pub fn apply_settings(settings: &Value) {
    let game_mode = settings.pointer("/performance/gameMode").and_then(Value::as_bool).unwrap_or(true);
    let battery_mode = match settings.pointer("/performance/batteryMode").and_then(Value::as_str) {
        Some("always") => BatteryMode::Always,
        Some("off") => BatteryMode::Off,
        _ => BatteryMode::Auto,
    };
    let on_battery = read_power();
    {
        let mut st = STATE.lock().unwrap();
        st.battery_mode = battery_mode;
        st.on_battery = on_battery;
        st.game_mode = game_mode;
    }
    if GAME_MODE.swap(game_mode, Ordering::SeqCst) != game_mode {
        desktop_window::game_hooks_changed();
    }
    evaluate_game();
}

/// `WM_POWERBROADCAST`: AC ↔ battery, battery / energy saver on or off, resume from sleep.
pub fn on_power_change() {
    let on_battery = read_power();
    let mut st = STATE.lock().unwrap();
    if st.on_battery != on_battery {
        st.on_battery = on_battery;
        publish(st);
    }
}

/// Re-checks the covered monitors (a covering window may have closed while another monitor had
/// the focus).
pub fn revalidate() {
    if !STATE.lock().unwrap().covered.is_empty() {
        evaluate_game();
    }
}

fn read_power() -> bool {
    let mut s = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut s) }.is_err() {
        return false;
    }
    // ACLineStatus 0 = offline (battery); SystemStatusFlag 1 = battery saver / energy saver on
    s.ACLineStatus == 0 || s.SystemStatusFlag == 1
}

// ---------------------------------------------------------------------------
// Game mode

enum Front {
    /// the desktop itself is in front (Win+D, clicked an empty spot of the shell)
    Desktop,
    /// says nothing about what covers the monitors (shell UI, our own windows, a hidden window)
    Ignore,
    App,
}

fn cloaked(h: HWND) -> bool {
    let mut c: u32 = 0;
    unsafe {
        DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut c as *mut u32 as *mut _, std::mem::size_of::<u32>() as u32).is_ok()
            && c != 0
    }
}

fn classify(h: HWND) -> Front {
    unsafe {
        if h.is_invalid() || !IsWindow(Some(h)).as_bool() {
            return Front::Ignore;
        }
        if h == GetShellWindow() || h == GetDesktopWindow() {
            return Front::Desktop;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, Some(&mut pid));
        if pid == GetCurrentProcessId() {
            return Front::Ignore;
        }
        let class = desktop_window::class_name(h);
        if class == "Progman" || class == "WorkerW" {
            return Front::Desktop;
        }
        if desktop_window::is_shell_ui_class(&class) {
            return Front::Ignore;
        }
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW.0 != 0 || !IsWindowVisible(h).as_bool() || IsIconic(h).as_bool() || cloaked(h) {
            return Front::Ignore;
        }
        Front::App
    }
}

fn monitor_of(h: HWND) -> Option<(String, RECT)> {
    unsafe {
        let hm = MonitorFromWindow(h, MONITOR_DEFAULTTONULL);
        if hm.is_invalid() {
            return None;
        }
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if !GetMonitorInfoW(hm, &mut info.monitorInfo as *mut MONITORINFO).as_bool() {
            return None;
        }
        Some((util::wide_to_string(&info.szDevice), info.monitorInfo.rcMonitor))
    }
}

/// The visible frame (without the invisible resize borders, so a maximized window is never mistaken
/// for a fullscreen one).
fn frame_rect(h: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    unsafe {
        if DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut _, std::mem::size_of::<RECT>() as u32)
            .is_ok()
        {
            return Some(r);
        }
        GetWindowRect(h, &mut r).ok().map(|_| r)
    }
}

fn window_rect(h: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    unsafe { GetWindowRect(h, &mut r) }.ok().map(|_| r)
}

fn contains(outer: &RECT, inner: &RECT) -> bool {
    outer.left <= inner.left && outer.top <= inner.top && outer.right >= inner.right && outer.bottom >= inner.bottom
}

fn overlaps(a: &RECT, b: &RECT) -> bool {
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

fn to_rect(r: &env::Rect) -> RECT {
    RECT { left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height }
}

/// The visible frame covers the monitor; or the shell reports a fullscreen app (exclusive D3D or
/// "busy") and the window rect covers it (DWM frame bounds can be off for exclusive-mode windows).
fn fills(h: HWND, monitor: &RECT, quns: QUERY_USER_NOTIFICATION_STATE) -> bool {
    frame_rect(h).is_some_and(|r| contains(&r, monitor))
        || ((quns == QUNS_RUNNING_D3D_FULL_SCREEN || quns == QUNS_BUSY)
            && window_rect(h).is_some_and(|r| contains(&r, monitor)))
}

/// A window recorded as covering `monitor` still does (not closed, minimized, cloaked, windowed or moved).
fn still_covers(h: HWND, monitor: &str, quns: QUERY_USER_NOTIFICATION_STATE) -> bool {
    unsafe {
        if !IsWindow(Some(h)).as_bool() || !IsWindowVisible(h).as_bool() || IsIconic(h).as_bool() || cloaked(h) {
            return false;
        }
    }
    monitor_of(h).is_some_and(|(id, rc)| id == monitor && fills(h, &rc, quns))
}

/// Recomputes which monitors a fullscreen foreground window covers and publishes the result.
pub fn evaluate_game() {
    let quns = unsafe { SHQueryUserNotificationState() }.unwrap_or_default();
    let fg = unsafe { GetForegroundWindow() };
    let mut st = STATE.lock().unwrap();
    if !st.game_mode {
        st.covered.clear();
        st.presentation = false;
        return publish(st);
    }
    st.presentation = quns == QUNS_PRESENTATION_MODE;
    st.covered.retain(|id, hw| still_covers(util::hwnd_from(*hw), id, quns));
    if desktop_window::is_raised() {
        // raised over everything (a folder or dialog is open): the desktop is in front everywhere
        st.covered.clear();
        return publish(st);
    }
    match classify(fg) {
        Front::Desktop => st.covered.clear(),
        Front::Ignore => {}
        Front::App => {
            if let Some((id, rc)) = monitor_of(fg) {
                if fills(fg, &rc, quns) {
                    st.covered.insert(id, fg.0 as isize);
                } else if let Some(r) = frame_rect(fg) {
                    // an ordinary window is in front on the monitors it overlaps
                    let monitors = env::monitors();
                    st.covered.retain(|id, _| !monitors.iter().any(|m| m.id == *id && overlaps(&r, &to_rect(&m.bounds))));
                }
            }
        }
    }
    publish(st);
}

/// (what the UI is told, every monitor covered)
fn compute(st: &State) -> (Quiet, bool) {
    let covered: Vec<String> = st.covered.keys().cloned().collect();
    let all = !covered.is_empty() && {
        let monitors = env::monitors();
        !monitors.is_empty() && monitors.iter().all(|m| st.covered.contains_key(&m.id))
    };
    let quiet = Quiet {
        game: st.game_mode && (!covered.is_empty() || st.presentation),
        battery: match st.battery_mode {
            BatteryMode::Always => true,
            BatteryMode::Off => false,
            BatteryMode::Auto => st.on_battery,
        },
        covered,
    };
    (quiet, all)
}

fn publish(mut st: MutexGuard<'_, State>) {
    let (quiet, all) = compute(&st);
    let changed = st.published.as_ref() != Some(&quiet);
    if changed {
        st.published = Some(quiet.clone());
    }
    drop(st);
    let was_game = GAME.swap(quiet.game, Ordering::SeqCst);
    let was_all = ALL_COVERED.swap(all, Ordering::SeqCst);
    if changed {
        crate::diag!("quiet game={} battery={} covered={:?} all={all}", quiet.game, quiet.battery, quiet.covered);
        if let Some(app) = util::app() {
            let _ = app.emit("quiet-changed", quiet.clone());
        }
    }
    if all != was_all {
        sync_sleep(all);
    }
    if was_game && !quiet.game {
        wallpaper::flush_pending();
    }
}

fn sync_sleep(all: bool) {
    let gen = SLEEP_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    if all {
        std::thread::spawn(move || {
            std::thread::sleep(SLEEP_AFTER);
            if SLEEP_GEN.load(Ordering::SeqCst) == gen && ALL_COVERED.load(Ordering::SeqCst) {
                DESKTOP_ASLEEP.store(true, Ordering::SeqCst);
                windows_mgr::sync_desktop_webview();
            }
        });
    } else if DESKTOP_ASLEEP.swap(false, Ordering::SeqCst) {
        windows_mgr::sync_desktop_webview();
        // the z-order guard rested meanwhile
        desktop_window::kick(300, 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rc(left: i32, top: i32, right: i32, bottom: i32) -> RECT {
        RECT { left, top, right, bottom }
    }

    fn state(game_mode: bool, battery_mode: BatteryMode, on_battery: bool, presentation: bool) -> State {
        State { game_mode, battery_mode, on_battery, presentation, covered: BTreeMap::new(), published: None }
    }

    #[test]
    fn fullscreen_frame_covers_its_monitor() {
        let monitor = rc(0, 0, 1920, 1080);
        assert!(contains(&rc(0, 0, 1920, 1080), &monitor));
        // exclusive fullscreen windows may be larger than the monitor
        assert!(contains(&rc(-1, -1, 1921, 1081), &monitor));
        // maximized: the visible frame stops at the taskbar
        assert!(!contains(&rc(0, 0, 1920, 1040), &monitor));
        // second monitor to the right
        assert!(!contains(&rc(0, 0, 1920, 1080), &rc(1920, 0, 4480, 1440)));
    }

    #[test]
    fn overlap_is_strict() {
        let left = rc(0, 0, 1920, 1080);
        let right = rc(1920, 0, 4480, 1440);
        assert!(!overlaps(&rc(100, 100, 1920, 900), &right));
        assert!(overlaps(&rc(100, 100, 1921, 900), &right));
        assert!(overlaps(&rc(100, 100, 400, 400), &left));
    }

    #[test]
    fn battery_mode_decides_the_battery_flag() {
        assert!(!compute(&state(true, BatteryMode::Auto, false, false)).0.battery);
        assert!(compute(&state(true, BatteryMode::Auto, true, false)).0.battery);
        assert!(compute(&state(true, BatteryMode::Always, false, false)).0.battery);
        assert!(!compute(&state(true, BatteryMode::Off, true, false)).0.battery);
    }

    #[test]
    fn game_needs_game_mode_and_something_in_front() {
        assert_eq!(compute(&state(true, BatteryMode::Off, false, false)), (Quiet::default(), false));
        assert!(compute(&state(true, BatteryMode::Off, false, true)).0.game);
        assert!(!compute(&state(false, BatteryMode::Off, false, true)).0.game);
    }
}
