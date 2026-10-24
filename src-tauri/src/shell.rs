//! Shell operations: open, clipboard, file operations, recycle bin, OLE drag-out, Start-menu apps
//! and shortcut creation. The right-click menus are in `ctxmenu.rs`.

use std::collections::HashSet;
use std::ffi::c_void;
use std::path::Path;

use serde::Serialize;
use windows::core::{w, Interface, GUID, HSTRING, PCSTR, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, POINT, PROPERTYKEY, SIZE};
use windows::Win32::Graphics::Gdi::{DeleteObject, GetObjectW, BITMAP, HGDIOBJ};
use windows::Win32::System::Com::{CoCreateInstance, IDataObject, IPersistFile, CLSCTX_ALL, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Ole::{DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_MOVE};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_SHIFT};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    FileOperation, IContextMenu, IDragSourceHelper, IEnumShellItems,
    IFileOperation, IShellFolder, IShellItem, IShellItem2, IShellLinkW, ILFindLastID, ILFree,
    SHBindToParent, SHCreateItemFromParsingName, SHCreateShellItemArrayFromIDLists, SHDoDragDrop,
    SHGetKnownFolderItem, SHParseDisplayName, ShellExecuteExW, ShellLink, BHID_DataObject, BHID_EnumItems,
    BHID_SFUIObject, CMF_NORMAL, CMINVOKECOMMANDINFO,
    CMINVOKECOMMANDINFOEX, CMIC_MASK_PTINVOKE, FOFX_RECYCLEONDELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMMKDIR,
    FOF_RENAMEONCOLLISION, FOLDERID_AppsFolder, FOLDERID_RecycleBinFolder, KF_FLAG_DEFAULT,
    SEE_MASK_NOASYNC, SHDRAGIMAGE, SHELLEXECUTEINFOW, SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEEDITING,
    SIGDN_PARENTRELATIVEPARSING,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, CreatePopupMenu, DestroyMenu, GetAncestor, GetCursorPos, WindowFromPoint, ASFW_ANY,
    GA_ROOT, SW_SHOWNORMAL,
};

use crate::{desktop_window, icons, items, util};

const CMIC_MASK_UNICODE: u32 = 0x0000_4000;
const CMIC_MASK_FLAG_NO_UI: u32 = 0x0000_0400;
const CMIC_MASK_SHIFT_DOWN: u32 = 0x1000_0000;
const CMIC_MASK_CONTROL_DOWN: u32 = 0x4000_0000;
const CLSID_DRAG_DROP_HELPER: GUID = GUID::from_u128(0x4657278a_411b_11d2_839a_00c04fd918d0);
const PKEY_DELETED_FROM: PROPERTYKEY =
    PROPERTYKEY { fmtid: GUID::from_u128(0x9b174b33_40ff_11d2_a27e_00c04fc30871), pid: 2 };
const PKEY_DATE_DELETED: PROPERTYKEY =
    PROPERTYKEY { fmtid: GUID::from_u128(0x9b174b33_40ff_11d2_a27e_00c04fc30871), pid: 3 };

/// Owned absolute PIDL.
pub(crate) struct Pidl(pub(crate) *mut ITEMIDLIST);

impl Drop for Pidl {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { ILFree(Some(self.0)) };
        }
    }
}

/// Shell parsing APIs reject forward slashes in file-system paths.
pub fn fs_norm(path: &str) -> String {
    let b = path.as_bytes();
    let is_fs = (b.len() > 2 && b[1] == b':') || path.starts_with("\\\\") || path.starts_with("//");
    if is_fs {
        path.replace('/', "\\")
    } else {
        path.to_string()
    }
}

pub(crate) fn parse_pidl(path: &str) -> Result<Pidl, String> {
    let path = &fs_norm(path);
    let mut p: *mut ITEMIDLIST = std::ptr::null_mut();
    unsafe {
        SHParseDisplayName(&HSTRING::from(path), None, &mut p, 0, None).map_err(|e| format!("{path}: {}", e.message()))?;
    }
    Ok(Pidl(p))
}

pub(crate) fn parent_key(path: &str) -> String {
    if path.starts_with("::") {
        "::desktop".into()
    } else {
        util::norm_path(&util::parent_dir(path))
    }
}

fn modifier_mask() -> u32 {
    unsafe {
        let mut m = 0;
        if GetKeyState(VK_SHIFT.0 as i32) < 0 {
            m |= CMIC_MASK_SHIFT_DOWN;
        }
        if GetKeyState(VK_CONTROL.0 as i32) < 0 {
            m |= CMIC_MASK_CONTROL_DOWN;
        }
        m
    }
}

pub(crate) unsafe fn invoke_id(cm: &IContextMenu, id: usize, hwnd: HWND, pt: POINT) -> Result<(), String> {
    let mut info: CMINVOKECOMMANDINFOEX = std::mem::zeroed();
    info.cbSize = std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32;
    info.fMask = CMIC_MASK_UNICODE | CMIC_MASK_PTINVOKE | modifier_mask();
    info.hwnd = hwnd;
    info.lpVerb = PCSTR(id as *const u8);
    info.lpVerbW = PCWSTR(id as *const u16);
    info.nShow = SW_SHOWNORMAL.0;
    info.ptInvoke = pt;
    cm.InvokeCommand(&info as *const _ as *const CMINVOKECOMMANDINFO).map_err(|e| e.message())
}

unsafe fn invoke_verb(cm: &IContextMenu, verb_a: &'static [u8], verb_w: PCWSTR, hwnd: HWND) -> Result<(), String> {
    let mut info: CMINVOKECOMMANDINFOEX = std::mem::zeroed();
    info.cbSize = std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32;
    info.fMask = CMIC_MASK_UNICODE | CMIC_MASK_FLAG_NO_UI;
    info.hwnd = hwnd;
    info.lpVerb = PCSTR(verb_a.as_ptr());
    info.lpVerbW = verb_w;
    info.nShow = SW_SHOWNORMAL.0;
    cm.InvokeCommand(&info as *const _ as *const CMINVOKECOMMANDINFO).map_err(|e| e.message())
}

// ---------------------------------------------------------------------------

