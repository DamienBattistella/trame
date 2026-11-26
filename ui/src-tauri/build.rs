fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "restart_backend",
            "check_update",
            "install_update",
            "teams_web_open",
            "teams_web_hide",
            "teams_web_eval",
            "teams_bridge_reply",
        ]),
    ))
    .expect("échec du build Tauri");
}
