//! TEMPORARY diagnostics (debug builds only): appends timestamped lines to `fe-debug.log` in the
//! project folder, to find out what happens around a visible flicker. Remove when done.

use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

/// `diag!(...)`: like `format!`, logged in debug builds only. In release builds the arguments are
/// never evaluated (the branch is a constant `false`), so hot paths pay nothing.
#[macro_export]
macro_rules! diag {
    ($($arg:tt)*) => {
        if cfg!(debug_assertions) {
            $crate::diag::log(&format!($($arg)*));
        }
    };
}

pub fn log(msg: &str) {
    if !cfg!(debug_assertions) {
        return;
    }
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fe-debug.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{:>3}.{:03} {msg}", (ms / 1000) % 1000, ms % 1000);
    }
}
