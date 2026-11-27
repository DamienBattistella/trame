fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "restart_backend",
            "check_update",
            "install_update",
            "set_update_check_minutes",
            "teams_web_open",
            "teams_web_hide",
            "teams_web_visible",
            "teams_web_close",
            "teams_web_eval",
            "teams_bridge_reply",
            "teams_type_trusted",
            "notify",
            "set_tray_badge",
        ]),
    ))
    .expect("échec du build Tauri");
}
