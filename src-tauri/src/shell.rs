//! Shell operations: open, context menus, "New" menu, file operations, recycle bin,
//! OLE drag-out, Start-menu apps and shortcut creation.

use std::cell::RefCell;
use std::collections::HashSet;
use std::ffi::c_void;
use std::path::Path;

use serde::Serialize;
use windows::core::{w, Interface, GUID, HSTRING, PCSTR, PCWSTR, PSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, PROPERTYKEY, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::{DeleteObject, GetObjectW, BITMAP, HGDIOBJ};
use windows::Win32::System::Com::{CoCreateInstance, IDataObject, IPersistFile, CLSCTX_ALL, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Ole::{DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_MOVE};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_SHIFT};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    FileOperation, IContextMenu, IContextMenu2, IContextMenu3, IDragSourceHelper, IEnumShellItems,
    IFileOperation, IShellFolder, IShellItem, IShellItem2, IShellLinkW, ILFindLastID, ILFree,
    SHBindToParent, SHCreateItemFromParsingName, SHCreateShellItemArrayFromIDLists, SHDoDragDrop,
    SHGetKnownFolderItem, SHParseDisplayName, ShellExecuteExW, ShellLink, BHID_DataObject, BHID_EnumItems,
    BHID_SFUIObject, CMF_CANRENAME, CMF_EXTENDEDVERBS, CMF_NORMAL, CMINVOKECOMMANDINFO,
    CMINVOKECOMMANDINFOEX, CMIC_MASK_PTINVOKE, FOFX_RECYCLEONDELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMMKDIR,
    FOF_RENAMEONCOLLISION, FOLDERID_AppsFolder, FOLDERID_RecycleBinFolder, GCS_VERBW, KF_FLAG_DEFAULT,
    SEE_MASK_NOASYNC, SHDRAGIMAGE, SHELLEXECUTEINFOW, SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEEDITING,
    SIGDN_PARENTRELATIVEPARSING,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, CreatePopupMenu, DestroyMenu, GetAncestor, GetCursorPos,
    SetForegroundWindow, TrackPopupMenuEx, WindowFromPoint, ASFW_ANY, GA_ROOT, HMENU, SW_SHOWNORMAL,
    TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_MENUCHAR,
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

thread_local! {
    /// Context menu currently tracked on this (the UI) thread; owner-drawn / lazily built
    /// submenus need WM_INITMENUPOPUP etc. forwarded to it.
    static ACTIVE_MENU: RefCell<Option<IContextMenu>> = const { RefCell::new(None) };
}

/// Called from the desktop window subclass for menu messages.
pub fn forward_menu_msg(msg: u32, wparam: WPARAM, lparam: LPARAM) -> Option<LRESULT> {
    let cm = ACTIVE_MENU.with(|m| m.borrow().clone())?;
    unsafe {
        if let Ok(cm3) = cm.cast::<IContextMenu3>() {
            let mut res = LRESULT(0);
            if cm3.HandleMenuMsg2(msg, wparam, lparam, Some(&mut res)).is_ok() {
                return Some(res);
            }
        }
        if msg != WM_MENUCHAR {
            if let Ok(cm2) = cm.cast::<IContextMenu2>() {
                if cm2.HandleMenuMsg(msg, wparam, lparam).is_ok() {
                    return Some(LRESULT(0));
                }
            }
        }
    }
    None
}

/// Owned absolute PIDL.
struct Pidl(*mut ITEMIDLIST);

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

fn parse_pidl(path: &str) -> Result<Pidl, String> {
    let path = &fs_norm(path);
    let mut p: *mut ITEMIDLIST = std::ptr::null_mut();
    unsafe {
        SHParseDisplayName(&HSTRING::from(path), None, &mut p, 0, None).map_err(|e| format!("{path}: {}", e.message()))?;
    }
    Ok(Pidl(p))
}

fn parent_key(path: &str) -> String {
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

unsafe fn command_verb(cm: &IContextMenu, id: usize) -> Option<String> {
    let mut buf = [0u16; 260];
    cm.GetCommandString(id, GCS_VERBW, None, PSTR(buf.as_mut_ptr() as *mut u8), buf.len() as u32)
        .ok()?;
    let s = util::wide_to_string(&buf);
    if s.is_empty() {
        None
    } else {
        Some(s)
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

/// Tracks `menu` at the cursor with `cm` as the active handler. Returns the 0-based command id.
pub(crate) unsafe fn track(cm: &IContextMenu, menu: HMENU, hwnd: HWND, at: Option<POINT>) -> (Option<usize>, POINT) {
    let mut pt = POINT::default();
    match at {
        Some(p) => pt = p,
        None => {
            let _ = GetCursorPos(&mut pt);
        }
    }
    ACTIVE_MENU.with(|m| *m.borrow_mut() = Some(cm.clone()));
    let _ = SetForegroundWindow(hwnd);
    let cmd = TrackPopupMenuEx(menu, (TPM_RETURNCMD | TPM_RIGHTBUTTON).0, pt.x, pt.y, hwnd, None).0;
    ACTIVE_MENU.with(|m| *m.borrow_mut() = None);
    if cmd > 0 {
        (Some((cmd - 1) as usize), pt)
    } else {
        (None, pt)
    }
}

// ---------------------------------------------------------------------------

pub fn open_item(path: String) -> Result<(), String> {
    let hwnd_v = desktop_window::desktop_hwnd_value();
    util::run_sta(move || unsafe {
        let _ = AllowSetForegroundWindow(ASFW_ANY);
        let file = if path.starts_with("::") { format!("shell:{path}") } else { path.clone() };
        let file_w = HSTRING::from(file.as_str());
        let is_fs = !path.starts_with("::") && !path.to_lowercase().starts_with("shell:");
        let dir = if is_fs { util::parent_dir(&path) } else { String::new() };
        let dir_w = HSTRING::from(dir.as_str());
        let mut sei: SHELLEXECUTEINFOW = std::mem::zeroed();
        sei.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        sei.fMask = SEE_MASK_NOASYNC;
        sei.hwnd = util::hwnd_from(hwnd_v);
        sei.lpFile = PCWSTR(file_w.as_ptr());
        sei.lpDirectory = if dir.is_empty() { PCWSTR::null() } else { PCWSTR(dir_w.as_ptr()) };
        sei.nShow = SW_SHOWNORMAL.0;
        ShellExecuteExW(&mut sei).map_err(|e| e.message())
    })?
}

/// Native item context menu. Must run on the UI thread.
pub fn shell_menu_main(paths: Vec<String>, at: Option<POINT>) -> Result<Option<String>, String> {
    let hwnd = desktop_window::desktop_hwnd();
    unsafe {
        let pidls: Vec<(String, Pidl)> = paths
            .iter()
            .filter_map(|p| parse_pidl(p).ok().map(|pidl| (p.clone(), pidl)))
            .collect();
        let Some((first_path, first)) = pidls.first() else {
            return Err("öğe bulunamadı".into());
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
        let cm: IContextMenu = folder.GetUIObjectOf(hwnd, &children, None).map_err(|e| e.message())?;
        let menu = CreatePopupMenu().map_err(|e| e.message())?;
        let mut flags = CMF_NORMAL | CMF_CANRENAME;
        if GetKeyState(VK_SHIFT.0 as i32) < 0 {
            flags |= CMF_EXTENDEDVERBS;
        }
        cm.QueryContextMenu(menu, 0, 1, 0x7FFF, flags).ok().map_err(|e| e.message())?;
        let (cmd, pt) = track(&cm, menu, hwnd, at);
        let result = match cmd {
            None => Ok(None),
            Some(id) => {
                let verb = command_verb(&cm, id);
                match verb.as_deref().map(|v| v.to_ascii_lowercase()) {
                    Some(v) if v == "rename" => Ok(Some("rename".to_string())),
                    Some(v) if v == "delete" => Ok(Some("delete".to_string())),
                    _ => invoke_id(&cm, id, hwnd, pt).map(|_| Some(verb.unwrap_or_default())),
                }
            }
        };
        let _ = DestroyMenu(menu);
        result
    }
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

/// Copies (or moves, Explorer-style on the same volume) external files onto the user desktop.
pub fn import_dropped(paths: Vec<String>, copy: bool) -> Result<Vec<String>, String> {
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
            if util::same_dir(&parent, &desktop) || util::same_dir(&parent, &public) {
                result.push(Some(p.clone()));
                continue;
            }
            let item = shell_item(p)?;
            let do_copy = copy || volume_of(p) != volume_of(&desktop);
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
        let pidls: Vec<Pidl> = paths.iter().filter_map(|p| parse_pidl(p).ok()).collect();
        if pidls.is_empty() {
            return Err("öğe bulunamadı".into());
        }
        let ptrs: Vec<*const ITEMIDLIST> = pidls.iter().map(|p| p.0 as *const _).collect();
        let array = SHCreateShellItemArrayFromIDLists(&ptrs).map_err(|e| e.message())?;
        let data: IDataObject = array.BindToHandler(None, &BHID_DataObject).map_err(|e| e.message())?;
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
        Ok(if effect.0 & DROPEFFECT_MOVE.0 != 0 {
            "move"
        } else if effect.0 & DROPEFFECT_COPY.0 != 0 {
            "copy"
        } else if effect.0 & DROPEFFECT_LINK.0 != 0 {
            "link"
        } else {
            "none"
        }
        .to_string())
    }
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
