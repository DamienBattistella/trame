#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
        .map(|cmd| cmd.env("TRAME_PARENT_PID", std::process::id().to_string()))
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
fn restart_backend(app: AppHandle) {
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
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Trame est déjà à jour.".to_string())?;
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    stop_backend(&app);
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
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
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Backend(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![restart_backend, check_update, install_update])
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