/// ShellExecuteEx of `path` (a file, folder, "::{CLSID}" system item or URI such as
/// "ms-settings:display") with `verb` (None = the default one).
fn execute(path: &str, verb: Option<&str>, params: Option<&str>) -> Result<(), String> {
    let hwnd_v = desktop_window::desktop_hwnd_value();
    let (path, verb, params) = (path.to_string(), verb.map(str::to_string), params.map(str::to_string));
    util::run_sta(move || unsafe {
        let _ = AllowSetForegroundWindow(ASFW_ANY);
        let file = if path.starts_with("::") { format!("shell:{path}") } else { fs_norm(&path) };
        let file_w = HSTRING::from(file.as_str());
        let dir = if Path::new(&path).is_absolute() { util::parent_dir(&path) } else { String::new() };
        let dir_w = HSTRING::from(dir.as_str());
        let verb_w = verb.as_deref().map(HSTRING::from);
        let params_w = params.as_deref().map(HSTRING::from);
        let mut sei: SHELLEXECUTEINFOW = std::mem::zeroed();
        sei.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        sei.fMask = SEE_MASK_NOASYNC;
        sei.hwnd = util::hwnd_from(hwnd_v);
        sei.lpFile = PCWSTR(file_w.as_ptr());
        sei.lpVerb = verb_w.as_ref().map(|v| PCWSTR(v.as_ptr())).unwrap_or(PCWSTR::null());
        sei.lpParameters = params_w.as_ref().map(|v| PCWSTR(v.as_ptr())).unwrap_or(PCWSTR::null());
        sei.lpDirectory = if dir.is_empty() { PCWSTR::null() } else { PCWSTR(dir_w.as_ptr()) };
        sei.nShow = SW_SHOWNORMAL.0;
        ShellExecuteExW(&mut sei).map_err(|e| e.message())
    })?
}

pub fn open_item(path: String) -> Result<(), String> {
    execute(&path, None, None)
}

/// The first of `verbs` that works ("opennewtab", "opennewwindow"…), else the default verb.
pub fn open_with_verb(path: String, verbs: Vec<String>) -> Result<(), String> {
    for v in &verbs {
        if execute(&path, Some(v), None).is_ok() {
            return Ok(());
        }
    }
    execute(&path, None, None)
}

/// "Terminalde Aç": Windows Terminal in `dir` (the console host when Terminal is missing).
pub fn open_terminal(dir: String) -> Result<(), String> {
    let quoted = format!("-d \"{}\"", dir.trim_end_matches('\\'));
    execute("wt.exe", None, Some(&quoted)).or_else(|_| {
        let cmd = format!("/k cd /d \"{dir}\"");
        execute("cmd.exe", None, Some(&cmd))
    })
}

/// Whether Windows Terminal is installed (its "Terminalde Aç" entry is shown only then).
pub fn has_terminal() -> bool {
    std::env::var("LOCALAPPDATA")
        .map(|d| Path::new(&d).join("Microsoft\\WindowsApps\\wt.exe").exists())
        .unwrap_or(false)
}

/// Windows Terminal's exe, whose icon Windows shows next to "Terminalde Aç" (the Start-menu item's
/// logo has a transparent margin and looks too small). Found through the package repository
/// (read-only).
pub fn terminal_app() -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ, RRF_RT_REG_SZ,
    };
    const PACKAGES: PCWSTR =
        w!("Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages");
    unsafe {
        let mut key = HKEY::default();
        if RegOpenKeyExW(HKEY_CURRENT_USER, PACKAGES, Some(0), KEY_READ, &mut key) != ERROR_SUCCESS {
            return None;
        }
        let mut names = Vec::new();
        for i in 0.. {
            let mut name = [0u16; 256];
            let mut len = name.len() as u32;
            if RegEnumKeyExW(key, i, Some(PWSTR(name.as_mut_ptr())), &mut len, None, None, None, None) != ERROR_SUCCESS {
                break;
            }
            names.push(String::from_utf16_lossy(&name[..len as usize]));
        }
        let mut found = None;
        'families: for family in ["Microsoft.WindowsTerminal_", "Microsoft.WindowsTerminalPreview_"] {
            // newest version last
            for n in names.iter().rev().filter(|n| n.starts_with(family) && n.ends_with("__8wekyb3d8bbwe")) {
                let mut buf = vec![0u16; 1024];
                let mut size = (buf.len() * 2) as u32;
                let rc = RegGetValueW(key, &HSTRING::from(n.as_str()), w!("PackageRootFolder"), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut size));
                if rc != ERROR_SUCCESS {
                    continue;
                }
                let root = String::from_utf16_lossy(&buf[..size as usize / 2]);
                let exe = Path::new(root.trim_end_matches('\0')).join("WindowsTerminal.exe");
                if exe.exists() {
                    found = Some(exe.to_string_lossy().into_owned());
                    break 'families;
                }
            }
        }
        let _ = RegCloseKey(key);
        found
    }
}

