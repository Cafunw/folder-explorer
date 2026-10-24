//! "Şuna sıkıştır ▸": ZIP / 7z / TAR archives through libarchive, the library Windows 11's own
//! menu uses for this (archiveint.dll ships with Windows). Names keep their Unicode characters.

use std::ffi::c_void;
use std::io::Read;
use std::path::Path;
use std::sync::OnceLock;

use windows::core::{w, PCSTR};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

type Ar = *mut c_void;

const AE_IFREG: u32 = 0o100000;
const AE_IFDIR: u32 = 0o040000;

#[allow(clippy::type_complexity)]
struct Lib {
    write_new: unsafe extern "C" fn() -> Ar,
    format_zip: unsafe extern "C" fn(Ar) -> i32,
    format_7zip: unsafe extern "C" fn(Ar) -> i32,
    format_tar: unsafe extern "C" fn(Ar) -> i32,
    options: unsafe extern "C" fn(Ar, *const u8) -> i32,
    open_w: unsafe extern "C" fn(Ar, *const u16) -> i32,
    header: unsafe extern "C" fn(Ar, Ar) -> i32,
    data: unsafe extern "C" fn(Ar, *const c_void, usize) -> isize,
    finish_entry: unsafe extern "C" fn(Ar) -> i32,
    close: unsafe extern "C" fn(Ar) -> i32,
    free: unsafe extern "C" fn(Ar) -> i32,
    error: unsafe extern "C" fn(Ar) -> *const i8,
    entry_new: unsafe extern "C" fn() -> Ar,
    entry_free: unsafe extern "C" fn(Ar),
    pathname_w: unsafe extern "C" fn(Ar, *const u16),
    set_size: unsafe extern "C" fn(Ar, i64),
    set_filetype: unsafe extern "C" fn(Ar, u32),
    set_perm: unsafe extern "C" fn(Ar, u32),
    set_mtime: unsafe extern "C" fn(Ar, i64, i64),
}

unsafe impl Send for Lib {}
unsafe impl Sync for Lib {}

fn lib() -> Result<&'static Lib, String> {
    static LIB: OnceLock<Option<Lib>> = OnceLock::new();
    LIB.get_or_init(|| unsafe {
        let h = LoadLibraryW(w!("archiveint.dll")).ok()?;
        macro_rules! f {
            ($name:literal) => {
                std::mem::transmute(GetProcAddress(h, PCSTR(concat!($name, "\0").as_ptr()))?)
            };
        }
        Some(Lib {
            write_new: f!("archive_write_new"),
            format_zip: f!("archive_write_set_format_zip"),
            format_7zip: f!("archive_write_set_format_7zip"),
            format_tar: f!("archive_write_set_format_pax_restricted"),
            options: f!("archive_write_set_options"),
            open_w: f!("archive_write_open_filename_w"),
            header: f!("archive_write_header"),
            data: f!("archive_write_data"),
            finish_entry: f!("archive_write_finish_entry"),
            close: f!("archive_write_close"),
            free: f!("archive_write_free"),
            error: f!("archive_error_string"),
            entry_new: f!("archive_entry_new"),
            entry_free: f!("archive_entry_free"),
            pathname_w: f!("archive_entry_copy_pathname_w"),
            set_size: f!("archive_entry_set_size"),
            set_filetype: f!("archive_entry_set_filetype"),
            set_perm: f!("archive_entry_set_perm"),
            set_mtime: f!("archive_entry_set_mtime"),
        })
    })
    .as_ref()
    .ok_or_else(|| "sıkıştırma kitaplığı (archiveint.dll) bulunamadı".to_string())
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

unsafe fn fail(l: &Lib, a: Ar, what: &str) -> String {
    let e = (l.error)(a);
    if e.is_null() {
        what.to_string()
    } else {
        format!("{what}: {}", std::ffi::CStr::from_ptr(e).to_string_lossy())
    }
}

