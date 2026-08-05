import { clampFrame, type TelemetryFrame } from "$lib/telemetry/contract";
import { SPECTRUM_BINS, WAVEFORM_SAMPLES } from "$lib/telemetry/constants";

/** 周波数ビン（0..255）を bins グループへ線形平均で集約（各 0..1）。 */
export function downsampleSpectrum(freq: Uint8Array, bins: number): number[] {
  const out = new Array<number>(bins).fill(0);
  const n = freq.length;
  if (n === 0) return out;
  const per = n / bins;
  for (let b = 0; b < bins; b++) {
    const start = Math.floor(b * per);
    const end = Math.max(start + 1, Math.floor((b + 1) * per));
    let sum = 0;
    let cnt = 0;
    for (let i = start; i < end && i < n; i++) {
      sum += freq[i];
      cnt++;
    }
    out[b] = cnt ? sum / cnt / 255 : 0;
  }
  return out;
}

/** 時間領域（-1..1）を samples 本へ stride 間引き。 */
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

/** ビン→Hz で low/mid/high に積分平均（各 0..1）。 */
export function computeBands(freq: Uint8Array, sampleRate: number, fftSize: number) {
  const n = freq.length;
  let lo = 0;
  let ln = 0;
  let mi = 0;
  let mn = 0;
  let hi = 0;
  let hn = 0;
  for (let i = 0; i < n; i++) {
    const hz = (i * sampleRate) / fftSize;
    const v = freq[i] / 255;
    if (hz < 250) {
      lo += v;
      ln++;
    } else if (hz < 4000) {
      mi += v;
      mn++;
    } else {
      hi += v;
      hn++;
    }
  }
  return {
    low: ln ? lo / ln : 0,
    mid: mn ? mi / mn : 0,
    high: hn ? hi / hn : 0,
  };
}

/** 時間領域から RMS(level) と peak。 */
export function computeLevelPeak(time: Float32Array) {
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < time.length; i++) {
    const x = time[i];
    sumSq += x * x;
    const a = Math.abs(x);
    if (a > peak) peak = a;
  }
  return { level: time.length ? Math.sqrt(sumSq / time.length) : 0, peak };
}

/** スペクトルフラックス（前フレーム比の正増分）を 0..1 に正規化。 */
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

/** AnalyserNode の生配列から TelemetryFrame を計算（純粋・音源非依存）。 */
export function computeFrame(args: ComputeArgs): TelemetryFrame {
  const { freq, time, sampleRate, prevSpectrum, seq, tMs } = args;
  const fftSize = time.length;
  const spectrum = downsampleSpectrum(freq, SPECTRUM_BINS);
  const waveform = downsampleWaveform(time, WAVEFORM_SAMPLES);
  const bands = computeBands(freq, sampleRate, fftSize);
  const { level, peak } = computeLevelPeak(time);
  const onset = computeOnset(spectrum, prevSpectrum);
  return clampFrame({
    tMs,
    seq,
    audio: { level, peak, bands, spectrum, waveform, onset },
  });
}
