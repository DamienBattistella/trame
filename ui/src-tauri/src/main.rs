// Trame — enveloppe Tauri. Fenêtre sans cadre (decorations=false, barre de titre
// custom côté React) + lancement du backend Python en sidecar au démarrage.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Démarre le sidecar `trame-backend` (uvicorn empaqueté par PyInstaller).
            let sidecar = app
                .shell()
                .sidecar("trame-backend")
                .expect("sidecar trame-backend introuvable");
            let (mut rx, _child) = sidecar.spawn().expect("échec au lancement du backend");

            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let CommandEvent::Stderr(line) = event {
                        eprintln!("[backend] {}", String::from_utf8_lossy(&line));
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Trame");
}
