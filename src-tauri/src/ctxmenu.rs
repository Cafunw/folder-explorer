//! Native Windows Shell menus and verbs, on an STA thread with a hidden message owner.
//! Windows renders the menus; no menu webviews or app-drawn replacements are created.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::sync::{mpsc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use windows::core::{w, Interface, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{DeleteObject, HBITMAP, HGDIOBJ};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, IDataObject, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Ole::OleInitialize;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_SHIFT};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    IAssocHandler, IContextMenu, IContextMenu2, IContextMenu3, IShellExtInit, IShellFolder, ILFindLastID,
    SHAssocEnumHandlers, SHBindToParent, SHDefExtractIconW, SHGetDesktopFolder, SHLoadIndirectString,
    SHOpenWithDialog, ASSOC_FILTER_RECOMMENDED, CLSID_NewMenu, CMF_CANRENAME, CMF_EXTENDEDVERBS, CMF_NORMAL,
    GCS_VERBW, OAIF_ALLOW_REGISTRATION, OAIF_EXEC, OAIF_REGISTER_EXT, OPENASINFO,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyMenu, DispatchMessageW,
    GetCursorPos, GetIconInfo, GetMenuItemCount, GetMenuItemInfoW, GetMessageW, GetSubMenu, InsertMenuItemW,
    PostMessageW, RegisterClassW, SetForegroundWindow, TrackPopupMenuEx, TranslateMessage, HICON, HMENU,
    ICONINFO, MENUITEMINFOW, MENU_ITEM_STATE, MFS_CHECKED, MFS_DISABLED, MFT_OWNERDRAW, MFT_RADIOCHECK,
    MFT_SEPARATOR, MFT_STRING, MIIM_BITMAP, MIIM_FTYPE, MIIM_ID, MIIM_STATE, MIIM_STRING,
    MIIM_SUBMENU, MSG, TPM_RETURNCMD, TPM_RIGHTBUTTON, WINDOW_EX_STYLE, WM_APP, WM_DRAWITEM, WM_INITMENUPOPUP,
    WM_MEASUREITEM, WM_MENUCHAR, WM_NULL, WNDCLASSW, WS_EX_TOOLWINDOW, WS_POPUP,
};

use crate::{icons, shell, util};

const WM_JOB: u32 = WM_APP + 7;
/// Command id ranges inside one tracked menu: the shell's, Windows' New menu, ours.
const SHELL_FIRST: u32 = 1;
const SHELL_LAST: u32 = 0x6FFF;
const NEW_FIRST: u32 = 0x7000;
const NEW_LAST: u32 = 0x7FFF;
const OWN_FIRST: u32 = 0x8000;

/// Shell menu diagnostics used by --menutest.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MenuExtra {
    pub key: String,
    /// canonical verbs the classic menu offers ("pintohome", "Windows.ModernShare"…)
    pub verbs: Option<Vec<String>>,
    /// Windows' New ▸ list (desktop only); id 0 = separator
    pub new_items: Option<Vec<NewItem>>,
    /// Open with ▸ (one file only)
    pub open_with: Option<Vec<Handler>>,
}

#[derive(Serialize, Clone)]
pub struct NewItem {
    pub id: u32,
    pub text: String,
    /// data: URL of the icon Windows shows for it
    pub icon: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct Handler {
    pub index: usize,
    pub name: String,
    /// data: URL, or a file whose shell icon is the app's icon
    pub icon: Option<String>,
}

/// Entries of an OS-rendered menu for app objects, such as virtual headings.
#[derive(Deserialize, Clone, Default)]
#[serde(default)]
pub struct OwnItem {
    pub id: String,
    pub text: String,
    pub sep: bool,
    pub checked: bool,
    pub radio: bool,
    pub disabled: bool,
    pub items: Vec<OwnItem>,
}

struct Classic {
    cm: IContextMenu,
    menu: HMENU,
}

struct Session {
    key: String,
    paths: Vec<String>,
    classic: Option<Classic>,
    data: Option<IDataObject>,
    open_with: Option<Vec<IAssocHandler>>,
}

impl Drop for Classic {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyMenu(self.menu);
        }
    }
}

