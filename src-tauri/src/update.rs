//! Updates: the signed installer of the latest GitHub release (tauri-plugin-updater; the endpoint and
//! public key are in tauri.conf.json > plugins.updater). A check only reads `latest.json`; nothing is
//! downloaded or installed until the user clicks Install (Settings ▸ About or the desktop's toast).

use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{desktop_window, store};

/// The update the last check found, kept for the Install click.
static FOUND: Mutex<Option<Update>> = Mutex::new(None);

const DAY: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub version: String,
}

pub async fn check(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = app
        .updater_builder()
        // On Windows the plugin starts the installer and ends this process with std::process::exit,
        // so the graceful quit's steps run here: bring the Windows desktop icons back first.
        .on_before_exit(|| {
            desktop_window::mark_quitting(true);
            desktop_window::restore_icons();
        })
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo { version: u.version.clone() });
    *FOUND.lock().unwrap() = update;
    Ok(info)
}

/// Downloads the installer, checks its signature and runs it (passive: a progress bar only). This
/// process exits as the installer starts; the installer starts the new version when it is done.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("development builds are not updated".into());
    }
    if FOUND.lock().unwrap().is_none() {
        check(app).await?;
    }
    let Some(update) = FOUND.lock().unwrap().take() else {
        return Err("no update".into());
    };
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())
}

/// While `behavior.checkUpdates` is on (default): a check a minute after start, then once a day by
/// the wall clock. The tick is hourly, so a PC that sleeps doesn't stretch the day and a failed
/// check (offline at sign-in) is retried an hour later.
pub fn start(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let _ = std::thread::Builder::new().name("fe-update".into()).spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        let mut last_ok = None;
        loop {
            if due(last_ok, SystemTime::now()) && enabled() {
                if let Ok(found) = tauri::async_runtime::block_on(check(&app)) {
                    last_ok = Some(SystemTime::now());
                    if let Some(info) = found {
                        let _ = app.emit_to("desktop", "update-available", info);
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(60 * 60));
        }
    });
}

fn enabled() -> bool {
    store::settings().pointer("/behavior/checkUpdates").and_then(|v| v.as_bool()).unwrap_or(true)
}

/// A clock set back (now before the last check) counts as due rather than waiting it out.
fn due(last_ok: Option<SystemTime>, now: SystemTime) -> bool {
    last_ok.is_none_or(|t| now.duration_since(t).map_or(true, |d| d >= DAY))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_once_a_day_and_after_a_clock_change() {
        let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        assert!(due(None, t));
        assert!(!due(Some(t), t + Duration::from_secs(60 * 60)));
        assert!(due(Some(t), t + DAY));
        assert!(due(Some(t + DAY), t));
    }
}
