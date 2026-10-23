//! Clean-up of what earlier versions of Folder Explorer wrote into Windows. The app no longer
//! writes to the registry at all (docs/ARCHITECTURE.md, "Core rule"); this only removes its old
//! entries, once, so that Windows is back to normal:
//!  * the "Yeni ▸ Grup" New-menu entry (`.fegroup` / `FolderExplorer.Group` under HKCU\Software\Classes)
//!  * a "Start with Windows" Run value that points to our executable
//! Anything that is not ours is left alone, and nothing is touched when nothing of ours is found.

use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegDeleteKeyValueW, RegDeleteTreeW, RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ,
};
use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};

fn read_str(key: PCWSTR, name: PCWSTR) -> Option<String> {
    unsafe {
        let mut size = 0u32;
        if RegGetValueW(HKEY_CURRENT_USER, key, name, RRF_RT_REG_SZ, None, None, Some(&mut size)) != ERROR_SUCCESS || size < 2 {
            return None;
        }
        let mut buf = vec![0u16; (size as usize + 1) / 2];
        let rc = RegGetValueW(HKEY_CURRENT_USER, key, name, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut size));
        (rc == ERROR_SUCCESS).then(|| String::from_utf16_lossy(&buf).trim_end_matches('\0').to_string())
    }
}

/// Runs the clean-up in the background (at every start; it does nothing when nothing of ours is found).
pub fn clean_up() {
    let _ = std::thread::Builder::new().name("fe-legacy".into()).spawn(|| {
        run();
    });
}

/// The clean-up itself; returns what it removed (for `--clean-legacy`).
pub fn run() -> Vec<&'static str> {
    let mut removed = Vec::new();
    unsafe {
        let mut notify = false;
        let ours = |s: &Option<String>| s.as_deref().map(|v| v.to_lowercase().contains("folder-explorer")).unwrap_or(false);

        let cmd = read_str(w!(r"Software\Classes\.fegroup\ShellNew"), w!("Command"));
        let ext = read_str(w!(r"Software\Classes\.fegroup"), PCWSTR::null());
        if ours(&cmd) || ext.as_deref() == Some("FolderExplorer.Group") {
            let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from(r"Software\Classes\.fegroup"));
            let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from(r"Software\Classes\FolderExplorer.Group"));
            removed.push("New-menu entry (.fegroup, FolderExplorer.Group)");
            notify = true;
        }

        let run = w!(r"Software\Microsoft\Windows\CurrentVersion\Run");
        if ours(&read_str(run, w!("Folder Explorer"))) {
            let _ = RegDeleteKeyValueW(HKEY_CURRENT_USER, run, w!("Folder Explorer"));
            let _ = RegDeleteKeyValueW(
                HKEY_CURRENT_USER,
                w!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"),
                w!("Folder Explorer"),
            );
            removed.push("Run value");
        }

        if notify {
            // Windows' own "file types changed" notice, so the New menu is rebuilt without our entry
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
        }
    }
    removed
}
