use tauri::{AppHandle, Manager, PhysicalPosition};

/// vj ウィンドウを第2ディスプレイへ移動し全画面化する。
/// モニタが1枚、または各種取得に失敗した場合は何もしない（フォールバック）。panic しない。
pub fn place_vj_on_second_display(app: &AppHandle) {
    let Some(vj) = app.get_webview_window("vj") else {
        eprintln!("[windows] vj ウィンドウが見つからない");
        return;
    };
    let monitors = match vj.available_monitors() {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[windows] available_monitors 失敗: {e}");
            return;
        }
    };
    if monitors.len() < 2 {
        // 1枚: フォールバック（ウィンドウのまま）
        return;
    }
    let second = &monitors[1];
    let pos: &PhysicalPosition<i32> = second.position();
    if let Err(e) = vj.set_position(tauri::Position::Physical(*pos)) {
        eprintln!("[windows] set_position 失敗: {e}");
        return;
    }
    if let Err(e) = vj.set_fullscreen(true) {
        eprintln!("[windows] set_fullscreen 失敗: {e}");
    }
}
