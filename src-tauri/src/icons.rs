//! Shell icon / thumbnail rendering (STA worker pool) and the `fe` URI scheme.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::http::{Request, Response, Uri};
use tauri::{UriSchemeContext, UriSchemeResponder, Wry};
use windows::core::{Interface, HSTRING};
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
};
use windows::Win32::UI::Shell::{
    IShellItem, IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_RESIZETOFIT,
};

use crate::{store, util, wallpaper};

const WORKERS: usize = 3;
const CACHE_LIMIT: usize = 3000;

struct Job {
    parsing: String,
    size: u32,
    reply: Sender<Result<Arc<Vec<u8>>, String>>,
}

static QUEUE: OnceLock<Mutex<Sender<Job>>> = OnceLock::new();
static CACHE: OnceLock<Mutex<HashMap<String, Arc<Vec<u8>>>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, Arc<Vec<u8>>>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn queue() -> &'static Mutex<Sender<Job>> {
    QUEUE.get_or_init(|| {
        let (tx, rx) = channel::<Job>();
        let rx = Arc::new(Mutex::new(rx));
        for i in 0..WORKERS {
            let rx: Arc<Mutex<Receiver<Job>>> = rx.clone();
            std::thread::Builder::new()
                .name(format!("fe-icon-{i}"))
                .spawn(move || {
                    let _com = util::ComApartment::sta();
                    loop {
                        let job = {
                            let guard = match rx.lock() {
                                Ok(g) => g,
                                Err(_) => return,
                            };
                            match guard.recv() {
                                Ok(j) => j,
                                Err(_) => return,
                            }
                        };
                        let res = render_png(&job.parsing, job.size).map(Arc::new);
                        let _ = job.reply.send(res);
                    }
                })
                .ok();
        }
        Mutex::new(tx)
    })
}

/// Returns PNG bytes for a shell item at `size` physical px (cached by version).
pub fn icon_png(parsing: &str, size: u32, version: &str) -> Result<Arc<Vec<u8>>, String> {
    let size = size.clamp(16, 512);
    let key = format!("{}|{}|{}", parsing.to_lowercase(), size, version);
    if let Some(hit) = cache().lock().unwrap().get(&key) {
        return Ok(hit.clone());
    }
    let (tx, rx) = channel();
    queue()
        .lock()
        .map_err(|e| e.to_string())?
        .send(Job { parsing: parsing.to_string(), size, reply: tx })
        .map_err(|e| e.to_string())?;
    let png = rx.recv().map_err(|e| e.to_string())??;
    let mut c = cache().lock().unwrap();
    if c.len() > CACHE_LIMIT {
        c.clear();
    }
    c.insert(key, png.clone());
    Ok(png)
}

/// Gets an HBITMAP for a shell item. Caller owns it. Needs STA.
pub fn shell_bitmap(parsing: &str, size: u32) -> Result<HBITMAP, String> {
    unsafe {
        let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(crate::shell::fs_norm(parsing)), None)
            .map_err(|e| e.message())?;
        let factory: IShellItemImageFactory = item.cast().map_err(|e| e.message())?;
        factory
            .GetImage(SIZE { cx: size as i32, cy: size as i32 }, SIIGBF_RESIZETOFIT)
            .map_err(|e| e.message())
    }
}

fn render_png(parsing: &str, size: u32) -> Result<Vec<u8>, String> {
    let hbmp = shell_bitmap(parsing, size)?;
    let res = unsafe { bitmap_rgba(hbmp) };
    unsafe {
        let _ = DeleteObject(HGDIOBJ(hbmp.0));
    }
    let (w, h, rgba) = res?;
    encode_png(w, h, &rgba)
}

