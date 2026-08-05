# Lyria VJ — M5b: マスターFXチェーン（リバーブ調整＋ビートリピート＋カオス演出）設計

- 日付: 2026-07-24
- 位置づけ: M5 の拡張（トランジションを「もっとぐちゃぐちゃ」に）。M6 の本番ビジュアル前。
- ステータス: 設計（brainstorming 合意済み）。git 未初期化のまま（コミットしない合意）。
- **更新（2026-07-24, 実装後）**: crush（歪み/WaveShaper）は user FB「酷すぎる」で**除去**。実装済み FX は **reverb / stutter / filter / delay の4つ**。本ドキュメント中の crush 記述（§1・§2・§3.4・§3.3 の crush 系）は設計時点の記録として残すが、現行コードには存在しない。

## 1. ゴール

M5 の単純リバーブ wash を、複数エフェクトのマスターチェーンに拡張する。トランジション中に
「カオス量 0→peak→0」で全 FX を一括駆動しつつ、各 FX を個別にスライダー/MIDI で調整できる。

**brainstorming 合意（2026-07-24）**:
- FX パレット（全採用）: **リバーブ量調整 / ビートリピート・スタッター / フィルタースイープ / ビットクラッシュ・歪み＋ディレイ**。
- ビートリピート: **AudioWorklet で本物のスライスループ**（リングバッファ）。DSP コアは純粋関数化して Vitest 検証。
- 制御: **カオスマクロ（0..1）＋各 FX 個別調整**。

## 2. マスターFXチェーン（信号グラフ）

```
preMaster(=デッキ合流)
  → beatRepeat (AudioWorkletNode 'beat-repeat' / 失敗時はパススルー)
  → distortion (WaveShaper / amount=0 で透過)
  → filter (BiquadFilter lowpass / freq=20k・Q=0.7 で透過)
  →┬────────────────────────────→ master   （dry）
   ├→ delaySend → Delay ⇄ feedback → master （delay wet）
   └→ reverbSend → Convolver(IR) → master    （reverb wet）
master → destination / analyser
```

- 定常時（chaos=0・全 base=0）: reverbSend/delaySend=0, filter 全開, distortion 透過, stutter mix=0 ＝ **dry のみ＝従来の音**。
- `createMasterFx` は AudioWorklet の `addModule` があるため **async** になる（driver は既に await 済み）。

## 3. コンポーネント

### 3.1 `src/lib/audio/beatRepeat.ts`（純粋・Vitest）

AudioWorklet と共有するビートリピートの DSP コア（1ch分）。worklet 側は同一ロジックを自己完結でミラー。

- `interface BeatRepeatState { ring: Float32Array; w: number; looping: boolean; frozen: Float32Array; loopPos: number; sliceLen: number }`
- `createBeatRepeatState(maxFrames: number): BeatRepeatState`
- `beatRepeatBlock(st, input, output, mix, sliceFrames): void`
  - 常に ring に input を書く（履歴保持）。
  - `mix>0` で初回に「直前 sliceFrames サンプル」を `frozen` にコピーして凍結ループ開始。`output = mix*frozen[loopPos] + (1-mix)*input`。
  - `mix<=0` で `looping=false`（次回起動で再キャプチャ）、`output=input`。
  - frozen は ring と独立バッファなので、ループ中に input で上書きされない。

### 3.2 `static/worklets/beat-repeat.js`（AudioWorkletProcessor・自己完結の古典スクリプト）

- `registerProcessor('beat-repeat', ...)`。paramDescriptors: `mix`(0..1, k-rate), `sliceFrames`(1..96000, k-rate)。
- ch ごとに ring/frozen を持ち、§3.1 と同一アルゴリズムを inline 実装（コメントで beatRepeat.ts をミラーと明記）。
- 静的配信: SvelteKit の `static/` → `${base}/worklets/beat-repeat.js` を `ctx.audioWorklet.addModule` で読む。
- 未対応/失敗時は driver 側 createMasterFx が try/catch でパススルー（stutter ノード無し）にフォールバック。

### 3.3 `src/lib/audio/fxParams.ts`（純粋・Vitest）

カオスマクロと各 base から具体的なノード値を計算する中核。

- `interface FxBases { reverb; stutter; filter; crush; delay }`（各 0..1）
- `interface FxParams { reverbWet; stutterMix; filterFreq; filterQ; crushDrive; delayWet; delayFeedback }`
- `FILTER_OPEN_HZ=20000`, `FILTER_CLOSED_HZ=300`
- `computeFxParams(bases, chaos): FxParams`
  - 各 FX 実効量 = `clamp01(base + chaos * weight)`（weight: reverb .6 / stutter .9 / filter .85 / crush .7 / delay .7）。
  - `filterFreq = FILTER_OPEN_HZ * (FILTER_CLOSED_HZ/FILTER_OPEN_HZ)^filterAmt`（対数スイープ・全開→closed）。
  - `filterQ = 0.7 + filterAmt*8`、`delayFeedback = delayAmt*0.82`。
  - chaos=0・base=0 で透過値（reverbWet0/stutterMix0/filterFreq≈20000/filterQ≈0.7/crush0/delay0）。

