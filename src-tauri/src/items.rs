//! Desktop item enumeration and the file-system watcher.

use std::os::windows::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::mpsc::{RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::Emitter;
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, WPARAM};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
use windows::Win32::UI::Shell::{
    FOLDERID_RecycleBinFolder, IShellItem, SHChangeNotification_Lock, SHChangeNotification_Unlock, SHChangeNotifyEntry,
    SHChangeNotifyRegister, SHCreateItemFromParsingName, SHGetKnownFolderIDList, SHQueryRecycleBinW, SHCNE_ALLEVENTS,
    SHCNRF_InterruptLevel, SHCNRF_NewDelivery, SHCNRF_ShellLevel, SHQUERYRBINFO, SIGDN_NORMALDISPLAY,
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
const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;

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

fn mtime_ms(md: &std::fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Visible entries of `dir` with their metadata: `desktop.ini` and hidden files (with `skip_system`
/// also system files) left out.
fn visible_entries(dir: &str, skip_system: bool) -> Vec<(std::fs::DirEntry, std::fs::Metadata)> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let skip = FILE_ATTRIBUTE_HIDDEN | if skip_system { FILE_ATTRIBUTE_SYSTEM } else { 0 };
    rd.flatten()
        .filter(|e| !e.file_name().to_string_lossy().eq_ignore_ascii_case("desktop.ini"))
        .filter_map(|e| {
            let md = e.metadata().ok()?;
            (md.file_attributes() & skip == 0).then_some((e, md))
        })
        .collect()
}

fn entry_item(entry: &std::fs::DirEntry, md: &std::fs::Metadata, is_public: bool) -> DesktopItem {
    let file_name = entry.file_name().to_string_lossy().to_string();
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
    let modified = mtime_ms(md);
    let size = if is_dir { 0 } else { md.len() };
    let name = display_name(&path).unwrap_or_else(|| {
        if ext == ".lnk" || ext == ".url" {
            file_name.trim_end_matches(ext.as_str()).to_string()
        } else {
            file_name.clone()
        }
    });
    DesktopItem {
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
    }
}

fn list_dir(dir: &str, is_public: bool, out: &mut Vec<DesktopItem>) {
    for (entry, md) in visible_entries(dir, false) {
        out.push(entry_item(&entry, &md, is_public));
    }
}

/// A live folder's entries, newest first, at most `limit` (hidden and system files left out).
/// Display names come from the shell: needs an STA apartment (use `util::run_sta`).
pub fn list_folder_sta(dir: &str, limit: usize) -> Vec<DesktopItem> {
    let mut entries = visible_entries(dir, true);
    entries.sort_by_cached_key(|(_, md)| std::cmp::Reverse(mtime_ms(md)));
    entries.truncate(limit);
    entries.iter().map(|(e, md)| entry_item(e, md, false)).collect()
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

/// Watches both desktop folders (non-recursive) and the recycle bin state.
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

    start_recycle_watch();
}

// ---------------------------------------------------------------- Recycle Bin full / empty
//
// The shell reports changes of the Recycle Bin (`watch_recycle_bin`, registered by the desktop
// window's event thread); a check then follows a short debounce. A slow safety check covers anything
// it might not report, skipped while a game is in front.

static RECYCLE_TX: Mutex<Option<Sender<()>>> = Mutex::new(None);
const RECYCLE_SAFETY_CHECK: Duration = Duration::from_secs(60);

fn start_recycle_watch() {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    *RECYCLE_TX.lock().unwrap() = Some(tx);
    std::thread::Builder::new()
        .name("fe-recycle".into())
        .spawn(move || {
            let _com = util::ComApartment::sta();
            let mut last = recycle_bin_full();
            loop {
                let check = match rx.recv_timeout(RECYCLE_SAFETY_CHECK) {
                    Ok(()) => {
                        // one check for a burst of notifications (emptying sends one per item)
                        while rx.recv_timeout(Duration::from_millis(400)).is_ok() {}
                        true
                    }
                    Err(RecvTimeoutError::Timeout) => !crate::quiet::game_quiet(),
                    Err(RecvTimeoutError::Disconnected) => break,
                };
                if check {
                    let full = recycle_bin_full();
                    if full != last {
                        last = full;
                        emit_changed(Vec::new());
                    }
                }
            }
        })
        .ok();
}

/// Registers `hwnd` for the shell's change notifications of the Recycle Bin (message `msg`, new
/// delivery: pass both parameters to `on_recycle_notify`). Read-only and gone when we exit.
pub fn watch_recycle_bin(hwnd: HWND, msg: u32) {
    unsafe {
        let Ok(pidl) = SHGetKnownFolderIDList(&FOLDERID_RecycleBinFolder, 0, None) else {
            dlog!("recycle bin: no pidl");
            return;
        };
        // the pidl stays allocated for the life of the registration (= the process)
        let entry = SHChangeNotifyEntry { pidl, fRecursive: true.into() };
        let events = SHCNE_ALLEVENTS.0 as i32;
        let mut id = SHChangeNotifyRegister(
            hwnd,
            SHCNRF_ShellLevel | SHCNRF_InterruptLevel | SHCNRF_NewDelivery,
            events,
            msg,
            1,
            &entry,
        );
        if id == 0 {
            id = SHChangeNotifyRegister(hwnd, SHCNRF_ShellLevel | SHCNRF_NewDelivery, events, msg, 1, &entry);
        }
        dlog!("recycle bin notifications: {}", if id != 0 { "on" } else { "failed" });
    }
}

pub fn on_recycle_notify(wparam: WPARAM, lparam: LPARAM) {
    unsafe {
        let lock = SHChangeNotification_Lock(HANDLE(wparam.0 as *mut _), lparam.0 as u32, None, None);
        if !lock.is_invalid() {
            let _ = SHChangeNotification_Unlock(lock);
        }
    }
    if let Some(tx) = RECYCLE_TX.lock().unwrap().as_ref() {
        let _ = tx.send(());
    }
}
