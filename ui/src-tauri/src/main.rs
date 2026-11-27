#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    if cfg!(debug_assertions) || is_trial(&app) {
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

/// Trial instance (`npm run tauri:essai`, tauri.essai.conf.json): its own identifier,
/// hence its own single-instance lock, window state and Teams web profile, so it runs
/// beside the installed Trame without touching it.
const TRIAL_SUFFIX: &str = ".essai";
/// Engine port of the trial instance. Must match VITE_TRAME_PORT in ui/.env.essai.
const TRIAL_PORT: &str = "8732";

fn is_trial(app: &AppHandle) -> bool {
    app.config().identifier.ends_with(TRIAL_SUFFIX)
}

/// The installed app runs its sidecar. The trial instance runs the engine from the
/// sources of this checkout (backend/.venv, or TRAME_PYTHON), on its own port and with
/// its own data folder (%APPDATA%\ovh.battistella.trame.essai), never %APPDATA%\Trame.
fn engine_command(app: &AppHandle) -> Result<tauri_plugin_shell::process::Command, String> {
    let cmd = if is_trial(app) {
        let backend = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../backend");
        let venv = backend.join(".venv/Scripts/python.exe");
        let python = std::env::var("TRAME_PYTHON")
            .ok()
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| if venv.exists() { venv.to_string_lossy().into_owned() } else { "python".into() });
        let home = app.path().app_data_dir().map_err(|e| e.to_string())?;
        app.shell()
            .command(python)
            .arg("run.py")
            .current_dir(backend)
            .env("TRAME_PORT", TRIAL_PORT)
            .env("TRAME_HOME", home)
            .env("PYTHONIOENCODING", "utf-8")
    } else {
        app.shell().sidecar("trame-backend").map_err(|e| e.to_string())?
    };
    Ok(cmd
        .env("TRAME_PARENT_PID", std::process::id().to_string())
        .env("TRAME_VERSION", app.package_info().version.to_string())
        .env("TRAME_BRIDGE", bridge_fingerprint()))
}