/// Windows' New-menu handler for the desktop folder, its menu and the submenu holding the entries.
struct NewMenu {
    cm: IContextMenu,
    menu: HMENU,
    sub: HMENU,
}

impl Drop for NewMenu {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyMenu(self.menu);
        }
    }
}

type Job = Box<dyn FnOnce(HWND) + Send>;
static JOBS: Mutex<VecDeque<Job>> = Mutex::new(VecDeque::new());

thread_local! {
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
    static NEW_MENU: RefCell<Option<NewMenu>> = const { RefCell::new(None) };
    /// handlers that get the menu messages while a classic menu is tracked
    static ACTIVE: RefCell<Vec<IContextMenu>> = const { RefCell::new(Vec::new()) };
    static TRACKING: Cell<bool> = const { Cell::new(false) };
}

pub fn key_of(paths: &[String]) -> String {
    if paths.is_empty() {
        "desktop".into()
    } else {
        paths.iter().map(|p| util::norm_path(p)).collect::<Vec<_>>().join("\n")
    }
}

// ---------------------------------------------------------------- worker thread

fn worker() -> Result<HWND, String> {
    static HWND_V: OnceLock<Option<isize>> = OnceLock::new();
    let v = HWND_V.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        let spawned = std::thread::Builder::new().name("fe-ctxmenu".into()).spawn(move || unsafe {
            let _com = util::ComApartment::sta();
            let _ = OleInitialize(None);
            let class = w!("FolderExplorerMenuOwner");
            let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), lpszClassName: class, ..Default::default() };
            RegisterClassW(&wc);
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(WS_EX_TOOLWINDOW.0),
                class,
                w!("Folder Explorer menü"),
                WS_POPUP,
                0,
                0,
                0,
                0,
                None,
                None,
                None,
                None,
            );
            let ok = hwnd.as_ref().ok().map(|h| h.0 as isize);
            let _ = tx.send(ok);
            if ok.is_none() {
                return;
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
        if spawned.is_err() {
            return None;
        }
        rx.recv().ok().flatten()
    });
    v.map(util::hwnd_from).ok_or_else(|| "menü iş parçacığı başlatılamadı".to_string())
}

/// Runs `f` on the menu thread and waits for its result.
fn run<T: Send + 'static>(f: impl FnOnce(HWND) -> T + Send + 'static) -> Result<T, String> {
    let hwnd = worker()?;
    let (tx, rx) = mpsc::channel();
    JOBS.lock().unwrap().push_back(Box::new(move |h| {
        let _ = tx.send(f(h));
    }));
    unsafe { PostMessageW(Some(hwnd), WM_JOB, WPARAM(0), LPARAM(0)) }.map_err(|e| e.message())?;
    rx.recv().map_err(|_| "menü iş parçacığı yanıt vermedi".to_string())
}

fn run_jobs(hwnd: HWND) {
    // a job that tracks a menu runs a modal loop: the others wait until it is closed
    if TRACKING.with(|t| t.get()) {
        return;
    }
    loop {
        let Some(job) = JOBS.lock().unwrap().pop_front() else { break };
        job(hwnd);
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_JOB => {
            run_jobs(hwnd);
            return LRESULT(0);
        }
        WM_INITMENUPOPUP | WM_DRAWITEM | WM_MEASUREITEM | WM_MENUCHAR => {
            let handlers = ACTIVE.with(|a| a.borrow().clone());
            for cm in handlers {
                if let Ok(cm3) = cm.cast::<IContextMenu3>() {
                    let mut res = LRESULT(0);
                    if cm3.HandleMenuMsg2(msg, wparam, lparam, Some(&mut res)).is_ok() && msg != WM_INITMENUPOPUP {
                        return res;
                    }
                } else if msg != WM_MENUCHAR {
                    if let Ok(cm2) = cm.cast::<IContextMenu2>() {
                        let _ = cm2.HandleMenuMsg(msg, wparam, lparam);
                    }
                }
            }
            if msg == WM_INITMENUPOPUP {
                return LRESULT(0);
            }
        }
        _ => {}
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

// ---------------------------------------------------------------- sessions

/// The session for `paths` (empty = the desktop background), replacing the previous one.
fn session<T>(paths: &[String], f: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
    let key = key_of(paths);
    SESSION.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.as_ref().map(|s| s.key != key).unwrap_or(true) {
            *slot = Some(Session { key, paths: paths.to_vec(), classic: None, data: None, open_with: None });
        }
        f(slot.as_mut().unwrap())
    })
}

