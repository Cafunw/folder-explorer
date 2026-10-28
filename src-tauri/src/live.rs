//! Live folders: a group that shows a real directory. `list_folder` reads it, `watch_folder` /
//! `unwatch_folder` keep one reference-counted `notify` watcher per directory (non-recursive) that
//! sends `folder-changed { dir }` to the desktop window, debounced like the desktop watcher.

use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::Emitter;

use crate::items::{self, DesktopItem};
use crate::{dlog, icons, shell, util};

/// Entries a live group shows at most (the newest).
pub const LIST_LIMIT: usize = 500;
const DEBOUNCE: Duration = Duration::from_millis(250);
/// Under constant churn a change is still reported once per second.
const MAX_DELAY: Duration = Duration::from_secs(1);

struct Watched {
    /// as the UI passed it (the event carries it back)
    dir: String,
    refs: usize,
}

struct Live {
    watcher: RecommendedWatcher,
    /// key: `util::norm_path`
    dirs: HashMap<String, Watched>,
}

static LIVE: Mutex<Option<Live>> = Mutex::new(None);

fn existing_dir(dir: &str) -> Result<String, String> {
    let dir = shell::fs_norm(dir);
    if Path::new(&dir).is_dir() {
        Ok(dir)
    } else {
        Err(crate::lang::t("Folder not found", "Klasör bulunamadı").into())
    }
}

/// The newest `LIST_LIMIT` entries of `dir` (hidden / system files left out). Also lets Quick Look
/// read files below it.
pub fn list_folder(dir: String) -> Result<Vec<DesktopItem>, String> {
    let dir = existing_dir(&dir)?;
    icons::allow_root(&dir);
    util::run_sta(move || items::list_folder_sta(&dir, LIST_LIMIT))
}

pub fn watch(dir: String) -> Result<(), String> {
    let key = util::norm_path(&shell::fs_norm(&dir));
    let mut guard = LIVE.lock().map_err(|e| e.to_string())?;
    if let Some(w) = guard.as_mut().and_then(|l| l.dirs.get_mut(&key)) {
        w.refs += 1;
        return Ok(());
    }
    let path = existing_dir(&dir)?;
    if guard.is_none() {
        *guard = Some(Live { watcher: start()?, dirs: HashMap::new() });
    }
    let live = guard.as_mut().expect("just set");
    live.watcher.watch(Path::new(&path), RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
    live.dirs.insert(key, Watched { dir, refs: 1 });
    drop(guard);
    icons::allow_root(&path);
    Ok(())
}

pub fn unwatch(dir: String) {
    let key = util::norm_path(&shell::fs_norm(&dir));
    let Ok(mut guard) = LIVE.lock() else { return };
    let Some(live) = guard.as_mut() else { return };
    let Some(w) = live.dirs.get_mut(&key) else { return };
    w.refs = w.refs.saturating_sub(1);
    if w.refs > 0 {
        return;
    }
    if let Some(w) = live.dirs.remove(&key) {
        let _ = live.watcher.unwatch(Path::new(&shell::fs_norm(&w.dir)));
    }
    if live.dirs.is_empty() {
        // dropping the watcher closes the channel: the `fe-live` thread ends
        *guard = None;
    }
}

fn start() -> Result<RecommendedWatcher, String> {
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    std::thread::Builder::new()
        .name("fe-live".into())
        .spawn(move || run(rx))
        .map_err(|e| e.to_string())?;
    Ok(watcher)
}

#[derive(Serialize, Clone)]
struct FolderChanged {
    dir: String,
}

fn run(rx: Receiver<notify::Result<notify::Event>>) {
    // watched dir key → first event of the current burst
    let mut dirty: HashMap<String, Instant> = HashMap::new();
    loop {
        let timeout = if dirty.is_empty() { Duration::from_secs(3600) } else { DEBOUNCE };
        match rx.recv_timeout(timeout) {
            Ok(Ok(ev)) => {
                for p in &ev.paths {
                    // the entry's directory, or the watched directory itself (renamed / removed)
                    for cand in [p.parent(), Some(p.as_path())].into_iter().flatten() {
                        dirty.entry(util::norm_path(&cand.to_string_lossy())).or_insert_with(Instant::now);
                    }
                }
                flush(&mut dirty, false);
            }
            Ok(Err(e)) => dlog!("live watch error: {e}"),
            Err(RecvTimeoutError::Timeout) => flush(&mut dirty, true),
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// Sends `folder-changed` for the watched directories in `dirty` (all of them, or only those
/// waiting longer than `MAX_DELAY`); keys that are not watched are dropped.
fn flush(dirty: &mut HashMap<String, Instant>, all: bool) {
    if dirty.is_empty() {
        return;
    }
    let due: Vec<String> = dirty
        .iter()
        .filter(|(_, since)| all || since.elapsed() > MAX_DELAY)
        .map(|(k, _)| k.clone())
        .collect();
    if due.is_empty() {
        return;
    }
    let dirs: Vec<String> = match LIVE.lock() {
        Ok(g) => due
            .iter()
            .filter_map(|k| g.as_ref().and_then(|l| l.dirs.get(k)).map(|w| w.dir.clone()))
            .collect(),
        Err(_) => Vec::new(),
    };
    for k in &due {
        dirty.remove(k);
    }
    if all {
        dirty.clear();
    }
    let Some(app) = util::app() else { return };
    for dir in dirs {
        let _ = app.emit_to("desktop", "folder-changed", FolderChanged { dir });
    }
}
