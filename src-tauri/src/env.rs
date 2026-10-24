//! Monitor enumeration and the `Environment` handed to the UI.

use serde::Serialize;
use windows::core::{w, BOOL, HSTRING};
use windows::Win32::Devices::Display::{
    DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig, DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
    DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
    DISPLAYCONFIG_SOURCE_DEVICE_NAME, DISPLAYCONFIG_TARGET_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
};
use windows::Win32::Foundation::{ERROR_SUCCESS, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_BINARY};
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
    /// physical image size from the monitor's EDID; None when unknown (projectors, some docks)
    pub size_mm: Option<SizeMm>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct SizeMm {
    pub width: u32,
    pub height: u32,
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
                size_mm: None,
            });
        }
    }
    // Primary first, then left-to-right for stable ordering.
    out.sort_by(|a, b| b.primary.cmp(&a.primary).then(a.bounds.x.cmp(&b.bounds.x)).then(a.bounds.y.cmp(&b.bounds.y)));
    out
}

/// `monitors()` plus each monitor's physical size. Reads the registry, so it is for the UI's
/// environment, not for hot paths.
pub fn monitors_with_size() -> Vec<MonitorInfo> {
    let sizes = physical_sizes();
    let mut list = monitors();
    for m in &mut list {
        m.size_mm = sizes.iter().find(|(id, _)| id.eq_ignore_ascii_case(&m.id)).map(|(_, s)| *s);
    }
    list
}

/// Physical size of every active display, keyed by GDI device name ("\\.\DISPLAY1"). Read-only:
/// QueryDisplayConfig maps the GDI name to the monitor's device path, and Windows keeps that
/// monitor's EDID under HKLM\SYSTEM\CurrentControlSet\Enum\DISPLAY\<model>\<instance>.
fn physical_sizes() -> Vec<(String, SizeMm)> {
    let mut out = Vec::new();
    unsafe {
        let (mut np, mut nm) = (0u32, 0u32);
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut np, &mut nm) != ERROR_SUCCESS {
            return out;
        }
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); np as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); nm as usize];
        if QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &mut np, paths.as_mut_ptr(), &mut nm, modes.as_mut_ptr(), None)
            != ERROR_SUCCESS
        {
            return out;
        }
        paths.truncate(np as usize);
        for p in &paths {
            let mut src = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
            src.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
            src.header.size = std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
            src.header.adapterId = p.sourceInfo.adapterId;
            src.header.id = p.sourceInfo.id;
            if DisplayConfigGetDeviceInfo(&mut src.header) != 0 {
                continue;
            }
            let mut tgt = DISPLAYCONFIG_TARGET_DEVICE_NAME::default();
            tgt.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
            tgt.header.size = std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32;
            tgt.header.adapterId = p.targetInfo.adapterId;
            tgt.header.id = p.targetInfo.id;
            if DisplayConfigGetDeviceInfo(&mut tgt.header) != 0 {
                continue;
            }
            let path = util::wide_to_string(&tgt.monitorDevicePath);
            if let Some(size) = read_edid(&path).and_then(|e| edid_size_mm(&e)) {
                out.push((util::wide_to_string(&src.viewGdiDeviceName), size));
            }
        }
    }
    out
}

/// `\\?\DISPLAY#CMN1616#5&172e2d83&0&UID4355#{guid}` → the EDID Windows stored for that monitor.
fn read_edid(device_path: &str) -> Option<Vec<u8>> {
    let mut parts = device_path.trim_start_matches(r"\\?\").split('#');
    let (class, model, instance) = (parts.next()?, parts.next()?, parts.next()?);
    let key = HSTRING::from(format!(r"SYSTEM\CurrentControlSet\Enum\{class}\{model}\{instance}\Device Parameters"));
    let mut size = 0u32;
    unsafe {
        if RegGetValueW(HKEY_LOCAL_MACHINE, &key, w!("EDID"), RRF_RT_REG_BINARY, None, None, Some(&mut size)) != ERROR_SUCCESS {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let rc = RegGetValueW(
            HKEY_LOCAL_MACHINE,
            &key,
            w!("EDID"),
            RRF_RT_REG_BINARY,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut size),
        );
        if rc != ERROR_SUCCESS {
            return None;
        }
        buf.truncate(size as usize);
        Some(buf)
    }
}

/// Image size from an EDID block: the first detailed timing descriptor (mm), else the basic display
/// parameters (cm). Projectors report 0 and some panels put an aspect ratio there; both are rejected.
fn edid_size_mm(e: &[u8]) -> Option<SizeMm> {
    if e.len() < 128 || e[..8] != [0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00] {
        return None;
    }
    let plausible = |w: u32, h: u32| (w >= 60 && h >= 40 && w <= 4000 && h <= 4000).then_some(SizeMm { width: w, height: h });
    let dtd = if e[54] != 0 || e[55] != 0 {
        plausible(e[66] as u32 | ((e[68] as u32 & 0xF0) << 4), e[67] as u32 | ((e[68] as u32 & 0x0F) << 8))
    } else {
        None
    };
    let basic = plausible(e[21] as u32 * 10, e[22] as u32 * 10);
    match (dtd, basic) {
        // a descriptor that disagrees wildly with the basic size is the broken one
        (Some(d), Some(b)) if (d.width as f64 / b.width as f64 - 1.0).abs() > 0.25 => Some(b),
        (Some(d), _) => Some(d),
        (None, b) => b,
    }
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
        monitors: monitors_with_size(),
        window_origin,
        scale_factor,
        desktop_dir: util::user_desktop_dir(),
        public_desktop_dir: util::public_desktop_dir(),
        is_dev: cfg!(debug_assertions),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edid(basic_cm: (u8, u8), dtd_mm: Option<(u32, u32)>) -> Vec<u8> {
        let mut e = vec![0u8; 128];
        e[..8].copy_from_slice(&[0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00]);
        e[21] = basic_cm.0;
        e[22] = basic_cm.1;
        if let Some((w, h)) = dtd_mm {
            e[54] = 0x01;
            e[66] = (w & 0xFF) as u8;
            e[67] = (h & 0xFF) as u8;
            e[68] = (((w >> 8) as u8) << 4) | ((h >> 8) as u8 & 0x0F);
        }
        e
    }

    #[test]
    fn edid_prefers_detailed_timing_mm() {
        assert_eq!(edid_size_mm(&edid((34, 22), Some((344, 215)))), Some(SizeMm { width: 344, height: 215 }));
    }

    #[test]
    fn edid_falls_back_to_basic_cm() {
        assert_eq!(edid_size_mm(&edid((60, 34), None)), Some(SizeMm { width: 600, height: 340 }));
        // aspect ratio stored instead of a size
        assert_eq!(edid_size_mm(&edid((60, 34), Some((16, 9)))), Some(SizeMm { width: 600, height: 340 }));
        // descriptor that disagrees with the basic size
        assert_eq!(edid_size_mm(&edid((34, 22), Some((1600, 900)))), Some(SizeMm { width: 340, height: 220 }));
    }

    #[test]
    fn edid_unknown_size() {
        assert_eq!(edid_size_mm(&edid((0, 0), None)), None);
        assert_eq!(edid_size_mm(&[0u8; 128]), None);
        assert_eq!(edid_size_mm(&[0u8; 10]), None);
    }
}