/// A UI object (context menu, data object) for items in the folder of the first one.
unsafe fn ui_object<T: Interface>(paths: &[String], hwnd: HWND) -> Result<T, String> {
    let pidls: Vec<(String, shell::Pidl)> =
        paths.iter().filter_map(|p| shell::parse_pidl(p).ok().map(|pidl| (p.clone(), pidl))).collect();
    let Some((first_path, first)) = pidls.first() else {
        return Err("öğe bulunamadı".into());
    };
    let mut last: *mut ITEMIDLIST = std::ptr::null_mut();
    let folder: IShellFolder = SHBindToParent(first.0, Some(&mut last)).map_err(|e| e.message())?;
    let key = shell::parent_key(first_path);
    let mut children: Vec<*const ITEMIDLIST> = vec![last as *const _];
    for (p, pidl) in pidls.iter().skip(1) {
        if shell::parent_key(p) == key {
            children.push(ILFindLastID(pidl.0) as *const _);
        }
    }
    folder.GetUIObjectOf(hwnd, &children, None).map_err(|e| e.message())
}

unsafe fn ensure_classic(s: &mut Session, hwnd: HWND) -> Result<(), String> {
    if s.classic.is_some() {
        return Ok(());
    }
    let cm: IContextMenu = if s.paths.is_empty() {
        let desk: IShellFolder = SHGetDesktopFolder().map_err(|e| e.message())?;
        desk.CreateViewObject(hwnd).map_err(|e| e.message())?
    } else {
        ui_object(&s.paths, hwnd)?
    };
    let menu = CreatePopupMenu().map_err(|e| e.message())?;
    let mut flags = CMF_NORMAL;
    if !s.paths.is_empty() {
        flags |= CMF_CANRENAME;
    }
    if GetKeyState(VK_SHIFT.0 as i32) < 0 {
        flags |= CMF_EXTENDEDVERBS;
    }
    if let Err(e) = cm.QueryContextMenu(menu, 0, SHELL_FIRST, SHELL_LAST, flags).ok() {
        let _ = DestroyMenu(menu);
        return Err(e.message());
    }
    s.classic = Some(Classic { cm, menu });
    Ok(())
}

unsafe fn ensure_open_with(s: &mut Session, hwnd: HWND) {
    if s.open_with.is_some() {
        return;
    }
    s.open_with = Some(if s.paths.len() == 1 { assoc_handlers(&s.paths[0]) } else { vec![] });
    if s.data.is_none() && !s.paths.is_empty() {
        s.data = ui_object(&s.paths, hwnd).ok();
    }
}

/// Windows' own New submenu for the user's desktop folder.
unsafe fn build_new_menu() -> Result<NewMenu, String> {
    let init: IShellExtInit = CoCreateInstance(&CLSID_NewMenu, None, CLSCTX_INPROC_SERVER).map_err(|e| e.message())?;
    let pidl = shell::parse_pidl(&util::user_desktop_dir())?;
    init.Initialize(Some(pidl.0 as *const _), None::<&IDataObject>, None).map_err(|e| e.message())?;
    let cm: IContextMenu = init.cast().map_err(|e| e.message())?;
    let menu = CreatePopupMenu().map_err(|e| e.message())?;
    if let Err(e) = cm.QueryContextMenu(menu, 0, NEW_FIRST, NEW_LAST, CMF_NORMAL).ok() {
        let _ = DestroyMenu(menu);
        return Err(e.message());
    }
    let sub = GetSubMenu(menu, 0);
    if sub.is_invalid() {
        let _ = DestroyMenu(menu);
        return Err("Yeni menüsü boş".into());
    }
    // the handler fills its submenu only when it is about to open
    if let Ok(cm3) = cm.cast::<IContextMenu3>() {
        let mut res = LRESULT(0);
        let _ = cm3.HandleMenuMsg2(WM_INITMENUPOPUP, WPARAM(sub.0 as usize), LPARAM(0), Some(&mut res));
    } else if let Ok(cm2) = cm.cast::<IContextMenu2>() {
        let _ = cm2.HandleMenuMsg(WM_INITMENUPOPUP, WPARAM(sub.0 as usize), LPARAM(0));
    }
    Ok(NewMenu { cm, menu, sub })
}

