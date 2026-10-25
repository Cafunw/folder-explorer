//! Explorer owns the default Windows desktop-item menu (including Windows 11's modern menu).
//! IContextMenu/TrackPopupMenuEx would bypass it and open "Show more options" directly.

use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use windows::core::{w, Interface, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HANDLE, HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, IServiceProvider, CLSCTX_ALL};
use windows::Win32::System::Variant::{VARIANT, VT_I4};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Shell::Common::{ITEMIDLIST, STRRET};
use windows::Win32::UI::Shell::{
    IEnumIDList, IFolderView, IShellBrowser, IShellFolder, IShellView, IShellWindows, ShellWindows, StrRetToStrW,
    SHGDN_FORPARSING, SID_STopLevelBrowser, SVGIO_ALLVIEW, SVSI_DESELECTOTHERS, SVSI_FOCUSED,
    SVSI_SELECT, SWC_DESKTOP, SWFO_NEEDDISPATCH,
};
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::{desktop_window, util};
use tauri::Emitter;

static OPEN_LOCK: Mutex<()> = Mutex::new(());
static OPEN_TOKEN: AtomicU64 = AtomicU64::new(0);

/// A menu is about to open: stops the previous menu's observer and returns the new menu's token.
pub fn cancel_observer() -> u64 {
    OPEN_TOKEN.fetch_add(1, Ordering::SeqCst) + 1
}
// Scalar HWND properties let the existing watchdog recover even after the app is killed.
const STYLE: PCWSTR = w!("FolderExplorer.MenuView.Style");
const X: PCWSTR = w!("FolderExplorer.MenuView.X");
const Y: PCWSTR = w!("FolderExplorer.MenuView.Y");
const VISIBLE: PCWSTR = w!("FolderExplorer.MenuView.Visible");
const ALPHA: PCWSTR = w!("FolderExplorer.MenuView.Alpha");
const COLOR: PCWSTR = w!("FolderExplorer.MenuView.Color");
const FLAGS: PCWSTR = w!("FolderExplorer.MenuView.Flags");

pub fn is_staged(lv: HWND) -> bool {
    unsafe { !GetPropW(lv, STYLE).is_invalid() }
}

