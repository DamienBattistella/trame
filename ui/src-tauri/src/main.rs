#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

struct Backend(Mutex<Option<CommandChild>>);

static UPDATING: AtomicBool = AtomicBool::new(false);

struct UpdateGuard;

impl UpdateGuard {
    fn take() -> Option<Self> {
        (!UPDATING.swap(true, Ordering::SeqCst)).then_some(UpdateGuard)
    }
}

impl Drop for UpdateGuard {
    fn drop(&mut self) {
        UPDATING.store(false, Ordering::SeqCst);
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The backend is a PyInstaller --onefile exe: a bootloader plus the real Python
/// process. Killing the bootloader alone would leave the engine running (and acting
/// on Teams), so the whole process tree goes. The engine also watches this process
/// (TRAME_PARENT_PID) and exits on its own if it crashes.
fn stop_backend(app: &AppHandle) {
    let child = app.state::<Backend>().0.lock().ok().and_then(|mut c| c.take());
    if let Some(child) = child {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let _ = std::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &child.pid().to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
        let _ = child.kill();
    }
}

/// At launch: if GitHub has a newer signed release, download it, stop the engine
/// (its exe must be replaceable and it must not act on Teams meanwhile), install it
/// and restart. Any failure leaves the current version running. Release builds only.
async fn update_on_launch(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let Some(_guard) = UpdateGuard::take() else { return };
    let Ok(updater) = app.updater() else { return };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return,
        Err(e) => {
            eprintln!("[update] vérification impossible : {e}");
            return;
        }
    };
    let _ = app.emit("update-available", update.version.clone());
    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("[update] téléchargement impossible : {e}");
            let _ = app.emit("update-failed", ());
            return;
        }
    };
    stop_backend(&app);
    if let Err(e) = update.install(bytes) {
        eprintln!("[update] installation impossible : {e}");
        spawn_backend(&app);
        let _ = app.emit("update-failed", ());
        return;
    }
    app.restart();
}

/// Start the Python engine (sidecar). A missing or quarantined engine must not take
/// the window and tray down: the UI then shows that the engine does not start.
fn spawn_backend(app: &AppHandle) {
    let spawned = app
        .shell()
        .sidecar("trame-backend")
        .map(|cmd| {
            cmd.env("TRAME_PARENT_PID", std::process::id().to_string())
                .env("TRAME_VERSION", app.package_info().version.to_string())
        })
        .and_then(|cmd| cmd.spawn());
    match spawned {
        Ok((mut rx, child)) => {
            *app.state::<Backend>().0.lock().unwrap() = Some(child);
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stderr(line) => {
                            eprintln!("[backend] {}", String::from_utf8_lossy(&line))
                        }
                        CommandEvent::Terminated(status) => {
                            eprintln!("[backend] arrêté : {:?}", status.code);
                            let _ = handle.emit("backend-exited", status.code);
                        }
                        _ => {}
                    }
                }
            });
        }
        Err(e) => eprintln!("[backend] lancement impossible : {e}"),
    }
}

/// "Réessayer" on the engine-down screen: stop whatever is left and start again.
#[tauri::command]
async fn restart_backend(app: AppHandle) {
    stop_backend(&app);
    spawn_backend(&app);
}

/// Trame lives in the tray and is rarely relaunched: look for a new release every
/// 6 hours too, and let the UI offer it (« Mettre à jour »).
async fn watch_updates(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    loop {
        pause_for(std::time::Duration::from_secs(6 * 60 * 60)).await;
        if let Ok(updater) = app.updater() {
            if let Ok(Some(update)) = updater.check().await {
                let _ = app.emit("update-ready", update.version.clone());
            }
        }
    }
}

async fn pause_for(d: std::time::Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

/// Réglages › Mises à jour : « Rechercher ».
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<String>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(Some(update.version.clone())),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// « Installer et redémarrer » : download, stop the engine, install, restart.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let _guard = UpdateGuard::take().ok_or_else(|| "Une mise à jour est déjà en cours.".to_string())?;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Trame est déjà à jour.".to_string())?;
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    stop_backend(&app);
    if let Err(e) = update.install(bytes) {
        spawn_backend(&app);
        return Err(e.to_string());
    }
    app.restart();
}

const TEAMS_WEB: &str = "teams-web";
const TEAMS_URL: &str = "https://teams.microsoft.com/v2/";
const TEAMS_BRIDGE: &str = include_str!("../teams-bridge.js");

/// Teams web runs in its own WebView2 profile, with background throttling and
/// occlusion detection off: a page Chromium believes hidden is frozen, and Send
/// then does nothing. "Hidden" therefore means parked off-screen, never hide().
const TEAMS_ARGS: &str = "--disable-features=CalculateNativeWinOcclusion --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";

fn park(w: &tauri::WebviewWindow) {
    let _ = w.set_skip_taskbar(true);
    let _ = w.unminimize();
    let _ = w.set_position(tauri::PhysicalPosition::new(-32000, -32000));
    let _ = w.show();
}

fn unpark(w: &tauri::WebviewWindow) {
    let _ = w.set_skip_taskbar(false);
    let _ = w.unminimize();
    let _ = w.center();
    let _ = w.show();
    let _ = w.set_focus();
}

