# Lyria VJ — M3 Web Audio 実解析 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。Steps は checkbox。

**Goal:** 実 AnalyserNode 解析で `TelemetryFrame` を実値生成し、control 窓で Dummy/Test/Mic を切替、VJ が実音に反応する。

**Architecture:** 値計算は純粋関数 `compute.ts` に集約（★テスト対象）。`analyser.ts` が AnalyserNode を薄く配線し配列取得→compute。`sources.ts` が Test/Mic の AudioNode を提供。`driver.ts` が rAF で readFrame→`transport.pushFrame`。VJ 側は変更なし。

**Tech Stack:** Web Audio API / three（既存）/ Vitest / Tauri v2。

## Global Constraints（M2 から継続）
- 形の単一定義は TS の `contract.ts`。全フレームは `clampFrame` を通す。
- 固定長 SPECTRUM_BINS=48 / WAVEFORM_SAMPLES=256。
- 例外を投げない（Mic 失敗・音源切替でリークしない）。
- 検証: 純ロジック=Vitest／型=svelte-check／Rust=cargo test／描画=ブラウザ目視。git 未初期化（コミット手順はスキップ）。

## ファイル
```
src/lib/audio/compute.ts        … 新規（純粋関数群）
src/lib/audio/compute.test.ts   … 新規
src/lib/audio/analyser.ts       … 新規（AnalyserNode 配線）
src/lib/audio/sources.ts        … 新規（Test/Mic）
src/lib/audio/driver.ts         … 新規（解析/ダミーループ）
src/routes/+page.svelte         … 変更（音源セレクタ）
src-tauri/tauri.conf.json 他    … 変更（macOS マイク権限）
```

---

## Task M3-1: compute.ts（純粋関数）＋ tests

**Files:** Create `src/lib/audio/compute.ts`, `src/lib/audio/compute.test.ts`

**Interfaces (Produces):**
- `downsampleSpectrum(freq: Uint8Array, bins: number): number[]`（各 0..1）
- `downsampleWaveform(time: Float32Array, samples: number): number[]`（-1..1）
- `computeBands(freq: Uint8Array, sampleRate: number, fftSize: number): {low,mid,high}`（0..1）
- `computeLevelPeak(time: Float32Array): {level, peak}`
- `computeOnset(spectrum: number[], prevSpectrum: number[]): number`（0..1）
- `computeFrame(args: {freq,time,sampleRate,prevSpectrum,seq,tMs}): TelemetryFrame`

- [ ] Step 1: テスト＋実装を書く（下記コード）。
- [ ] Step 2: `npm test` 緑。
- [ ] Step 3: `npm run check` 0エラー。

実装 `compute.ts`:
```ts
import { clampFrame, type TelemetryFrame } from "$lib/telemetry/contract";
import { SPECTRUM_BINS, WAVEFORM_SAMPLES } from "$lib/telemetry/constants";

export function downsampleSpectrum(freq: Uint8Array, bins: number): number[] {
  const out = new Array<number>(bins).fill(0);
  const n = freq.length;
  if (n === 0) return out;
  const per = n / bins;
  for (let b = 0; b < bins; b++) {
    const start = Math.floor(b * per);
    const end = Math.max(start + 1, Math.floor((b + 1) * per));
    let sum = 0, cnt = 0;
    for (let i = start; i < end && i < n; i++) { sum += freq[i]; cnt++; }
    out[b] = cnt ? sum / cnt / 255 : 0;
  }
  return out;
}

export function downsampleWaveform(time: Float32Array, samples: number): number[] {
  const out = new Array<number>(samples).fill(0);
  const n = time.length;
  if (n === 0) return out;
  const stride = n / samples;
  for (let i = 0; i < samples; i++) {
    out[i] = time[Math.min(n - 1, Math.floor(i * stride))];
  }
  return out;
}

export function computeBands(freq: Uint8Array, sampleRate: number, fftSize: number) {
  const n = freq.length;
  let lo = 0, ln = 0, mi = 0, mn = 0, hi = 0, hn = 0;
  for (let i = 0; i < n; i++) {
    const hz = (i * sampleRate) / fftSize;
    const v = freq[i] / 255;
    if (hz < 250) { lo += v; ln++; }
    else if (hz < 4000) { mi += v; mn++; }
    else { hi += v; hn++; }
  }
  return {
    low: ln ? lo / ln : 0,
    mid: mn ? mi / mn : 0,
    high: hn ? hi / hn : 0,
  };
}

export function computeLevelPeak(time: Float32Array) {
  let sumSq = 0, peak = 0;
  for (let i = 0; i < time.length; i++) {
    const x = time[i];
    sumSq += x * x;
    const a = Math.abs(x);
    if (a > peak) peak = a;
  }
  return { level: time.length ? Math.sqrt(sumSq / time.length) : 0, peak };
}

export function computeOnset(spectrum: number[], prevSpectrum: number[]): number {
  const n = spectrum.length;
  if (!n) return 0;
  let flux = 0;
  for (let i = 0; i < n; i++) {
    const d = spectrum[i] - (prevSpectrum[i] ?? 0);
    if (d > 0) flux += d;
  }
  return Math.min(1, (flux / n) * 6); // ゲイン 6 で 0..1 に寄せる
}

export interface ComputeArgs {
  freq: Uint8Array;
  time: Float32Array;
  sampleRate: number;
  prevSpectrum: number[];
  seq: number;
  tMs: number;
}

export function computeFrame(args: ComputeArgs): TelemetryFrame {
  const { freq, time, sampleRate, prevSpectrum, seq, tMs } = args;
  const fftSize = time.length;
  const spectrum = downsampleSpectrum(freq, SPECTRUM_BINS);
  const waveform = downsampleWaveform(time, WAVEFORM_SAMPLES);
  const bands = computeBands(freq, sampleRate, fftSize);
  const { level, peak } = computeLevelPeak(time);
  const onset = computeOnset(spectrum, prevSpectrum);
  return clampFrame({ tMs, seq, audio: { level, peak, bands, spectrum, waveform, onset } });
}
```

