//! Persistence in `%APPDATA%\Folder Explorer\`: state.json, backups, media.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Write;
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
        let (layout, settings) = load_or_recover(&state_path(), &backups_dir());
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

/// A state file with a layout or settings; one with neither is as good as unreadable.
fn read_nonempty(path: &Path) -> Option<(Value, Value)> {
    read_state_file(path).filter(|(l, s)| !(l.is_null() && s.is_null()))
}

/// Reads state.json. One that doesn't parse is moved aside as `state.corrupt-<ms>.json` (kept for
/// good) and the newest backup that parses takes its place; empty only when nothing parses.
fn load_or_recover(state: &Path, backups: &Path) -> (Value, Value) {
    if let Some(s) = read_state_file(state) {
        return s;
    }
    if !state.exists() {
        return (Value::Null, Value::Null);
    }
    let aside = state.with_file_name(format!("state.corrupt-{}.json", util::now_ms()));
    if fs::rename(state, &aside).is_err() {
        let _ = fs::copy(state, &aside);
    }
    dlog!("state.json unreadable, kept as {}", aside.display());
    for b in list_backups_in(backups) {
        if let Some((layout, settings)) = read_nonempty(&backups.join(&b.name)) {
            // on disk right away: a crash before the first save must not find state.json missing
            let _ = write_atomic(state, &serialize(&layout, &settings));
            dlog!("state recovered from {}", b.name);
            return (layout, settings);
        }
    }
    (Value::Null, Value::Null)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        // on disk before the rename, or a power loss can leave a zero-filled state.json
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn serialize(layout: &Value, settings: &Value) -> Vec<u8> {
    serde_json::to_vec_pretty(&json!({ "layout": layout, "settings": settings })).unwrap_or_default()
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
        if g.layout.is_null() && g.settings.is_null() {
            return Ok(());
        }
        serialize(&g.layout, &g.settings)
    };
    if let Some(name) = write_backup(&backups_dir(), &bytes)? {
        dlog!("backup {name}");
    }
    Ok(())
}

/// Writes `bytes` as a new backup unless the newest one already holds exactly them, so restarts
/// without changes don't push the good backups out.
fn write_backup(dir: &Path, bytes: &[u8]) -> Result<Option<String>, String> {
    if let Some(newest) = list_backups_in(dir).first() {
        if fs::read(dir.join(&newest.name)).ok().as_deref() == Some(bytes) {
            return Ok(None);
        }
    }
    let name = format!("state-{}.json", util::now_ms());
    write_atomic(&dir.join(&name), bytes)?;
    prune_backups(dir);
    Ok(Some(name))
}

fn prune_backups(dir: &Path) {
    let mut list = list_backups_in(dir);
    if list.len() <= MAX_BACKUPS {
        return;
    }
    // list is newest first
    for b in list.drain(MAX_BACKUPS..) {
        let _ = fs::remove_file(dir.join(b.name));
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
    write_atomic(&state_path(), &serialize(&g.layout, &g.settings))
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
    list_backups_in(&backups_dir())
}

fn list_backups_in(dir: &Path) -> Vec<BackupInfo> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
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

/// Import / restore: a file with only a layout or only settings keeps the current other half.
fn apply_halves(g: &mut Inner, layout: Value, settings: Value) {
    if !layout.is_null() {
        g.layout = layout;
    }
    if !settings.is_null() {
        g.settings = settings;
    }
}

fn replace_state(layout: Value, settings: Value) -> Result<PersistedState, String> {
    let mut g = store().lock().map_err(|e| e.to_string())?;
    apply_halves(&mut g, layout, settings);
    persist(&mut g)?;
    Ok(PersistedState { layout: g.layout.clone(), settings: g.settings.clone() })
}

pub fn restore_backup(name: &str) -> Result<PersistedState, String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("geçersiz yedek adı".into());
    }
    let path = backups_dir().join(name);
    let (layout, settings) = read_nonempty(&path).ok_or("yedek okunamadı ya da boş")?;
    // keep the current state as a backup before overwriting it
    let _ = make_backup();
    replace_state(layout, settings)
}

