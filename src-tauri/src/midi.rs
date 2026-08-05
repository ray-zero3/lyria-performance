use midir::{MidiInput, MidiInputConnection};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// 開いている MIDI 入力接続を保持（drop で切断されるため保持が必要）。
#[derive(Default)]
pub struct MidiState {
    conn: Mutex<Option<MidiInputConnection<()>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MidiEvent {
    kind: String, // "cc" | "note"
    channel: u8,
    id: u8,
    value: u8,
    on: bool,
}

/// 生 MIDI バイト列を MidiEvent へ（CC / Note のみ）。純粋。
fn parse_midi(msg: &[u8]) -> Option<MidiEvent> {
    if msg.len() < 3 {
        return None;
    }
    let status = msg[0] & 0xF0;
    let channel = msg[0] & 0x0F;
    match status {
        0xB0 => Some(MidiEvent {
            kind: "cc".into(),
            channel,
            id: msg[1],
            value: msg[2],
            on: true,
        }),
        0x90 => Some(MidiEvent {
            kind: "note".into(),
            channel,
            id: msg[1],
            value: msg[2],
            on: msg[2] > 0, // velocity 0 の Note On は Note Off 扱い
        }),
        0x80 => Some(MidiEvent {
            kind: "note".into(),
            channel,
            id: msg[1],
            value: msg[2],
            on: false,
        }),
        _ => None,
    }
}

#[tauri::command]
pub fn list_midi_ports() -> Vec<String> {
    match MidiInput::new("lyria-vj-list") {
        Ok(midi_in) => midi_in
            .ports()
            .iter()
            .map(|p| midi_in.port_name(p).unwrap_or_else(|_| "?".into()))
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[tauri::command]
pub fn open_midi_port(
    app: AppHandle,
    state: State<'_, MidiState>,
    index: usize,
) -> Result<String, String> {
    let midi_in = MidiInput::new("lyria-vj").map_err(|e| e.to_string())?;
    let ports = midi_in.ports();
    let port = ports.get(index).ok_or_else(|| "port index out of range".to_string())?;
    let name = midi_in.port_name(port).unwrap_or_else(|_| "?".into());
    let app_cl = app.clone();
    let conn = midi_in
        .connect(
            port,
            "lyria-vj-in",
            move |_ts, msg, _| {
                if let Some(ev) = parse_midi(msg) {
                    let _ = app_cl.emit_to("main", "midi", ev);
                }
            },
            (),
        )
        .map_err(|e| e.to_string())?;
    if let Ok(mut guard) = state.conn.lock() {
        *guard = Some(conn); // 旧接続は drop されて切断
    }
    Ok(name)
}

#[tauri::command]
pub fn close_midi_port(state: State<'_, MidiState>) {
    if let Ok(mut guard) = state.conn.lock() {
        *guard = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cc() {
        let ev = parse_midi(&[0xB0 | 2, 74, 100]).unwrap();
        assert_eq!(ev.kind, "cc");
        assert_eq!(ev.channel, 2);
        assert_eq!(ev.id, 74);
        assert_eq!(ev.value, 100);
        assert!(ev.on);
    }

    #[test]
    fn parses_note_on_and_off() {
        let on = parse_midi(&[0x90, 36, 120]).unwrap();
        assert_eq!(on.kind, "note");
        assert!(on.on);
        let off = parse_midi(&[0x80, 36, 0]).unwrap();
        assert!(!off.on);
        let zero_vel = parse_midi(&[0x90, 36, 0]).unwrap();
        assert!(!zero_vel.on); // velocity 0 = note off
    }

    #[test]
    fn ignores_short_or_unknown() {
        assert!(parse_midi(&[0x90, 36]).is_none());
        assert!(parse_midi(&[0xF0, 0, 0]).is_none());
    }
}
