// Lyria VJ: 2窓＋hub＋テレメトリ中継＋APIキー供給＋MIDI入力のバックエンド。
mod hub;
mod keystore;
mod midi;
mod windows;

use hub::state::HubState;
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(HubState::default()))
        .manage(midi::MidiState::default())
        .invoke_handler(tauri::generate_handler![
            hub::relay::get_state,
            hub::relay::set_state,
            hub::relay::push_frame,
            hub::relay::push_event,
            hub::relay::push_prompt_space,
            keystore::get_api_key,
            midi::list_midi_ports,
            midi::open_midi_port,
            midi::close_midi_port,
        ])
        .setup(|app| {
            windows::place_vj_on_second_display(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