pub fn export_state(path: &str) -> Result<(), String> {
    let bytes = {
        let g = store().lock().map_err(|e| e.to_string())?;
        serialize(&g.layout, &g.settings)
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

#[derive(Serialize, Clone, Debug)]
pub struct IconPack {
    pub name: String,
    /// lowercased file stem → stored media path
    pub map: BTreeMap<String, String>,
}

const PACK_EXTS: [&str; 3] = ["png", "ico", "svg"];
// the map lives in settings.json, which is re-sent to every window on each change
const PACK_MAX_ICONS: usize = 2000;
const PACK_MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const PACK_MAX_DEPTH: usize = 4;

fn safe_dir_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.') { c } else { '_' })
        .collect();
    let s = s.trim().trim_matches('.').trim();
    if s.is_empty() { "pack".into() } else { s.to_string() }
}

/// Copies the PNG / ICO / SVG files of `dir` (subfolders too) into `media\iconpacks\<name>\`.
/// One file per lowercased stem: SVG wins, otherwise the biggest file (usually the sharpest).
/// Importing a folder with the same name again replaces that pack.
pub fn import_icon_pack(dir: &str) -> Result<IconPack, String> {
    let src = Path::new(dir);
    if !src.is_dir() {
        return Err("klasör bulunamadı".into());
    }
    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "Simge paketi".into());

    let mut found: HashMap<String, (PathBuf, String, u64)> = HashMap::new();
    let mut stack = vec![(src.to_path_buf(), 0usize)];
    'walk: while let Some((d, depth)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            let p = e.path();
            if ft.is_dir() {
                if depth < PACK_MAX_DEPTH {
                    stack.push((p, depth + 1));
                }
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            if !PACK_EXTS.contains(&ext.as_str()) {
                continue;
            }
            let stem = p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            if stem.trim().is_empty() || size == 0 || size > PACK_MAX_FILE_BYTES {
                continue;
            }
            let rank = |ext: &str, size: u64| (ext == "svg", size);
            let better = found.get(&stem).map_or(true, |(_, oe, os)| rank(&ext, size) > rank(oe, *os));
            if better {
                if !found.contains_key(&stem) && found.len() >= PACK_MAX_ICONS {
                    break 'walk;
                }
                found.insert(stem, (p, ext, size));
            }
        }
    }
    if found.is_empty() {
        return Err("klasörde PNG, ICO ya da SVG dosyası yok".into());
    }

    // copy into a staging folder first: the source may be the pack folder itself
    let root = media_dir().join("iconpacks");
    let dest = root.join(safe_dir_name(&name));
    let staging = root.join(format!(".import-{}", util::now_ms()));
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let mut files = Vec::with_capacity(found.len());
    for (stem, (p, ext, _)) in found {
        let file = format!("{stem}.{ext}");
        if fs::copy(&p, staging.join(&file)).is_ok() {
            files.push((stem, file));
        }
    }
    if files.is_empty() {
        let _ = fs::remove_dir_all(&staging);
        return Err("simgeler kopyalanamadı".into());
    }
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| {
            let _ = fs::remove_dir_all(&staging);
            e.to_string()
        })?;
    }
    fs::rename(&staging, &dest).map_err(|e| e.to_string())?;
    let map = files
        .into_iter()
        .map(|(stem, file)| (stem, dest.join(file).to_string_lossy().to_string()))
        .collect();
    dlog!("icon pack {name}: {}", dest.display());
    Ok(IconPack { name, map })
}

pub fn export_theme(path: &str, theme: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(theme).map_err(|e| e.to_string())?;
    fs::write(path, bytes).map_err(|e| e.to_string())
}

