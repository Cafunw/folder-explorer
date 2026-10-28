//! "Start with Windows": a shortcut in the user's Startup folder. Nothing is written to the registry.

use std::path::{Path, PathBuf};

use windows::core::{Interface, HSTRING};
use windows::Win32::System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER, STGM_READ};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH};

use crate::util;

const ARGS: &str = "--autostart";

fn shortcut_path() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    Some(PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs\Startup\Folder Explorer.lnk"))
}

/// Creates the Startup shortcut, or removes it.
pub fn set(enabled: bool) -> Result<(), String> {
    let Some(path) = shortcut_path() else { return Ok(()) };
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    set_at(&path, enabled, &exe)
}

/// Runs on every settings save, so the shortcut is only written when it is missing or points
/// elsewhere: rewriting an autostart entry again and again looks like malware persistence to
/// antivirus behaviour monitoring (Defender flagged the app for it).
fn set_at(path: &Path, enabled: bool, exe: &Path) -> Result<(), String> {
    if !enabled {
        let _ = std::fs::remove_file(path);
        return Ok(());
    }
    let dir = exe.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let exe = exe.to_string_lossy().into_owned();
    let path = path.to_string_lossy().into_owned();
    util::run_sta(move || unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| e.message())?;
        let pf: IPersistFile = link.cast().map_err(|e| e.message())?;
        if pf.Load(&HSTRING::from(path.as_str()), STGM_READ).is_ok() {
            let mut target = [0u16; 1024];
            let mut args = [0u16; 512];
            let same = link.GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32).is_ok()
                && link.GetArguments(&mut args).is_ok()
                && util::norm_path(&util::wide_to_string(&target)) == util::norm_path(&exe)
                && util::wide_to_string(&args) == ARGS;
            if same {
                return Ok(());
            }
        }
        link.SetPath(&HSTRING::from(exe.as_str())).map_err(|e| e.message())?;
        link.SetArguments(&HSTRING::from(ARGS)).map_err(|e| e.message())?;
        link.SetWorkingDirectory(&HSTRING::from(dir.as_str())).map_err(|e| e.message())?;
        pf.Save(&HSTRING::from(path.as_str()), true).map_err(|e| e.message())
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shortcut_is_written_once_and_refreshed_when_the_exe_moves() {
        let dir = std::env::temp_dir().join(format!("fe-startup-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let lnk = dir.join("Folder Explorer.lnk");
        let exe = std::env::current_exe().unwrap();
        set_at(&lnk, true, &exe).unwrap();
        let first = std::fs::metadata(&lnk).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        set_at(&lnk, true, &exe).unwrap();
        assert_eq!(std::fs::metadata(&lnk).unwrap().modified().unwrap(), first, "unchanged shortcut rewritten");
        let other = dir.join("elsewhere.exe");
        set_at(&lnk, true, &other).unwrap();
        assert_ne!(std::fs::metadata(&lnk).unwrap().modified().unwrap(), first, "moved exe not picked up");
        set_at(&lnk, false, &exe).unwrap();
        assert!(!lnk.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
