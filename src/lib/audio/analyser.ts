import { computeFrame } from "./compute";
import { SPECTRUM_BINS } from "$lib/telemetry/constants";
import type { TelemetryFrame } from "$lib/telemetry/contract";

export interface FrameAnalyser {
  readFrame(seq: number, tMs: number): TelemetryFrame;
  dispose(): void;
}

/** 入力 AudioNode に AnalyserNode を繋ぎ、毎回 readFrame で実解析フレームを返す。 */
export function createAnalyser(ctx: AudioContext, input: AudioNode): FrameAnalyser {
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
        freq,
        time,
        sampleRate: ctx.sampleRate,
        prevSpectrum,
        seq,
        tMs,
      });
      prevSpectrum = frame.audio.spectrum;
      return frame;
    },
    dispose() {
      try {
        input.disconnect(analyser);
      } catch {
        /* ignore */
      }
    },
  };
}