pub fn import_theme(path: &str) -> Result<Value, String> {
    let len = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if len > 4 * 1024 * 1024 {
        return Err("dosya bir tema için fazla büyük".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| "dosya geçerli bir tema değil".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `<temp>\fe-store-test-<tag>-<pid>\` with an empty `backups\`, never the real app dir.
    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fe-store-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("backups")).unwrap();
        d
    }

    fn corrupt_files(d: &Path) -> Vec<PathBuf> {
        fs::read_dir(d)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("state.corrupt-"))
            .map(|e| e.path())
            .collect()
    }

    #[test]
    fn corrupt_state_is_set_aside_and_newest_valid_backup_used() {
        let d = temp_dir("corrupt");
        let (state, b) = (d.join("state.json"), d.join("backups"));
        fs::write(&state, [0u8; 64]).unwrap();
        fs::write(b.join("state-100.json"), serialize(&json!({ "n": 1 }), &Value::Null)).unwrap();
        fs::write(b.join("state-200.json"), serialize(&json!({ "n": 2 }), &json!({ "s": 2 }))).unwrap();
        fs::write(b.join("state-300.json"), b"{ broken").unwrap();
        fs::write(b.join("state-400.json"), serialize(&Value::Null, &Value::Null)).unwrap();

        let got = load_or_recover(&state, &b);
        assert_eq!(got, (json!({ "n": 2 }), json!({ "s": 2 })));
        assert_eq!(read_state_file(&state), Some(got));
        let aside = corrupt_files(&d);
        assert_eq!(aside.len(), 1);
        assert_eq!(fs::read(&aside[0]).unwrap(), vec![0u8; 64]);

        // nothing parses: empty, and the bad file is still kept
        let d2 = temp_dir("corrupt-nobackup");
        fs::write(d2.join("state.json"), b"").unwrap();
        assert_eq!(load_or_recover(&d2.join("state.json"), &d2.join("backups")), (Value::Null, Value::Null));
        assert_eq!(corrupt_files(&d2).len(), 1);
        fs::remove_dir_all(d).unwrap();
        fs::remove_dir_all(d2).unwrap();
    }

    #[test]
    fn no_backup_when_unchanged() {
        let d = temp_dir("backup");
        let b = d.join("backups");
        let bytes = serialize(&json!({ "n": 1 }), &json!({}));
        assert!(write_backup(&b, &bytes).unwrap().is_some());
        assert_eq!(write_backup(&b, &bytes).unwrap(), None);
        assert_eq!(list_backups_in(&b).len(), 1);
        std::thread::sleep(Duration::from_millis(5)); // backup names are millisecond timestamps
        assert!(write_backup(&b, &serialize(&json!({ "n": 2 }), &json!({}))).unwrap().is_some());
        assert_eq!(list_backups_in(&b).len(), 2);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn partial_import_keeps_the_other_half() {
        let mut g = Inner {
            layout: json!({ "l": 1 }),
            settings: json!({ "s": 1 }),
            dirty_since_backup: false,
            last_backup: Instant::now(),
        };
        apply_halves(&mut g, Value::Null, json!({ "s": 2 }));
        assert_eq!((&g.layout, &g.settings), (&json!({ "l": 1 }), &json!({ "s": 2 })));
        apply_halves(&mut g, json!({ "l": 2 }), Value::Null);
        assert_eq!((&g.layout, &g.settings), (&json!({ "l": 2 }), &json!({ "s": 2 })));
    }

    #[test]
    fn both_null_backup_is_refused() {
        let d = temp_dir("null");
        let p = d.join("backups").join("state-1.json");
        fs::write(&p, serialize(&Value::Null, &Value::Null)).unwrap();
        assert_eq!(read_nonempty(&p), None);
        fs::write(&p, br#"{ "layout": { "l": 1 } }"#).unwrap();
        assert_eq!(read_nonempty(&p), Some((json!({ "l": 1 }), Value::Null)));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn write_atomic_leaves_a_parsable_file() {
        let d = temp_dir("atomic");
        let p = d.join("state.json");
        fs::write(&p, b"old garbage").unwrap();
        write_atomic(&p, &serialize(&json!({ "l": 1 }), &json!({ "s": 1 }))).unwrap();
        assert_eq!(read_state_file(&p), Some((json!({ "l": 1 }), json!({ "s": 1 }))));
        assert!(!p.with_extension("json.tmp").exists());
        fs::remove_dir_all(d).unwrap();
    }
}
