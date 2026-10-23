//! Persistence in `%APPDATA%\Folder Explorer\`: state.json, backups, media.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use crate::{dlog, util};

const MAX_BACKUPS: usize = 10;
const BACKUP_INTERVAL: Duration = Duration::from_secs(15 * 60);

#[derive(Serialize, Clone, Debug)]
pub struct PersistedState {
    pub layout: Value,
    pub settings: Value,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub name: String,
    pub created_at: u64,
    pub size: u64,
}

struct Inner {
    layout: Value,
    settings: Value,
    dirty_since_backup: bool,
    last_backup: Instant,
}

static STORE: OnceLock<Mutex<Inner>> = OnceLock::new();

pub fn app_dir() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("Folder Explorer")
}

pub fn media_dir() -> PathBuf {
    app_dir().join("media")
}

fn backups_dir() -> PathBuf {
    app_dir().join("backups")
}

fn state_path() -> PathBuf {
    app_dir().join("state.json")
}

fn store() -> &'static Mutex<Inner> {
    STORE.get_or_init(|| {
        let (layout, settings) = read_state_file(&state_path()).unwrap_or((Value::Null, Value::Null));
        Mutex::new(Inner { layout, settings, dirty_since_backup: false, last_backup: Instant::now() })
    })
}

fn read_state_file(path: &Path) -> Option<(Value, Value)> {
    let bytes = fs::read(path).ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    if !v.is_object() {
        return None;
    }
    Some((v.get("layout").cloned().unwrap_or(Value::Null), v.get("settings").cloned().unwrap_or(Value::Null)))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn serialize(inner: &Inner) -> Vec<u8> {
    serde_json::to_vec_pretty(&json!({ "layout": inner.layout, "settings": inner.settings })).unwrap_or_default()
}

/// Loads state, makes the startup backup and starts the periodic backup thread.
pub fn init() {
    let _ = fs::create_dir_all(app_dir());
    let _ = fs::create_dir_all(media_dir());
    let _ = fs::create_dir_all(backups_dir());
    let st = store();
    if state_path().exists() {
        let _ = make_backup();
    }
    let _ = st;
    std::thread::Builder::new()
        .name("fe-backup".into())
        .spawn(|| loop {
            std::thread::sleep(Duration::from_secs(60));
            let due = {
                let g = store().lock().unwrap();
                g.dirty_since_backup && g.last_backup.elapsed() >= BACKUP_INTERVAL
            };
            if due {
                let _ = make_backup();
            }
        })
        .ok();
}

fn make_backup() -> Result<(), String> {
    let bytes = {
        let mut g = store().lock().map_err(|e| e.to_string())?;
        g.dirty_since_backup = false;
        g.last_backup = Instant::now();
        serialize(&g)
    };
    let name = format!("state-{}.json", util::now_ms());
    write_atomic(&backups_dir().join(&name), &bytes)?;
    prune_backups();
    dlog!("backup {name}");
    Ok(())
}

fn prune_backups() {
    let mut list = list_backups();
    if list.len() <= MAX_BACKUPS {
        return;
    }
    // list is newest first
    for b in list.drain(MAX_BACKUPS..) {
        let _ = fs::remove_file(backups_dir().join(b.name));
    }
}

pub fn load_state() -> PersistedState {
    let g = store().lock().unwrap();
    PersistedState { layout: g.layout.clone(), settings: g.settings.clone() }
}

pub fn settings() -> Value {
    store().lock().unwrap().settings.clone()
}

fn persist(g: &mut Inner) -> Result<(), String> {
    g.dirty_since_backup = true;
    write_atomic(&state_path(), &serialize(g))
}

pub fn save_layout(layout: Value) -> Result<(), String> {
    let mut g = store().lock().map_err(|e| e.to_string())?;
    g.layout = layout;
    persist(&mut g)
}

pub fn save_settings(settings: Value) -> Result<(), String> {
    let mut g = store().lock().map_err(|e| e.to_string())?;
    g.settings = settings;
    persist(&mut g)
}

pub fn list_backups() -> Vec<BackupInfo> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(backups_dir()) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !(name.starts_with("state-") && name.ends_with(".json")) {
                continue;
            }
            let created_at = name
                .trim_start_matches("state-")
                .trim_end_matches(".json")
                .parse::<u64>()
                .unwrap_or(0);
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(BackupInfo { name, created_at, size });
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

fn replace_state(layout: Value, settings: Value) -> Result<PersistedState, String> {
    let mut g = store().lock().map_err(|e| e.to_string())?;
    g.layout = layout;
    g.settings = settings;
    persist(&mut g)?;
    Ok(PersistedState { layout: g.layout.clone(), settings: g.settings.clone() })
}

pub fn restore_backup(name: &str) -> Result<PersistedState, String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("geçersiz yedek adı".into());
    }
    let path = backups_dir().join(name);
    let (layout, settings) = read_state_file(&path).ok_or("yedek okunamadı")?;
    // keep the current state as a backup before overwriting it
    let _ = make_backup();
    replace_state(layout, settings)
}

pub fn export_state(path: &str) -> Result<(), String> {
    let bytes = {
        let g = store().lock().map_err(|e| e.to_string())?;
        serialize(&g)
    };
    fs::write(path, bytes).map_err(|e| e.to_string())
}

pub fn import_state(path: &str) -> Result<PersistedState, String> {
    let (layout, settings) = read_state_file(Path::new(path)).ok_or("dosya geçerli bir Folder Explorer yedeği değil")?;
    if layout.is_null() && settings.is_null() {
        return Err("dosyada düzen ya da ayar yok".into());
    }
    let _ = make_backup();
    replace_state(layout, settings)
}

pub fn import_media(path: &str, kind: &str) -> Result<String, String> {
    let src = Path::new(path);
    if !src.is_file() {
        return Err("dosya bulunamadı".into());
    }
    let kind = if kind == "wallpaper" { "wallpaper" } else { "icon" };
    let ext = src
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    fs::create_dir_all(media_dir()).map_err(|e| e.to_string())?;
    let dest = media_dir().join(format!("{kind}-{}{ext}", util::now_ms()));
    fs::copy(src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}
