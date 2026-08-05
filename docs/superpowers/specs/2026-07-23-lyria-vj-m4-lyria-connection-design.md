# Lyria RealTime VJ — M4 Lyria 接続 設計

- **日付:** 2026-07-23
- **対象:** M4（Lyria RealTime 接続 + PCM 再生 + 操作UI）
- **ステータス:** ドラフト（brainstorming 承認済み・自動進行）
- **前提:** M2/M3 完了。M3 の AnalyserNode 入口に Lyria の音を流す。

## 一次情報（確認済み 2026-07-23）
- client: `new GoogleGenAI({ apiKey, apiVersion: "v1alpha" })`、`client.live.music.connect({ model: "models/lyria-realtime-exp", callbacks: { onmessage, onerror, onclose } })`。
- 受信: `message.serverContent.audioChunks[].data`（base64）。**出力 48kHz / 16-bit / stereo PCM**。
- 制御: `setWeightedPrompts({weightedPrompts:[{text,weight}]})` / `setMusicGenerationConfig({musicGenerationConfig:{bpm,guidance,density,brightness,temperature,...}})` / `play()` / `stop()` / `reset_context()`（bpm/scale 変更は reset か stop→play で反映＝ハード遷移）。
- **allowlist＋課金が必要な可能性**（キー作成後に実接続で要確認）。→ live 検証はユーザー環境。
- キー供給: **env `GEMINI_API_KEY`**（Rust が読み control 窓へ供給、コード/ログに出さない）。

## スコープ
### 入れる（キー無しでも作れる／モックで検証可能）
- `@google/genai` 依存追加。
- PCM デコード（base64 PCM16 stereo 48k → Float32 L/R）＝純粋関数（★Vitest）。
- ストリーミング再生プレイヤ（AudioBuffer をスケジューリング、M3 の analyser 入口へ接続）。
- **モックLyria音源**（合成 PCM16 チャンクを実 Lyria と同形/同レートで吐く）→ 経路を今検証可能に。
- 実 Lyria セッション（session.ts）を同インターフェースで wire（live はキー依存）。
- 操作UI：prompts エディタ＋config（bpm/guidance/density/brightness/temperature）＋connect/play/stop。音源に `MockLyria`/`Lyria` を追加。
- Rust `keystore.rs`：`get_api_key`（env `GEMINI_API_KEY`）。control 窓のみ。
- **API テレメトリイベント**：session/mock が `TelemetryEvent{kind:'api', api:'session'|'prompt_set'|'config_set'|'chunk'|'rotate'}` を発火 → transport.pushEvent → VJ が可視化（データビジュアライズの主役データ）。

### 入れない
- 2セッション crossfade（M5）、VJ 本番ビジュアル（M6）、MIDI（M2.5）、ephemeral token 化（将来のセキュリティ強化）。

## モジュール
```
src/lib/lyria/pcm.ts      … 純粋: decodePcm16Stereo(base64|ArrayBuffer) → {left:Float32Array,right:Float32Array}（★Vitest）
src/lib/lyria/player.ts   … ストリーミング再生（pushChunk→AudioBuffer→スケジュール→出力ノード）。nextTime 管理・アンダーラン耐性
src/lib/lyria/session.ts  … @google/genai ラッパ: connect(apiKey)/setPrompts/setConfig/play/stop/resetContext + onChunk + onEvent
src/lib/lyria/mock.ts     … モック音源: 合成 PCM16 チャンク生成（session.ts と同 onChunk/onEvent i/f）
src/lib/lyria/config.ts   … 定数: MODEL, API_VERSION, SAMPLE_RATE=48000, CHANNELS=2、config→payload マップ（★一部Vitest）
src/lib/audio/driver.ts   … 変更: source に "mocklyria"/"lyria" を追加（player→analyser 入口へ）
src/routes/+page.svelte   … 変更: prompts/config UI＋音源に Lyria/MockLyria
src-tauri/src/keystore.rs … 新規: get_api_key（env）
src-tauri/src/lib.rs      … 変更: keystore コマンド登録
```

## オーディオグラフ
`player(AudioBufferSource群) → gain → analyser(M3) → destination`。VJ は解析経由で反応、同時にスピーカ出力。PCM は 48k 固定バッファ（`ctx.createBuffer(2, frames, 48000)`）で context が再生時リサンプル。

## セッション/再生フロー
1. control で音源 `Lyria`（or `MockLyria`）選択、prompts/config 入力、connect。
2. Lyria: `get_api_key`(Rust env) → `GoogleGenAI` → `live.music.connect` → setPrompts/setConfig → play。onmessage の audioChunks を player.pushChunk。
3. player が analyser 入口へ流し、driver の rAF ループが readFrame→pushFrame（M3 のまま）。
4. prompts/config 変更は session に反映（bpm/scale は resetContext）。都度 `TelemetryEvent{api:...}` を pushEvent。

## 検証
| 対象 | 方法 |
|---|---|
| pcm.ts（base64→Float32 L/R、範囲、length）、config→payload マップ、player の nextTime スケジュール算術 | **Vitest** |
| MockLyria → 再生 → 解析 → VJ 反応 | ブラウザ目視（※M3同様 rAF/AudioContext のハーネス制約あり→フォーカスされたブラウザ/実機でユーザー確認） |
| 実 Lyria 接続（prompts/config/play、音、reset） | **キー＋allowlist 前提でユーザー環境** |

## 成功基準
1. `pcm.ts`・config マップ・player 算術の Vitest 緑。
2. `npm test`/`npm run check`/`cargo test`/`cargo build` 緑。
3. control に prompts/config UI と Lyria/MockLyria 音源。`get_api_key` が env を返す（キー未設定なら空/エラーを UI 表示、例外で落ちない）。
4. MockLyria で再生経路が動く（ユーザーのフォーカスブラウザ/実機で音＋VJ反応、私は unit＋構築確認まで）。
5. 実 Lyria は「キー＋allowlist 準備後」に live 検証（別途）。

## 未決/リスク
- **allowlist＋課金**（外部ブロッカー、ユーザー対応）。
- `@google/genai` のブラウザ/WKWebView 動作・WebSocket 挙動は実接続で確認。
- `reset_context` の SDK 名（`resetContext`/`reset_context`）は実装時に SDK 実体で確定。
- ephemeral token 化は将来（本番セキュリティ）。
