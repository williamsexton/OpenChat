use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_updater::UpdaterExt;

// Hand an openchat://auth deep link to the web layer. Preferred: ?code=… (PKCE
// authorization code, exchanged for a token family) → "auth-code". Legacy: ?token=…
// (raw token from older servers) → "auth-token".
fn handle_auth_url(app: &AppHandle, url: &str) {
    if let Some((_, rest)) = url.split_once("code=") {
        let code = rest.split('&').next().unwrap_or("");
        if !code.is_empty() {
            let _ = app.emit("auth-code", code.to_string());
        }
    } else if let Some((_, rest)) = url.split_once("token=") {
        let token = rest.split('&').next().unwrap_or("");
        if !token.is_empty() {
            let _ = app.emit("auth-token", token.to_string());
        }
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// Open a URL (e.g. the SSO login) in the user's default browser.
#[tauri::command]
async fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

// Show an OS notification (mentions, DMs, incoming calls when the app is unfocused).
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

// Push-to-talk: register a global shortcut so the mic key works even when the app is
// unfocused. Emits `ptt://down` on press and `ptt://up` on release; the web layer gates
// the mic on those events. Any previous PTT binding is cleared first.
#[tauri::command]
fn register_ptt(app: AppHandle, accelerator: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let handle = app.clone();
    // on_shortcut accepts a string-like accelerator (e.g. "Ctrl+Shift+V") directly.
    gs.on_shortcut(accelerator.as_str(), move |_app, _sc, event| {
        match event.state() {
            ShortcutState::Pressed => { let _ = handle.emit("ptt://down", ()); }
            ShortcutState::Released => { let _ = handle.emit("ptt://up", ()); }
        }
    })
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn unregister_ptt(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    app.global_shortcut().unregister_all().map_err(|e| e.to_string())?;
    Ok(())
}

// Marker file recording the version of the last update we attempted. Used to break the
// infinite-update loop that a botched install can cause (see run_update).
fn update_attempt_marker(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(".update-attempt"))
}

// Driven by the web "checking for updates" gate on launch. Returns false when the app is
// already current (or when a prior update didn't stick — see the loop guard); when an update
// is found it downloads it (emitting progress) and relaunches into the new version.
//
// Loop guard: a known Windows/NSIS updater failure mode installs the new version into a
// DIFFERENT directory than the running app, so the running binary is never replaced — the
// updater then keeps offering the "update" forever (download → restart → same version →
// repeat), hanging the app each cycle. We record the version we attempted; if on the next
// launch we're STILL on an older version than that same target, we assume the install didn't
// take and DO NOT re-download — we return false so the app just opens. (User can reinstall
// manually to move to the new version.) A genuinely-newer target clears the guard.
#[tauri::command]
async fn run_update(app: AppHandle) -> Result<bool, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    let updater = app.updater().map_err(|e| e.to_string())?;
    let marker = update_attempt_marker(&app);
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => {
            let target = update.version.to_string();
            let current = app.package_info().version.to_string();
            if current != target {
                if let Some(m) = &marker {
                    if std::fs::read_to_string(m).ok().as_deref() == Some(target.as_str()) {
                        // Already tried this exact target and it didn't stick — stop looping.
                        return Ok(false);
                    }
                    if let Some(parent) = m.parent() { let _ = std::fs::create_dir_all(parent); }
                    let _ = std::fs::write(m, &target);
                }
            }
            let _ = app.emit("update://status", "downloading");
            let downloaded = AtomicU64::new(0);
            update
                .download_and_install(
                    |chunk_len, content_len| {
                        let d = downloaded.fetch_add(chunk_len as u64, Ordering::Relaxed) + chunk_len as u64;
                        let _ = app.emit("update://progress", serde_json::json!({ "downloaded": d, "total": content_len }));
                    },
                    || { let _ = app.emit("update://status", "installing"); },
                )
                .await
                .map_err(|e| e.to_string())?;
            app.restart();
        }
        // Up to date — clear any stale attempt marker so a future update isn't wrongly skipped.
        None => { if let Some(m) = &marker { let _ = std::fs::remove_file(m); } }
    }
    Ok(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin: routes a second launch (incl. a deep link on
        // Windows/Linux) into the already-running instance.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(url) = argv.iter().find(|a| a.starts_with("openchat://")) {
                handle_auth_url(app, url);
            } else if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![open_external, notify, run_update, register_ptt, unregister_ptt])
        .setup(|app| {
            // Deep links that cold-started the app / arrive while running.
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for u in urls {
                        handle_auth_url(app.handle(), u.as_str());
                    }
                }
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for u in event.urls() {
                        handle_auth_url(&handle, u.as_str());
                    }
                });
            }

            // System tray with Open / Quit.
            let open = MenuItem::with_id(app, "open", "Open OpenChat", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("OpenChat")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        // Close-to-tray: hide instead of quitting so notifications keep flowing.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running OpenChat");
}
