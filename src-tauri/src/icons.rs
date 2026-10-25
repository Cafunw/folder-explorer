//! Shell icon / thumbnail rendering (STA worker pool), a byte-bounded image cache and the `fe` URI
//! scheme (served by a small fixed pool of threads).

use std::collections::{BTreeMap, HashMap};
use std::ffi::c_void;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::http::{header, HeaderMap, Method, Request, Response, Uri};
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

use crate::{shell, store, util, wallpaper};

const RENDER_WORKERS: usize = 3;
const PROTOCOL_WORKERS: usize = 4;
/// Rendered PNGs kept in memory (icons and thumbnails).
const CACHE_BYTES: usize = 24 * 1024 * 1024;
/// A preview without a Range header is sent whole only up to this size.
const MAX_FULL_BODY: u64 = 64 * 1024 * 1024;
/// "bytes=N-" is answered with at most this much (the player asks for the rest).
const OPEN_RANGE_CHUNK: u64 = 4 * 1024 * 1024;
const MAX_RANGE_CHUNK: u64 = 16 * 1024 * 1024;

type Png = Arc<Vec<u8>>;

struct RenderJob {
    parsing: String,
    size: u32,
    reply: Sender<Result<Vec<u8>, String>>,
}

struct ProtocolJob {
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
}

/// `n` threads taking jobs from one queue (`sta` = each in a single-threaded COM apartment).
fn spawn_pool<J: Send + 'static>(name: &str, n: usize, sta: bool, run: fn(J)) -> Sender<J> {
    let (tx, rx) = channel::<J>();
    let rx = Arc::new(Mutex::new(rx));
    for i in 0..n {
        let rx: Arc<Mutex<Receiver<J>>> = rx.clone();
        let _ = std::thread::Builder::new().name(format!("{name}-{i}")).spawn(move || {
            let _com = sta.then(util::ComApartment::sta);
            loop {
                let job = match rx.lock() {
                    Ok(guard) => match guard.recv() {
                        Ok(j) => j,
                        Err(_) => return,
                    },
                    Err(_) => return,
                };
                run(job);
            }
        });
    }
    tx
}

fn render_queue() -> &'static Mutex<Sender<RenderJob>> {
    static Q: OnceLock<Mutex<Sender<RenderJob>>> = OnceLock::new();
    Q.get_or_init(|| {
        Mutex::new(spawn_pool("fe-icon", RENDER_WORKERS, true, |job: RenderJob| {
            let _ = job.reply.send(render_png(&job.parsing, job.size));
        }))
    })
}

fn protocol_queue() -> &'static Mutex<Sender<ProtocolJob>> {
    static Q: OnceLock<Mutex<Sender<ProtocolJob>>> = OnceLock::new();
    Q.get_or_init(|| {
        Mutex::new(spawn_pool("fe-proto", PROTOCOL_WORKERS, false, |job: ProtocolJob| {
            job.responder.respond(handle(&job.request));
        }))
    })
}

// ---------------------------------------------------------------------------
// cache: least recently used entries go first once the byte budget is exceeded

#[derive(Default)]
struct Lru {
    map: HashMap<String, (Png, u64)>,
    order: BTreeMap<u64, String>,
    bytes: usize,
    tick: u64,
}

impl Lru {
    fn get(&mut self, key: &str) -> Option<Png> {
        self.tick += 1;
        let tick = self.tick;
        let entry = self.map.get_mut(key)?;
        self.order.remove(&entry.1);
        entry.1 = tick;
        self.order.insert(tick, key.to_string());
        Some(entry.0.clone())
    }

    fn put(&mut self, key: String, data: Png) {
        if data.len() > CACHE_BYTES / 4 {
            return;
        }
        if let Some((old, t)) = self.map.remove(&key) {
            self.bytes -= old.len();
            self.order.remove(&t);
        }
        self.tick += 1;
        self.bytes += data.len();
        self.order.insert(self.tick, key.clone());
        self.map.insert(key, (data, self.tick));
        while self.bytes > CACHE_BYTES {
            let Some((_, k)) = self.order.pop_first() else { break };
            if let Some((d, _)) = self.map.remove(&k) {
                self.bytes -= d.len();
            }
        }
    }
}

