//! Command-line diagnostics that exercise the Win32 layer without starting Tauri.
//!
//! * `--selftest [outdir]`  environment, items, Windows layout, wallpapers, start apps, one icon PNG
//! * `--ztest`              z-order behaviour of HWND_BOTTOM relative to Progman
//! * `--fileops-test <dir>` rename → recycle → restore of a throw-away file inside <dir>

use serde_json::json;

use crate::{desktop_window, env, icons, items, shell, store, util, wallpaper};

fn arg_after(args: &[String], flag: &str) -> Option<String> {
    let i = args.iter().position(|a| a == flag)?;
    args.get(i + 1).filter(|a| !a.starts_with("--")).cloned()
}

pub fn run(args: &[String]) {
    let _com = util::ComApartment::sta();
    if args.iter().any(|a| a == "--ztest") {
        println!("{}", desktop_window::ztest());
    }
    if args.iter().any(|a| a == "--selftest") {
        selftest(arg_after(args, "--selftest"));
    }
    if let Some(dir) = arg_after(args, "--fileops-test") {
        fileops(&dir);
    }
    if args.iter().any(|a| a == "--store-test") {
        store_test();
    }
    if let Some(path) = arg_after(args, "--restore") {
        println!("restore {:?}", shell::restore_from_recycle(vec![path]));
    }
}

fn selftest(outdir: Option<String>) {
    let monitors = env::monitors();
    println!("monitors = {}", serde_json::to_string_pretty(&monitors).unwrap());
    println!("virtual bounds = {:?}", env::virtual_bounds());
    println!("desktop = {} | public = {}", util::user_desktop_dir(), util::public_desktop_dir());

    let t = std::time::Instant::now();
    match items::list_desktop_items() {
        Ok(list) => {
            let sys = list.iter().filter(|i| i.kind == "system").count();
            let dirs = list.iter().filter(|i| i.kind == "folder").count();
            let public = list.iter().filter(|i| i.is_public).count();
            println!(
                "items: total={} system={} folders={} public={} ({} ms)",
                list.len(),
                sys,
                dirs,
                public,
                t.elapsed().as_millis()
            );
            for it in list.iter().take(4) {
                println!("  {}", serde_json::to_string(it).unwrap());
            }
            if let Some(lnk) = list.iter().find(|i| i.ext == ".lnk") {
                println!("  sample shortcut: {}", serde_json::to_string(lnk).unwrap());
                let t = std::time::Instant::now();
                match icons::icon_png(&lnk.parsing_name, 96, &lnk.icon_version) {
                    Ok(png) => {
                        let dir = outdir.clone().unwrap_or_else(|| std::env::temp_dir().to_string_lossy().to_string());
                        let path = std::path::Path::new(&dir).join("fe-icon-test.png");
                        let _ = std::fs::write(&path, png.as_slice());
                        println!("  icon png {} bytes -> {} ({} ms)", png.len(), path.display(), t.elapsed().as_millis());
                    }
                    Err(e) => println!("  icon error: {e}"),
                }
                // second request must hit the cache
                let t = std::time::Instant::now();
                let _ = icons::icon_png(&lnk.parsing_name, 96, &lnk.icon_version);
                println!("  cached icon fetch {} µs", t.elapsed().as_micros());
            }
            if let Some(rb) = list.iter().find(|i| i.id == items::RECYCLE_BIN.to_lowercase()) {
                match icons::icon_png(&rb.parsing_name, 64, "x") {
                    Ok(p) => println!("  recycle bin icon ok ({} bytes), full={:?}", p.len(), rb.recycle_full),
                    Err(e) => println!("  recycle bin icon error: {e}"),
                }
            }
        }
        Err(e) => println!("items error: {e}"),
    }

    match util::run_sta(desktop_window::capture_windows_layout_sta) {
        Ok(Ok(l)) => {
            println!("windows layout: spacing={:?} items={}", l.spacing, l.items.len());
            for it in l.items.iter().take(3) {
                println!("  {}", serde_json::to_string(it).unwrap());
            }
            if let Some(sp) = l.spacing {
                let mut cols = std::collections::BTreeMap::new();
                for it in &l.items {
                    let c = ((it.x as f64) / (sp.x as f64)).round() as i64;
                    *cols.entry(c).or_insert(0) += 1;
                }
                println!("windows layout per column: {:?}", cols);
            }
        }
        Ok(Err(e)) | Err(e) => println!("windows layout error: {e}"),
    }
    println!("listview found: {}", desktop_window::find_listview().is_some());

    match wallpaper::get_wallpapers() {
        Ok(w) => println!("wallpapers = {}", serde_json::to_string(&w).unwrap()),
        Err(e) => println!("wallpaper error: {e}"),
    }
    if let Some(first) = monitors.first() {
        match wallpaper::wallpaper_bytes(&first.id) {
            Some((b, p)) => println!("wallpaper bytes: {} from {} ({})", b.len(), p, icons::sniff_mime(&b, &p)),
            None => println!("wallpaper bytes: none"),
        }
    }

    let t = std::time::Instant::now();
    match shell::list_start_apps() {
        Ok(apps) => {
            println!("start apps: {} ({} ms)", apps.len(), t.elapsed().as_millis());
            for a in apps.iter().take(3) {
                println!("  {}", serde_json::to_string(a).unwrap());
            }
            if let Some(a) = apps.first() {
                match icons::icon_png(&a.parsing_name, 48, "1") {
                    Ok(p) => println!("  app icon ok ({} bytes)", p.len()),
                    Err(e) => println!("  app icon error: {e}"),
                }
            }
        }
        Err(e) => println!("start apps error: {e}"),
    }
    println!("{}", json!({ "selftest": "done" }));
}

