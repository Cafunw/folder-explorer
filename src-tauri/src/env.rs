//! Monitor enumeration and the `Environment` handed to the UI.

use serde::Serialize;
use windows::core::{w, BOOL};
use windows::Win32::Foundation::{LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

use crate::util;

#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub fn from_rect(r: &RECT) -> Self {
        Rect { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }
    }
    pub fn union(&self, o: &Rect) -> Rect {
        let l = self.x.min(o.x);
        let t = self.y.min(o.y);
        let r = (self.x + self.width).max(o.x + o.width);
        let b = (self.y + self.height).max(o.y + o.height);
        Rect { x: l, y: t, width: r - l, height: b - t }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub id: String,
    pub primary: bool,
    pub bounds: Rect,
    pub work: Rect,
    pub scale: f64,
}

#[derive(Serialize, Clone, Copy, Debug)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub monitors: Vec<MonitorInfo>,
    pub window_origin: Point,
    pub scale_factor: f64,
    pub desktop_dir: String,
    pub public_desktop_dir: String,
    pub is_dev: bool,
    /// Windows' own desktop icon size in logical px (View ▸ Small 32 / Medium 48 / Large 96, or Ctrl+wheel)
    pub windows_icon_size: u32,
}

unsafe extern "system" fn enum_proc(hmon: HMONITOR, _hdc: HDC, _rc: *mut RECT, data: LPARAM) -> BOOL {
    let list = &mut *(data.0 as *mut Vec<HMONITOR>);
    list.push(hmon);
    BOOL(1)
}

pub fn monitors() -> Vec<MonitorInfo> {
    let mut handles: Vec<HMONITOR> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(enum_proc), LPARAM(&mut handles as *mut _ as isize));
    }
    let mut out = Vec::new();
    for h in handles {
        unsafe {
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            if !GetMonitorInfoW(h, &mut info.monitorInfo as *mut MONITORINFO).as_bool() {
                continue;
            }
            let mut dx = 96u32;
            let mut dy = 96u32;
            let _ = GetDpiForMonitor(h, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
            out.push(MonitorInfo {
                id: util::wide_to_string(&info.szDevice),
                primary: info.monitorInfo.dwFlags & 1 != 0,
                bounds: Rect::from_rect(&info.monitorInfo.rcMonitor),
                work: Rect::from_rect(&info.monitorInfo.rcWork),
                scale: dx as f64 / 96.0,
            });
        }
    }
    // Primary first, then left-to-right for stable ordering.
    out.sort_by(|a, b| b.primary.cmp(&a.primary).then(a.bounds.x.cmp(&b.bounds.x)).then(a.bounds.y.cmp(&b.bounds.y)));
    out
}

/// Bounding box of all monitors (physical px).
pub fn virtual_bounds() -> Rect {
    let mons = monitors();
    let mut it = mons.iter();
    match it.next() {
        Some(first) => it.fold(first.bounds, |acc, m| acc.union(&m.bounds)),
        None => Rect { x: 0, y: 0, width: 1920, height: 1080 },
    }
}

pub fn environment(window_origin: Point, scale_factor: f64) -> Environment {
    Environment {
        monitors: monitors(),
        window_origin,
        scale_factor,
        desktop_dir: util::user_desktop_dir(),
        public_desktop_dir: util::public_desktop_dir(),
        is_dev: cfg!(debug_assertions),
        windows_icon_size: windows_icon_size(),
    }
}

/// Read only; Windows writes it when the icon size is changed on its desktop. Absent = Medium.
fn windows_icon_size() -> u32 {
    let mut data: u32 = 0;
    let mut size: u32 = 4;
    let res = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\Shell\\Bags\\1\\Desktop"),
            w!("IconSize"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    if res.is_ok() && data > 0 { data } else { 48 }
}
