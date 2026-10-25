//! TEMPORARY diagnostics (debug builds only): appends timestamped lines to `fe-debug.log` in the
//! project folder, to find out what happens around a visible flicker. Remove when done.

use std::io::Write;
use std::path::Path;
use std::sync::Once;
use std::time::{SystemTime, UNIX_EPOCH};

/// A log bigger than this at the first line of a session is moved to `fe-debug.old.log`.
const MAX_LOG_BYTES: u64 = 4 << 20;

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
    let path = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../fe-debug.log"));
    static ROTATED: Once = Once::new();
    ROTATED.call_once(|| rotate_if_big(path, MAX_LOG_BYTES));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{:>3}.{:03} {msg}", (ms / 1000) % 1000, ms % 1000);
    }
}

/// Moves a log over `max` bytes to `<name>.old.log` (replacing the one before), so a session starts
/// a fresh file and the previous session's lines are still there once.
fn rotate_if_big(path: &Path, max: u64) {
    if std::fs::metadata(path).is_ok_and(|m| m.len() > max) {
        let _ = std::fs::rename(path, path.with_extension("old.log"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_log_over_the_cap_is_moved_aside() {
        let dir = std::env::temp_dir().join(format!("fe-diag-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("fe-debug.log");
        let old = dir.join("fe-debug.old.log");
        rotate_if_big(&log, 5); // no log yet: nothing to do
        std::fs::write(&old, "session before last").unwrap();
        std::fs::write(&log, "12345").unwrap();
        rotate_if_big(&log, 5);
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "12345", "at the cap: kept");
        std::fs::write(&log, "123456").unwrap();
        rotate_if_big(&log, 5);
        assert!(!log.exists());
        assert_eq!(std::fs::read_to_string(&old).unwrap(), "123456", "replaces the older backup");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
