# Lyria RealTime VJ — M2 テレメトリ基盤スケルトン 設計

- **日付:** 2026-07-23
- **対象マイルストーン:** M2（テレメトリ基盤スケルトン先行）
- **ステータス:** ドラフト（brainstorming 承認済み／ユーザーレビュー待ち）
- **前提文脈:** `../../../HANDOFF.md`（プロジェクト全体の決定事項・API一次情報）

---

## 1. 北極星（不変の指針）

「AIが生成する音を人間がリアルタイムに操る」——その **操作の動き・API受信の内容/タイミング・時刻/タイムライン・音の波形という"データそのもの"を主役** に、オーガニック＋幾何学の視覚言語で見せ、**DJではないライブ感** を成立させるデータビジュアライズ型VJ。見せ方は **ハイブリッド（世界＝媒体 ＋ 読めるデータ層 を合成）**。

### 確定している中心軸（brainstorming の結果）

- **用途:** ライブ演奏（観客前）。優先度は 堅牢性（落ちない）＞ 即応する操作性 ＞ 第2ディスプレイ全画面。
- **視覚言語:** オーガニック＋幾何学の複数シーン（データが駆動する媒体）。※M2では作り込まず最小プレースホルダ。
- **見せ方:** ハイブリッド。
- **操作:** 汎用MIDIラーン（Rust midir 経由、機種未定）。操作の動き自体も可視化対象。

---

## 2. スコープ（この設計が対象にする範囲＝M2）

### 入れる
- 2窓（control=`/` ／ VJ=`/vj`）の skeleton。
- Rust hub：commanded-state の単一の真実 ＋ イベント中継 ＋ 窓/第2ディスプレイ管理。
- **テレメトリ契約**（音解析＋操作＋API＋時刻）を Rust ⇔ TS で型定義。
- **ダミーテレメトリ**を control 窓が生成 → hub 経由 → VJ 窓が消費（実データ経路と同じ向き）。
- VJ 窓の **最小ハイブリッド描画**（波形リボン／タイムライン／操作発火フラッシュ／level駆動の背景パルス／prompt文字・config読み出し）。
- 第2ディスプレイ全画面。
- **トランスポート抽象化**（`tauriTransport` / `browserTransport` の2実装）。

### 入れない（後続マイルストーンへ委譲、M2では差し替え口だけ用意）
- 実MIDI入力（M2.5）、実Web Audio解析（M3）、実Lyria接続（M4）、2セッション crossfade（M5）、シーンシステム作り込み（M6）。

### マイルストーン全体像（文脈）
| # | 内容 | Lyriaキー |
|---|------|-----------|
| M2 | **本設計**：2窓＋hub＋テレメトリ契約（ダミー流）＋最小VJ描画＋第2ディスプレイ | 不要 |
| M2.5 | MIDI入力層（midir → events → UIマッピング＋MIDIラーン） | 不要 |
| M3 | Web Audio再生＋AnalyserNode実解析（ダミー→実 frame） | 不要 |
| M4 | Lyria接続（prompts/config、PCM→Web Audio）＋操作UI | 要 |
| M5 | 2セッション・8分ローテ＋クロスフェード | 要 |
| M6 | VJビジュアル作り込み（WebGPU/TSLを音解析で駆動） | 一部要 |

---

## 3. アーキテクチャと責務分担

- **Rust hub** = *commanded-state*（コマンドで変わる状態：session / config / prompts / 操作パラメータのスナップショット）の権威 ＋ 全イベント中継 ＋ 窓・第2ディスプレイ・APIキー管理。
- **control 窓** = *measured-telemetry*（測定値：音解析フレーム、将来のLyria受信イベント）の権威。M2ではここがダミー生成器。
- **VJ 窓** = 純粋な消費者。hub から来た state＋telemetry で描画するだけ（ロジックを持たない＝落ちにくい）。

### データ経路の方針
- 遅い authoritative state は hub が保持し、変化時にブロードキャスト（`state`）。
- 高レートのテレメトリフレーム（~30-60fps）は control 窓が emit → hub が `emit_to` で VJ へ中継（`frame`）。
- 離散の発火イベントは `event` で中継。
- **hub 一元中継の理由:** 権威の一本化。後で record/replay を挟めてダミー検証やライブのフェイルセーフに使える。60fps×数KBは Tauri IPC で問題なし。将来ボトルネックなら window直結 / Tauri Channel に差し替え可（`bus.ts` の内側だけの変更で済む）。