テスト `compute.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  downsampleSpectrum, downsampleWaveform, computeBands,
  computeLevelPeak, computeOnset, computeFrame,
} from "./compute";
import { SPECTRUM_BINS, WAVEFORM_SAMPLES } from "$lib/telemetry/constants";

describe("downsampleSpectrum", () => {
  it("uniform 255 -> all 1.0, fixed length", () => {
    const f = new Uint8Array(1024).fill(255);
    const s = downsampleSpectrum(f, SPECTRUM_BINS);
    expect(s.length).toBe(SPECTRUM_BINS);
    expect(s.every((v) => Math.abs(v - 1) < 1e-9)).toBe(true);
  });
  it("empty -> zeros", () => {
    expect(downsampleSpectrum(new Uint8Array(0), SPECTRUM_BINS).length).toBe(SPECTRUM_BINS);
  });
});

describe("downsampleWaveform", () => {
  it("strided sampling, fixed length in [-1,1]-ish", () => {
    const t = new Float32Array(2048);
    for (let i = 0; i < t.length; i++) t[i] = Math.sin((i / t.length) * Math.PI * 2);
    const w = downsampleWaveform(t, WAVEFORM_SAMPLES);
    expect(w.length).toBe(WAVEFORM_SAMPLES);
    expect(w[0]).toBeCloseTo(0, 5);
  });
});

describe("computeBands", () => {
  it("low-only energy -> low>0, mid/high=0", () => {
    const f = new Uint8Array(1024);
    for (let i = 0; i <= 10; i++) f[i] = 255; // 48000/2048=23.4Hz/bin -> i<=10 は <250Hz
    const b = computeBands(f, 48000, 2048);
    expect(b.low).toBeGreaterThan(0.9);
    expect(b.mid).toBe(0);
    expect(b.high).toBe(0);
  });
});

describe("computeLevelPeak", () => {
  it("sine amp 0.5 -> rms~0.354, peak~0.5", () => {
    const t = new Float32Array(1024);
    for (let i = 0; i < t.length; i++) t[i] = 0.5 * Math.sin((i / t.length) * Math.PI * 2 * 4);
    const { level, peak } = computeLevelPeak(t);
    expect(level).toBeCloseTo(0.354, 2);
    expect(peak).toBeCloseTo(0.5, 2);
  });
});

describe("computeOnset", () => {
  it("rising spectrum -> positive; falling -> 0", () => {
    const prev = new Array(SPECTRUM_BINS).fill(0.1);
    const up = new Array(SPECTRUM_BINS).fill(0.5);
    const down = new Array(SPECTRUM_BINS).fill(0.0);
    expect(computeOnset(up, prev)).toBeGreaterThan(0);
    expect(computeOnset(down, prev)).toBe(0);
  });
});

describe("computeFrame", () => {
  it("returns clamped fixed-length frame", () => {
    const freq = new Uint8Array(1024).fill(128);
    const time = new Float32Array(2048);
    for (let i = 0; i < time.length; i++) time[i] = Math.sin(i * 0.1);
    const f = computeFrame({ freq, time, sampleRate: 48000, prevSpectrum: new Array(SPECTRUM_BINS).fill(0), seq: 7, tMs: 100 });
    expect(f.seq).toBe(7);
    expect(f.audio.spectrum.length).toBe(SPECTRUM_BINS);
    expect(f.audio.waveform.length).toBe(WAVEFORM_SAMPLES);
    expect(f.audio.level).toBeGreaterThan(0);
  });
});
```