// ---------------------------------------------------------------- reading menus

struct Entry {
    id: u32,
    text: String,
    ftype: u32,
    sub: HMENU,
    bitmap: HBITMAP,
    disabled: bool,
}

unsafe fn entries(menu: HMENU) -> Vec<Entry> {
    let n = GetMenuItemCount(Some(menu)).max(0) as u32;
    let mut out = Vec::new();
    for i in 0..n {
        let mut mi = MENUITEMINFOW {
            cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
            fMask: MIIM_ID | MIIM_FTYPE | MIIM_STRING | MIIM_SUBMENU | MIIM_BITMAP | MIIM_STATE,
            ..Default::default()
        };
        if GetMenuItemInfoW(menu, i, true, &mut mi).is_err() {
            continue;
        }
        let mut text = String::new();
        if mi.cch > 0 && (mi.fType.0 & MFT_OWNERDRAW.0) == 0 {
            let mut buf = vec![0u16; mi.cch as usize + 1];
            mi.dwTypeData = PWSTR(buf.as_mut_ptr());
            mi.cch += 1;
            if GetMenuItemInfoW(menu, i, true, &mut mi).is_ok() {
                text = util::wide_to_string(&buf);
            }
        }
        out.push(Entry {
            id: mi.wID,
            text,
            ftype: mi.fType.0,
            sub: mi.hSubMenu,
            bitmap: mi.hbmpItem,
            disabled: (mi.fState.0 & MFS_DISABLED.0) != 0,
        });
    }
    out
}

unsafe fn all_entries(menu: HMENU, depth: u32, out: &mut Vec<Entry>) {
    for e in entries(menu) {
        if !e.sub.is_invalid() && depth < 2 {
            all_entries(e.sub, depth + 1, out);
        }
        out.push(e);
    }
}

/// Menu text without the "&" access-key marker and the "\t" accelerator part.
fn clean(text: &str) -> String {
    let t = text.split('\t').next().unwrap_or("");
    let mut out = String::with_capacity(t.len());
    let mut chars = t.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '&' {
            if chars.peek() == Some(&'&') {
                out.push('&');
                chars.next();
            }
        } else {
            out.push(c);
        }
    }
    out.trim().to_string()
}

unsafe fn command_verb(cm: &IContextMenu, offset: usize) -> Option<String> {
    let mut buf = [0u16; 260];
    cm.GetCommandString(offset, GCS_VERBW, None, windows::core::PSTR(buf.as_mut_ptr() as *mut u8), buf.len() as u32)
        .ok()?;
    let s = util::wide_to_string(&buf);
    (!s.is_empty()).then_some(s)
}

unsafe fn verbs_of(c: &Classic) -> Vec<String> {
    let mut all = Vec::new();
    all_entries(c.menu, 0, &mut all);
    let mut out: Vec<String> = Vec::new();
    for e in all {
        if !e.sub.is_invalid() || e.ftype & MFT_SEPARATOR.0 != 0 || e.disabled || !(SHELL_FIRST..=SHELL_LAST).contains(&e.id) {
            continue;
        }
        if let Some(v) = command_verb(&c.cm, (e.id - SHELL_FIRST) as usize) {
            if !out.iter().any(|x| x.eq_ignore_ascii_case(&v)) {
                out.push(v);
            }
        }
    }
    out
}