### モジュール境界（多数の小さいファイル）
```
src-tauri/src/
  lib.rs            … 配線・commands 登録
  windows.rs        … control/vj 窓生成・第2ディスプレイ検出・全画面
  hub/state.rs      … commanded-state 保持＋変化ブロードキャスト
  hub/events.rs     … 契約型(serde)＋中継(emit_to/listen)
  midi.rs           … midir/CoreMIDI（M2はstub）
  keystore.rs       … APIキー(env)（M4、M2はstub）
src/
  routes/+page.svelte        … control 窓シェル
  routes/vj/+page.svelte     … VJ 窓シェル
  lib/telemetry/contract.ts  … Rust契約のTSミラー（形の単一定義）
  lib/telemetry/constants.ts … SPECTRUM_BINS=48 / WAVEFORM_SAMPLES=256 等
  lib/telemetry/bus.ts       … TelemetryTransport インターフェース＋環境判定
  lib/telemetry/tauriTransport.ts   … 本番（emit/listen/invoke）
  lib/telemetry/browserTransport.ts … 検証（BroadcastChannel＋ローカルdummy）
  lib/telemetry/dummy.ts     … ダミー生成器（M2、差し替え可）
  lib/vj/renderer.ts         … three.js/WebGPU（probe流用）
  lib/vj/scene.ts            … 合成・ループ
  lib/vj/store.ts            … 窓内の最新 state/frame/event 保持（消費側の小ストア）
  lib/vj/layers/{backgroundPulse,waveformRibbon,timeline,controlFlashes,readouts}.ts
```

---

## 4. テレメトリ契約

「今の状態（遅い・権威）」「測定フレーム（高レート）」「発火イベント（離散）」を分離するのが堅牢性の鍵。

### ① HubState（commanded-state：hubが権威、変化時に `state` でブロードキャスト）
```ts
HubState {
  session: {
    id: string
    state: 'idle' | 'connecting' | 'playing' | 'rotating' | 'closed'
    startedAtMs: number | null   // 実時計ms（VJは elapsed = now - startedAtMs で算出）
    durationCapMs: number        // 600_000（10分上限）
    rotateAtMs: number | null    // ~480_000（M5のローテ目標）
  }
  music:   { bpm: number, scale: string, guidance: number, density: number, brightness: number }
  prompts: { text: string, weight: number }[]     // 読めるデータ層のテキスト
  controlParams: Record<string, number>           // マップ済みパラメータ現在値（読み出し用）
}
```

### ② TelemetryFrame（測定値：control窓が権威、~30-60fps、control→hub→VJ の `frame`）
```ts
TelemetryFrame {
  tMs: number            // 生成側タイムスタンプ（実時計）
  seq: number            // 連番（欠落検知。落ちてもVJは last-known 保持で継続）
  audio: {
    level: number        // 0-1（RMS）
    peak:  number         // 0-1
    bands: { low: number, mid: number, high: number }   // 各0-1
    spectrum: number[]   // 固定 SPECTRUM_BINS=48（0-1）
    waveform: number[]   // 固定 WAVEFORM_SAMPLES=256（-1..1）← ハイブリッドの波形リボン
    onset: number        // トランジェント強度 0-1
  }
}
```
- 配列は固定長（`constants.ts`）。M2はJSONで十分、将来重ければ Tauri Channel / 型付き配列へ（`bus.ts` 内側で差し替え）。

### ③ TelemetryEvent（離散の「今起きた」：`event`、低〜中レート）
```ts
TelemetryEvent =
  | { kind:'control', tMs:number, source:'midi'|'ui', ctrl:'cc'|'note'|'param',
      id:string|number, value:number, label?:string }                 // 操作発火フラッシュ
  | { kind:'api', tMs:number,
      api:'prompt_set'|'config_set'|'chunk'|'session'|'rotate', payload:unknown }  // API受信の内容/タイミング可視化
```

### コマンド（窓 → hub）
- `get_state` … VJ/control がマウント時に現在スナップショットを要求（遅れて起動した窓も即正しくなる＝堅牢性）。
- `set_music_config` / `set_prompts` / `set_control_param` … hub state 更新 → `state` ブロードキャスト（M2はダミー生成器/UIスタブが叩く）。

### データフロー（M2ダミー）
```
control窓 (dummy.ts)
  ├─ 60fps : TelemetryFrame ─emit('frame')→ Rust hub ─emit_to(vj,'frame')→ VJ scene
  ├─ 変化時: set_* command  → hub state →(broadcast 'state')→ control + VJ
  └─ 随時  : TelemetryEvent  ─emit('event')→ hub ─emit_to(vj,'event')→ VJ layers
VJ窓 マウント時: invoke('get_state') → 現在 HubState を取得
```

**堅牢性の要点:** state=いつでも正しい現在値（読み出し用）、frame=高レート測定、event=瞬間の発火。VJは frame 欠落を last-known で吸収、窓は任意順で起動可（`get_state`で同期）。

---

## 5. VJ最小描画（ハイブリッド経路の端から端までの証明）

各レイヤーは小さい独立モジュール。`scene.ts` が rAF ループで `store.ts` の最新 frame/state/event を引いて更新。