---

## Task M3-2: analyser.ts ＋ sources.ts

**Files:** Create `src/lib/audio/analyser.ts`, `src/lib/audio/sources.ts`

**Interfaces:**
- `createAnalyser(ctx: AudioContext, input: AudioNode): { readFrame(seq,tMs): TelemetryFrame; dispose(): void }`
- `createTestSource(ctx: AudioContext): { node: AudioNode; dispose(): void }`
- `createMicSource(ctx: AudioContext): Promise<{ node: AudioNode; dispose(): void }>`

- [ ] Step 1: 実装（下記）。
- [ ] Step 2: `npm run check` 0エラー。（AudioNode 系は目視 M3-5 で）

`analyser.ts`:
```ts
import { computeFrame } from "./compute";
import { SPECTRUM_BINS, type } from "$lib/telemetry/constants"; // ※ SPECTRUM_BINS のみ使用
import type { TelemetryFrame } from "$lib/telemetry/contract";

export function createAnalyser(ctx: AudioContext, input: AudioNode) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.7;
  input.connect(analyser);
  const freq = new Uint8Array(analyser.frequencyBinCount); // 1024
  const time = new Float32Array(analyser.fftSize); // 2048
  let prevSpectrum: number[] = new Array(SPECTRUM_BINS).fill(0);

  return {
    readFrame(seq: number, tMs: number): TelemetryFrame {
      analyser.getByteFrequencyData(freq);
      analyser.getFloatTimeDomainData(time);
      const frame = computeFrame({
        freq, time, sampleRate: ctx.sampleRate, prevSpectrum, seq, tMs,
      });
      prevSpectrum = frame.audio.spectrum;
      return frame;
    },
    dispose() {
      try { input.disconnect(analyser); } catch { /* ignore */ }
    },
  };
}
```
> 注: `import { SPECTRUM_BINS } from "$lib/telemetry/constants";` のみ（上の `type` は誤り、実装時は `import { SPECTRUM_BINS } ...` に）。

`sources.ts`:
```ts
export interface AudioSource {
  node: AudioNode;
  dispose(): void;
}

/** 内蔵テスト信号: オシレータ（LFO で周波数スイープ）＋振幅。 */
export function createTestSource(ctx: AudioContext): AudioSource {
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = 220;
  // LFO で周波数をスイープ
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.2;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 180;
  lfo.connect(lfoGain).connect(osc.frequency);
  // 振幅を周期的に（onset が動くよう）
  const amp = ctx.createGain();
  amp.gain.value = 0.6;
  const tremolo = ctx.createOscillator();
  tremolo.frequency.value = 2;
  const tremGain = ctx.createGain();
  tremGain.gain.value = 0.4;
  tremolo.connect(tremGain).connect(amp.gain);
  osc.connect(amp);
  osc.start();
  lfo.start();
  tremolo.start();
  return {
    node: amp,
    dispose() {
      try { osc.stop(); lfo.stop(); tremolo.stop(); } catch { /* ignore */ }
      try { amp.disconnect(); } catch { /* ignore */ }
    },
  };
}

/** マイク入力（destination へは繋がない＝ハウリング回避）。 */
export async function createMicSource(ctx: AudioContext): Promise<AudioSource> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const node = ctx.createMediaStreamSource(stream);
  return {
    node,
    dispose() {
      try { node.disconnect(); } catch { /* ignore */ }
      for (const t of stream.getTracks()) t.stop();
    },
  };
}
```

---

## Task M3-3: driver.ts ＋ control UI

**Files:** Create `src/lib/audio/driver.ts`; Modify `src/routes/+page.svelte`