unsafe fn new_entries(sub: HMENU) -> Vec<NewItem> {
    let mut out: Vec<NewItem> = Vec::new();
    for e in entries(sub) {
        if e.ftype & MFT_SEPARATOR.0 != 0 {
            if out.last().is_some_and(|l| l.id != 0) {
                out.push(NewItem { id: 0, text: String::new(), icon: None });
            }
            continue;
        }
        let text = clean(&e.text);
        if text.is_empty() || !(NEW_FIRST..=NEW_LAST).contains(&e.id) {
            continue;
        }
        // HBMMENU_* constants are small integers, not real bitmaps
        let b = e.bitmap.0 as isize;
        let icon = if !(-1..=16).contains(&b) { bitmap_url(e.bitmap) } else { None };
        out.push(NewItem { id: e.id, text, icon });
    }
    if out.last().is_some_and(|l| l.id == 0) {
        out.pop();
    }
    out
}

unsafe fn bitmap_url(b: HBITMAP) -> Option<String> {
    let (w, h, rgba) = icons::bitmap_rgba(b).ok()?;
    let png = icons::encode_png(w, h, &rgba).ok()?;
    Some(format!("data:image/png;base64,{}", util::base64(&png)))
}

unsafe fn icon_url(hicon: HICON) -> Option<String> {
    let mut info = ICONINFO::default();
    GetIconInfo(hicon, &mut info).ok()?;
    let url = if !info.hbmColor.is_invalid() { bitmap_url(info.hbmColor) } else { None };
    let _ = DeleteObject(HGDIOBJ(info.hbmColor.0));
    let _ = DeleteObject(HGDIOBJ(info.hbmMask.0));
    url
}

unsafe fn take_pwstr(p: PWSTR) -> Option<String> {
    if p.is_null() {
        return None;
    }
    let s = p.to_string().ok();
    CoTaskMemFree(Some(p.0 as *const _));
    s.filter(|s| !s.is_empty())
}

/// The icon of an Open-with app: "@{package…}" resources resolve to an image file, anything else is
/// an icon resource of an exe/dll.
unsafe fn handler_icon(h: &IAssocHandler) -> Option<String> {
    let mut loc = PWSTR::null();
    let mut index = 0;
    h.GetIconLocation(&mut loc, &mut index).ok()?;
    let loc = take_pwstr(loc)?;
    if loc.starts_with('@') {
        let mut buf = [0u16; 1024];
        SHLoadIndirectString(&HSTRING::from(loc.as_str()), &mut buf, None).ok()?;
        let file = util::wide_to_string(&buf);
        let bytes = std::fs::read(&file).ok()?;
        return Some(format!("data:{};base64,{}", icons::sniff_mime(&bytes, &file), util::base64(&bytes)));
    }
    let mut large = HICON::default();
    if SHDefExtractIconW(&HSTRING::from(loc.as_str()), index, 0, Some(&mut large), None, 32).is_ok() && !large.is_invalid() {
        let url = icon_url(large);
        let _ = DestroyIcon(large);
        if url.is_some() {
            return url;
        }
    }
    std::path::Path::new(&loc).is_file().then_some(loc)
}

fn assoc_handlers(path: &str) -> Vec<IAssocHandler> {
    let p = std::path::Path::new(path);
    let Some(ext) = p.extension().map(|e| format!(".{}", e.to_string_lossy().to_lowercase())) else { return vec![] };
    if p.is_dir() || [".exe", ".lnk", ".url", ".bat", ".cmd", ".com", ".msi", ".scr", ".pif"].contains(&ext.as_str()) {
        return vec![];
    }
    let mut out = Vec::new();
    unsafe {
        let Ok(en) = SHAssocEnumHandlers(&HSTRING::from(ext.as_str()), ASSOC_FILTER_RECOMMENDED) else { return out };
        loop {
            let mut one: [Option<IAssocHandler>; 1] = [None];
            let mut got = 0u32;
            if en.Next(&mut one, Some(&mut got)).is_err() || got == 0 {
                break;
            }
            if let Some(h) = one[0].take() {
                out.push(h);
            }
            if out.len() >= 12 {
                break;
            }
        }
    }
    out
}