/// Files on the clipboard (CF_HDROP) and whether they were cut.
pub fn clipboard_paths() -> Result<(Vec<String>, bool), String> {
    use windows::Win32::System::Com::{DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
    use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows::Win32::System::Ole::{OleGetClipboard, OleInitialize, ReleaseStgMedium, CF_HDROP};
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
    util::run_sta(move || unsafe {
        OleInitialize(None).map_err(|e| e.message())?;
        let dobj = OleGetClipboard().map_err(|e| e.message())?;
        let fmt = |cf: u16| FORMATETC {
            cfFormat: cf,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        let mut paths = Vec::new();
        if let Ok(mut m) = dobj.GetData(&fmt(CF_HDROP.0)) {
            let hdrop = HDROP(m.u.hGlobal.0);
            let n = DragQueryFileW(hdrop, u32::MAX, None);
            for i in 0..n {
                let len = DragQueryFileW(hdrop, i, None) as usize;
                let mut buf = vec![0u16; len + 1];
                DragQueryFileW(hdrop, i, Some(&mut buf));
                paths.push(util::wide_to_string(&buf));
            }
            ReleaseStgMedium(&mut m);
        }
        let mut cut = false;
        let effect = RegisterClipboardFormatW(w!("Preferred DropEffect"));
        if let Ok(mut m) = dobj.GetData(&fmt(effect as u16)) {
            let p = GlobalLock(m.u.hGlobal) as *const u32;
            if !p.is_null() {
                cut = (*p & DROPEFFECT_MOVE.0) != 0 && (*p & DROPEFFECT_COPY.0) == 0;
                let _ = GlobalUnlock(m.u.hGlobal);
            }
            ReleaseStgMedium(&mut m);
        }
        Ok((paths, cut))
    })?
}

pub fn can_paste() -> bool {
    use windows::Win32::System::DataExchange::IsClipboardFormatAvailable;
    use windows::Win32::System::Ole::CF_HDROP;
    unsafe { IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_ok() }
}

/// "Yapıştır" on the desktop: the clipboard's files are copied, or moved after "Kes". With
/// `shortcuts` ("Kısayol yapıştır") shortcuts to them are created instead. Returns the new paths.
pub fn paste(shortcuts: bool) -> Result<Vec<String>, String> {
    let (paths, cut) = clipboard_paths()?;
    if paths.is_empty() {
        return Ok(vec![]);
    }
    if shortcuts {
        let desktop = util::user_desktop_dir();
        return Ok(paths
            .iter()
            .filter_map(|p| {
                let name = Path::new(p).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                create_shortcut_in(desktop.clone(), p.clone(), format!("{name} - Kısayol")).ok()
            })
            .collect());
    }
    transfer(paths, if cut { Transfer::Move } else { Transfer::Copy })
}

/// Explorer's Copy / Cut: puts the files on the clipboard (cut = "Preferred DropEffect" move). This uses
/// the shell's data object only, no context-menu extensions, so it is instant.
pub fn clipboard_files(paths: Vec<String>, cut: bool) -> Result<(), String> {
    use windows::Win32::System::Com::{FORMATETC, STGMEDIUM, STGMEDIUM_0, DVASPECT_CONTENT, TYMED_HGLOBAL};
    use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::{OleFlushClipboard, OleInitialize, OleSetClipboard};
    util::run_sta(move || unsafe {
        let pidls: Vec<(String, Pidl)> = paths
            .iter()
            .filter_map(|p| parse_pidl(p).ok().map(|pidl| (p.clone(), pidl)))
            .collect();
        let Some((first_path, first)) = pidls.first() else {
            return Err("öğe bulunamadı".to_string());
        };
        let mut last: *mut ITEMIDLIST = std::ptr::null_mut();
        let folder: IShellFolder = SHBindToParent(first.0, Some(&mut last)).map_err(|e| e.message())?;
        let key = parent_key(first_path);
        let mut children: Vec<*const ITEMIDLIST> = vec![last as *const _];
        for (p, pidl) in pidls.iter().skip(1) {
            if parent_key(p) == key {
                children.push(ILFindLastID(pidl.0) as *const _);
            }
        }
        let dobj: IDataObject = folder.GetUIObjectOf(HWND::default(), &children, None).map_err(|e| e.message())?;
        if cut {
            let fmt = RegisterClipboardFormatW(w!("Preferred DropEffect"));
            let hmem = GlobalAlloc(GMEM_MOVEABLE, 4).map_err(|e| e.message())?;
            *(GlobalLock(hmem) as *mut u32) = DROPEFFECT_MOVE.0;
            let _ = GlobalUnlock(hmem);
            let fe = FORMATETC {
                cfFormat: fmt as u16,
                ptd: std::ptr::null_mut(),
                dwAspect: DVASPECT_CONTENT.0 as u32,
                lindex: -1,
                tymed: TYMED_HGLOBAL.0 as u32,
            };
            let medium = STGMEDIUM {
                tymed: TYMED_HGLOBAL.0 as u32,
                u: STGMEDIUM_0 { hGlobal: hmem },
                pUnkForRelease: std::mem::ManuallyDrop::new(None),
            };
            dobj.SetData(&fe, &medium, true).map_err(|e| e.message())?;
        }
        OleInitialize(None).map_err(|e| e.message())?;
        OleSetClipboard(&dobj).map_err(|e| e.message())?;
        // render now: this thread ends right after, and delayed rendering would die with it
        OleFlushClipboard().map_err(|e| e.message())
    })?
}

/// Plain text to the clipboard ("Yol olarak kopyala").
pub fn copy_text(text: String) -> Result<(), String> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    unsafe {
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let hmem = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2).map_err(|e| e.message())?;
        std::ptr::copy_nonoverlapping(wide.as_ptr(), GlobalLock(hmem) as *mut u16, wide.len());
        let _ = GlobalUnlock(hmem);
        OpenClipboard(None).map_err(|e| e.message())?;
        let _ = EmptyClipboard();
        let r = SetClipboardData(13, Some(HANDLE(hmem.0))); // CF_UNICODETEXT
        let _ = CloseClipboard();
        r.map(|_| ()).map_err(|e| e.message())
    }
}

/// The file's Properties window (shows itself on its own thread).
pub fn show_properties(path: String) -> Result<(), String> {
    use windows::Win32::UI::Shell::{SHObjectProperties, SHOP_FILEPATH};
    unsafe {
        let ok = SHObjectProperties(Some(desktop_window::desktop_hwnd()), SHOP_FILEPATH, &HSTRING::from(fs_norm(&path)), PCWSTR::null());
        if ok.as_bool() {
            Ok(())
        } else {
            Err("özellikler açılamadı".into())
        }
    }
}

/// "Yönetici olarak çalıştır" (the UAC prompt appears as usual).
pub fn run_as_admin(path: String) -> Result<(), String> {
    util::run_sta(move || unsafe {
        let file = HSTRING::from(fs_norm(&path));
        let dir = HSTRING::from(util::parent_dir(&path));
        let mut sei: SHELLEXECUTEINFOW = std::mem::zeroed();
        sei.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        sei.lpVerb = w!("runas");
        sei.lpFile = PCWSTR(file.as_ptr());
        sei.lpDirectory = PCWSTR(dir.as_ptr());
        sei.nShow = SW_SHOWNORMAL.0;
        ShellExecuteExW(&mut sei).map_err(|e| e.message())
    })?
}

fn file_op() -> Result<IFileOperation, String> {
    unsafe {
        let op: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL).map_err(|e| e.message())?;
        let h = desktop_window::desktop_hwnd_value();
        if h != 0 {
            let _ = op.SetOwnerWindow(util::hwnd_from(h));
        }
        Ok(op)
    }
}

fn shell_item(path: &str) -> Result<IShellItem, String> {
    let path = &fs_norm(path);
    unsafe { SHCreateItemFromParsingName(&HSTRING::from(path), None).map_err(|e| format!("{path}: {}", e.message())) }
}

fn perform(op: &IFileOperation) -> Result<(), String> {
    unsafe {
        op.PerformOperations().map_err(|e| e.message())?;
        if op.GetAnyOperationsAborted().map(|b| b.as_bool()).unwrap_or(false) {
            return Err("işlem iptal edildi".into());
        }
    }
    Ok(())
}

pub fn recycle(paths: Vec<String>) -> Result<(), String> {
    util::run_sta(move || unsafe {
        let op = file_op()?;
        op.SetOperationFlags(FOF_ALLOWUNDO | FOFX_RECYCLEONDELETE).map_err(|e| e.message())?;
        let mut any = false;
        for p in &paths {
            if p.starts_with("::") {
                continue;
            }
            let item = shell_item(p)?;
            op.DeleteItem(&item, None).map_err(|e| e.message())?;
            any = true;
        }
        if any {
            perform(&op)
        } else {
            Ok(())
        }
    })?
}

