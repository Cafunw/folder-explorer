//! "Yeni grup oluştur" in Windows' Yeni ▸ menu (Explorer and Windows 11's own menu): the one
//! entry the app writes into Windows' shell, by the user's choice (`behavior.newMenuEntry`,
//! Ayarlar ▸ Davranış, on by default). Two per-user keys under HKCU\Software\Classes; turning the
//! setting off or uninstalling removes exactly those. Clicking it runs `--new-group`.

use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegGetValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
    KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ,
};
use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};

/// The entry in Explorer's native New submenu, including the desktop background menu.
pub const MENU_TEXT: &str = "Yeni grup oluştur";
const PROGID: &str = "FolderExplorer.Group";

const EXT_KEY: PCWSTR = w!("Software\\Classes\\.fegroup");
const SHELLNEW_KEY: PCWSTR = w!("Software\\Classes\\.fegroup\\ShellNew");
const PROGID_KEY: PCWSTR = w!("Software\\Classes\\FolderExplorer.Group");
const ICON_KEY: PCWSTR = w!("Software\\Classes\\FolderExplorer.Group\\DefaultIcon");

fn wide_bytes(s: &str) -> Vec<u8> {
    s.encode_utf16().chain(std::iter::once(0)).flat_map(|u| u.to_le_bytes()).collect()
}

unsafe fn set_str(key: PCWSTR, name: PCWSTR, value: &str) -> Result<(), String> {
    let mut h = HKEY::default();
    let rc = RegCreateKeyExW(HKEY_CURRENT_USER, key, None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_WRITE, None, &mut h, None);
    if rc != ERROR_SUCCESS {
        return Err(format!("key not created ({})", rc.0));
    }
    let rc = RegSetValueExW(h, name, None, REG_SZ, Some(&wide_bytes(value)));
    let _ = RegCloseKey(h);
    if rc != ERROR_SUCCESS {
        return Err(format!("value not written ({})", rc.0));
    }
    Ok(())
}

unsafe fn get_str(key: PCWSTR, name: PCWSTR) -> Option<String> {
    let mut size = 0u32;
    if RegGetValueW(HKEY_CURRENT_USER, key, name, RRF_RT_REG_SZ, None, None, Some(&mut size)) != ERROR_SUCCESS || size < 2 {
        return None;
    }
    let mut buf = vec![0u16; (size as usize).div_ceil(2)];
    let rc = RegGetValueW(HKEY_CURRENT_USER, key, name, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut size));
    (rc == ERROR_SUCCESS).then(|| String::from_utf16_lossy(&buf).trim_end_matches('\0').to_string())
}

/// Windows' own "file types changed" notice, so Explorer rebuilds its New menu.
fn notify() {
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
}

/// Make the registry match `enabled`. Writes nothing (and sends no notice) when it already does.
pub fn sync(enabled: bool) {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    if exe.is_empty() {
        return;
    }
    let command = format!("\"{exe}\" --new-group");
    let icon = format!("{exe},0");
    unsafe {
        let ext = get_str(EXT_KEY, PCWSTR::null());
        if enabled {
            let current = get_str(SHELLNEW_KEY, w!("Command")).as_deref() == Some(command.as_str())
                && get_str(SHELLNEW_KEY, w!("MenuText")).as_deref() == Some(MENU_TEXT)
                && get_str(PROGID_KEY, PCWSTR::null()).as_deref() == Some(MENU_TEXT)
                && ext.as_deref() == Some(PROGID);
            if current {
                return;
            }
            let written = set_str(EXT_KEY, PCWSTR::null(), PROGID)
                .and(set_str(SHELLNEW_KEY, w!("Command"), &command))
                .and(set_str(SHELLNEW_KEY, w!("MenuText"), MENU_TEXT))
                .and(set_str(SHELLNEW_KEY, w!("IconPath"), &icon))
                .and(set_str(PROGID_KEY, PCWSTR::null(), MENU_TEXT))
                .and(set_str(ICON_KEY, PCWSTR::null(), &icon));
            match written {
                Ok(()) => notify(),
                Err(e) => crate::dlog!("New-menu entry not written: {e}"),
            }
        } else if ext.is_some() || get_str(PROGID_KEY, PCWSTR::null()).is_some() {
            let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from("Software\\Classes\\.fegroup"));
            let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from("Software\\Classes\\FolderExplorer.Group"));
            notify();
        }
    }
}