unsafe fn invoke_offset(cm: &IContextMenu, offset: usize, hwnd: HWND, pt: Option<POINT>) -> Result<(), String> {
    let pt = pt.unwrap_or_else(|| {
        let mut p = POINT::default();
        let _ = GetCursorPos(&mut p);
        p
    });
    shell::invoke_id(cm, offset, hwnd, pt)
}

// ---------------------------------------------------------------- API (any thread)

/// Enumerate Open with apps (one file) or Windows' New
/// list (desktop).
pub fn prepare_quick(paths: Vec<String>) -> Result<MenuExtra, String> {
    run(move |hwnd| unsafe {
        let key = key_of(&paths);
        if paths.is_empty() {
            NEW_MENU.with(|n| *n.borrow_mut() = None);
            let built = build_new_menu();
            let items = match &built {
                Ok(n) => new_entries(n.sub),
                Err(e) => {
                    crate::dlog!("new menu: {e}");
                    vec![]
                }
            };
            NEW_MENU.with(|n| *n.borrow_mut() = built.ok());
            return Ok(MenuExtra { key, new_items: Some(items), ..Default::default() });
        }
        session(&paths, |s| {
            ensure_open_with(s, hwnd);
            let list = s
                .open_with
                .as_ref()
                .map(|hs| {
                    hs.iter()
                        .enumerate()
                        .filter_map(|(index, h)| {
                            let name = take_pwstr(h.GetUIName().ok()?)?;
                            Some(Handler { index, name, icon: handler_icon(h) })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(MenuExtra { key: key.clone(), open_with: Some(list), ..Default::default() })
        })
    })?
}

/// Windows' classic menu at `at` (physical px). Rename/delete stay with the desktop's undo flow;
/// other commands are executed by their original Shell handler.
pub fn show(paths: Vec<String>, at: Option<POINT>) -> Result<Option<String>, String> {
    run(move |hwnd| {
        session(&paths, |s| unsafe {
            // Clipboard state, Shift and installed shell extensions can change between clicks.
            s.classic = None;
            ensure_classic(s, hwnd)?;
            let c = s.classic.as_ref().unwrap();
            let pt = at.unwrap_or_else(|| {
                let mut p = POINT::default();
                let _ = GetCursorPos(&mut p);
                p
            });
            ACTIVE.with(|a| *a.borrow_mut() = vec![c.cm.clone()]);
            TRACKING.with(|t| t.set(true));
            let _ = SetForegroundWindow(hwnd);
            let cmd = TrackPopupMenuEx(c.menu, (TPM_RETURNCMD | TPM_RIGHTBUTTON).0, pt.x, pt.y, hwnd, None).0 as u32;
            let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));
            TRACKING.with(|t| t.set(false));
            ACTIVE.with(|a| a.borrow_mut().clear());
            let _ = PostMessageW(Some(hwnd), WM_JOB, WPARAM(0), LPARAM(0));
            match cmd {
                0 => Ok(None),
                c2 => {
                    let offset = (c2 - SHELL_FIRST) as usize;
                    let verb = command_verb(&c.cm, offset);
                    match verb.as_deref().map(|v| v.to_ascii_lowercase()) {
                        Some(v) if !s.paths.is_empty() && (v == "rename" || v == "delete") => Ok(Some(v)),
                        _ => invoke_offset(&c.cm, offset, hwnd, Some(pt)).map(|_| Some(verb.unwrap_or_default())),
                    }
                }
            }
        })
    })?
}

/// Native Win32 popup for app-only objects. Never includes a desktop Shell menu.
pub fn show_own(items: Vec<OwnItem>, at: Option<POINT>) -> Result<Option<String>, String> {
    run(move |hwnd| unsafe {
        let menu = CreatePopupMenu().map_err(|e| e.message())?;
        let mut ids = Vec::new();
        let mut pos = 0;
        for item in &items {
            if let Err(e) = insert_own(menu, &mut pos, item, &mut ids) {
                let _ = DestroyMenu(menu);
                return Err(e);
            }
        }
        let mut pt = at.unwrap_or_default();
        if at.is_none() { let _ = GetCursorPos(&mut pt); }
        TRACKING.with(|t| t.set(true));
        let _ = SetForegroundWindow(hwnd);
        let cmd = TrackPopupMenuEx(menu, (TPM_RETURNCMD | TPM_RIGHTBUTTON).0, pt.x, pt.y, hwnd, None).0 as u32;
        let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));
        TRACKING.with(|t| t.set(false));
        let _ = DestroyMenu(menu);
        let _ = PostMessageW(Some(hwnd), WM_JOB, WPARAM(0), LPARAM(0));
        Ok(cmd.checked_sub(OWN_FIRST).and_then(|index| ids.get(index as usize).cloned()))
    })?
}