pub fn restore_from_recycle(paths: Vec<String>) -> Result<Vec<String>, String> {
    util::run_sta(move || unsafe {
        struct Target {
            dir: String,
            name: String,
            stem: String,
            path: String,
        }
        let targets: Vec<Target> = paths
            .iter()
            .map(|p| {
                let pp = Path::new(p);
                Target {
                    dir: util::norm_path(&util::parent_dir(p)),
                    name: pp.file_name().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default(),
                    stem: pp.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default(),
                    path: p.clone(),
                }
            })
            .collect();
        let bin: IShellItem =
            SHGetKnownFolderItem(&FOLDERID_RecycleBinFolder, KF_FLAG_DEFAULT, None).map_err(|e| e.message())?;
        let en: IEnumShellItems = bin.BindToHandler(None, &BHID_EnumItems).map_err(|e| e.message())?;
        let mut best: Vec<Option<(IShellItem, u64)>> = (0..targets.len()).map(|_| None).collect();
        loop {
            let mut arr: [Option<IShellItem>; 1] = [None];
            let mut fetched = 0u32;
            if en.Next(&mut arr, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            let Some(item) = arr[0].take() else { break };
            let Ok(i2) = item.cast::<IShellItem2>() else { continue };
            let from = i2.GetString(&PKEY_DELETED_FROM).map(|p| util::take_pwstr(p)).unwrap_or_default();
            let from = util::norm_path(&from);
            // NORMALDISPLAY is the full original path; PARENTRELATIVEEDITING the original name
            // (without the extension when extensions are hidden).
            let disp = item
                .GetDisplayName(SIGDN_NORMALDISPLAY)
                .map(|p| util::take_pwstr(p))
                .unwrap_or_default()
                .to_lowercase();
            let edit = item
                .GetDisplayName(SIGDN_PARENTRELATIVEEDITING)
                .map(|p| util::take_pwstr(p))
                .unwrap_or_default()
                .to_lowercase();
            let when = i2
                .GetFileTime(&PKEY_DATE_DELETED)
                .map(|ft| ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64)
                .unwrap_or(0);
            for (i, t) in targets.iter().enumerate() {
                let full = util::norm_path(&t.path);
                let matches = util::norm_path(&disp) == full
                    || (from == t.dir && (edit == t.name || edit == t.stem || disp == t.name || disp == t.stem));
                if matches {
                    let newer = best[i].as_ref().map(|(_, w)| when >= *w).unwrap_or(true);
                    if newer {
                        best[i] = Some((item.clone(), when));
                    }
                }
            }
        }
        let mut restored = Vec::new();
        for (i, b) in best.into_iter().enumerate() {
            let Some((item, _)) = b else { continue };
            let Ok(cm) = item.BindToHandler::<_, IContextMenu>(None, &BHID_SFUIObject) else { continue };
            if let Ok(menu) = CreatePopupMenu() {
                let _ = cm.QueryContextMenu(menu, 0, 1, 0x7FFF, CMF_NORMAL);
                let r = invoke_verb(&cm, b"undelete\0", w!("undelete"), HWND::default());
                let _ = DestroyMenu(menu);
                if r.is_ok() && Path::new(&targets[i].path).exists() {
                    restored.push(targets[i].path.clone());
                }
            }
        }
        Ok(restored)
    })?
}

/// Debug helper: the most recently deleted recycle-bin entries.
pub fn dump_recycle(limit: usize) -> Vec<String> {
    unsafe {
        let mut rows: Vec<(u64, String)> = Vec::new();
        let Ok(bin) = SHGetKnownFolderItem::<IShellItem>(&FOLDERID_RecycleBinFolder, KF_FLAG_DEFAULT, None) else { return vec![] };
        let Ok(en) = bin.BindToHandler::<_, IEnumShellItems>(None, &BHID_EnumItems) else { return vec![] };
        loop {
            let mut arr: [Option<IShellItem>; 1] = [None];
            let mut fetched = 0u32;
            if en.Next(&mut arr, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            let Some(item) = arr[0].take() else { break };
            let Ok(i2) = item.cast::<IShellItem2>() else { continue };
            let from = i2.GetString(&PKEY_DELETED_FROM).map(|p| util::take_pwstr(p)).map_err(|e| e.message());
            let disp = item.GetDisplayName(SIGDN_NORMALDISPLAY).map(|p| util::take_pwstr(p)).unwrap_or_default();
            let edit = item.GetDisplayName(SIGDN_PARENTRELATIVEEDITING).map(|p| util::take_pwstr(p)).unwrap_or_default();
            let when = i2.GetFileTime(&PKEY_DATE_DELETED).map(|ft| ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64);
            rows.push((when.clone().unwrap_or(0), format!("from={from:?} disp={disp:?} edit={edit:?} when={when:?}")));
        }
        rows.sort_by(|a, b| b.0.cmp(&a.0));
        rows.into_iter().take(limit).map(|r| r.1).collect()
    }
}

fn invalid_name(name: &str) -> bool {
    name.is_empty()
        || name == "."
        || name == ".."
        || name.chars().any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 32)
}

pub fn rename_item(path: String, new_name: String) -> Result<String, String> {
    let path = fs_norm(&path);
    let new_name = new_name.trim().trim_end_matches(['.', ' ']).to_string();
    if invalid_name(&new_name) {
        return Err("Dosya adı şu karakterleri içeremez: \\ / : * ? \" < > |".into());
    }
    if path.starts_with("::") {
        return Err("sistem öğeleri yeniden adlandırılamaz".into());
    }
    util::run_sta(move || unsafe {
        let p = Path::new(&path);
        let file_name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let is_dir = p.is_dir();
        let ext = if is_dir {
            String::new()
        } else {
            p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default()
        };
        let display = items::display_name(&path).unwrap_or_else(|| file_name.clone());
        let ext_hidden = !ext.is_empty() && !display.to_lowercase().ends_with(&ext.to_lowercase());
        let new_file = if ext_hidden { format!("{new_name}{ext}") } else { new_name.clone() };
        if new_file == file_name {
            return Ok(path.clone());
        }
        let op = file_op()?;
        op.SetOperationFlags(FOF_ALLOWUNDO).map_err(|e| e.message())?;
        let item = shell_item(&path)?;
        op.RenameItem(&item, &HSTRING::from(new_file.as_str()), None).map_err(|e| e.message())?;
        perform(&op)?;
        let new_path = Path::new(&util::parent_dir(&path)).join(&new_file).to_string_lossy().to_string();
        Ok(new_path)
    })?
}

pub fn move_into_folder(paths: Vec<String>, target_dir: String) -> Result<(), String> {
    util::run_sta(move || unsafe {
        let op = file_op()?;
        op.SetOperationFlags(FOF_ALLOWUNDO | FOF_NOCONFIRMMKDIR).map_err(|e| e.message())?;
        let dest = shell_item(&target_dir)?;
        let target_norm = util::norm_path(&target_dir);
        let mut any = false;
        for p in &paths {
            if p.starts_with("::") || util::norm_path(p) == target_norm {
                continue;
            }
            let item = shell_item(p)?;
            op.MoveItem(&item, &dest, PCWSTR::null(), None).map_err(|e| e.message())?;
            any = true;
        }
        if any {
            perform(&op)
        } else {
            Ok(())
        }
    })?
}

/// Like `move_into_folder`, but copies (a drop from another volume or with Ctrl).
pub fn copy_into_folder(paths: Vec<String>, target_dir: String) -> Result<(), String> {
    util::run_sta(move || unsafe {
        let op = file_op()?;
        op.SetOperationFlags(FOF_ALLOWUNDO | FOF_NOCONFIRMMKDIR).map_err(|e| e.message())?;
        let dest = shell_item(&target_dir)?;
        let target_norm = util::norm_path(&target_dir);
        let mut any = false;
        for p in &paths {
            if p.starts_with("::") || util::norm_path(p) == target_norm {
                continue;
            }
            let item = shell_item(p)?;
            op.CopyItem(&item, &dest, PCWSTR::null(), None).map_err(|e| e.message())?;
            any = true;
        }
        if any {
            perform(&op)
        } else {
            Ok(())
        }
    })?
}

fn volume_of(p: &str) -> String {
    let n = p.replace('/', "\\").to_lowercase();
    if let Some(rest) = n.strip_prefix("\\\\") {
        // UNC: \\server\share
        let mut parts = rest.split('\\');
        format!("\\\\{}\\{}", parts.next().unwrap_or(""), parts.next().unwrap_or(""))
    } else {
        n.chars().take(2).collect()
    }
}

fn dir_names(dir: &str) -> HashSet<String> {
    std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect())
        .unwrap_or_default()
}