/// The trial instance's icon: the Trame icon in amber, to tell the two apart in the
/// tray and the taskbar.
fn trial_icon(icon: &tauri::image::Image<'_>) -> tauri::image::Image<'static> {
    let mut rgba = icon.rgba().to_vec();
    for px in rgba.chunks_exact_mut(4) {
        let l = (px[0] as u16 * 3 + px[1] as u16 * 6 + px[2] as u16) / 10;
        px[0] = (127 + l / 2) as u8;
        px[1] = (60 + l / 3) as u8;
        px[2] = (l / 8) as u8;
    }
    tauri::image::Image::new_owned(rgba, icon.width(), icon.height())
}

/// Start the Python engine (sidecar). A missing or quarantined engine must not take
/// the window and tray down: the UI then shows that the engine does not start.
fn spawn_backend(app: &AppHandle) {
    let spawned = engine_command(app).and_then(|cmd| cmd.spawn().map_err(|e| e.to_string()));
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

/// Minutes between two looks for a new release while the app runs (the LED in the
/// header); 0: at launch only. Réglages › Mises à jour sets it (config.json › ui).
static UPDATE_CHECK_MINUTES: AtomicU64 = AtomicU64::new(15);

/// A release the UI can offer: its version and the release notes of latest.json
/// (the app changelog, as JSON, since the build publishes it there).
#[derive(Clone, serde::Serialize)]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

impl From<&tauri_plugin_updater::Update> for UpdateInfo {
    fn from(update: &tauri_plugin_updater::Update) -> Self {
        Self { version: update.version.clone(), notes: update.body.clone() }
    }
}

/// Trame lives in the tray and is rarely relaunched: look for a new release on the
/// chosen schedule too, and let the UI light its LED (once per version). Wakes every
/// minute so a new setting applies without a restart.
async fn watch_updates(app: AppHandle) {
    if cfg!(debug_assertions) || is_trial(&app) {
        return;
    }
    let mut announced: Option<String> = None;
    let mut last_check = std::time::Instant::now();
    loop {
        pause_for(std::time::Duration::from_secs(60)).await;
        let minutes = UPDATE_CHECK_MINUTES.load(Ordering::SeqCst);
        if minutes == 0 || last_check.elapsed() < std::time::Duration::from_secs(minutes * 60) {
            continue;
        }
        last_check = std::time::Instant::now();
        if UPDATING.load(Ordering::SeqCst) {
            continue;
        }
        let Ok(updater) = app.updater() else { continue };
        if let Ok(Some(update)) = updater.check().await {
            if announced.as_deref() != Some(update.version.as_str()) {
                announced = Some(update.version.clone());
                let _ = app.emit("update-ready", UpdateInfo::from(&update));
            }
        }
    }
}

async fn pause_for(d: std::time::Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

/// Réglages › Mises à jour : the chosen frequency, sent at startup and on every change.
#[tauri::command]
fn set_update_check_minutes(minutes: u64) {
    UPDATE_CHECK_MINUTES.store(minutes.min(24 * 60), Ordering::SeqCst);
}

const TRIAL_NO_UPDATE: &str = "Pas de mise à jour dans l'instance d'essai.";

/// Réglages › Mises à jour : « Rechercher ».
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    if is_trial(&app) {
        return Err(TRIAL_NO_UPDATE.into());
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(Some(UpdateInfo::from(&update))),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// « Installer et redémarrer » : download, stop the engine, install, restart.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    if is_trial(&app) {
        return Err(TRIAL_NO_UPDATE.into());
    }
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

/// Empreinte du pont injecté : change dès que `teams-bridge.js` change (donc à chaque
/// build qui le modifie), sans dépendre d'une montée de version.
fn bridge_fingerprint() -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    TEAMS_BRIDGE.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Le script d'init réellement posé : l'empreinte d'abord (le pont et `diagnose` la
/// relisent via `globalThis.__trameBridge`), puis le pont lui-même.
fn teams_init_script() -> String {
    format!("globalThis.__trameBridge={:?};\n{}", bridge_fingerprint(), TEAMS_BRIDGE)
}

fn bridge_marker(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("teams-web").join(".bridge"))
}

/// Après une mise à jour, la fenêtre Teams cachée peut garder le pont injecté par la
/// version précédente (document restauré par WebView2 au redémarrage). Si l'empreinte du
/// pont a changé depuis la dernière ouverture, on recharge la page : le script d'init
/// courant se réinjecte, et la session (profil WebView2) est conservée. Rien n'est envoyé
/// nulle part — on recharge seulement une page Teams déjà affichée.
fn reinject_if_stale(app: &AppHandle, w: &tauri::WebviewWindow) {
    let fp = bridge_fingerprint();
    let marker = bridge_marker(app);
    let last = marker.as_ref().and_then(|p| std::fs::read_to_string(p).ok());
    if last.as_deref() == Some(fp.as_str()) {
        return;
    }
    if let Some(p) = &marker {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, &fp);
    }
    // Empreinte inconnue ou différente : le document restauré peut porter un ancien pont
    // (y compris lors de la toute première version qui embarque ce correctif, où aucun
    // repère n'existe encore). On laisse la navigation initiale se poser, puis on recharge
    // si une page Teams est affichée — jamais l'écran de connexion. Fenêtre cachée : un
    // rechargement de trop est invisible, et il n'arrive qu'une fois par empreinte.
    let handle = w.clone();
    tauri::async_runtime::spawn(async move {
        pause_for(std::time::Duration::from_secs(3)).await;
        if matches!(handle.url(), Ok(u) if is_teams_host(&u)) {
            let _ = handle.eval("location.reload()");
        }
    });
}

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
        reinject_if_stale(&app, &w);
        return Ok(());
    }
    let url = TEAMS_URL.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    let profile = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("teams-web");
    let w = tauri::WebviewWindowBuilder::new(&app, TEAMS_WEB, tauri::WebviewUrl::External(url))
        .title(if is_trial(&app) { "Teams · Trame (essai)" } else { "Teams · Trame" })
        .inner_size(1100.0, 760.0)
        .visible(false)
        .data_directory(profile)
        .additional_browser_args(TEAMS_ARGS)
        // Toutes les frames : la transcription d'une réunion s'affiche dans une iframe
        // SharePoint, où le même script ne fait que la relire (voir teams-bridge.js).
        .initialization_script_for_all_frames(&teams_init_script())
        .build()
        .map_err(|e| e.to_string())?;
    if visible {
        unpark(&w);
    } else {
        park(&w);
    }
    reinject_if_stale(&app, &w);
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
    let context = tauri::generate_context!();
    let trial = context.config().identifier.ends_with(TRIAL_SUFFIX);
    let mut builder =
        tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)));
    // No autostart for the trial instance: it must never launch with Windows.
    if !trial {
        builder = builder.plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])));
    }
    builder
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
            set_update_check_minutes,
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

            let mut icon = app.default_window_icon().unwrap().clone();
            if is_trial(app.handle()) {
                icon = trial_icon(&icon);
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_icon(icon.clone());
                }
            }
            TrayIconBuilder::with_id("main")
                .icon(icon)
                .tooltip(if is_trial(app.handle()) { "Trame (essai)" } else { "Trame" })
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
        .build(context)
        .expect("erreur au lancement de Trame")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_backend(app);
            }
        });
}
