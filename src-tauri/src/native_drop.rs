//! Drops from other apps on the desktop, taken before WebView2 sees them.
//!
//! WebView2's drop target lives on its browser window (another process). Files from inside an archive
//! (a ZIP / RAR opened in Explorer, WinRAR) reach the page with no path, can't be read there, and crash
//! the renderer when handed back. So as soon as the page sees a file drag come in (`dragenter`), it calls
//! `begin_native_drop`: an invisible layer window (alpha 1, owned by the desktop window, so other apps
//! stay above it) covers the desktop, and the drag moves on to this layer's own `IDropTarget`.
//! - Real files (CF_HDROP): their paths go to the page (`native-drop`), which imports them as before
//!   (moves stay undoable). The source is always told "copy", so it never deletes them first.
//! - Anything else (virtual files): handed to the shell drop target of the folder the page picked
//!   (`set_drop_dest`), so Windows extracts or copies them exactly like a drop in Explorer.
//!
//! The page follows the drag through `native-drag` events to highlight the target. The layer hides on
//! drop or leave, and a 250 ms timer hides it as soon as no mouse button is down.

use std::cell::RefCell;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use windows::core::{implement, w, Ref};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, POINTL, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Com::{
    CoCreateInstance, IDataObject, CLSCTX_INPROC_SERVER, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
use windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, CF_HDROP, DROPEFFECT, DROPEFFECT_COPY,
    DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::{MK_CONTROL, MK_SHIFT, MODIFIERKEYS_FLAGS};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
use windows::Win32::UI::Shell::{
    DragQueryFileW, IDropTargetHelper, IShellItemArray, SHCreateShellItemArrayFromDataObject, CFSTR_FILEDESCRIPTORW,
    CLSID_DragDropHelper, FILEGROUPDESCRIPTORW, HDROP, SIGDN_PARENTRELATIVEPARSING,
};
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::{desktop_window, shell, util};

/// Where the page wants the current drag to go.
#[derive(Deserialize, Clone, PartialEq, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Dest {
    /// no target here: refuse
    None,
    /// real files: the page imports them itself after the drop
    Accept,
    /// virtual files: dropped into this folder by the shell
    Folder { path: String },
}

static DEST: Mutex<Dest> = Mutex::new(Dest::None);
static LAYER: AtomicIsize = AtomicIsize::new(0);
const HIDE_TIMER: usize = 1;

pub fn set_dest(dest: Dest) {
    *DEST.lock().unwrap() = dest;
}

