//! Windows wallpaper information via IDesktopWallpaper.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tauri::Emitter;
use windows::core::PCWSTR;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::UI::Shell::{
    DesktopWallpaper, IDesktopWallpaper, DWPOS_CENTER, DWPOS_FILL, DWPOS_FIT, DWPOS_SPAN, DWPOS_STRETCH,
    DWPOS_TILE,
};

use crate::{env, util};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperInfo {
    pub monitor_id: String,
    pub path: Option<String>,
    pub position: &'static str,
    pub color: String,
    pub version: String,
}

static LAST: Mutex<Option<Vec<WallpaperInfo>>> = Mutex::new(None);

fn transcoded_fallback(index: usize) -> Option<String> {
    let appdata = std::env::var("APPDATA").ok()?;
    let themes = Path::new(&appdata).join("Microsoft\\Windows\\Themes");
    let candidates = [
        themes.join(format!("Transcoded_{index:03}")),
        themes.join("TranscodedWallpaper"),
    ];
    candidates
        .iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().to_string())
}

fn mtime(path: &str) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Needs STA.
pub fn get_wallpapers_sta() -> Result<Vec<WallpaperInfo>, String> {
    let monitors = env::monitors();
    unsafe {
        let dw: IDesktopWallpaper = CoCreateInstance(&DesktopWallpaper, None, CLSCTX_ALL).map_err(|e| e.message())?;
        let position = match dw.GetPosition().unwrap_or(DWPOS_FILL) {
            DWPOS_CENTER => "center",
            DWPOS_TILE => "tile",
            DWPOS_STRETCH => "stretch",
            DWPOS_FIT => "fit",
            DWPOS_SPAN => "span",
            _ => "fill",
        };
        let c = dw.GetBackgroundColor().map(|c| c.0).unwrap_or(0);
        let color = format!("#{:02x}{:02x}{:02x}", c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff);
        let count = dw.GetMonitorDevicePathCount().unwrap_or(0);
        let mut out = Vec::new();
        for i in 0..count {
            let Ok(dev) = dw.GetMonitorDevicePathAt(i) else { continue };
            let dev_s = util::take_pwstr(dev);
            let dev_w = windows::core::HSTRING::from(dev_s.as_str());
            let Ok(rect) = dw.GetMonitorRECT(PCWSTR(dev_w.as_ptr())) else { continue };
            let r = env::Rect::from_rect(&rect);
            let monitor_id = monitors
                .iter()
                .find(|m| m.bounds == r)
                .map(|m| m.id.clone())
                .unwrap_or_else(|| dev_s.clone());
            let wp = dw.GetWallpaper(PCWSTR(dev_w.as_ptr())).map(|p| util::take_pwstr(p)).unwrap_or_default();
            let path = if wp.is_empty() {
                None
            } else if Path::new(&wp).is_file() {
                Some(wp)
            } else {
                transcoded_fallback(i as usize)
            };
            let version = util::short_hash(&format!(
                "{}|{}|{}|{}",
                path.clone().unwrap_or_default(),
                path.as_deref().map(mtime).unwrap_or(0),
                position,
                color
            ));
            out.push(WallpaperInfo { monitor_id, path, position, color: color.clone(), version });
        }
        if out.is_empty() {
            // IDesktopWallpaper returned nothing usable; fall back to the transcoded image.
            for (i, m) in monitors.iter().enumerate() {
                let path = transcoded_fallback(i);
                let version = util::short_hash(&format!("{:?}|{}", path, path.as_deref().map(mtime).unwrap_or(0)));
                out.push(WallpaperInfo { monitor_id: m.id.clone(), path, position, color: color.clone(), version });
            }
        }
        Ok(out)
    }
}

pub fn get_wallpapers() -> Result<Vec<WallpaperInfo>, String> {
    let list = util::run_sta(get_wallpapers_sta)??;
    *LAST.lock().unwrap() = Some(list.clone());
    Ok(list)
}

/// Image bytes for the wallpaper of `monitor_id` (or the first one).
pub fn wallpaper_bytes(monitor_id: &str) -> Option<(Vec<u8>, String)> {
    let cached = LAST.lock().unwrap().clone();
    let list = match cached {
        Some(l) => l,
        None => get_wallpapers().ok()?,
    };
    let info = list
        .iter()
        .find(|w| w.monitor_id == monitor_id)
        .or_else(|| list.first())?;
    let path = info.path.clone()?;
    let bytes = std::fs::read(&path).ok()?;
    Some((bytes, path))
}

pub fn emit_changed() {
    if let Ok(list) = get_wallpapers() {
        let _ = list;
    }
    if let Some(app) = util::app() {
        let _ = app.emit("wallpaper-changed", ());
    }
}

static CHECK_SCHEDULED: AtomicBool = AtomicBool::new(false);
/// A change came while a game was in front; looked at when game mode ends.
static PENDING: AtomicBool = AtomicBool::new(false);

/// Changes announced with WM_SETTINGCHANGE reach the desktop window. Slideshows and Spotlight do not
/// always send it, but every wallpaper change rewrites Windows' transcoded copy of the image: watch
/// that folder (no polling).
pub fn start_watch() {
    let Ok(appdata) = std::env::var("APPDATA") else { return };
    let dir = Path::new(&appdata).join("Microsoft\\Windows\\Themes");
    let handler = |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        let transcoded = ev
            .paths
            .iter()
            .any(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("Transcoded")));
        if transcoded {
            schedule_check();
        }
    };
    match notify::recommended_watcher(handler) {
        Ok(mut watcher) => {
            if watcher.watch(&dir, RecursiveMode::NonRecursive).is_ok() {
                // lives as long as the app
                Box::leak(Box::new(watcher));
            }
        }
        Err(e) => crate::dlog!("wallpaper watch: {e}"),
    }
}

fn schedule_check() {
    if CHECK_SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        // the image is written in several steps
        std::thread::sleep(Duration::from_millis(1500));
        CHECK_SCHEDULED.store(false, Ordering::SeqCst);
        if crate::quiet::game_quiet() {
            PENDING.store(true, Ordering::SeqCst);
        } else {
            refresh_if_changed();
        }
    });
}

fn refresh_if_changed() {
    let before = LAST.lock().unwrap().clone();
    if let Ok(now) = get_wallpapers() {
        if before.as_ref() != Some(&now) {
            if let Some(app) = util::app() {
                let _ = app.emit("wallpaper-changed", ());
            }
        }
    }
}

/// Game mode ended: catch up with a change that came meanwhile.
pub fn flush_pending() {
    if PENDING.swap(false, Ordering::SeqCst) {
        std::thread::spawn(refresh_if_changed);
    }
}
