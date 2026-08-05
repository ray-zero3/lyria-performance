use crate::hub::state::HubState;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// vj ウィンドウへ frame を中継（不透明JSON）。
#[tauri::command]
pub fn push_frame(app: AppHandle, frame: serde_json::Value) {
    let _ = app.emit_to("vj", "frame", frame);
}

/// vj ウィンドウへ event を中継（不透明JSON）。
#[tauri::command]
pub fn push_event(app: AppHandle, event: serde_json::Value) {
    let _ = app.emit_to("vj", "event", event);
}

/// M7: vj ウィンドウへプロンプト空間を中継（不透明JSON）。
#[tauri::command]
pub fn push_prompt_space(app: AppHandle, space: serde_json::Value) {
    let _ = app.emit_to("vj", "prompt_space", space);
}

/// 現在の HubState スナップショットを返す。
#[tauri::command]
pub fn get_state(state: State<'_, Mutex<HubState>>) -> HubState {
    state.lock().map(|s| s.clone()).unwrap_or_default()
}

/// HubState を全置換し、全ウィンドウへ "state" をブロードキャスト。
#[tauri::command]
pub fn set_state(app: AppHandle, state: State<'_, Mutex<HubState>>, patch: HubState) {
    if let Ok(mut s) = state.lock() {
        *s = patch.clone();
    }
    let _ = app.emit("state", patch);
}
