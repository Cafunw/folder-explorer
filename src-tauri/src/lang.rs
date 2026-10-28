//! The UI language on the Rust side: the tray menu, the New ▸ entry, window titles and the errors
//! the UI shows. Follows `settings.language` ("tr" = Turkish, anything else English).

use std::sync::atomic::{AtomicBool, Ordering};

static TURKISH: AtomicBool = AtomicBool::new(false);

fn turkish(settings: &serde_json::Value) -> bool {
    settings.get("language").and_then(|v| v.as_str()) == Some("tr")
}

/// Takes the language from settings; true when it changed.
pub fn set_from(settings: &serde_json::Value) -> bool {
    let tr = turkish(settings);
    TURKISH.swap(tr, Ordering::Relaxed) != tr
}

/// `en` or `tr`, by the UI language.
pub fn t(en: &'static str, tr: &'static str) -> &'static str {
    if TURKISH.load(Ordering::Relaxed) { tr } else { en }
}

#[cfg(test)]
mod tests {
    use super::*;

    // the global is left alone: other tests run in parallel and read it
    #[test]
    fn only_tr_is_turkish() {
        assert!(turkish(&serde_json::json!({ "language": "tr" })));
        assert!(!turkish(&serde_json::json!({ "language": "en" })));
        assert!(!turkish(&serde_json::json!({})));
        assert!(!turkish(&serde_json::json!({ "language": 1 })));
    }
}
