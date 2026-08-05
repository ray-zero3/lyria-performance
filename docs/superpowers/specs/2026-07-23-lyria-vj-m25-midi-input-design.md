# Lyria VJ — M2.5 MIDI 入力層 設計/計画

- **日付:** 2026-07-23 / 対象: M2.5（MIDI入力層）/ ステータス: 承認済み・自動進行
- **前提:** M2〜M4 実装済み。汎用 MIDI ラーン（Web MIDI 非採用、Rust midir/CoreMIDI）。

## スコープ
- Rust midir で MIDI 入力を購読 → Tauri `midi` イベントで control 窓へ。
- frontend: マッピング（純粋）＋ MIDI ラーン ＋ localStorage 永続化。
- CC → Lyria config/prompt weight を live 反映、Note/pad → アクション（reset_context/play_toggle/mute_bass/mute_drums）。
- 全 MIDI 入力を `TelemetryEvent{control,source:'midi'}` で pushEvent → VJ フラッシュ（"操作の動き"可視化）。
- ブラウザ検証用の**合成 MIDI インジェクタ**（実機なしで経路確認）。
- 入れない: MIDI out(LED)、CC ピックアップ/テイクオーバー、ファイル永続化（localStorage で足りる）。将来。

## モジュール
```
src/lib/midi/types.ts     … MidiMessage / MidiTarget / MidiMapping
src/lib/midi/mapping.ts   … midiKey/scaleCc/isContinuous/applyMidi（★Vitest）
src/lib/midi/store.ts     … loadMapping/saveMapping(localStorage)/bind（bindは純粋・★Vitest）
src/lib/midi/midiBus.ts   … Tauri `midi` 購読＋list/open/close＋inject（合成）
src/routes/+page.svelte   … MIDIポート選択/Learn/合成インジェクタ、MIDI→driver反映
src-tauri/src/midi.rs     … midir: list/open/close_midi_port, parse_midi(test), midi イベント
src-tauri/Cargo.toml      … midir 依存
src-tauri/src/lib.rs      … MidiState manage＋コマンド登録
```

## 契約
- Rust→front `midi` イベント: `{kind:'cc'|'note', channel:0-15, id:0-127, value:0-127, on:bool}`（camelCase）。
- マップ key: `"cc:ch:id"` / `"note:ch:id"` → target。
- 連続ターゲット範囲: bpm[60,200] guidance[0,6] density[0,1] brightness[0,1] temperature[0,2] promptWeight[0,1]。
- アクション: note-on（velocity>0）/ CC>63 で発火。reset_context/play_toggle/mute_bass/mute_drums。
- mute_bass/mute_drums は Lyria `setMusicGenerationConfig` の同名フィールド（実挙動は live 確認）。

## 反映フロー
MIDI msg → (learn中なら bind→保存) → applyMidi(mapping) → 連続: driver.setConfig(patch)/setPrompts(weight)、アクション: driver.resetContext 等 → いずれも transport.pushEvent(control) で VJ フラッシュ。

## 検証
- `mapping.ts`/`store.bind` を Vitest。Rust `parse_midi` を cargo test。midir コンパイル＋`list_midi_ports`。
- 合成 MIDI インジェクタで マッピング→driver→VJフラッシュ（イベントは rAF 非依存で流れる）。
- **実機 MIDI はユーザー**（コントローラ接続 → ポート選択 → Learn → 操作）。

## 成功基準
1. mapping/bind/parse_midi のテスト緑、npm test/check・cargo test/build/clippy 緑。
2. control に MIDIポート選択・Learn・合成インジェクタ。合成 CC/Note でマッピングが driver に反映し、VJ にフラッシュ＋読み出し変化。
3. mapping が localStorage で永続。
4. 実機 MIDI はユーザー確認（別途）。