/// Teams web in a Trame window, parked off-screen unless the user asks to see it
/// (sign-in). Its page may only call `teams_bridge_reply`.
/// Async on purpose: building a window from a synchronous command deadlocks on
/// Windows (WebView2), and sync commands run on the main thread.
#[tauri::command]
async fn teams_web_open(app: AppHandle, visible: bool) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(TEAMS_WEB) {
        if visible {
            unpark(&w);
        }
        return Ok(());
    }
    let url = TEAMS_URL.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    let profile = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("teams-web");
    let w = tauri::WebviewWindowBuilder::new(&app, TEAMS_WEB, tauri::WebviewUrl::External(url))
        .title("Teams · Trame")
        .inner_size(1100.0, 760.0)
        .visible(false)
        .data_directory(profile)
        .additional_browser_args(TEAMS_ARGS)
        .initialization_script(TEAMS_BRIDGE)
        .build()
        .map_err(|e| e.to_string())?;
    if visible {
        unpark(&w);
    } else {
        park(&w);
    }
    Ok(())
}

#[tauri::command]
fn teams_web_hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window(TEAMS_WEB) {
        park(&w);
    }
}

/// Teams intégré turned off: close the signed-in Teams web session too.
#[tauri::command]
fn teams_web_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window(TEAMS_WEB) {
        let _ = w.destroy();
    }
}

fn is_teams_host(url: &tauri::Url) -> bool {
    matches!(url.host_str(), Some(h) if h == "teams.microsoft.com" || h == "teams.cloud.microsoft" || h.ends_with(".teams.microsoft.com"))
}

/// Relay from the Trame UI: run one bridge command inside the Teams page.
#[tauri::command]
fn teams_web_eval(app: AppHandle, script: String) -> Result<(), String> {
    let w = app.get_webview_window(TEAMS_WEB).ok_or("Teams intégré n'est pas ouvert")?;
    let url = w.url().map_err(|e| e.to_string())?;
    if !is_teams_host(&url) {
        return Err("Teams n'est pas affiché (connexion en cours ?)".into());
    }
    w.eval(&script).map_err(|e| e.to_string())
}

/// Real keystrokes into the Teams page, for what Teams only does on genuine typing
/// (the @mention picker ignores events made up by a script). Only the Teams window
/// may ask, and only for itself: it can type into its own page and nothing else.
/// The keys go through WebView2's DevTools protocol, so the window can stay parked.
#[tauri::command]
fn teams_type_trusted(window: tauri::WebviewWindow, text: String) -> Result<(), String> {
    if window.label() != TEAMS_WEB {
        return Err("réservé à Teams intégré".into());
    }
    if text.is_empty() || text.chars().count() > 120 || text.chars().any(char::is_control) {
        return Err("texte refusé".into());
    }
    window
        .with_webview(move |webview| {
            #[cfg(windows)]
            unsafe {
                use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
                use windows::core::HSTRING;
                let Ok(core) = webview.controller().CoreWebView2() else { return };
                let method = HSTRING::from("Input.dispatchKeyEvent");
                for ch in text.chars() {
                    let key = ch.to_string();
                    let down = serde_json::json!({ "type": "keyDown", "key": key, "text": key, "unmodifiedText": key });
                    let up = serde_json::json!({ "type": "keyUp", "key": key });
                    for event in [down, up] {
                        let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
                        let _ = core.CallDevToolsProtocolMethod(&method, &HSTRING::from(event.to_string()), &done);
                    }
                }
            }
            #[cfg(not(windows))]
            let _ = (webview, &text);
        })
        .map_err(|e| e.to_string())
}

/// The Teams page answers here; the Trame UI forwards the answer to the engine.
#[tauri::command]
fn teams_bridge_reply(app: AppHandle, payload: serde_json::Value) {
    let _ = app.emit_to("main", "teams-bridge-reply", payload);
}

/// Windows notification for a message just received (asked by the Trame UI).
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

fn quit(app: &AppHandle) {
    let _ = app.save_window_state(StateFlags::all());
    stop_backend(app);
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        // The Teams web window is not restored: the plugin would bring it back visible
        // at every launch. It stays hidden unless the user asks to see it.
        .plugin(tauri_plugin_window_state::Builder::default().with_denylist(&[TEAMS_WEB]).build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(Backend(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            restart_backend,
            check_update,
            install_update,
            teams_web_open,
            teams_web_hide,
            teams_web_close,
            teams_web_eval,
            teams_bridge_reply,
            teams_type_trusted,
            notify
        ])
        .setup(|app| {
            spawn_backend(app.handle());

            let show = MenuItem::with_id(app, "show", "Ouvrir Trame", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "Pause / reprise", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let exit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &pause, &sep, &exit])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Trame")
                .menu(&menu)
                .menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main(app),
                    "pause" => {
                        let _ = app.emit("tray-toggle-pause", ());
                    }
                    "quit" => quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            tauri::async_runtime::spawn(update_on_launch(app.handle().clone()));
            tauri::async_runtime::spawn(watch_updates(app.handle().clone()));

            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == TEAMS_WEB {
                    if let Some(w) = window.app_handle().get_webview_window(TEAMS_WEB) {
                        park(&w);
                    }
                    return;
                }
                let _ = window.app_handle().save_window_state(StateFlags::all());
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("erreur au lancement de Trame")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_backend(app);
            }
        });
}
