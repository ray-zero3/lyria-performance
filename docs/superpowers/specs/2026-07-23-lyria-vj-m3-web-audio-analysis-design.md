# Lyria RealTime VJ — M3 Web Audio 実解析 設計

- **日付:** 2026-07-23
- **対象マイルストーン:** M3（Web Audio 再生 + AnalyserNode 実解析）
- **ステータス:** ドラフト（brainstorming 承認済み・自動進行）
- **前提:** M2 完了（テレメトリ契約・トランスポート・hub・VJ描画）。本設計は M2 の `TelemetryFrame` を**実 AnalyserNode 値**で埋める。

---

## 1. スコープ

### 入れる
- 実 AnalyserNode による解析で `TelemetryFrame`（level/peak/bands/spectrum/waveform/onset）を実値生成 → transport で VJ へ（VJ 側は変更なし）。
- **プラグ可能な音源**：`Dummy`（M2 の合成・音なし）／`Test`（内蔵オシレータ/ノイズ）／`Mic`（getUserMedia）。control 窓で切替。
- 解析の純ロジックを音源非依存の純粋関数に切り出し（M4 で Lyria を同じ入口に差す）。
- Mic の Tauri macOS 権限（`NSMicrophoneUsageDescription`）の最小設定。

### 入れない（後続へ）
- Lyria 接続（M4）、2セッション crossfade（M5）、VJ ビジュアル作り込み（M6）、MIDI（M2.5）。
- 高度な解析（ビート/テンポ推定、メル尺度、A特性）。M3 は素直な RMS/帯域/スペクトルフラックス。

---

## 2. モジュール構成

```
src/lib/audio/
  compute.ts   … 純粋関数 computeFrame(...) → TelemetryFrame（★Vitest 対象）
  analyser.ts  … AudioContext/AnalyserNode 構成 ＋ readFrame(seq,tMs)（配列取得→compute）
  sources.ts   … createTestSource(ctx,mode) / createMicSource(ctx)（{node, dispose} を返す）
  driver.ts    … AudioContext＋source＋transport を受け rAF ループで readFrame→pushFrame
src/routes/+page.svelte … 音源セレクタ [Dummy|Test|Mic] ＋ start/stop（M2 の UI を拡張）
src-tauri/ …（Mic 用）macOS マイク権限設定
```

責務分担（M2 準拠）: control 窓 = 測定テレメトリの権威（ここで解析）。VJ 窓 = 消費のみ（変更なし）。

---

## 3. 解析仕様（デフォルト、変更可）

- **FFT 2048**（`fftSize`）。周波数 1024 ビン、`smoothingTimeConstant ≈ 0.7`。
- **spectrum 48**：1024 の周波数ビンを 48 グループへ**線形平均**で集約、各 0..1（`getByteFrequencyData`/255）。
- **waveform 256**：時間領域（`getFloatTimeDomainData`, 長さ 2048）を stride 8 で間引き、`clampRange(-1,1)`。
- **level**：時間領域の RMS（0..1 に clamp）。**peak**：max|x|。
- **bands**：ビン→Hz（`i * sampleRate / fftSize`）で low `<250Hz` / mid `250–4000Hz` / high `>4000Hz` を平均集約、各 0..1。
- **onset**：スペクトルフラックス = `Σ max(0, spectrum[i] − prevSpectrum[i])`（前フレーム比の正増分）を正規化して 0..1 に clamp。prevSpectrum は driver が保持。
- すべて最後に M2 の `clampFrame` を通して契約へ整形（安全網）。

### 純粋関数の境界（テスト可能性）
```ts
// compute.ts
computeFrame(args: {
  freq: Uint8Array;      // getByteFrequencyData の結果（0..255）
  time: Float32Array;    // getFloatTimeDomainData の結果（-1..1）
  sampleRate: number;
  prevSpectrum: number[]; // 長さ SPECTRUM_BINS（onset 用）。初回は 0 埋め
  seq: number;
  tMs: number;
}): TelemetryFrame
```
AnalyserNode の配線（analyser.ts）は薄く、値計算はすべて compute.ts（純粋）に置く。

---

## 4. オーディオグラフ / 音源

- **Test**：`OscillatorNode`（周波数を LFO でスイープ）＋ `Gain` で振幅変調 → `Analyser`（必要なら低音量で `destination`）。bands/onset が動くように sweep＋周期パルス。
- **Mic**：`getUserMedia({audio}) → MediaStreamAudioSourceNode → Analyser`。**`destination` へ繋がない**（ハウリング回避）。
- **Dummy**：AnalyserNode を使わず M2 の `makeDummyFrame` を流す（音なし・決定的。VJ 描画開発用に温存）。
- **M4**：Lyria の PCM を鳴らす AudioNode を同じ `Analyser` 入口へ。

driver は選択された音源に応じて「Dummy ループ」or「解析ループ（readFrame）」を回し、いずれも `transport.pushFrame` で送る。session state（playing/startedAtMs）も M2 同様に setState。

---

## 5. control UI（+page.svelte 拡張）

- 音源セレクタ（ラジオ/セグメント）：`Dummy` / `Test` / `Mic`。
- start/stop、現在の push fps 表示（M2 のまま）。
- Mic 選択時は開始でパーミッション要求。失敗時はエラー表示（例外を投げない）。

---

## 6. Mic の Tauri 権限（macOS）

- Tauri v2 macOS で WKWebView が `getUserMedia` するには **マイク使用許可の説明文**が必要：バンドルの Info.plist に `NSMicrophoneUsageDescription` を与える。
- Tauri v2 の方法（いずれか実装時に確定）：`tauri.conf.json` の `bundle.macOS` 経由、またはカスタム `Info.plist`。最小の説明文（例:「音声解析のためマイクを使用します」）を設定。
- **ブラウザ検証（Test 信号）はこの設定に依存しない**。Mic の実機動作はユーザー環境で確認。

---

## 7. 検証

| 対象 | 方法 |
|---|---|
| `compute.ts`（帯域集約・spectrum 集約・waveform 間引き・RMS/peak・spectral-flux onset・clamp） | **Vitest**（合成した freq/time 配列で決定的に検証） |
| Test 信号 → 解析 → VJ 描画反応 | ブラウザ目視（`npm run dev`、`/` で Test 選択→開始、`/vj` で反応） |
| Mic → 解析、Tauri 実機・マイク権限 | **ユーザー環境で確認**（私からは検証不可） |

---

## 8. 成功基準（Done）

1. `computeFrame` の Vitest が緑（帯域・spectrum・waveform・level/peak・onset・clamp）。
2. control 窓で `Test` を選び開始 → VJ 窓の描画（背景/波形/読み出し）が**実解析値**で反応（ブラウザ目視）。
3. `Dummy` は従来どおり動作（温存）。`Mic` はブラウザで許可すれば解析が動く（ブラウザ目視、可能なら）。
4. `npm test` / `npm run check` / `cargo test` すべて緑。
5. 音源セレクタで Dummy/Test/Mic を切替でき、切替時に前音源が正しく停止（リーク無し）。

---

## 9. 未決/後続

- **Mic の Tauri 実機**：macOS 権限プロンプト・実挙動はユーザー確認（M3 で設定は入れる）。
- spectrum の対数尺度化・ビート/テンポ推定・より高度な onset は将来（M6 のビジュアル要求が固まってから）。
- Lyria PCM の再生方式（AudioBufferSource ストリーミング等）は M4 で設計（M3 の Analyser 入口は再利用）。