/// How files come onto the desktop.
#[derive(Clone, Copy, PartialEq)]
pub enum Transfer {
    /// a drop from another app: moved on the same volume, else copied (`copy` forces a copy)
    Drop { copy: bool },
    /// "Yapıştır" after "Kopyala": always a copy, items already on the desktop get " - Kopya"
    Copy,
    /// "Yapıştır" after "Kes"
    Move,
}

/// Copies (or moves, Explorer-style on the same volume) external files onto the user desktop.
pub fn import_dropped(paths: Vec<String>, copy: bool) -> Result<Vec<String>, String> {
    transfer(paths, Transfer::Drop { copy })
}

/// Puts `paths` onto the user desktop. Returns the resulting paths, in order.
pub fn transfer(paths: Vec<String>, mode: Transfer) -> Result<Vec<String>, String> {
    let desktop = util::user_desktop_dir();
    let public = util::public_desktop_dir();
    util::run_sta(move || unsafe {
        let mut result: Vec<Option<String>> = Vec::new();
        let mut pending: Vec<(usize, String)> = Vec::new();
        let op = file_op()?;
        op.SetOperationFlags(FOF_ALLOWUNDO | FOF_RENAMEONCOLLISION | FOF_NOCONFIRMMKDIR).map_err(|e| e.message())?;
        let dest = shell_item(&desktop)?;
        let before = dir_names(&desktop);
        for p in &paths {
            let parent = util::parent_dir(p);
            let on_desktop = util::same_dir(&parent, &desktop) || util::same_dir(&parent, &public);
            if on_desktop && mode != Transfer::Copy {
                result.push(Some(p.clone()));
                continue;
            }
            let item = shell_item(p)?;
            let do_copy = match mode {
                Transfer::Drop { copy } => copy || volume_of(p) != volume_of(&desktop),
                Transfer::Copy => true,
                Transfer::Move => false,
            };
            if do_copy {
                op.CopyItem(&item, &dest, PCWSTR::null(), None).map_err(|e| e.message())?;
            } else {
                op.MoveItem(&item, &dest, PCWSTR::null(), None).map_err(|e| e.message())?;
            }
            pending.push((result.len(), p.clone()));
            result.push(None);
        }
        if !pending.is_empty() {
            perform(&op)?;
            let after = dir_names(&desktop);
            let mut fresh: Vec<String> = after.difference(&before).cloned().collect();
            for (idx, src) in &pending {
                let sp = Path::new(src);
                let name = sp.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                let stem = sp.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
                let ext = sp.extension().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
                let pick = fresh
                    .iter()
                    .position(|f| f.eq_ignore_ascii_case(&name))
                    .or_else(|| {
                        fresh.iter().position(|f| {
                            let fp = Path::new(f);
                            fp.file_stem().map(|s| s.to_string_lossy().to_lowercase().starts_with(&stem)).unwrap_or(false)
                                && fp.extension().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default() == ext
                        })
                    });
                let chosen = match pick {
                    Some(i) => fresh.remove(i),
                    None => name,
                };
                result[*idx] = Some(Path::new(&desktop).join(chosen).to_string_lossy().to_string());
            }
        }
        Ok(result.into_iter().flatten().collect())
    })?
}

/// Native OLE drag of desktop items into other applications. Must run on the UI thread.
pub fn drag_out_main(paths: Vec<String>) -> Result<String, String> {
    let hwnd = desktop_window::desktop_hwnd();
    unsafe {
        let data = files_data_object(&paths)?;
        if let Ok(helper) = CoCreateInstance::<_, IDragSourceHelper>(&CLSID_DRAG_DROP_HELPER, None, CLSCTX_INPROC_SERVER) {
            if let Ok(hbmp) = icons::shell_bitmap(&paths[0], 96) {
                let mut bm = BITMAP::default();
                GetObjectW(HGDIOBJ(hbmp.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut c_void));
                let (w, h) = (bm.bmWidth.max(1), bm.bmHeight.abs().max(1));
                let shdi = SHDRAGIMAGE {
                    sizeDragImage: SIZE { cx: w, cy: h },
                    ptOffset: POINT { x: w / 2, y: h / 2 },
                    hbmpDragImage: hbmp,
                    crColorKey: COLORREF(0xFFFF_FFFF),
                };
                if helper.InitializeFromBitmap(&shdi, &data).is_err() {
                    let _ = DeleteObject(HGDIOBJ(hbmp.0));
                }
            }
        }
        let effect = SHDoDragDrop(
            Some(hwnd),
            &data,
            None::<&windows::Win32::System::Ole::IDropSource>,
            DROPEFFECT_COPY | DROPEFFECT_MOVE | DROPEFFECT_LINK,
        )
        .map_err(|e| e.message())?;
        Ok(effect_name(effect))
    }
}

fn effect_name(effect: DROPEFFECT) -> String {
    if effect.0 & DROPEFFECT_MOVE.0 != 0 {
        "move"
    } else if effect.0 & DROPEFFECT_COPY.0 != 0 {
        "copy"
    } else if effect.0 & DROPEFFECT_LINK.0 != 0 {
        "link"
    } else {
        "none"
    }
    .to_string()
}

/// A shell data object for files (any folders; what Explorer puts into a drag).
unsafe fn files_data_object(paths: &[String]) -> Result<IDataObject, String> {
    let pidls: Vec<Pidl> = paths.iter().filter_map(|p| parse_pidl(p).ok()).collect();
    if pidls.is_empty() {
        return Err("öğe bulunamadı".into());
    }
    let ptrs: Vec<*const ITEMIDLIST> = pidls.iter().map(|p| p.0 as *const _).collect();
    let array = SHCreateShellItemArrayFromIDLists(&ptrs).map_err(|e| e.message())?;
    array.BindToHandler(None, &BHID_DataObject).map_err(|e| e.message())
}

