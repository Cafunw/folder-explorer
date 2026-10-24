//! Clean-up of what earlier versions of Folder Explorer wrote into Windows: a "Start with Windows"
//! Run value that points to our executable ("Windows ile başlat" is a Startup-folder shortcut now).
//! Anything that is not ours is left alone, and nothing is touched when nothing of ours is found.
//! The Yeni ▸ menu entry is not legacy any more; `shell_new` keeps it in step with the setting.

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{RegDeleteKeyValueW, RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};

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
        let ours = |s: &Option<String>| s.as_deref().map(|v| v.to_lowercase().contains("folder-explorer")).unwrap_or(false);
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
    }
    removed
}