/// Shows the layer over the desktop window, directly above it in z-order. Main thread.
pub fn show() {
    let desk = desktop_window::desktop_hwnd();
    if desk.is_invalid() {
        return;
    }
    set_dest(Dest::None);
    unsafe {
        let Some(layer) = ensure_layer(desk) else { return };
        let mut r = RECT::default();
        if GetWindowRect(desk, &mut r).is_err() {
            return;
        }
        // directly above the desktop window: behind whatever is above it
        let above = GetWindow(desk, GW_HWNDPREV).ok().filter(|h| !h.is_invalid() && *h != layer);
        let _ = SetWindowPos(
            layer,
            Some(above.unwrap_or(HWND_TOP)),
            r.left,
            r.top,
            r.right - r.left,
            r.bottom - r.top,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
        SetTimer(Some(layer), HIDE_TIMER, 250, None);
    }
}

fn hide() {
    let layer = util::hwnd_from(LAYER.load(Ordering::SeqCst));
    if layer.is_invalid() {
        return;
    }
    unsafe {
        let _ = KillTimer(Some(layer), HIDE_TIMER);
        let _ = ShowWindow(layer, SW_HIDE);
    }
}

unsafe fn ensure_layer(desk: HWND) -> Option<HWND> {
    let existing = util::hwnd_from(LAYER.load(Ordering::SeqCst));
    if !existing.is_invalid() && IsWindow(Some(existing)).as_bool() {
        return Some(existing);
    }
    // RegisterDragDrop needs OLE on this (the main) thread; a second call only adds a reference
    let _ = windows::Win32::System::Ole::OleInitialize(None);
    let class = w!("FolderExplorerDropLayer");
    let wc = WNDCLASSW { lpfnWndProc: Some(layer_proc), lpszClassName: class, ..Default::default() };
    RegisterClassW(&wc);
    let layer = CreateWindowExW(
        WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        class,
        w!(""),
        WS_POPUP,
        0,
        0,
        0,
        0,
        Some(desk),
        None,
        None,
        None,
    )
    .ok()?;
    // alpha 1: invisible, but still hit (an alpha-0 or WS_EX_TRANSPARENT window would let the drag through)
    let _ = SetLayeredWindowAttributes(layer, COLORREF(0), 1, LWA_ALPHA);
    let target: IDropTarget = LayerTarget::default().into();
    if RegisterDragDrop(layer, &target).is_err() {
        let _ = DestroyWindow(layer);
        return None;
    }
    LAYER.store(layer.0 as isize, Ordering::SeqCst);
    Some(layer)
}

unsafe extern "system" fn layer_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // An OLE drag holds a mouse button: none down means the drag is over (or never reached the layer).
    if msg == WM_TIMER && wparam.0 == HIDE_TIMER {
        let down = |vk: u16| (GetAsyncKeyState(vk as i32) as u16) & 0x8000 != 0;
        if !down(VK_LBUTTON.0) && !down(VK_RBUTTON.0) {
            hide();
        }
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DragMove {
    /// "over" or "leave"
    phase: &'static str,
    /// physical px in the desktop window
    x: i32,
    y: i32,
    ctrl: bool,
    shift: bool,
    /// real files (the page imports them) rather than virtual ones (the shell drops them)
    files: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Dropped {
    x: i32,
    y: i32,
    ctrl: bool,
    shift: bool,
    /// real files: the page imports these
    paths: Vec<String>,
    /// virtual files: the top-level names the shell wrote into `folder`
    names: Vec<String>,
    folder: Option<String>,
}

#[derive(Default)]
struct DragState {
    data: Option<IDataObject>,
    paths: Option<Vec<String>>,
    names: Vec<String>,
    /// the shell drop target currently in use (virtual files), by folder
    shell: Option<(String, IDropTarget)>,
    helper: Option<IDropTargetHelper>,
    last: Option<(i32, i32, u32)>,
}

#[implement(IDropTarget)]
#[derive(Default)]
struct LayerTarget(RefCell<DragState>);

fn client_point(pt: &POINTL) -> (i32, i32) {
    let mut p = POINT { x: pt.x, y: pt.y };
    unsafe {
        let _ = ScreenToClient(desktop_window::desktop_hwnd(), &mut p);
    }
    (p.x, p.y)
}

fn emit<S: Serialize + Clone>(event: &str, payload: S) {
    if let Some(app) = util::app() {
        let _ = app.emit_to("desktop", event, payload);
    }
}

impl LayerTarget_Impl {
    /// The effect for the current destination; virtual files ask the folder's shell drop target.
    unsafe fn effect(&self, keys: MODIFIERKEYS_FLAGS, pt: &POINTL, allowed: DROPEFFECT) -> DROPEFFECT {
        let mut st = self.0.borrow_mut();
        let dest = DEST.lock().unwrap().clone();
        if st.paths.is_some() {
            return if dest == Dest::None { DROPEFFECT_NONE } else { DROPEFFECT_COPY };
        }
        let Dest::Folder { path } = dest else {
            if let Some((_, old)) = st.shell.take() {
                let _ = old.DragLeave();
            }
            return DROPEFFECT_NONE;
        };
        if st.shell.as_ref().is_none_or(|(p, _)| *p != path) {
            if let Some((_, old)) = st.shell.take() {
                let _ = old.DragLeave();
            }
            let layer = util::hwnd_from(LAYER.load(Ordering::SeqCst));
            let (Some(data), Ok(target)) = (st.data.clone(), shell::item_drop_target(&path, layer)) else {
                return DROPEFFECT_NONE;
            };
            let mut e = allowed;
            if target.DragEnter(&data, keys, *pt, &mut e).is_err() {
                return DROPEFFECT_NONE;
            }
            st.shell = Some((path, target));
        }
        let mut e = allowed;
        match &st.shell {
            Some((_, target)) if target.DragOver(keys, *pt, &mut e).is_ok() => e,
            _ => DROPEFFECT_NONE,
        }
    }

    fn report(&self, phase: &'static str, keys: MODIFIERKEYS_FLAGS, pt: &POINTL) {
        let (x, y) = client_point(pt);
        let mut st = self.0.borrow_mut();
        if phase == "over" && st.last == Some((x, y, keys.0)) {
            return;
        }
        st.last = Some((x, y, keys.0));
        let files = st.paths.is_some();
        drop(st);
        emit("native-drag", DragMove { phase, x, y, ctrl: keys.contains(MK_CONTROL), shift: keys.contains(MK_SHIFT), files });
    }

    fn reset(&self) {
        let mut st = self.0.borrow_mut();
        if let Some((_, target)) = st.shell.take() {
            unsafe {
                let _ = target.DragLeave();
            }
        }
        *st = DragState::default();
        drop(st);
        hide();
    }
}

impl IDropTarget_Impl for LayerTarget_Impl {
    fn DragEnter(
        &self,
        data: Ref<IDataObject>,
        keys: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let data = data.ok()?.clone();
        unsafe {
            // Only plain files on disk are the page's to import. A drag out of an archive goes to the shell:
            // Explorer extracts a ZIP's files to %TEMP% for other apps and deletes them once the drop is over,
            // and WinRAR hands over bare names (no folder) during the drag and extracts to %TEMP% only when
            // the drop asks for the files, which the shell's drop does.
            let descriptor = has_format(&data, descriptor_format());
            let all = hdrop_paths(&data);
            let names = match &all {
                Some(p) if !p.is_empty() && p.iter().any(|p| !is_absolute(p) || in_temp(p)) => {
                    p.iter().map(|p| p.rsplit(['\\', '/']).next().unwrap_or(p).to_string()).collect()
                }
                _ => Vec::new(),
            };
            let paths = all.filter(|_| !descriptor && names.is_empty());
            let helper: Option<IDropTargetHelper> = CoCreateInstance(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER).ok();
            {
                let mut st = self.0.borrow_mut();
                st.names = if paths.is_some() { Vec::new() } else if names.is_empty() { virtual_names(&data) } else { names };
                st.paths = paths;
                st.data = Some(data.clone());
                st.helper = helper.clone();
                st.last = None;
            }
            self.report("over", keys, pt);
            *effect = self.effect(keys, pt, *effect);
            if let Some(h) = helper {
                let layer = util::hwnd_from(LAYER.load(Ordering::SeqCst));
                let _ = h.DragEnter(layer, &data, &POINT { x: pt.x, y: pt.y }, *effect);
            }
        }
        Ok(())
    }

    fn DragOver(&self, keys: MODIFIERKEYS_FLAGS, pt: &POINTL, effect: *mut DROPEFFECT) -> windows::core::Result<()> {
        self.report("over", keys, pt);
        unsafe {
            *effect = self.effect(keys, pt, *effect);
            if let Some(h) = self.0.borrow().helper.clone() {
                let _ = h.DragOver(&POINT { x: pt.x, y: pt.y }, *effect);
            }
        }
        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        if let Some(h) = self.0.borrow().helper.clone() {
            unsafe {
                let _ = h.DragLeave();
            }
        }
        emit("native-drag", DragMove { phase: "leave", x: 0, y: 0, ctrl: false, shift: false, files: false });
        self.reset();
        Ok(())
    }

    fn Drop(
        &self,
        data: Ref<IDataObject>,
        keys: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let data = data.ok()?.clone();
        let (x, y) = client_point(pt);
        let (ctrl, shift) = (keys.contains(MK_CONTROL), keys.contains(MK_SHIFT));
        unsafe {
            let allowed = *effect;
            *effect = self.effect(keys, pt, allowed);
            if let Some(h) = self.0.borrow().helper.clone() {
                let _ = h.Drop(&data, &POINT { x: pt.x, y: pt.y }, *effect);
            }
            let st = self.0.borrow();
            let mut dropped = Dropped { x, y, ctrl, shift, paths: Vec::new(), names: Vec::new(), folder: None };
            if *effect != DROPEFFECT_NONE {
                if let Some(paths) = &st.paths {
                    dropped.paths = paths.clone();
                } else if let Some((folder, target)) = &st.shell {
                    let mut e = allowed;
                    if target.Drop(&data, keys, *pt, &mut e).is_ok() {
                        *effect = e;
                        dropped.names = st.names.clone();
                        dropped.folder = Some(folder.clone());
                    }
                }
            }
            let done = !dropped.paths.is_empty() || dropped.folder.is_some();
            drop(st);
            // the shell target took the drop: no DragLeave for it
            if dropped.folder.is_some() {
                self.0.borrow_mut().shell = None;
            }
            if done {
                emit("native-drop", dropped);
            } else {
                emit("native-drag", DragMove { phase: "leave", x, y, ctrl, shift, files: false });
            }
        }
        self.reset();
        Ok(())
    }
}

fn descriptor_format() -> u16 {
    unsafe { RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW) as u16 }
}

unsafe fn has_format(data: &IDataObject, cf: u16) -> bool {
    let fmt = FORMATETC {
        cfFormat: cf,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    data.QueryGetData(&fmt) == windows::Win32::Foundation::S_OK
}

/// "C:\…" or "\\server\…", not a bare name.
fn is_absolute(path: &str) -> bool {
    let b = path.as_bytes();
    (b.len() > 2 && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')) || path.starts_with(r"\\")
}

fn in_temp(path: &str) -> bool {
    let temp = std::env::temp_dir().to_string_lossy().to_lowercase();
    path.to_lowercase().starts_with(temp.trim_end_matches('\\'))
}

/// The paths a drag carries as real files (CF_HDROP), if it does.
unsafe fn hdrop_paths(data: &IDataObject) -> Option<Vec<String>> {
    let fmt = FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let mut medium = data.GetData(&fmt).ok()?;
    let hdrop = HDROP(medium.u.hGlobal.0);
    let count = DragQueryFileW(hdrop, u32::MAX, None);
    let mut paths = Vec::with_capacity(count as usize);
    for i in 0..count {
        let len = DragQueryFileW(hdrop, i, None) as usize;
        let mut buf = vec![0u16; len + 1];
        DragQueryFileW(hdrop, i, Some(&mut buf));
        paths.push(String::from_utf16_lossy(&buf[..len]));
    }
    ReleaseStgMedium(&mut medium);
    Some(paths)
}

/// The names of the virtual files a drag carries: what lands in the folder. Explorer's archive views
/// hand over shell items, which name themselves; WinRAR and mail apps only a file group descriptor.
unsafe fn virtual_names(data: &IDataObject) -> Vec<String> {
    if let Ok(items) = SHCreateShellItemArrayFromDataObject::<_, IShellItemArray>(data) {
        let names: Vec<String> = (0..items.GetCount().unwrap_or(0))
            .filter_map(|i| items.GetItemAt(i).ok())
            .filter_map(|item| item.GetDisplayName(SIGDN_PARENTRELATIVEPARSING).ok())
            .map(|p| util::take_pwstr(p))
            .filter(|name| !name.is_empty())
            .collect();
        if !names.is_empty() {
            return names;
        }
    }
    descriptor_names(data)
}

/// Top-level names from a FileGroupDescriptorW (nested entries come as "folder\file").
unsafe fn descriptor_names(data: &IDataObject) -> Vec<String> {
    let fmt = FORMATETC {
        cfFormat: RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW) as u16,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let Ok(mut medium) = data.GetData(&fmt) else { return Vec::new() };
    let mut names: Vec<String> = Vec::new();
    let group = GlobalLock(medium.u.hGlobal) as *const FILEGROUPDESCRIPTORW;
    if !group.is_null() {
        let first = std::ptr::addr_of!((*group).fgd) as *const windows::Win32::UI::Shell::FILEDESCRIPTORW;
        for i in 0..(*group).cItems as usize {
            // the descriptor is packed: copy it out before reading a field
            let name = { std::ptr::read_unaligned(first.add(i)).cFileName };
            let name = util::wide_to_string(&name);
            let top = name.split(['\\', '/']).next().unwrap_or_default().to_string();
            if !top.is_empty() && !names.contains(&top) {
                names.push(top);
            }
        }
        let _ = GlobalUnlock(medium.u.hGlobal);
    }
    ReleaseStgMedium(&mut medium);
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::core::HSTRING;
    use windows::Win32::System::Ole::{OleInitialize, OleUninitialize};
    use windows::Win32::System::SystemServices::MK_LBUTTON;
    use windows::Win32::UI::Shell::{IShellItem, SHCreateItemFromParsingName, BHID_DataObject};

    /// What Explorer hands over when a file is dragged out of an archive it shows as a folder: no
    /// CF_HDROP, a file group descriptor, and the folder's shell drop target extracts it.
    fn drop_from_archive(name: &str, make: impl Fn(&std::path::Path, &std::path::Path) -> bool) {
        let dir = std::env::temp_dir().join(format!("fe-native-drop-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (src, dest) = (dir.join("src"), dir.join("dest"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(src.join("inside.txt"), "from the archive").unwrap();
        let archive = dir.join(name);
        assert!(make(&src.join("inside.txt"), &archive), "couldn't make {name}");

        let (item, dest_dir) = (archive.join("inside.txt").display().to_string(), dest.display().to_string());
        let landed = dest.join("inside.txt");
        let names = std::thread::spawn(move || unsafe {
            let _com = util::ComApartment::sta();
            let _ = OleInitialize(None);
            let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(item.as_str()), None).unwrap();
            let data: IDataObject = item.BindToHandler(None, &BHID_DataObject).unwrap();
            assert!(hdrop_paths(&data).is_none(), "a file inside an archive should come without a path");
            let names = virtual_names(&data);
            let target = shell::item_drop_target(&dest_dir, HWND::default()).unwrap();
            let pt = POINTL::default();
            let mut e = DROPEFFECT_COPY;
            target.DragEnter(&data, MK_LBUTTON, pt, &mut e).unwrap();
            e = DROPEFFECT_COPY;
            target.DragOver(MK_LBUTTON, pt, &mut e).unwrap();
            assert_ne!(e, DROPEFFECT_NONE, "the folder refused the drop");
            target.Drop(&data, MK_LBUTTON, pt, &mut e).unwrap();
            // the shell may extract on its own thread: wait, pumping messages, until the file is there
            let end = std::time::Instant::now() + std::time::Duration::from_secs(15);
            let mut msg = MSG::default();
            while !landed.exists() && std::time::Instant::now() < end {
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            OleUninitialize();
            names
        })
        .join()
        .unwrap();
        assert_eq!(names, ["inside.txt"]);
        assert_eq!(std::fs::read_to_string(dest.join("inside.txt")).unwrap(), "from the archive");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_absolute_paths_outside_temp_count_as_real_files() {
        assert!(is_absolute(r"C:\Users\u\a.txt"));
        assert!(is_absolute(r"\\server\share\a.txt"));
        assert!(!is_absolute("horizon-windows-x64"));
        assert!(!is_absolute(r"folder\a.txt"));
        assert!(in_temp(&std::env::temp_dir().join("Temp1_a.zip").join("a.txt").to_string_lossy()));
        assert!(!in_temp(r"C:\Users\Public\Desktop\a.txt"));
    }

    // Need the Windows shell: `cargo test --lib native_drop -- --ignored`.
    #[test]
    #[ignore]
    fn a_file_inside_a_zip_is_extracted_into_the_folder() {
        drop_from_archive("archive.zip", |file, zip| {
            std::process::Command::new("powershell")
                .args(["-NoProfile", "-Command", &format!("Compress-Archive -Path '{}' -DestinationPath '{}'", file.display(), zip.display())])
                .status()
                .is_ok_and(|s| s.success())
        });
    }

    /// Windows 11 opens RAR files in Explorer itself; needs WinRAR's Rar.exe to make one.
    #[test]
    #[ignore]
    fn a_file_inside_a_rar_is_extracted_into_the_folder() {
        drop_from_archive("archive.rar", |file, rar| {
            std::process::Command::new(r"C:\Program Files\WinRAR\Rar.exe")
                .args(["a", "-ep", "-idq"])
                .arg(rar)
                .arg(file)
                .status()
                .is_ok_and(|s| s.success())
        });
    }
}