/// Drops `paths` onto the item `target` exactly as Explorer does when files are dropped on it: an
/// app (`.exe`, a shortcut to one) opens them, a folder takes them. The item's own drop target
/// (`IShellFolder::GetUIObjectOf` on its parent folder, `IID_IDropTarget`) gets DragEnter /
/// DragOver / Drop with a shell data object of the files, the left button and copy | move | link
/// allowed. Runs on its own STA thread with OLE, which keeps pumping messages after the drop
/// until it has been quiet for a moment (drop handlers may finish asynchronously). Returns the
/// effect ("copy" | "move" | "link" | "none").
pub fn drop_on_item(target: String, paths: Vec<String>) -> Result<String, String> {
    use windows::Win32::System::Ole::{OleInitialize, OleUninitialize};
    let owner = desktop_window::desktop_hwnd_value();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("fe-drop".into())
        .spawn(move || {
            let _com = util::ComApartment::sta();
            let ole = unsafe { OleInitialize(None) }.is_ok();
            let result = unsafe { drop_sta(&target, &paths, util::hwnd_from(owner)) };
            let done = result.is_ok();
            let _ = tx.send(result);
            if done {
                pump_until_quiet(std::time::Duration::from_millis(1500), std::time::Duration::from_secs(60));
            }
            if ole {
                unsafe { OleUninitialize() };
            }
        })
        .map_err(|e| e.to_string())?;
    rx.recv().map_err(|_| "bırakma iş parçacığı yanıt vermedi".to_string())?
}

unsafe fn drop_sta(target: &str, paths: &[String], owner: HWND) -> Result<String, String> {
    use windows::Win32::Foundation::POINTL;
    use windows::Win32::System::Ole::{IDropTarget, DROPEFFECT_NONE};
    use windows::Win32::System::SystemServices::MK_LBUTTON;
    let item = parse_pidl(target)?;
    let mut last: *mut ITEMIDLIST = std::ptr::null_mut();
    let folder: IShellFolder = SHBindToParent(item.0, Some(&mut last)).map_err(|e| e.message())?;
    let drop_target: IDropTarget =
        folder.GetUIObjectOf(owner, &[last as *const ITEMIDLIST], None).map_err(|e| e.message())?;
    let data = files_data_object(paths)?;
    let mut cursor = POINT::default();
    let _ = GetCursorPos(&mut cursor);
    let pt = POINTL { x: cursor.x, y: cursor.y };
    let allowed = DROPEFFECT_COPY | DROPEFFECT_MOVE | DROPEFFECT_LINK;
    let mut effect = allowed;
    drop_target.DragEnter(&data, MK_LBUTTON, pt, &mut effect).map_err(|e| e.message())?;
    if effect != DROPEFFECT_NONE {
        effect = allowed;
        drop_target.DragOver(MK_LBUTTON, pt, &mut effect).map_err(|e| e.message())?;
    }
    if effect == DROPEFFECT_NONE {
        let _ = drop_target.DragLeave();
        return Ok("none".into());
    }
    let mut done = allowed;
    drop_target.Drop(&data, MK_LBUTTON, pt, &mut done).map_err(|e| e.message())?;
    Ok(effect_name(done))
}

/// Dispatches this thread's messages until none came for `quiet` (at most `max` in all).
fn pump_until_quiet(quiet: std::time::Duration, max: std::time::Duration) {
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, MsgWaitForMultipleObjects, PeekMessageW, TranslateMessage, MSG, PM_REMOVE, QS_ALLINPUT,
    };
    let end = std::time::Instant::now() + max;
    let mut idle_since = std::time::Instant::now();
    let mut msg = MSG::default();
    loop {
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
                idle_since = std::time::Instant::now();
            }
        }
        let now = std::time::Instant::now();
        let idle_end = idle_since + quiet;
        if now >= idle_end || now >= end {
            break;
        }
        let wait = idle_end.min(end) - now;
        unsafe { MsgWaitForMultipleObjects(None, false, wait.as_millis() as u32 + 1, QS_ALLINPUT) };
    }
}

#[derive(Serialize, Clone, Copy, Debug, Default)]
pub struct KeyState {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
}

/// The modifier keys held right now (read-only; for drops from other apps, whose events carry none).
pub fn key_state() -> KeyState {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_MENU};
    let down = |vk: u16| unsafe { (GetAsyncKeyState(vk as i32) as u16) & 0x8000 != 0 };
    KeyState { ctrl: down(VK_CONTROL.0), shift: down(VK_SHIFT.0), alt: down(VK_MENU.0) }
}