/// Restores the view window, never the positions of individual Windows icons.
pub fn restore_view() {
    let Some(lv) = desktop_window::find_listview() else { return };
    unsafe {
        let saved = GetPropW(lv, STYLE).0 as isize;
        if saved == 0 { return; }
        let style = saved - 1;
        let visible = GetPropW(lv, VISIBLE).0 as isize == 2;
        let x = GetPropW(lv, X).0 as isize as i32;
        let y = GetPropW(lv, Y).0 as isize as i32;
        let _ = ShowWindow(lv, SW_HIDE);
        let _ = SetWindowPos(lv, None, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
        SetWindowLongPtrW(lv, GWL_EXSTYLE, style);
        if style & WS_EX_LAYERED.0 as isize != 0 {
            let alpha = (GetPropW(lv, ALPHA).0 as isize - 1) as u8;
            let color = GetPropW(lv, COLOR).0 as usize as u32;
            let flags = GetPropW(lv, FLAGS).0 as usize as u32;
            let _ = SetLayeredWindowAttributes(lv, COLORREF(color), alpha, LAYERED_WINDOW_ATTRIBUTES_FLAGS(flags));
        }
        for key in [X, Y, VISIBLE, ALPHA, COLOR, FLAGS, STYLE] { let _ = RemovePropW(lv, key); }
        if visible { let _ = ShowWindow(lv, SW_SHOWNA); }
    }
}

struct StagedView;
impl Drop for StagedView {
    fn drop(&mut self) { restore_view(); }
}

unsafe fn stage_view(lv: HWND, at: POINT, item: POINT, spacing: POINT) -> Result<StagedView, String> {
    restore_view();
    let style = GetWindowLongPtrW(lv, GWL_EXSTYLE);
    let mut rect = RECT::default();
    GetWindowRect(lv, &mut rect).map_err(|e| e.message())?;
    let parent = GetParent(lv).map_err(|e| e.message())?;
    let mut parent_origin = POINT::default();
    if !ClientToScreen(parent, &mut parent_origin).as_bool() { return Err("masaüstü koordinatları okunamadı".into()); }
    let (x, y) = (rect.left - parent_origin.x, rect.top - parent_origin.y);
    let mut origin = POINT::default();
    if !ClientToScreen(lv, &mut origin).as_bool() { return Err("simge koordinatları okunamadı".into()); }
    let mut alpha = 255u8;
    let mut color = COLORREF(0);
    let mut flags = LWA_ALPHA;
    let _ = GetLayeredWindowAttributes(lv, Some(&mut color), Some(&mut alpha), Some(&mut flags));
    let values = [
        (X, x as isize), (Y, y as isize), (VISIBLE, if IsWindowVisible(lv).as_bool() { 2 } else { 1 }),
        (ALPHA, alpha as isize + 1), (COLOR, color.0 as isize), (FLAGS, flags.0 as isize), (STYLE, style + 1),
    ];
    for (key, value) in values {
        if let Err(e) = SetPropW(lv, key, Some(HANDLE(value as *mut _))) {
            for (key, _) in values { let _ = RemovePropW(lv, key); }
            return Err(e.message());
        }
    }
    let guard = StagedView;
    // Explorer requires a visible icon view to open an item menu. It is fully transparent only
    // while that menu is created; the app's hide guard recognizes the saved STYLE property.
    SetWindowLongPtrW(lv, GWL_EXSTYLE, style | WS_EX_LAYERED.0 as isize);
    SetLayeredWindowAttributes(lv, COLORREF(0), 0, LWA_ALPHA).map_err(|e| e.message())?;
    let sx = if spacing.x > 0 { spacing.x } else { 75 };
    let dx = at.x - (origin.x + item.x + sx / 2);
    let dy = at.y - (origin.y + item.y + 28);
    SetWindowPos(lv, None, x + dx, y + dy, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
        .map_err(|e| e.message())?;
    let _ = ShowWindow(lv, SW_SHOWNA);
    Ok(guard)
}

pub fn menu_kind() -> Option<&'static str> {
    let dv = desktop_window::find_defview()?;
    unsafe {
        let mut info = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
        GetGUIThreadInfo(GetWindowThreadProcessId(dv, None), &mut info).ok()?;
        if !info.hwndActive.is_invalid() && desktop_window::class_name(info.hwndActive).starts_with("XamlExplorerHostIslandWindow") {
            Some("modern")
        } else if info.flags.0 & 4 != 0 { Some("classic") } else { None }
    }
}

fn focus_window(hwnd: HWND) {
    unsafe {
        if SetForegroundWindow(hwnd).as_bool() { return; }
        let current = GetCurrentThreadId();
        let foreground = GetWindowThreadProcessId(GetForegroundWindow(), None);
        let attached = foreground != 0 && current != foreground && AttachThreadInput(current, foreground, true).as_bool();
        let _ = SetForegroundWindow(hwnd);
        if attached { let _ = AttachThreadInput(current, foreground, false); }
    }
}

pub fn dismiss() {
    let Some(dv) = desktop_window::find_defview() else { return };
    unsafe {
        let _ = SendMessageTimeoutW(dv, WM_CANCELMODE, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 200, None);
        focus_window(GetAncestor(dv, GA_ROOT));
    }
}

/// The native view is hidden again after opening. If Explorer starts inline rename there,
/// hand it to the desktop's visible editor instead of leaving an invisible input focused.
/// Watches the Explorer menu of `token` until it is gone, then `linger` longer. If Explorer starts
/// renaming in its hidden icon view (Rename, New ▸ …), that edit is cancelled and `action` goes to the
/// desktop as a menu action, so our rename takes over. The keyboard comes back to our desktop when
/// Explorer's desktop kept it after the menu.
fn observe_menu(token: u64, linger: Duration, action: serde_json::Value) {
    let Some(app) = util::app().cloned() else { return };
    std::thread::spawn(move || {
        let current = || OPEN_TOKEN.load(Ordering::SeqCst) == token;
        let start = Instant::now();
        // the menu was posted: give it a moment to open
        while current() && menu_kind().is_none() && start.elapsed() < Duration::from_secs(4) {
            std::thread::sleep(Duration::from_millis(20));
        }
        let mut gone: Option<Instant> = None;
        let mut refocused = false;
        while current() && start.elapsed() < Duration::from_secs(600) {
            if cancel_explorer_edit() {
                let _ = app.emit_to("desktop", "menu-action", action);
                break;
            }
            if menu_kind().is_some() {
                gone = None;
            } else {
                let since = gone.get_or_insert_with(Instant::now).elapsed();
                if since >= Duration::from_millis(250) && !refocused {
                    refocus_desktop();
                    refocused = true;
                }
                if since >= linger {
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        if current() {
            refocus_desktop();
        }
    });
}

/// Explorer is renaming in its hidden icon view: cancel that edit (the name stays as it was).
fn cancel_explorer_edit() -> bool {
    let Some(lv) = desktop_window::find_listview() else { return false };
    let mut edit = 0usize;
    unsafe {
        let _ = SendMessageTimeoutW(lv, 0x1018 /* LVM_GETEDITCONTROL */, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 100, Some(&mut edit));
        if edit == 0 {
            return false;
        }
        let _ = SendMessageTimeoutW(lv, 0x10B3 /* LVM_CANCELEDITLABEL */, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 100, None);
    }
    true
}

/// After a menu, keys go back to our desktop if Explorer's desktop kept the focus.
fn refocus_desktop() {
    unsafe {
        let class = desktop_window::class_name(GetForegroundWindow());
        if matches!(class.as_str(), "Progman" | "WorkerW") || class.starts_with("XamlExplorerHostIslandWindow") {
            let desktop = desktop_window::desktop_hwnd();
            if !desktop.is_invalid() { focus_window(desktop); }
        }
    }
}

/// The empty-desktop menu (posted by `desktop_window::show_context_menu`): an item made with New ▸
/// that Explorer wants renamed is renamed by us instead. Creating can take a few seconds (templates).
pub fn observe_desktop_menu(token: u64) {
    let action = serde_json::json!({
        "id": "renameNew", "target": "desktop", "ids": [], "paths": [], "at": [0, 0], "cell": null, "canPaste": false,
    });
    observe_menu(token, Duration::from_secs(5), action);
}

/// Explorer's desktop shell view (the one behind the hidden icon list) and its folder view.
unsafe fn desktop_view() -> Result<(IShellView, IFolderView), String> {
    let sw: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL).map_err(|e| e.message())?;
    let mut loc = VARIANT::default();
    (*loc.Anonymous.Anonymous).vt = VT_I4;
    let mut hwnd_i = 0i32;
    let disp = sw.FindWindowSW(&loc, &VARIANT::default(), SWC_DESKTOP, &mut hwnd_i, SWFO_NEEDDISPATCH).map_err(|e| e.message())?;
    let sp: IServiceProvider = disp.cast().map_err(|e| e.message())?;
    let browser: IShellBrowser = sp.QueryService(&SID_STopLevelBrowser).map_err(|e| e.message())?;
    let view = browser.QueryActiveShellView().map_err(|e| e.message())?;
    let fv: IFolderView = view.cast().map_err(|e| e.message())?;
    Ok((view, fv))
}

/// Selects exactly `paths` (parsing names) in the view, `focus` focused. Returns the paths that
/// were not found and the focused item's position.
unsafe fn select_paths(view: &IShellView, fv: &IFolderView, paths: &[String], focus: Option<&str>) -> Result<(HashSet<String>, Option<POINT>), String> {
    let mut wanted: HashSet<String> = paths.iter().map(|p| util::norm_path(p)).collect();
    view.SelectItem(std::ptr::null(), SVSI_DESELECTOTHERS.0 as u32).map_err(|e| e.message())?;
    if wanted.is_empty() { return Ok((wanted, None)); }
    let focus = focus.map(util::norm_path);
    let folder: IShellFolder = fv.GetFolder().map_err(|e| e.message())?;
    let en: IEnumIDList = fv.Items(SVGIO_ALLVIEW).map_err(|e| e.message())?;
    let mut position = None;
    while !wanted.is_empty() {
        let mut arr: [*mut ITEMIDLIST; 1] = [std::ptr::null_mut()];
        let mut fetched = 0;
        if en.Next(&mut arr, Some(&mut fetched)).is_err() || fetched == 0 || arr[0].is_null() { break; }
        let pidl = arr[0];
        let mut name = STRRET::default();
        let mut selected = Ok(());
        if folder.GetDisplayNameOf(pidl, SHGDN_FORPARSING, &mut name).is_ok() {
            let mut pw = windows::core::PWSTR::null();
            if StrRetToStrW(&mut name, Some(pidl), &mut pw).is_ok() {
                let path = util::norm_path(&util::take_pwstr(pw));
                if wanted.remove(&path) {
                    let focused = focus.as_deref() == Some(path.as_str());
                    selected = view.SelectItem(pidl, (SVSI_SELECT.0 | if focused { SVSI_FOCUSED.0 } else { 0 }) as u32);
                    if focused { position = fv.GetItemPosition(pidl).ok(); }
                }
            }
        }
        CoTaskMemFree(Some(pidl as *const _));
        selected.map_err(|e| e.message())?;
    }
    Ok((wanted, position))
}

static MIRROR_GEN: AtomicU64 = AtomicU64::new(0);

/// Keeps Explorer's hidden desktop view selected like our icons, so tools that read the desktop's
/// selection through the Shell (Filee's shortcut, preview apps) get the icons selected here.
/// Paths that are not in Explorer's view (live-folder entries) are skipped; a newer call wins.
pub fn mirror_selection(paths: Vec<String>) -> Result<(), String> {
    let generation = MIRROR_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    util::run_sta(move || unsafe {
        let _lock = OPEN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        if MIRROR_GEN.load(Ordering::SeqCst) != generation { return Ok(()); }
        let (view, fv) = desktop_view()?;
        select_paths(&view, &fv, &paths, None).map(|_| ())
    })?
}

/// Paths are parsing names of real desktop items, with the clicked item first.
pub fn show_items(paths: Vec<String>, at: Option<POINT>) -> Result<&'static str, String> {
    if paths.is_empty() { return Err("menü için simge seçilmedi".into()); }
    let token = cancel_observer();
    util::run_sta(move || unsafe {
        let _lock = OPEN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dv = desktop_window::find_defview().ok_or("Windows masaüstü görünümü bulunamadı")?;
        let lv = desktop_window::find_listview().ok_or("Windows simge görünümü bulunamadı")?;
        let (view, fv) = desktop_view()?;
        let (missing, position) = select_paths(&view, &fv, &paths, Some(&paths[0]))?;
        if !missing.is_empty() { return Err("seçilen simgeler Windows masaüstünde bulunamadı".into()); }
        let position = position.ok_or("tıklanan simgenin konumu bulunamadı")?;
        let mut spacing = POINT::default();
        let _ = fv.GetSpacing(&mut spacing);
        let mut point = at.unwrap_or_default();
        if at.is_none() { GetCursorPos(&mut point).map_err(|e| e.message())?; }
        let root = GetAncestor(dv, GA_ROOT);
        let mut pid = 0;
        GetWindowThreadProcessId(dv, Some(&mut pid));
        let _ = AllowSetForegroundWindow(pid);
        focus_window(root);
        let _ = SetWindowPos(root, Some(HWND_BOTTOM), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        let _stage = stage_view(lv, point, position, spacing)?;
        let packed = ((point.x as u32 & 0xffff) | ((point.y as u32 & 0xffff) << 16)) as i32 as isize;
        PostMessageW(Some(dv), WM_CONTEXTMENU, WPARAM(lv.0 as usize), LPARAM(packed)).map_err(|e| e.message())?;
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(4) {
            if let Some(kind) = menu_kind() {
                std::thread::sleep(Duration::from_millis(50));
                let path = paths[0].clone();
                observe_menu(token, Duration::from_millis(250), serde_json::json!({
                    "id": "rename", "target": "items", "ids": [util::norm_path(&path)],
                    "paths": [path], "at": [0, 0], "cell": null, "canPaste": false,
                }));
                return Ok(kind);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Err("Windows simge menüsü açılamadı".into())
    })?
}
