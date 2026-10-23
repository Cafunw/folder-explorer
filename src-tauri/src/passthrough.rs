//! Input pass-through. Folder Explorer's window takes the mouse only where it has something of its
//! own (icons, panels, dialogs); everywhere else the mouse goes straight through to Windows' real
//! desktop underneath. So right-click on an empty spot, the New menu, Refresh, View, Sort,
//! Personalize, drops from other apps… are all handled by Windows itself, untouched: nothing is
//! forwarded, faked or hooked.
//!
//! The UI reports where its own objects are (`set_regions`); a light poller (cursor position and
//! button state only) switches the window between "takes input" and "ignores input". While the
//! mouse is over nothing of ours it also tells the UI about presses on the empty desktop, which
//! the UI uses for its rubber-band selection and for placing a new item where the user clicked.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::Emitter;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_LBUTTON, VK_RBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW, WindowFromPoint, GA_ROOT, GWL_EXSTYLE,
    WS_EX_TRANSPARENT,
};

use crate::{desktop_window, util};

#[derive(Default)]
struct Regions {
    /// a panel, dialog, drag or name box is open: the whole window takes input
    all: bool,
    /// x, y, width, height in CSS pixels of the window
    rects: Vec<[f64; 4]>,
}

static REGIONS: Mutex<Regions> = Mutex::new(Regions { all: false, rects: Vec::new() });
static STARTED: AtomicBool = AtomicBool::new(false);

pub fn set_regions(all: bool, rects: Vec<[f64; 4]>) {
    *REGIONS.lock().unwrap() = Regions { all, rects };
}

#[derive(Serialize, Clone)]
struct EmptyPointer {
    x: f64,
    y: f64,
    ctrl: bool,
}

fn down(vk: u16) -> bool {
    unsafe { GetAsyncKeyState(vk as i32) as u16 & 0x8000 != 0 }
}

#[derive(PartialEq)]
enum Under {
    /// Windows' own desktop (we are click-through here)
    Desktop,
    /// our own window (we take input here)
    Ours,
    /// an app window is in front: the mouse is not on the desktop at all
    App,
}

fn under(pt: POINT, ours: HWND) -> Under {
    unsafe {
        let h = WindowFromPoint(pt);
        if h.is_invalid() {
            return Under::App;
        }
        let root = GetAncestor(h, GA_ROOT);
        let root = if root.is_invalid() { h } else { root };
        if root == ours {
            return Under::Ours;
        }
        let c = desktop_window::class_of(root);
        if c == "Progman" || c == "WorkerW" {
            Under::Desktop
        } else {
            Under::App
        }
    }
}

/// Click-through on/off. Only the `WS_EX_TRANSPARENT` bit changes (the window is layered for good,
/// see `desktop_window::enforce_exstyle`): switching `WS_EX_LAYERED` as well makes Windows hide and
/// re-show the window for a moment, which made the icons blink whenever the mouse moved.
fn set_through(h: HWND, through: bool) {
    unsafe {
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
        let want = if through { ex | WS_EX_TRANSPARENT.0 } else { ex & !WS_EX_TRANSPARENT.0 };
        if want != ex {
            SetWindowLongPtrW(h, GWL_EXSTYLE, want as isize);
        }
    }
}

pub fn start() {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = std::thread::Builder::new().name("fe-passthrough".into()).spawn(|| {
        let mut through = false; // the window currently ignores the mouse
        let mut latched = false; // a press started on our window: keep taking input until release
        let (mut l_prev, mut r_prev) = (false, false);
        let mut empty_drag = false;
        let mut last_sent = (f64::NAN, f64::NAN);
        loop {
            std::thread::sleep(Duration::from_millis(10));
            let Some(app) = util::app() else { continue };
            let hwnd = desktop_window::desktop_hwnd();

            // Not showing (Windows-icons mode, still starting): take input normally.
            if !desktop_window::is_active() {
                if through {
                    through = false;
                    set_through(hwnd, false);
                }
                continue;
            }

            let mut pt = POINT::default();
            if unsafe { GetCursorPos(&mut pt) }.is_err() {
                continue;
            }
            let b = desktop_window::window_rect();
            let scale = desktop_window::scale_factor(&app).max(0.5);
            let (x, y) = ((pt.x - b.x) as f64 / scale, (pt.y - b.y) as f64 / scale);
            let inside = pt.x >= b.x && pt.y >= b.y && pt.x < b.x + b.width && pt.y < b.y + b.height;

            let over_ours = {
                let r = REGIONS.lock().unwrap();
                r.all
                    || desktop_window::is_raised()
                    || (inside && r.rects.iter().any(|q| x >= q[0] && y >= q[1] && x < q[0] + q[2] && y < q[1] + q[3]))
            };

            let (l, r) = (down(VK_LBUTTON.0), down(VK_RBUTTON.0));
            let any = l || r;
            if any && !(l_prev || r_prev) {
                // a press began: if it began on one of our objects, it stays ours until released
                latched = !through;
            }
            if !any {
                latched = false;
            }
            let want_through = !(over_ours || latched);

            let at = under(pt, hwnd);

            // Presses on the empty desktop (Windows handles them); the UI only observes.
            if want_through && inside && at == Under::Desktop {
                let ctrl = down(VK_CONTROL.0);
                if l && !l_prev {
                    crate::diag::log(&format!("pt  empty-press at=({},{})", pt.x, pt.y));
                    empty_drag = true;
                    last_sent = (x, y);
                    let _ = app.emit_to("desktop", "empty-press", EmptyPointer { x, y, ctrl });
                }
                if r && !r_prev {
                    crate::diag::log("pt  empty right-press (Windows' own menu follows)");
                    let _ = app.emit_to("desktop", "empty-rclick", EmptyPointer { x, y, ctrl });
                }
            }
            if empty_drag {
                if !l {
                    empty_drag = false;
                    let _ = app.emit_to("desktop", "empty-release", EmptyPointer { x, y, ctrl: false });
                } else if (x, y) != last_sent {
                    last_sent = (x, y);
                    let _ = app.emit_to("desktop", "empty-drag", EmptyPointer { x, y, ctrl: false });
                }
            }
            l_prev = l;
            r_prev = r;

            // An app window in front of the desktop here: nothing to decide, leave the state alone.
            if want_through != through && (at != Under::App || latched) {
                through = want_through;
                set_through(hwnd, through);
                crate::diag::log(&format!("pt  through={through} at=({},{}) l={l} r={r}", pt.x, pt.y));
            }
        }
    });
}