pub fn cursor_over_foreign_window() -> bool {
    unsafe {
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_err() {
            return false;
        }
        let w = WindowFromPoint(pt);
        if w.is_invalid() {
            return false;
        }
        let root = GetAncestor(w, GA_ROOT);
        root.0 as isize != desktop_window::desktop_hwnd_value()
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartApp {
    pub name: String,
    pub parsing_name: String,
}

pub fn list_start_apps_sta() -> Result<Vec<StartApp>, String> {
    unsafe {
        let folder: IShellItem =
            SHGetKnownFolderItem(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None).map_err(|e| e.message())?;
        let en: IEnumShellItems = folder.BindToHandler(None, &BHID_EnumItems).map_err(|e| e.message())?;
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        loop {
            let mut arr: [Option<IShellItem>; 1] = [None];
            let mut fetched = 0u32;
            if en.Next(&mut arr, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            let Some(item) = arr[0].take() else { break };
            let name = item.GetDisplayName(SIGDN_NORMALDISPLAY).map(|p| util::take_pwstr(p)).unwrap_or_default();
            let id = item.GetDisplayName(SIGDN_PARENTRELATIVEPARSING).map(|p| util::take_pwstr(p)).unwrap_or_default();
            if name.is_empty() || id.is_empty() || !seen.insert(id.to_lowercase()) {
                continue;
            }
            out.push(StartApp { name, parsing_name: format!("shell:AppsFolder\\{id}") });
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(out)
    }
}

pub fn list_start_apps() -> Result<Vec<StartApp>, String> {
    util::run_sta(list_start_apps_sta)?
}

fn sanitize_name(name: &str, fallback: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 32 { '_' } else { c })
        .collect();
    let s = s.trim().trim_end_matches(['.', ' ']).to_string();
    if s.is_empty() {
        fallback.to_string()
    } else {
        s
    }
}

fn unique_path(dir: &str, base: &str, ext: &str) -> String {
    let mut candidate = Path::new(dir).join(format!("{base}{ext}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = Path::new(dir).join(format!("{base} ({n}){ext}"));
        n += 1;
    }
    candidate.to_string_lossy().to_string()
}

pub fn create_shortcut(parsing_name: String, name: String) -> Result<String, String> {
    create_shortcut_in(util::user_desktop_dir(), parsing_name, name)
}

pub fn create_shortcut_in(dir: String, parsing_name: String, name: String) -> Result<String, String> {
    util::run_sta(move || unsafe {
        let pidl = parse_pidl(&parsing_name)?;
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| e.message())?;
        link.SetIDList(pidl.0).map_err(|e| e.message())?;
        let pf: IPersistFile = link.cast().map_err(|e| e.message())?;
        let path = unique_path(&dir, &sanitize_name(&name, "Kısayol"), ".lnk");
        pf.Save(&HSTRING::from(path.as_str()), true).map_err(|e| e.message())?;
        Ok(path)
    })?
}

pub fn create_url_shortcut(url: String, name: String) -> Result<String, String> {
    create_url_shortcut_in(&util::user_desktop_dir(), url, name)
}

pub fn create_url_shortcut_in(dir: &str, url: String, name: String) -> Result<String, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("adres boş".into());
    }
    let url = if url.contains("://") { url } else { format!("https://{url}") };
    let fallback = url
        .split("://")
        .nth(1)
        .and_then(|r| r.split('/').next())
        .unwrap_or("Web sitesi")
        .to_string();
    let base = sanitize_name(if name.trim().is_empty() { &fallback } else { &name }, "Web sitesi");
    let path = unique_path(dir, &base, ".url");
    let content = format!("[InternetShortcut]\r\nURL={url}\r\n");
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// Read-only lookups for Quick Look and the search window (nothing here writes or resolves).

fn mtime_ms(md: &std::fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirPreview {
    pub entries: Vec<DirEntryInfo>,
    /// all visible entries, also those beyond `entries`
    pub total: usize,
}

/// Quick Look of a real folder: its first `limit` entries, folders first, then by name. Hidden and
/// system entries are left out like in Explorer's default view.
pub fn list_dir_preview(path: String, limit: usize) -> Result<DirPreview, String> {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN_OR_SYSTEM: u32 = 0x2 | 0x4;
    let mut entries = Vec::new();
    let mut total = 0;
    for e in std::fs::read_dir(fs_norm(&path)).map_err(|e| e.to_string())?.flatten() {
        let Ok(md) = e.metadata() else { continue };
        if md.file_attributes() & HIDDEN_OR_SYSTEM != 0 {
            continue;
        }
        total += 1;
        if entries.len() < 5000 {
            entries.push(DirEntryInfo {
                name: e.file_name().to_string_lossy().into_owned(),
                path: e.path().to_string_lossy().into_owned(),
                is_dir: md.is_dir(),
                size: if md.is_dir() { 0 } else { md.len() },
                modified: mtime_ms(&md),
            });
        }
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    entries.truncate(limit.clamp(1, 1000));
    Ok(DirPreview { entries, total })
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutInfo {
    pub target: String,
    pub args: String,
    pub work_dir: String,
    pub description: String,
    /// the target is a directory (a local one; network targets are never checked)
    pub is_dir: bool,
}

/// Where a shortcut points: `.lnk` through IShellLinkW (loaded only, never resolved or saved),
/// `.url` from its `URL=` line. None for other files.
pub fn shortcut_target(path: String) -> Result<Option<ShortcutInfo>, String> {
    let path = fs_norm(&path);
    let lower = path.to_lowercase();
    if lower.ends_with(".url") {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&bytes);
        return Ok(text.lines().find_map(|l| {
            l.trim().strip_prefix("URL=").map(|u| ShortcutInfo { target: u.trim().to_string(), ..Default::default() })
        }));
    }
    if !lower.ends_with(".lnk") {
        return Ok(None);
    }
    util::run_sta(move || unsafe { read_link(&path).map(Some) })?
}

/// Needs STA.
unsafe fn read_link(path: &str) -> Result<ShortcutInfo, String> {
    use windows::Win32::System::Com::STGM_READ;
    use windows::Win32::UI::Shell::{SHGetNameFromIDList, SIGDN_DESKTOPABSOLUTEEDITING};
    let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| e.message())?;
    let pf: IPersistFile = link.cast().map_err(|e| e.message())?;
    pf.Load(&HSTRING::from(path), STGM_READ).map_err(|e| e.message())?;
    let text = |f: &dyn Fn(&mut [u16]) -> windows::core::Result<()>| {
        let mut buf = vec![0u16; 1024];
        if f(&mut buf).is_ok() {
            util::wide_to_string(&buf)
        } else {
            String::new()
        }
    };
    let mut target = text(&|b| link.GetPath(b, std::ptr::null_mut(), 0));
    if target.is_empty() {
        // apps and other shell items have an ID list but no path
        if let Ok(p) = link.GetIDList() {
            let pidl = Pidl(p);
            if !pidl.0.is_null() {
                target = SHGetNameFromIDList(pidl.0, SIGDN_DESKTOPABSOLUTEEDITING).map(|p| util::take_pwstr(p)).unwrap_or_default();
            }
        }
    }
    let is_dir = Path::new(&target).is_absolute() && !remote_path(&target) && Path::new(&target).is_dir();
    Ok(ShortcutInfo {
        target,
        is_dir,
        args: text(&|b| link.GetArguments(b)),
        work_dir: text(&|b| link.GetWorkingDirectory(b)),
        description: text(&|b| link.GetDescription(b)),
    })
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub name: String,
    pub path: String,
    /// when it was last used (the Recent shortcut's time), ms
    pub modified: u64,
}

/// Network paths are skipped: checking them can hang for seconds when the server is gone.
fn remote_path(path: &str) -> bool {
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;
    const DRIVE_REMOTE: u32 = 4;
    if path.starts_with("\\\\") {
        return true;
    }
    let b = path.as_bytes();
    if b.len() < 2 || b[1] != b':' || !b[0].is_ascii_alphabetic() {
        return false;
    }
    let root = HSTRING::from(format!("{}:\\", &path[..1]));
    unsafe { GetDriveTypeW(&root) == DRIVE_REMOTE }
}

/// Recently used files: the shortcuts in the user's Recent folder, newest first. Missing targets,
/// folders and network paths are left out.
pub fn list_recent(limit: usize) -> Result<Vec<RecentFile>, String> {
    use windows::Win32::UI::Shell::FOLDERID_Recent;
    let dir = util::known_folder(&FOLDERID_Recent).ok_or("Son kullanılanlar klasörü bulunamadı")?;
    let mut links: Vec<(u64, std::path::PathBuf)> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().extension().map(|x| x.eq_ignore_ascii_case("lnk")).unwrap_or(false))
        .filter_map(|e| e.metadata().ok().map(|m| (mtime_ms(&m), e.path())))
        .collect();
    links.sort_by(|a, b| b.0.cmp(&a.0));
    let limit = limit.clamp(1, 200);
    util::run_sta(move || unsafe {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for (when, lnk) in links {
            if out.len() >= limit {
                break;
            }
            let Ok(info) = read_link(&lnk.to_string_lossy()) else { continue };
            let target = info.target;
            if target.is_empty() || remote_path(&target) || !seen.insert(target.to_lowercase()) {
                continue;
            }
            let p = Path::new(&target);
            if !p.is_file() {
                continue;
            }
            let name = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            out.push(RecentFile { name, path: target.clone(), modified: when });
        }
        out
    })
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FoundFile {
    pub name: String,
    pub path: String,
    pub parsing_name: String,
    pub is_dir: bool,
}

static SEARCH_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static SEARCHES_RUNNING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
const SEARCH_TIMEOUT_MS: u64 = 1500;
const PKEY_ITEM_NAME_DISPLAY: PROPERTYKEY =
    PROPERTYKEY { fmtid: GUID::from_u128(0xb725f130_47ef_101a_a5f1_02608c9eebac), pid: 10 };
const PKEY_DATE_MODIFIED: PROPERTYKEY =
    PROPERTYKEY { fmtid: GUID::from_u128(0xb725f130_47ef_101a_a5f1_02608c9eebac), pid: 14 };

/// The Windows Search service is not disabled (read-only registry check). Without it the search
/// folder would crawl the disk instead of asking the index.
fn search_service_enabled() -> bool {
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD};
    let mut start = 0u32;
    let mut size = 4u32;
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!("SYSTEM\\CurrentControlSet\\Services\\WSearch"),
            w!("Start"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut start as *mut u32 as *mut c_void),
            Some(&mut size),
        )
    };
    rc == ERROR_SUCCESS && start != 4
}

