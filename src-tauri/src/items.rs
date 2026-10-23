//! Desktop item enumeration and the file-system watcher.

use std::os::windows::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI8, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::Emitter;
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
use windows::Win32::UI::Shell::{
    IShellItem, SHCreateItemFromParsingName, SHQueryRecycleBinW, SHQUERYRBINFO, SIGDN_NORMALDISPLAY,
};

use crate::{dlog, util};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DesktopItem {
    pub id: String,
    pub kind: &'static str,
    pub path: String,
    pub parsing_name: String,
    pub name: String,
    pub ext: String,
    pub is_shortcut: bool,
    pub is_public: bool,
    pub modified: u64,
    pub size: u64,
    pub icon_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recycle_full: Option<bool>,
}

pub const RECYCLE_BIN: &str = "::{645FF040-5081-101B-9F08-00AA002F954E}";

/// (parsing name, visible when the registry value is missing)
const SYSTEM_ICONS: &[(&str, bool)] = &[
    ("::{20D04FE0-3AEA-1069-A2D8-08002B30309D}", false), // This PC
    ("::{59031a47-3f72-44a7-89c5-5595fe6b30ee}", false), // User's files
    ("::{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}", false), // Network
    (RECYCLE_BIN, true),                                  // Recycle Bin
    ("::{5399E694-6CE5-4D6C-8FCE-1D8870FDCBA0}", false), // Control Panel
];

const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;

/// Shell display name ("Belge" for "Belge.txt" when extensions are hidden, localized names, …).
pub fn display_name(parsing: &str) -> Option<String> {
    unsafe {
        let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(crate::shell::fs_norm(parsing)), None).ok()?;
        let p = item.GetDisplayName(SIGDN_NORMALDISPLAY).ok()?;
        let s = util::take_pwstr(p);
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

fn system_icon_visible(clsid_parsing: &str, default_visible: bool) -> bool {
    let clsid = clsid_parsing.trim_start_matches("::");
    let mut data: u32 = 0;
    let mut size: u32 = 4;
    let res = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\HideDesktopIcons\\NewStartPanel"),
            &HSTRING::from(clsid),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    if res.is_ok() {
        data == 0
    } else {
        default_visible
    }
}

pub fn recycle_bin_full() -> bool {
    let mut info = SHQUERYRBINFO { cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32, ..Default::default() };
    unsafe {
        if SHQueryRecycleBinW(PCWSTR::null(), &mut info).is_ok() {
            info.i64NumItems > 0
        } else {
            false
        }
    }
}

fn list_dir(dir: &str, is_public: bool, out: &mut Vec<DesktopItem>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.eq_ignore_ascii_case("desktop.ini") {
            continue;
        }
        let Ok(md) = entry.metadata() else { continue };
        if md.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0 {
            continue;
        }
        let path = entry.path().to_string_lossy().to_string();
        let is_dir = md.is_dir();
        let ext = if is_dir {
            String::new()
        } else {
            entry
                .path()
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
                .unwrap_or_default()
        };
        let modified = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let size = if is_dir { 0 } else { md.len() };
        let name = display_name(&path).unwrap_or_else(|| {
            if ext == ".lnk" || ext == ".url" {
                file_name.trim_end_matches(ext.as_str()).to_string()
            } else {
                file_name.clone()
            }
        });
        out.push(DesktopItem {
            id: path.to_lowercase(),
            kind: if is_dir { "folder" } else { "file" },
            parsing_name: path.clone(),
            path,
            name,
            is_shortcut: ext == ".lnk" || ext == ".url",
            ext,
            is_public,
            modified,
            size,
            icon_version: format!("{modified:x}-{size:x}"),
            recycle_full: None,
        });
    }
}

