//! "Windows ile başlat": a shortcut in the user's Startup folder. Nothing is written to the registry.

use std::path::PathBuf;

use windows::core::{Interface, HSTRING};
use windows::Win32::System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

use crate::util;

fn shortcut_path() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    Some(PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs\Startup\Folder Explorer.lnk"))
}

/// Creates (or refreshes) the Startup shortcut, or removes it.
pub fn set(enabled: bool) -> Result<(), String> {
    let Some(path) = shortcut_path() else { return Ok(()) };
    if !enabled {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let exe = exe.to_string_lossy().into_owned();
    util::run_sta(move || unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| e.message())?;
        link.SetPath(&HSTRING::from(exe.as_str())).map_err(|e| e.message())?;
        link.SetArguments(&HSTRING::from("--autostart")).map_err(|e| e.message())?;
        link.SetWorkingDirectory(&HSTRING::from(dir.as_str())).map_err(|e| e.message())?;
        let pf: IPersistFile = link.cast().map_err(|e| e.message())?;
        pf.Save(&HSTRING::from(path.to_string_lossy().as_ref()), true).map_err(|e| e.message())
    })?
}