unsafe fn insert_own(
    menu: HMENU,
    pos: &mut u32,
    it: &OwnItem,
    ids: &mut Vec<String>,
) -> Result<(), String> {
    let text_w: Vec<u16> = it.text.encode_utf16().chain(Some(0)).collect();
    let mut mi = MENUITEMINFOW { cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32, ..Default::default() };
    if it.sep {
        mi.fMask = MIIM_FTYPE;
        mi.fType = MFT_SEPARATOR;
    } else {
        mi.fMask = MIIM_FTYPE | MIIM_STRING | MIIM_ID | MIIM_STATE;
        mi.fType = if it.radio { MFT_STRING | MFT_RADIOCHECK } else { MFT_STRING };
        mi.dwTypeData = PWSTR(text_w.as_ptr() as *mut u16);
        mi.wID = OWN_FIRST + ids.len() as u32;
        ids.push(it.id.clone());
        let mut state = 0;
        if it.checked {
            state |= MFS_CHECKED.0;
        }
        if it.disabled {
            state |= MFS_DISABLED.0;
        }
        mi.fState = MENU_ITEM_STATE(state);
        if !it.items.is_empty() {
            let sub = CreatePopupMenu().map_err(|e| e.message())?;
            let mut sub_pos = 0;
            for k in &it.items {
                if let Err(e) = insert_own(sub, &mut sub_pos, k, ids) {
                    let _ = DestroyMenu(sub);
                    return Err(e);
                }
            }
            mi.fMask |= MIIM_SUBMENU;
            mi.hSubMenu = sub;
        }
    }
    if let Err(e) = InsertMenuItemW(menu, *pos, true, &mi) {
        if !mi.hSubMenu.is_invalid() { let _ = DestroyMenu(mi.hSubMenu); }
        return Err(e.message());
    }
    *pos += 1;
    Ok(())
}

/// Runs the first of `verbs` ("pintohome", "Windows.ModernShare", "paste"…) that the classic menu
/// for `paths` (empty = the desktop background) offers. Returns false when it offers none.
pub fn invoke_verb(paths: Vec<String>, verbs: Vec<String>) -> Result<bool, String> {
    run(move |hwnd| {
        session(&paths, |s| unsafe {
            ensure_classic(s, hwnd)?;
            let c = s.classic.as_ref().unwrap();
            let mut all = Vec::new();
            all_entries(c.menu, 0, &mut all);
            for verb in &verbs {
                for e in &all {
                    if !e.sub.is_invalid() || e.disabled || !(SHELL_FIRST..=SHELL_LAST).contains(&e.id) {
                        continue;
                    }
                    let offset = (e.id - SHELL_FIRST) as usize;
                    if command_verb(&c.cm, offset).is_some_and(|v| v.eq_ignore_ascii_case(verb)) {
                        invoke_offset(&c.cm, offset, hwnd, None)?;
                        return Ok(true);
                    }
                }
            }
            Ok(false)
        })
    })?
}