/// Needs an STA apartment on the calling thread (use `util::run_sta`).
pub fn list_desktop_items_sta() -> Vec<DesktopItem> {
    let mut out = Vec::new();
    for (clsid, default_visible) in SYSTEM_ICONS {
        if !system_icon_visible(clsid, *default_visible) {
            continue;
        }
        let name = display_name(clsid).unwrap_or_else(|| clsid.to_string());
        let (recycle_full, icon_version) = if *clsid == RECYCLE_BIN {
            let full = recycle_bin_full();
            (Some(full), if full { "full".to_string() } else { "empty".to_string() })
        } else {
            (None, "1".to_string())
        };
        out.push(DesktopItem {
            id: clsid.to_lowercase(),
            kind: "system",
            path: clsid.to_string(),
            parsing_name: clsid.to_string(),
            name,
            ext: String::new(),
            is_shortcut: false,
            is_public: false,
            modified: 0,
            size: 0,
            icon_version,
            recycle_full,
        });
    }
    let user = util::user_desktop_dir();
    let public = util::public_desktop_dir();
    list_dir(&user, false, &mut out);
    if !util::same_dir(&user, &public) {
        list_dir(&public, true, &mut out);
    }
    out
}

pub fn list_desktop_items() -> Result<Vec<DesktopItem>, String> {
    util::run_sta(list_desktop_items_sta)
}

#[derive(Serialize, Clone, Debug)]
pub struct Rename {
    pub from: String,
    pub to: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct DesktopChanged {
    pub renames: Vec<Rename>,
}

fn emit_changed(renames: Vec<Rename>) {
    if let Some(app) = util::app() {
        let _ = app.emit("desktop-changed", DesktopChanged { renames });
    }
}

/// Watches both desktop folders (non-recursive) and polls the recycle bin state.
pub fn start_watcher() {
    std::thread::Builder::new()
        .name("fe-watch".into())
        .spawn(|| {
            let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
            let mut watcher = match notify::recommended_watcher(tx) {
                Ok(w) => w,
                Err(e) => {
                    dlog!("watcher error: {e}");
                    return;
                }
            };
            let user = util::user_desktop_dir();
            let public = util::public_desktop_dir();
            let _ = watcher.watch(&PathBuf::from(&user), RecursiveMode::NonRecursive);
            if !util::same_dir(&user, &public) {
                let _ = watcher.watch(&PathBuf::from(&public), RecursiveMode::NonRecursive);
            }
            let mut renames: Vec<Rename> = Vec::new();
            let mut pending_from: Option<String> = None;
            let mut dirty = false;
            let mut first_event: Option<Instant> = None;
            loop {
                let timeout = if dirty { Duration::from_millis(250) } else { Duration::from_secs(3600) };
                match rx.recv_timeout(timeout) {
                    Ok(Ok(ev)) => {
                        dirty = true;
                        first_event.get_or_insert_with(Instant::now);
                        let lower = |p: &PathBuf| p.to_string_lossy().to_lowercase();
                        match ev.kind {
                            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if ev.paths.len() >= 2 => {
                                renames.push(Rename { from: lower(&ev.paths[0]), to: lower(&ev.paths[1]) });
                            }
                            EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
                                pending_from = ev.paths.first().map(lower);
                            }
                            EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
                                if let (Some(from), Some(to)) = (pending_from.take(), ev.paths.first()) {
                                    renames.push(Rename { from, to: lower(to) });
                                }
                            }
                            _ => {}
                        }
                        // Under constant churn still flush at least once per second.
                        if first_event.map(|t| t.elapsed() > Duration::from_secs(1)).unwrap_or(false) {
                            emit_changed(std::mem::take(&mut renames));
                            dirty = false;
                            first_event = None;
                        }
                    }
                    Ok(Err(e)) => dlog!("watch error: {e}"),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        if dirty {
                            emit_changed(std::mem::take(&mut renames));
                            dirty = false;
                            first_event = None;
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            drop(watcher);
        })
        .ok();

    // Recycle bin full/empty polling.
    std::thread::Builder::new()
        .name("fe-recycle".into())
        .spawn(|| {
            let _com = util::ComApartment::sta();
            static LAST: AtomicI8 = AtomicI8::new(-1);
            loop {
                let full = recycle_bin_full() as i8;
                let prev = LAST.swap(full, Ordering::SeqCst);
                if prev != -1 && prev != full {
                    emit_changed(Vec::new());
                }
                std::thread::sleep(Duration::from_secs(4));
            }
        })
        .ok();
}