- `backgroundPulse.ts` … level/bands で呼吸するオーガニック風の全画面背景（世界＝媒体のプレースホルダ。最小ノイズ/グラデ場）。
- `waveformRibbon.ts` … 256サンプルを世界に織り込む波形リボン（"読めるデータ"の看板要素）。
- `timeline.ts` … セッション経過/残り＋ローテ・カウントダウン（実時計＋ダミーsession）。
- `controlFlashes.ts` … `TelemetryEvent{control}` で発火位置にフラッシュ/トレイルを生成し減衰（"操作の動き"の可視化）。
- `readouts.ts` … 読める文字：現在prompt("warm pads")・bpm/guidance/density/brightness・session状態。

**描画方式:** 世界・波形・フラッシュは three.js/WebGPU（probe流用）、**読めるテキストは WebGPUキャンバス上のDOMオーバーレイ** でシャープに。

---

## 6. 第2ディスプレイ全画面（Rust `windows.rs`）

- 起動時：control窓＝プライマリ（ウィンドウ）、VJ窓を生成。
- モニタ検出（Tauri `available_monitors`）：**2枚以上ならVJ窓を第2ディスプレイへ移動＋全画面**。1枚ならプライマリにウィンドウ表示（dev フォールバック＝落とさない）。
- control窓から **VJ窓のディスプレイ再割当＋全画面トグル** をコマンドで（本番中に配線が変わっても復帰可）。

---

## 7. 堅牢性（ライブ最優先）

- VJ窓は純消費者：入力値は clamp/検証、frame欠落は last-known 保持、state無しはデフォルト描画。**rAFループ内で例外を投げない**（各レイヤー更新を防御的にラップ）。
- 窓は任意順で起動可（`get_state`で同期）。
- control窓がリロード/クラッシュしても hub state は Rust 側に残り、VJは最後の frame を保持（黒画面にしない）。※完全な再接続ポリッシュは後続。
- WebGPU初期化失敗はフォールバック表示（false-earth の gpuError / LoadingScreen パターン）。

---

## 8. 検証方針

### トランスポート抽象化（検証を可能にする設計上の工夫）
Tauri のネイティブ窓は Chrome拡張で attach できず目視検証が難しい。`bus.ts` を `TelemetryTransport` インターフェースにし2実装を持たせる:
- `tauriTransport`（emit/listen/invoke）… 本番。
- `browserTransport`（`/`と`/vj`タブ間を BroadcastChannel ＋ローカル dummy 生成）… 素の `vite dev` ＋ Chrome で VJ描画・control UI・契約を高速に目視検証。

環境判定（`window.__TAURI__`）で自動切替。疎結合な良い設計を兼ねる。実Tauri（2窓・第2ディスプレイ・hub統合）は `cargo tauri dev` で最終確認。

**browserモードでのhub権威:** browser には Rust hub が無いため、**control タブ（`/`）が hub を代行**する。すなわち control タブが HubState を保持し、`get_state` 要求や `set_*` を BroadcastChannel 越しに応答・ブロードキャストする（Tauriモードでは Rust hub がこれを担う）。契約・イベント名・消費側コードは両モードで完全に同一で、`bus.ts` の実装差だけで吸収する。

### テストレベル（性質で分ける＝brainstormingで採択）
| 対象 | 方法 |
|---|---|
| 純ロジック（契約の(de)serialize/検証、timeline/rotate算術、clamp、dummy生成の決定性、将来のMIDIマップ/crossfade曲線） | **Vitest ユニットテスト**（決定的で正しさが要る箇所） |
| 描画（WebGPU/threeレイヤー、窓/ディスプレイ配置） | **svelte-check/tsc ＋ Chrome/WKWebView 目視** |

---

## 9. M2 の成功基準（Done の定義）

1. `cargo tauri dev` で control 窓（プライマリ）と VJ 窓が起動し、モニタ2枚時に VJ 窓が第2ディスプレイで全画面になる（1枚時はフォールバック）。
2. control 窓のダミー生成器が frame(60fps)/state/event を発行し、hub 経由で VJ 窓に届く。
3. VJ 窓が最小ハイブリッドを描画：波形リボン・タイムライン・操作フラッシュ・背景パルス・読み出しテキストがダミーデータで動く。
4. `browserTransport` で素の `vite dev` ＋ Chrome から `/` と `/vj` を開き、同じ描画が目視確認できる。
5. 純ロジックの Vitest が緑、`svelte-check`/`tsc` が通過。
6. 窓を任意順で起動しても `get_state` で同期し、frame を数フレーム落としても VJ が破綻しない。

---

## 10. 未決事項（後続マイルストーンで詰める・M2の実装を妨げない）

- **ブロッカー: Lyria APIキー ＋ allowlist**（AI Studio で `lyria-realtime-exp` が叩けるか要確認。M4で必要）。
- **MIDIコントローラ機種**（未定 → M2.5でMIDIラーンUXを詰める。決まれば固定マップも併設可）。
- **シーンシステムの作り込み**（オーガニック/幾何学の各シーン・遷移・音特徴→パラメータの割当。M6）。
- **クロスフェードのUX**（拍合わせの作り込み度合い。M5）。
- **音特徴 → 視覚パラメータの詳細マッピング**（M3で実解析が入ってから詰める）。
