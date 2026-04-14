#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::WebviewSiteLoaded = event {
                let _ = window.show();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