fn cache() -> &'static Mutex<Lru> {
    static C: OnceLock<Mutex<Lru>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Lru::default()))
}

fn render_cached(key: String, parsing: &str, size: u32) -> Result<Png, String> {
    if let Some(hit) = cache().lock().map_err(|e| e.to_string())?.get(&key) {
        return Ok(hit);
    }
    let (tx, rx) = channel();
    render_queue()
        .lock()
        .map_err(|e| e.to_string())?
        .send(RenderJob { parsing: parsing.to_string(), size, reply: tx })
        .map_err(|e| e.to_string())?;
    let png: Png = Arc::new(rx.recv().map_err(|e| e.to_string())??);
    if let Ok(mut c) = cache().lock() {
        c.put(key, png.clone());
    }
    Ok(png)
}

/// Returns PNG bytes for a shell item at `size` physical px (cached by version).
pub fn icon_png(parsing: &str, size: u32, version: &str) -> Result<Png, String> {
    let size = size.clamp(16, 512);
    render_cached(format!("i|{}|{}|{}", parsing.to_lowercase(), size, version), parsing, size)
}

/// Large shell thumbnail of a file or folder (Quick Look); the cache key follows its mtime and length.
fn thumb_png(path: &str, canon: &Path, size: u32) -> Result<Png, String> {
    let size = size.clamp(16, 1024);
    let stamp = std::fs::metadata(canon)
        .map(|m| format!("{:?}|{}", m.modified().ok(), m.len()))
        .unwrap_or_default();
    render_cached(format!("t|{}|{}|{}", path.to_lowercase(), size, stamp), path, size)
}

/// Gets an HBITMAP for a shell item. Caller owns it. Needs STA.
pub fn shell_bitmap(parsing: &str, size: u32) -> Result<HBITMAP, String> {
    unsafe {
        let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(shell::fs_norm(parsing)), None)
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
    let (w, h, mut rgba) = res?;
    strip_icon_frame(w as usize, h as usize, &mut rgba);
    encode_png(w, h, &rgba)
}

/// Pixel positions of the k-th ring from the edge.
fn ring(w: usize, h: usize, k: usize) -> impl Iterator<Item = (usize, usize)> {
    (k..w - k)
        .flat_map(move |x| [(x, k), (x, h - 1 - k)])
        .chain((k..h - k).flat_map(move |y| [(k, y), (w - 1 - k, y)]))
}

/// Windows draws a faint square frame around an icon that has no image as big as the asked size
/// (Explorer's "extra large icons" look). That frame is the outer rings while they are faint
/// (alpha ≤ 96) and followed by a fully transparent ring; it is cleared. A real icon is not
/// touched: its edge is either transparent, or opaque, or not set apart by a transparent gap.
fn strip_icon_frame(w: usize, h: usize, rgba: &mut [u8]) {
    if w < 16 || h < 16 || rgba.len() < w * h * 4 {
        return;
    }
    let mut frame = 0;
    for k in 0..=w.min(h) / 16 {
        let max = ring(w, h, k).map(|(x, y)| rgba[(y * w + x) * 4 + 3]).max().unwrap_or(0);
        if max == 0 {
            frame = k;
            break;
        }
        if max > 96 {
            return;
        }
    }
    for k in 0..frame {
        for (x, y) in ring(w, h, k) {
            rgba[(y * w + x) * 4..][..4].fill(0);
        }
    }
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
// where fe://preview and fe://thumb may read

static ROOTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// Lets `fe://preview` / `fe://thumb` serve files below `dir` (besides the two desktop folders).
/// Live folders register their source directory here.
pub fn allow_root(dir: &str) {
    let Ok(canon) = std::fs::canonicalize(shell::fs_norm(dir)) else { return };
    if let Ok(mut roots) = ROOTS.lock() {
        if !roots.contains(&canon) {
            roots.push(canon);
        }
    }
}

/// The canonical path of `p` when it lies below an allowed root.
fn allowed(p: &str) -> Option<PathBuf> {
    let canon = std::fs::canonicalize(shell::fs_norm(p)).ok()?;
    let desktops = [util::user_desktop_dir(), util::public_desktop_dir()];
    let ok = desktops.iter().filter_map(|d| std::fs::canonicalize(d).ok()).any(|r| canon.starts_with(&r))
        || ROOTS.lock().map(|roots| roots.iter().any(|r| canon.starts_with(r))).unwrap_or(false);
    ok.then_some(canon)
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

const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "log", "csv", "tsv", "json", "jsonc", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf",
    "env", "properties", "gitignore", "editorconfig", "html", "htm", "css", "scss", "less", "js", "mjs", "cjs", "jsx",
    "ts", "tsx", "vue", "svelte", "rs", "py", "rb", "php", "java", "kt", "kts", "go", "c", "h", "cpp", "cc", "hpp",
    "cs", "fs", "swift", "lua", "sh", "bash", "zsh", "bat", "cmd", "ps1", "psm1", "sql", "r", "dart", "scala", "pl",
    "gradle", "srt", "vtt", "nfo", "reg",
];

/// Content type of a previewed file by its extension. Markup and scripts go out as plain text so they
/// never run.
fn preview_mime(name: &str) -> &'static str {
    let ext = Path::new(name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" | "pjpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "mp4" | "m4v" | "mov" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        e if TEXT_EXTS.contains(&e) => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn builder(status: u16, mime: &str, cache: &str) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, cache)
}