fn fileops(dir: &str) {
    let _ = std::fs::create_dir_all(dir);
    let name = format!("fe-test-{}.txt", util::now_ms());
    let path = std::path::Path::new(dir).join(&name).to_string_lossy().to_string();
    std::fs::write(&path, "Folder Explorer test").unwrap();
    println!("created {path}");
    let renamed = match shell::rename_item(path.clone(), "fe-renamed".into()) {
        Ok(p) => {
            println!("renamed -> {p} exists={}", std::path::Path::new(&p).exists());
            p
        }
        Err(e) => {
            println!("rename error: {e}");
            path.clone()
        }
    };
    match shell::recycle(vec![renamed.clone()]) {
        Ok(()) => println!("recycled, exists={}", std::path::Path::new(&renamed).exists()),
        Err(e) => println!("recycle error: {e}"),
    }
    for row in shell::dump_recycle(3) {
        println!("  bin: {row}");
    }
    match shell::restore_from_recycle(vec![renamed.clone()]) {
        Ok(r) => println!("restored {:?}, exists={}", r, std::path::Path::new(&renamed).exists()),
        Err(e) => println!("restore error: {e}"),
    }
    let _ = std::fs::remove_file(&renamed);
    // Shortcut writers (into the test dir, not the desktop)
    match shell::create_shortcut_in(dir.to_string(), r"shell:AppsFolder\Microsoft.Windows.Explorer".into(), "Gezgin test".into()) {
        Ok(p) => {
            let target = items::display_name(&p);
            println!("lnk -> {p} display={target:?}");
            match icons::icon_png(&p, 48, "t") {
                Ok(png) => println!("  lnk icon ok ({} bytes)", png.len()),
                Err(e) => println!("  lnk icon error: {e}"),
            }
            let _ = std::fs::remove_file(&p);
        }
        Err(e) => println!("lnk error: {e}"),
    }
    match shell::create_url_shortcut_in(dir, "example.com".into(), String::new()) {
        Ok(p) => {
            println!("url -> {p}: {:?}", std::fs::read_to_string(&p).unwrap_or_default());
            let _ = std::fs::remove_file(&p);
        }
        Err(e) => println!("url error: {e}"),
    }
    println!("cleaned up");
}

fn store_test() {
    println!("app dir = {}", store::app_dir().display());
    store::init();
    println!("initial = {:?}", store::load_state());
    for i in 0..3 {
        store::save_layout(json!({ "version": 1, "n": i })).unwrap();
    }
    store::save_settings(json!({ "behavior": { "searchHotkey": "Ctrl+Space" } })).unwrap();
    println!("after save = {:?}", store::load_state());
    let exp = store::app_dir().join("export-test.json");
    store::export_state(&exp.to_string_lossy()).unwrap();
    store::save_layout(json!({ "version": 1, "n": 99 })).unwrap();
    let imp = store::import_state(&exp.to_string_lossy()).unwrap();
    println!("imported layout n = {}", imp.layout["n"]);
    println!("backups = {:?}", store::list_backups().iter().map(|b| b.name.clone()).collect::<Vec<_>>());
    if let Some(b) = store::list_backups().last() {
        println!("restore oldest -> {:?}", store::restore_backup(&b.name).map(|s| s.layout));
    }
    let media = store::import_media(&exp.to_string_lossy(), "icon");
    println!("media = {media:?}");
}
