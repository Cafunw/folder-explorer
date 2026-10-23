//! Small shared helpers: COM apartments, string conversions, global app handle.

use std::ffi::c_void;
use std::sync::OnceLock;

use tauri::AppHandle;
use windows::core::{GUID, PWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
    COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::UI::Shell::{SHGetKnownFolderPath, KF_FLAG_DEFAULT};

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn set_app(app: AppHandle) {
    let _ = APP.set(app);
}

pub fn app() -> Option<&'static AppHandle> {
    APP.get()
}

/// Logs only in debug builds.
#[macro_export]
macro_rules! dlog {
    ($($arg:tt)*) => {
        if cfg!(debug_assertions) {
            eprintln!("[folder-explorer] {}", format!($($arg)*));
        }
    };
}

/// RAII guard for a single-threaded COM apartment on the current thread.
pub struct ComApartment {
    owned: bool,
}

impl ComApartment {
    pub fn sta() -> Self {
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
        // S_OK / S_FALSE both need a matching CoUninitialize; RPC_E_CHANGED_MODE does not.
        ComApartment { owned: hr.is_ok() }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.owned {
            unsafe { CoUninitialize() };
        }
    }
}

/// Runs `f` on a fresh thread inside an STA apartment and waits for the result.
pub fn run_sta<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    std::thread::Builder::new()
        .name("fe-sta".into())
        .spawn(move || {
            let _com = ComApartment::sta();
            f()
        })
        .map_err(|e| e.to_string())?
        .join()
        .map_err(|_| "STA iş parçacığı çöktü".to_string())
}

/// Runs `f` on the Tauri main (UI) thread and waits for the result.
/// Must NOT be called from the main thread itself.
pub fn on_main<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let app = app().ok_or("uygulama hazır değil")?;
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())
}

/// Takes ownership of a CoTaskMem-allocated wide string.
pub unsafe fn take_pwstr(p: PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    let s = p.to_string().unwrap_or_default();
    CoTaskMemFree(Some(p.0 as *const c_void));
    s
}

pub fn wide_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

pub fn known_folder(id: &GUID) -> Option<String> {
    unsafe {
        let p = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
        let s = take_pwstr(p);
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

pub fn user_desktop_dir() -> String {
    known_folder(&windows::Win32::UI::Shell::FOLDERID_Desktop).unwrap_or_else(|| {
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Public".into());
        format!("{home}\\Desktop")
    })
}

pub fn public_desktop_dir() -> String {
    known_folder(&windows::Win32::UI::Shell::FOLDERID_PublicDesktop)
        .unwrap_or_else(|| "C:\\Users\\Public\\Desktop".into())
}

pub fn hwnd_from(v: isize) -> HWND {
    HWND(v as *mut c_void)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Short stable hash for version strings.
pub fn short_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// Same directory (case-insensitive, separators normalised)?
pub fn same_dir(a: &str, b: &str) -> bool {
    norm_path(a) == norm_path(b)
}

pub fn norm_path(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

pub fn parent_dir(p: &str) -> String {
    std::path::Path::new(p)
        .parent()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_default()
}