### 3.4 `src/lib/audio/masterFx.ts`（改修）

- `impulseResponseSamples`（既存・純粋）は維持。
- `interface MasterFx { input: GainNode; output: AudioNode; setChaos(v): void; setReverbBase(v): void; setStutterBase(v): void; setFilterBase(v): void; setCrushBase(v): void; setDelayBase(v): void; setBpm(bpm): void; dispose() }`
- `createMasterFx(ctx, opts?): Promise<MasterFx>`：上記チェーンを構築。内部 `apply()` が `computeFxParams(bases, chaos)` を評価し各ノードへ反映。
  - 連続値は `setTargetAtTime(v, now, 0.02)` で平滑化（zipper 回避）。WaveShaper curve は crushDrive 変化時のみ再生成（毎フレーム再構築しない）。
  - `setBpm(bpm)`: `sliceFrames = round(sampleRate * (60/bpm) * STUTTER_DIVISION)` を stutter param へ。
  - stutter が null（worklet 失敗）なら preMaster→distortion 直結。
- `makeDistortionCurve(amount)`：amount=0 で線形（透過）、増で歪み。

### 3.5 `src/lib/lyria/rotation.ts`（軽微改修）

- コールバック `onWet` を **`onChaos`** にリネーム（意味を「トランジション強度＝カオス量」に）。emit は envelope の `wet`（0→peak→0）を chaos として渡す。テスト影響なし（rotation.test は onWet 未使用）。

### 3.6 `src/lib/audio/driver.ts`（改修）

- `masterFx = await createMasterFx(ctx)`。初期 `masterFx.setBpm(curConfig.bpm)`。
- rotation opts: `onChaos: (c) => masterFx?.setChaos(c)`。
- `setConfig` で bpm 変化を `masterFx?.setBpm(c.bpm)` に反映。
- `AudioDriver` に `setChaos(v: number)` と `setFx(name: MasterFxName, v: number)` を追加（`MasterFxName='reverb'|'stutter'|'filter'|'crush'|'delay'`）。非 lyria は no-op。
- transition ローカルの `wet`→`chaos` にリネーム。`controlParams.chaos`（0..1）と `transitionProgress` を公開（`session.state="rotating"`）。

### 3.7 MIDI / UI（改修）

- `ContinuousTarget` に追加: `fxReverb / fxStutter / fxFilter / fxCrush / fxDelay / chaos`。`CONTINUOUS_TARGETS` と `mapping.ts` の `RANGES`（全て `[0,1]`）に登録。
- `+page.svelte`:
  - FX パネル（sliders）: chaos / reverb / stutter / filter / crush / delay（各 0..1）。onchange → `driver.setChaos` / `driver.setFx`。
  - `applyContinuous`: fx/chaos ターゲットを先に分岐（`driver.setFx`/`setChaos` ＋ ローカル slider 更新）、それ以外は従来の cfg 経路。

## 4. 定数（`src/lib/telemetry/constants.ts`）

- `CHAOS_PEAK = 0.8`（トランジションのカオス強度ピーク。plan.wetPeak に渡す）。
- `STUTTER_DIVISION = 0.5`（ビート分割: 1/8 音符）。
- `DELAY_TIME_S = 0.18`。
- （filter 境界・chaos weight は fxParams.ts に集約）。
- 既存 `REVERB_WET_PEAK` は撤去し `CHAOS_PEAK` に置換（driver の plan.wetPeak）。

## 5. テスト計画

**純粋・単体（Vitest）**:
- `beatRepeat`: mix=0 パススルー、mix=1 で凍結スライスをループ（小さな ring/slice で決定的検証）、mix=0.5 の dry/wet ブレンド、再起動で再キャプチャ。
- `fxParams.computeFxParams`: 透過（0,0）、chaos=1 で全 FX 上昇＋filterFreq≈closed、base が floor、chaos 単調、filterFreq 単調減少。
- `masterFx.impulseResponseSamples`: 既存維持。
- `crossfade` / `rotation`: 既存維持（rotation は onWet→onChaos リネームのみ、テスト不変）。

**live のみ（user 確認）**: 実 FX の聞こえ（特に本物ビートリピートの質感、フィルタースイープ、歪み、ディレイ）、WKWebView の AudioWorklet 動作、カオス連動トランジションの「ぐちゃぐちゃ」度、個別スライダー/MIDI の効き。

## 6. エラーハンドリング / 後方互換

- AudioWorklet 未対応/読込失敗 → stutter 無しでチェーン成立（try/catch・log）。
- 全 base=0・chaos=0 で従来音（回帰: 既存 test/mic/dummy と M4/M5 の挙動不変）。
- dispose で全 FX ノード（stutter/shaper/filter/delay/fb/sends/conv/pre/master）を解放。

## 7. スコープ外

- 真のビットクラッシュ（サンプルレート/ビット深度削減の worklet 実装）は WaveShaper 歪みで近似（本物は将来）。
- FX の順序切替・プリセット・オートメーション記録は対象外。
- VJ 本番ビジュアル（M6）。