/// Reads a 32-bit DIB into straight-alpha RGBA.
pub unsafe fn bitmap_rgba(hbmp: HBITMAP) -> Result<(u32, u32, Vec<u8>), String> {
    let mut bm = BITMAP::default();
    if GetObjectW(HGDIOBJ(hbmp.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut c_void)) == 0 {
        return Err("GetObject başarısız".into());
    }
    let w = bm.bmWidth.max(1);
    let h = bm.bmHeight.abs().max(1);
    let mut bi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let hdc = GetDC(None);
    let lines = GetDIBits(hdc, hbmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut c_void), &mut bi, DIB_RGB_COLORS);
    ReleaseDC(None, hdc);
    if lines == 0 {
        return Err("GetDIBits başarısız".into());
    }
    let has_alpha = bm.bmBitsPixel == 32 && buf.chunks_exact(4).any(|p| p[3] != 0);
    if !has_alpha {
        for p in buf.chunks_exact_mut(4) {
            p[3] = 255;
        }
    } else {
        let premultiplied = !buf.chunks_exact(4).any(|p| p[0] > p[3] || p[1] > p[3] || p[2] > p[3]);
        if premultiplied {
            for p in buf.chunks_exact_mut(4) {
                let a = p[3] as u32;
                if a > 0 && a < 255 {
                    for c in 0..3 {
                        p[c] = ((p[c] as u32 * 255 + a / 2) / a).min(255) as u8;
                    }
                }
            }
        }
    }
    for p in buf.chunks_exact_mut(4) {
        p.swap(0, 2); // BGRA -> RGBA
    }
    Ok((w as u32, h as u32, buf))
}

pub fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(rgba.len() / 3);
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut wr = enc.write_header().map_err(|e| e.to_string())?;
        wr.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// fe:// protocol

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn query_map(uri: &Uri) -> HashMap<String, String> {
    let mut m = HashMap::new();
    if let Some(q) = uri.query() {
        for pair in q.split('&') {
            if pair.is_empty() {
                continue;
            }
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            m.insert(percent_decode(k), percent_decode(v));
        }
    }
    m
}

pub fn sniff_mime(bytes: &[u8], path: &str) -> &'static str {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.starts_with(b"BM") {
        "image/bmp"
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if path.to_lowercase().ends_with(".svg") {
        "image/svg+xml"
    } else if path.to_lowercase().ends_with(".ico") {
        "image/x-icon"
    } else if bytes.len() > 12 && &bytes[4..8] == b"ftyp" {
        "image/avif"
    } else {
        "application/octet-stream"
    }
}

fn respond(status: u16, mime: &str, body: Vec<u8>, cache: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", cache)
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn not_found() -> Response<Vec<u8>> {
    respond(404, "text/plain", Vec::new(), "no-store")
}

fn handle(uri: &Uri) -> Response<Vec<u8>> {
    let q = query_map(uri);
    let route = uri.path().trim_matches('/').to_string();
    // Windows webviews use http://fe.localhost/<route>; other forms put the route in the host.
    let route = if route.is_empty() { uri.host().unwrap_or("").split('.').next().unwrap_or("").to_string() } else { route };
    match route.as_str() {
        "icon" => {
            let Some(p) = q.get("p") else { return not_found() };
            let size = q.get("s").and_then(|s| s.parse::<f64>().ok()).unwrap_or(64.0).round() as u32;
            let version = q.get("v").cloned().unwrap_or_default();
            match icon_png(p, size, &version) {
                Ok(png) => respond(200, "image/png", (*png).clone(), "public, max-age=31536000, immutable"),
                Err(e) => {
                    crate::dlog!("icon fail {p}: {e}");
                    not_found()
                }
            }
        }
        "wallpaper" => {
            let monitor = q.get("m").cloned().unwrap_or_default();
            match wallpaper::wallpaper_bytes(&monitor) {
                Some((bytes, path)) => {
                    let mime = sniff_mime(&bytes, &path);
                    respond(200, mime, bytes, "public, max-age=31536000, immutable")
                }
                None => not_found(),
            }
        }
        "media" => {
            let Some(p) = q.get("p") else { return not_found() };
            let media = store::media_dir();
            let Ok(canon_media) = std::fs::canonicalize(&media) else { return not_found() };
            let Ok(canon) = std::fs::canonicalize(p) else { return not_found() };
            if !canon.starts_with(&canon_media) {
                return respond(403, "text/plain", Vec::new(), "no-store");
            }
            match std::fs::read(&canon) {
                Ok(bytes) => {
                    let mime = sniff_mime(&bytes, p);
                    respond(200, mime, bytes, "public, max-age=31536000, immutable")
                }
                Err(_) => not_found(),
            }
        }
        _ => not_found(),
    }
}

pub fn protocol(_ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let uri = request.uri().clone();
    std::thread::spawn(move || {
        let resp = handle(&uri);
        responder.respond(resp);
    });
}