/// An entry of the desktop's New ▸ list (ids from `MenuExtra::new_items`).
pub fn invoke_new(id: u32) -> Result<(), String> {
    run(move |hwnd| unsafe {
        if NEW_MENU.with(|n| n.borrow().is_none()) {
            NEW_MENU.with(|n| *n.borrow_mut() = build_new_menu().ok());
        }
        NEW_MENU.with(|n| {
            let n = n.borrow();
            let m = n.as_ref().ok_or("Yeni menüsü yok")?;
            if !(NEW_FIRST..=NEW_LAST).contains(&id) {
                return Err("geçersiz öğe".to_string());
            }
            invoke_offset(&m.cm, (id - NEW_FIRST) as usize, hwnd, None)
        })
    })?
}

/// Open with ▸: app `index` from `MenuExtra::open_with`, or `None` for Windows' "choose another app".
pub fn open_with(paths: Vec<String>, index: Option<usize>) -> Result<(), String> {
    run(move |hwnd| {
        session(&paths, |s| unsafe {
            match index {
                Some(i) => {
                    ensure_open_with(s, hwnd);
                    let h = s.open_with.as_ref().and_then(|l| l.get(i)).ok_or("uygulama bulunamadı")?;
                    let data = s.data.as_ref().ok_or("öğe bulunamadı")?;
                    h.Invoke(data).map_err(|e| e.message())
                }
                None => {
                    let file = HSTRING::from(s.paths.first().ok_or("öğe yok")?.as_str());
                    let info = OPENASINFO {
                        pcszFile: PCWSTR(file.as_ptr()),
                        pcszClass: PCWSTR::null(),
                        oaifInFlags: OAIF_ALLOW_REGISTRATION | OAIF_REGISTER_EXT | OAIF_EXEC,
                    };
                    SHOpenWithDialog(Some(hwnd), &info).map_err(|e| e.message())
                }
            }
        })
    })?
}

/// `--menutest [paths…]`: the classic menu (entries + verbs), New ▸ and Open with ▸ for `paths`.
pub fn describe(paths: Vec<String>) -> Result<String, String> {
    let t = std::time::Instant::now();
    let quick = prepare_quick(paths.clone())?;
    let quick_ms = t.elapsed().as_millis();
    run(move |hwnd| {
        session(&paths, |s| unsafe {
            let t = std::time::Instant::now();
            ensure_classic(s, hwnd)?;
            let mut out = format!("quick part {quick_ms} ms, classic menu {} ms\n", t.elapsed().as_millis());
            let c = s.classic.as_ref().unwrap();
            dump(&c.cm, c.menu, 0, &mut out);
            out.push_str(&format!("verbs: {:?}\n", verbs_of(c)));
            if let Some(n) = &quick.new_items {
                let names: Vec<String> =
                    n.iter().map(|i| format!("{}#{}{}", i.text, i.id, if i.icon.is_some() { "+icon" } else { "" })).collect();
                out.push_str(&format!("new: {names:?}\n"));
            }
            if let Some(o) = &quick.open_with {
                let names: Vec<String> =
                    o.iter().map(|h| format!("{}{}", h.name, if h.icon.is_some() { "+icon" } else { "" })).collect();
                out.push_str(&format!("open with: {names:?}\n"));
            }
            Ok(out)
        })
    })?
}

unsafe fn dump(cm: &IContextMenu, menu: HMENU, depth: usize, out: &mut String) {
    for e in entries(menu) {
        let pad = "  ".repeat(depth);
        if e.ftype & MFT_SEPARATOR.0 != 0 {
            out.push_str(&format!("{pad}----\n"));
            continue;
        }
        let verb = if e.sub.is_invalid() && (SHELL_FIRST..=SHELL_LAST).contains(&e.id) {
            command_verb(cm, (e.id - SHELL_FIRST) as usize).unwrap_or_default()
        } else {
            String::new()
        };
        let od = if e.ftype & MFT_OWNERDRAW.0 != 0 { " (ownerdraw)" } else { "" };
        let dis = if e.disabled { " (disabled)" } else { "" };
        out.push_str(&format!("{pad}{} [{verb}]{od}{dis}\n", clean(&e.text)));
        if !e.sub.is_invalid() && depth < 2 {
            dump(cm, e.sub, depth + 1, out);
        }
    }
}