fn respond(status: u16, mime: &str, body: Vec<u8>, cache: &str) -> Response<Vec<u8>> {
    builder(status, mime, cache).body(body).unwrap_or_else(|_| Response::new(Vec::new()))
}

fn not_found() -> Response<Vec<u8>> {
    respond(404, "text/plain", Vec::new(), "no-store")
}

fn forbidden() -> Response<Vec<u8>> {
    respond(403, "text/plain", Vec::new(), "no-store")
}

/// `Range: bytes=…` (the first range only). None = no usable byte range (send the whole file),
/// Some(None) = not satisfiable.
fn parse_range(value: &str, len: u64) -> Option<Option<(u64, u64)>> {
    let spec = value.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 || len == 0 {
            return Some(None);
        }
        let start = len.saturating_sub(n);
        return Some(Some((start, (start + MAX_RANGE_CHUNK - 1).min(len - 1))));
    }
    let start: u64 = a.parse().ok()?;
    if start >= len {
        return Some(None);
    }
    let end = if b.is_empty() {
        (start + OPEN_RANGE_CHUNK - 1).min(len - 1)
    } else {
        let e: u64 = b.parse().ok()?;
        if e < start {
            return Some(None);
        }
        e.min(len - 1).min(start + MAX_RANGE_CHUNK - 1)
    };
    Some(Some((start, end)))
}

/// A file for Quick Look: only the requested slice is read for Range requests (video, audio, the
/// first part of a text file); nothing is cached here.
fn serve_file(path: &Path, name: &str, headers: &HeaderMap) -> Response<Vec<u8>> {
    let Ok(mut file) = File::open(path) else { return not_found() };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mime = preview_mime(name);
    let base = |status: u16| {
        builder(status, mime, "no-store")
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Range, Content-Length, Accept-Ranges")
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
    };
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).and_then(|v| parse_range(v, len));
    let resp = match range {
        Some(Some((start, end))) => {
            let mut body = Vec::with_capacity((end - start + 1) as usize);
            if file.seek(SeekFrom::Start(start)).is_err() || (&mut file).take(end - start + 1).read_to_end(&mut body).is_err() {
                return not_found();
            }
            let end = start + body.len().max(1) as u64 - 1;
            base(206)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .header(header::CONTENT_LENGTH, body.len())
                .body(body)
        }
        Some(None) => base(416).header(header::CONTENT_RANGE, format!("bytes */{len}")).body(Vec::new()),
        None if len > MAX_FULL_BODY => base(413).body(Vec::new()),
        None => {
            let mut body = Vec::with_capacity(len as usize);
            if file.read_to_end(&mut body).is_err() {
                return not_found();
            }
            base(200).header(header::CONTENT_LENGTH, body.len()).body(body)
        }
    };
    resp.unwrap_or_else(|_| not_found())
}