**Interfaces:**
- `startAudioDriver(opts: { source: "dummy"|"test"|"mic"; transport: TelemetryTransport }): Promise<{ stop(): void; onFps(cb:(n:number)=>void)? }>`
  - dummy: M2 の makeDummyFrame ループ。test/mic: AudioContext＋source＋analyser で readFrame ループ。
  - いずれも startedAtMs で setState(playing) を投げ、rAF で pushFrame。

- [ ] Step 1: `driver.ts` 実装（下記）。
- [ ] Step 2: `+page.svelte` に音源セレクタ [Dummy|Test|Mic]＋start/stop。
- [ ] Step 3: `npm run check` 0エラー。

`driver.ts`:
```ts
import type { TelemetryTransport } from "$lib/telemetry/bus";
import { makeDummyFrame, dummyStateAt } from "$lib/telemetry/dummy";
import { createAnalyser } from "./analyser";
import { createTestSource, createMicSource, type AudioSource } from "./sources";

export type SourceKind = "dummy" | "test" | "mic";

export interface AudioDriver {
  stop(): void;
}

export async function startAudioDriver(opts: {
  source: SourceKind;
  transport: TelemetryTransport;
  onFps?: (n: number) => void;
}): Promise<AudioDriver> {
  const { source, transport, onFps } = opts;
  const startedAtMs = Date.now();
  let seq = 0;
  let raf = 0;
  let running = true;
  let frames = 0;
  let lastFpsT = performance.now();

  transport.setState(dummyStateAt(startedAtMs, Date.now()));

  let ctx: AudioContext | null = null;
  let src: AudioSource | null = null;
  let analyser: ReturnType<typeof createAnalyser> | null = null;

  if (source !== "dummy") {
    ctx = new AudioContext();
    src = source === "mic" ? await createMicSource(ctx) : createTestSource(ctx);
    analyser = createAnalyser(ctx, src.node);
  }

  const loop = () => {
    if (!running) return;
    const now = Date.now();
    seq += 1;
    const frame =
      analyser != null
        ? analyser.readFrame(seq, now - startedAtMs)
        : makeDummyFrame(seq, now - startedAtMs);
    transport.pushFrame(frame);
    if (seq % 30 === 0) transport.setState(dummyStateAt(startedAtMs, now));
    frames++;
    const pt = performance.now();
    if (pt - lastFpsT >= 1000) { onFps?.(frames); frames = 0; lastFpsT = pt; }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return {
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      analyser?.dispose();
      src?.dispose();
      if (ctx) void ctx.close();
    },
  };
}
```

`+page.svelte`（要点）: `let sourceKind: SourceKind = $state("test")`; ラジオで Dummy/Test/Mic 選択。start で `driver = await startAudioDriver({source: sourceKind, transport, onFps: n=>fps=n})`、stop で `driver.stop()`。Mic 失敗時は try/catch でエラー表示。既存の setState/直書きダミーループは driver に置換。

---

## Task M3-4: Tauri マイク権限（macOS）

**Files:** Modify `src-tauri/tauri.conf.json`（`bundle.macOS` に権限説明）。必要なら `src-tauri/Info.plist`。

- [ ] Step 1: tauri.conf.json の `bundle` に macOS マイク権限説明を追加（Tauri v2 のスキーマに従い実装時確定。`NSMicrophoneUsageDescription`）。
- [ ] Step 2: `cargo build --manifest-path src-tauri/Cargo.toml` 成功。
- [ ] 注: 実機マイク動作はユーザー確認（私は検証不可）。ブラウザ検証（Test）はこの設定に非依存。

---

## Task M3-5: 統合検証

- [ ] `npm test`（compute テスト含む）緑。
- [ ] `npm run check` 0エラー。
- [ ] `cargo build`（M3-4 後）成功。
- [ ] ブラウザ: `npm run dev` → `/` で `Test` 選択→開始 → `/vj` で背景/波形/読み出しが**実解析値**で反応（目視）。Dummy でも従来通り動作。
- [ ] 成功基準 §8 を確認。

---

## 自己レビュー
- Spec §3 の全解析項目 → M3-1 の関数群で網羅。§4 音源 → M3-2。§5 UI → M3-3。§6 Tauri権限 → M3-4。§7 検証 → M3-1/M3-5。
- 型整合: `TelemetryFrame`/`clampFrame`/定数は M2 と一致。`TelemetryTransport` は既存。
- プレースホルダ無し（`analyser.ts` の import 注記は実装時に `SPECTRUM_BINS` のみへ修正と明記）。