unsafe fn add(l: &Lib, a: Ar, src: &Path, name: &str) -> Result<(), String> {
    let md = std::fs::metadata(src).map_err(|e| format!("{}: {e}", src.display()))?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let e = (l.entry_new)();
    let entry_name = if md.is_dir() { format!("{name}/") } else { name.to_string() };
    (l.pathname_w)(e, wide(&entry_name).as_ptr());
    (l.set_mtime)(e, mtime, 0);
    if md.is_dir() {
        (l.set_filetype)(e, AE_IFDIR);
        (l.set_perm)(e, 0o755);
        let r = (l.header)(a, e);
        (l.entry_free)(e);
        if r < 0 {
            return Err(fail(l, a, name));
        }
        let mut children: Vec<_> = std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten().collect();
        children.sort_by_key(|c| c.file_name());
        for c in children {
            add(l, a, &c.path(), &format!("{name}/{}", c.file_name().to_string_lossy()))?;
        }
        return Ok(());
    }
    (l.set_filetype)(e, AE_IFREG);
    (l.set_perm)(e, 0o644);
    (l.set_size)(e, md.len() as i64);
    let r = (l.header)(a, e);
    (l.entry_free)(e);
    if r < 0 {
        return Err(fail(l, a, name));
    }
    let mut f = std::fs::File::open(src).map_err(|e| format!("{}: {e}", src.display()))?;
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if (l.data)(a, buf.as_ptr() as *const c_void, n) < 0 {
            return Err(fail(l, a, name));
        }
    }
    (l.finish_entry)(a);
    Ok(())
}

/// `paths` → `<first item's name>.<zip|7z|tar>` next to the first item (with " (2)"… when taken).
/// Returns the archive's path.
pub fn compress(paths: Vec<String>, format: String) -> Result<String, String> {
    let paths: Vec<String> = paths.into_iter().filter(|p| !p.starts_with("::")).collect();
    let first = Path::new(paths.first().ok_or("sıkıştırılacak öğe yok")?);
    let dir = first.parent().ok_or("klasör bulunamadı")?;
    let base = if first.is_dir() { first.file_name() } else { first.file_stem() }
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Arşiv".into());
    let ext = match format.as_str() {
        "zip" | "7z" | "tar" => format.as_str(),
        _ => return Err(format!("bilinmeyen biçim: {format}")),
    };
    let mut out = dir.join(format!("{base}.{ext}"));
    let mut n = 2;
    while out.exists() {
        out = dir.join(format!("{base} ({n}).{ext}"));
        n += 1;
    }
    let l = lib()?;
    let result = unsafe {
        let a = (l.write_new)();
        let r = match ext {
            "zip" => {
                let r = (l.format_zip)(a);
                (l.options)(a, b"hdrcharset=UTF-8\0".as_ptr());
                r
            }
            "7z" => (l.format_7zip)(a),
            _ => (l.format_tar)(a),
        };
        let res = if r < 0 {
            Err(fail(l, a, "biçim"))
        } else if (l.open_w)(a, wide(&out.to_string_lossy()).as_ptr()) < 0 {
            Err(fail(l, a, "arşiv oluşturulamadı"))
        } else {
            let mut res = Ok(());
            for p in &paths {
                let src = Path::new(p);
                let name = src.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                if let Err(e) = add(l, a, src, &name) {
                    res = Err(e);
                    break;
                }
            }
            if (l.close)(a) < 0 && res.is_ok() {
                res = Err(fail(l, a, "arşiv yazılamadı"));
            }
            res
        };
        (l.free)(a);
        res
    };
    match result {
        Ok(()) => Ok(out.to_string_lossy().to_string()),
        Err(e) => {
            let _ = std::fs::remove_file(&out);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archives_keep_unicode_names() {
        let dir = std::env::temp_dir().join(format!("fe-archive-test-{}", std::process::id()));
        let sub = dir.join("Klasör ğüş");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(dir.join("Şeker ı.txt"), "merhaba").unwrap();
        std::fs::write(sub.join("iç.txt"), "x").unwrap();
        for fmt in ["zip", "7z", "tar"] {
            let out = compress(
                vec![dir.join("Şeker ı.txt").to_string_lossy().into(), sub.to_string_lossy().into()],
                fmt.into(),
            )
            .unwrap();
            assert!(out.ends_with(&format!("Şeker ı.{fmt}")), "{out}");
            assert!(std::fs::metadata(&out).unwrap().len() > 0);
            std::fs::remove_file(out).unwrap();
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