fn handle(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri();
    if request.method() == Method::OPTIONS {
        return builder(204, "text/plain", "no-store")
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, OPTIONS")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range")
            .body(Vec::new())
            .unwrap_or_else(|_| not_found());
    }
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
                Ok(png) => respond(200, "image/png", png.to_vec(), "public, max-age=31536000, immutable"),
                Err(e) => {
                    crate::dlog!("icon fail {p}: {e}");
                    not_found()
                }
            }
        }
        "thumb" => {
            let Some(p) = q.get("p") else { return not_found() };
            let Some(canon) = allowed(p) else { return forbidden() };
            let size = q.get("s").and_then(|s| s.parse::<f64>().ok()).unwrap_or(256.0).round() as u32;
            match thumb_png(&shell::fs_norm(p), &canon, size) {
                Ok(png) => respond(200, "image/png", png.to_vec(), "public, max-age=31536000, immutable"),
                Err(e) => {
                    crate::dlog!("thumb fail {p}: {e}");
                    not_found()
                }
            }
        }
        "preview" => {
            let Some(p) = q.get("p") else { return not_found() };
            let Some(canon) = allowed(p) else { return forbidden() };
            if !canon.is_file() {
                return not_found();
            }
            serve_file(&canon, p, request.headers())
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
                return forbidden();
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
    let tx = match protocol_queue().lock() {
        Ok(tx) => tx.clone(),
        Err(e) => e.into_inner().clone(),
    };
    if let Err(e) = tx.send(ProtocolJob { request, responder }) {
        e.0.responder.respond(not_found());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some(Some((0, 99))));
        assert_eq!(parse_range("bytes=900-", 1000), Some(Some((900, 999))));
        assert_eq!(parse_range("bytes=-100", 1000), Some(Some((900, 999))));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some(Some((0, 999))));
        assert_eq!(parse_range("bytes=1000-", 1000), Some(None));
        assert_eq!(parse_range("bytes=5-2", 1000), Some(None));
        assert_eq!(parse_range("items=0-1", 1000), None);
        assert_eq!(parse_range("bytes=0-", 100 * 1024 * 1024), Some(Some((0, OPEN_RANGE_CHUNK - 1))));
    }

    /// 64 × 64 icon: opaque content in 12..52, optional faint rings (alpha per ring from the edge).
    fn framed(rings: &[u8], content_from: usize) -> Vec<u8> {
        let mut px = vec![0u8; 64 * 64 * 4];
        for (k, &a) in rings.iter().enumerate() {
            for (x, y) in ring(64, 64, k) {
                px[(y * 64 + x) * 4..][..4].copy_from_slice(&[160, 160, 160, a]);
            }
        }
        for y in content_from..64 - content_from {
            for x in content_from..64 - content_from {
                px[(y * 64 + x) * 4..][..4].copy_from_slice(&[200, 50, 40, 255]);
            }
        }
        px
    }

    #[test]
    fn strips_the_windows_icon_frame() {
        let mut px = framed(&[51, 7], 12);
        strip_icon_frame(64, 64, &mut px);
        assert_eq!(px, framed(&[], 12));
    }

    #[test]
    fn keeps_real_icons() {
        // full-bleed square icon
        let full = framed(&[], 0);
        let mut px = full.clone();
        strip_icon_frame(64, 64, &mut px);
        assert_eq!(px, full);
        // faint edge that runs into the content (no transparent gap)
        let soft = framed(&[40, 60, 80, 90, 90, 90, 90, 90, 90, 90, 90, 90], 12);
        let mut px = soft.clone();
        strip_icon_frame(64, 64, &mut px);
        assert_eq!(px, soft);
    }

    #[test]
    fn lru_evicts_oldest() {
        let mut c = Lru::default();
        let big = || Arc::new(vec![0u8; CACHE_BYTES / 5]);
        for i in 0..5 {
            c.put(format!("k{i}"), big());
        }
        assert!(c.get("k0").is_some());
        c.put("k5".into(), big());
        assert!(c.get("k0").is_some());
        assert!(c.get("k1").is_none());
        assert!(c.bytes <= CACHE_BYTES);
    }
}