/// Build output, caches and package folders that the index holds as well.
fn noise_path(path: &str) -> bool {
    let p = path.to_lowercase();
    let dirs = p.rsplit_once('\\').map(|(d, _)| d).unwrap_or("");
    dirs.split('\\').any(|seg| {
        (seg.len() > 1 && seg.starts_with('.'))
            || matches!(seg, "node_modules" | "__pycache__" | "site-packages" | "appdata" | "$recycle.bin")
    }) || p.contains("\\target\\debug\\")
        || p.contains("\\target\\release\\")
}

/// Files whose name has words starting with the query's words, from the Windows Search index under
/// the user profile (a shell search folder via ISearchFolderItemFactory), newest first. Waits at most
/// SEARCH_TIMEOUT_MS; a newer search stops older ones; empty when the search service is off.
pub fn search_files(query: String, limit: usize) -> Vec<FoundFile> {
    use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
    use std::sync::{Arc, Mutex};
    let query = query.trim().to_string();
    if query.chars().count() < 3 || !search_service_enabled() {
        return vec![];
    }
    let gen = SEARCH_GEN.fetch_add(1, SeqCst) + 1;
    // older searches stop at their next result; give them a moment
    for _ in 0..15 {
        if SEARCHES_RUNNING.load(SeqCst) < 2 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    if SEARCHES_RUNNING.load(SeqCst) >= 2 || SEARCH_GEN.load(SeqCst) != gen {
        return vec![];
    }
    let Ok(scope) = std::env::var("USERPROFILE") else { return vec![] };
    let found = Arc::new(Mutex::new(Vec::new()));
    let cancel = Arc::new(AtomicBool::new(false));
    let (tx, rx) = std::sync::mpsc::channel();
    let (sink, stop) = (found.clone(), cancel.clone());
    let limit = limit.clamp(1, 100);
    SEARCHES_RUNNING.fetch_add(1, SeqCst);
    let spawned = std::thread::Builder::new().name("fe-search".into()).spawn(move || {
        struct Running;
        impl Drop for Running {
            fn drop(&mut self) {
                SEARCHES_RUNNING.fetch_sub(1, SeqCst);
            }
        }
        let _running = Running;
        let _com = util::ComApartment::sta();
        let keep_going = || !stop.load(SeqCst) && SEARCH_GEN.load(SeqCst) == gen;
        unsafe {
            if let Ok(folder) = search_folder(&query, &scope) {
                collect_found(&folder, limit, &keep_going, &sink);
            }
        }
        let _ = tx.send(());
    });
    if spawned.is_err() {
        SEARCHES_RUNNING.fetch_sub(1, SeqCst);
        return vec![];
    }
    let _ = rx.recv_timeout(std::time::Duration::from_millis(SEARCH_TIMEOUT_MS));
    cancel.store(true, SeqCst);
    let out = found.lock().map(|v| v.clone()).unwrap_or_default();
    out
}

/// A shell search folder for `query` below `scope`. Needs STA.
unsafe fn search_folder(query: &str, scope: &str) -> windows::core::Result<IShellItem> {
    use windows::Win32::System::Search::Common::{COP_WORD_STARTSWITH, CT_AND_CONDITION};
    use windows::Win32::System::Search::{ConditionFactory, ICondition, IConditionFactory2, CONDITION_CREATION_DEFAULT};
    use windows::Win32::UI::Shell::{
        ISearchFolderItemFactory, IShellItemArray, SHCreateShellItemArrayFromShellItem, SearchFolderItemFactory, SORTCOLUMN,
        SORT_DESCENDING,
    };
    let factory: ISearchFolderItemFactory = CoCreateInstance(&SearchFolderItemFactory, None, CLSCTX_INPROC_SERVER)?;
    factory.SetDisplayName(w!("Folder Explorer"))?;
    let root: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(scope), None)?;
    let roots: IShellItemArray = SHCreateShellItemArrayFromShellItem(&root)?;
    factory.SetScope(&roots)?;
    let conditions: IConditionFactory2 = CoCreateInstance(&ConditionFactory, None, CLSCTX_INPROC_SERVER)?;
    let words = query
        .split_whitespace()
        .map(|word| {
            conditions
                .CreateStringLeaf::<_, _, ICondition>(
                    &PKEY_ITEM_NAME_DISPLAY,
                    COP_WORD_STARTSWITH,
                    &HSTRING::from(word),
                    PCWSTR::null(),
                    CONDITION_CREATION_DEFAULT,
                )
                .map(Some)
        })
        .collect::<windows::core::Result<Vec<_>>>()?;
    let all: ICondition = conditions.CreateCompoundFromArray(CT_AND_CONDITION, &words, CONDITION_CREATION_DEFAULT)?;
    factory.SetCondition(&all)?;
    factory.SetSortColumns(&[SORTCOLUMN { propkey: PKEY_DATE_MODIFIED, direction: SORT_DESCENDING }])?;
    factory.GetShellItem()
}

unsafe fn collect_found(folder: &IShellItem, limit: usize, keep_going: &dyn Fn() -> bool, sink: &std::sync::Mutex<Vec<FoundFile>>) {
    use windows::Win32::System::SystemServices::{SFGAO_FOLDER, SFGAO_STREAM};
    use windows::Win32::UI::Shell::SIGDN_FILESYSPATH;
    let Ok(en) = folder.BindToHandler::<_, IEnumShellItems>(None, &BHID_EnumItems) else { return };
    for _ in 0..400 {
        if !keep_going() {
            break;
        }
        let mut arr: [Option<IShellItem>; 1] = [None];
        let mut fetched = 0u32;
        if en.Next(&mut arr, Some(&mut fetched)).is_err() || fetched == 0 {
            break;
        }
        let Some(item) = arr[0].take() else { break };
        let path = item.GetDisplayName(SIGDN_FILESYSPATH).map(|p| util::take_pwstr(p)).unwrap_or_default();
        if path.is_empty() || noise_path(&path) {
            continue;
        }
        let name = item.GetDisplayName(SIGDN_NORMALDISPLAY).map(|p| util::take_pwstr(p)).unwrap_or_default();
        let attrs = item.GetAttributes(SFGAO_FOLDER | SFGAO_STREAM).map(|a| a.0).unwrap_or(0);
        let is_dir = attrs & SFGAO_FOLDER.0 != 0 && attrs & SFGAO_STREAM.0 == 0;
        let Ok(mut found) = sink.lock() else { break };
        found.push(FoundFile { name, parsing_name: path.clone(), path, is_dir });
        if found.len() >= limit {
            break;
        }
    }
}
