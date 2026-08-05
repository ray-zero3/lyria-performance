import {
  clamp01,
  defaultMusicConfig,
  type HubState,
  type TelemetryEvent,
  type TelemetryFrame,
} from "./contract";
import {
  SPECTRUM_BINS,
  WAVEFORM_SAMPLES,
  DURATION_CAP_MS,
  ROTATE_AT_MS,
} from "./constants";

const TAU = Math.PI * 2;
const EVENT_EVERY = 30; // フレーム毎に control イベント
const API_EVERY = 90; // フレーム毎に api イベント

/** tMs から決定的にフレームを生成（実 AnalyserNode の代役）。 */
export function makeDummyFrame(seq: number, tMs: number): TelemetryFrame {
  const t = tMs / 1000;
  const level = clamp01(
    0.4 + 0.35 * Math.sin(t * 1.3) + 0.15 * Math.sin(t * 5.1),
  );
  const low = clamp01(0.5 + 0.5 * Math.sin(t * 0.9));
  const mid = clamp01(0.5 + 0.5 * Math.sin(t * 2.3 + 1));
  const high = clamp01(0.5 + 0.5 * Math.sin(t * 4.7 + 2));

  const spectrum = new Array<number>(SPECTRUM_BINS);
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    const f = i / SPECTRUM_BINS;
    const env = Math.exp(-f * 2.5); // 低域が強い
    spectrum[i] = clamp01(env * (0.6 + 0.4 * Math.sin(t * (2 + f * 8) + i)));
  }

  const waveform = new Array<number>(WAVEFORM_SAMPLES);
  for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
    const p = i / WAVEFORM_SAMPLES;
    waveform[i] =
      0.6 * Math.sin(p * TAU * 3 + t * 4) * level +
      0.25 * Math.sin(p * TAU * 11 + t * 7);
  }

  const onset =
    seq % EVENT_EVERY === 0 ? 1 : clamp01(0.2 * Math.abs(Math.sin(t * 9)));

  return {
    tMs,
    seq,
    audio: {
      level,
      peak: clamp01(level + 0.1),
      bands: { low, mid, high },
      spectrum,
      waveform,
      onset,
    },
  };
}

export function maybeDummyEvent(seq: number, tMs: number): TelemetryEvent | null {
  if (seq > 0 && seq % EVENT_EVERY === 0) {
    const id = (seq / EVENT_EVERY) % 8;
    return {
      kind: "control",
      tMs,
      source: "ui",
      ctrl: "cc",
      id,
      value: clamp01(0.5 + 0.5 * Math.sin(tMs / 700)),
      label: `cc${id}`,
    };
  }
  if (seq > 0 && seq % API_EVERY === 0) {
    return {
      kind: "api",
      tMs,
      api: "chunk",
      payload: { chunkIndex: seq / API_EVERY, bytes: 48000 },
    };
  }
  return null;
}

/** ダミーの HubState（playing）。経過で prompt/config を軽く変化。 */
export function dummyStateAt(startedAtMs: number, nowMs: number): HubState {
  const elapsed = nowMs - startedAtMs;
  const music = defaultMusicConfig();
  music.bpm = 120 + Math.round(8 * Math.sin(elapsed / 4000));
  music.brightness = clamp01(0.5 + 0.3 * Math.sin(elapsed / 3000));
  music.density = clamp01(0.5 + 0.3 * Math.cos(elapsed / 5000));
  const prompts =
    elapsed % 16000 < 8000
      ? [
          { text: "warm analog pads", weight: 0.8 },
          { text: "sub bass", weight: 0.4 },
        ]
      : [
          { text: "glassy arps", weight: 0.7 },
          { text: "airy noise", weight: 0.3 },
        ];
  return {
    session: {
      id: "dummy-1",
      state: "playing",
      startedAtMs,
      durationCapMs: DURATION_CAP_MS,
      rotateAtMs: startedAtMs + ROTATE_AT_MS,
    },
    music,
    prompts,
    controlParams: {
      bpm: music.bpm,
      brightness: music.brightness,
      density: music.density,
    },
  };
}
