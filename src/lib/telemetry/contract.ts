import { SPECTRUM_BINS, WAVEFORM_SAMPLES, DURATION_CAP_MS } from "./constants";

export type SessionState =
  | "idle"
  | "connecting"
  | "playing"
  | "rotating"
  | "closed";

export interface MusicConfig {
  bpm: number;
  scale: string;
  guidance: number;
  density: number;
  brightness: number;
}

export interface WeightedPrompt {
  text: string;
  weight: number;
}

export interface HubState {
  session: {
    id: string;
    state: SessionState;
    startedAtMs: number | null;
    durationCapMs: number;
    rotateAtMs: number | null;
  };
  music: MusicConfig;
  prompts: WeightedPrompt[];
  controlParams: Record<string, number>;
}

export interface TelemetryFrame {
  tMs: number;
  seq: number;
  audio: {
    level: number;
    peak: number;
    bands: { low: number; mid: number; high: number };
    spectrum: number[]; // 長さ SPECTRUM_BINS, 0..1
    waveform: number[]; // 長さ WAVEFORM_SAMPLES, -1..1
    onset: number; // 0..1
  };
}

export type TelemetryEvent =
  | {
      kind: "control";
      tMs: number;
      source: "midi" | "ui";
      ctrl: "cc" | "note" | "param";
      id: string | number;
      value: number;
      label?: string;
    }
  | {
      kind: "api";
      tMs: number;
      api: "prompt_set" | "config_set" | "chunk" | "session" | "rotate";
      payload: unknown;
    };

export function clamp01(n: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function clampRange(n: number, lo: number, hi: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

export function defaultMusicConfig(): MusicConfig {
  return {
    bpm: 120,
    scale: "C_MAJOR",
    guidance: 3,
    density: 0.5,
    brightness: 0.5,
  };
}

export function defaultHubState(): HubState {
  return {
    session: {
      id: "none",
      state: "idle",
      startedAtMs: null,
      durationCapMs: DURATION_CAP_MS,
      rotateAtMs: null,
    },
    music: defaultMusicConfig(),
    prompts: [],
    controlParams: {},
  };
}

function fixedArray(
  src: unknown,
  len: number,
  map: (v: number) => number,
): number[] {
  const out = new Array<number>(len).fill(map(0));
  if (Array.isArray(src)) {
    for (let i = 0; i < len && i < src.length; i++) {
      out[i] = map(typeof src[i] === "number" ? src[i] : 0);
    }
  }
  return out;
}

/** 任意入力を安全な TelemetryFrame に整形（不正値は clamp、配列は固定長）。決して throw しない。 */
export function clampFrame(input: unknown): TelemetryFrame {
  const o = (input ?? {}) as Record<string, unknown>;
  const audio = (o.audio ?? {}) as Record<string, unknown>;
  const bands = (audio.bands ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number =>
    typeof v === "number" && !Number.isNaN(v) ? v : 0;
  return {
    tMs: num(o.tMs),
    seq: num(o.seq),
    audio: {
      level: clamp01(num(audio.level)),
      peak: clamp01(num(audio.peak)),
      bands: {
        low: clamp01(num(bands.low)),
        mid: clamp01(num(bands.mid)),
        high: clamp01(num(bands.high)),
      },
      spectrum: fixedArray(audio.spectrum, SPECTRUM_BINS, clamp01),
      waveform: fixedArray(audio.waveform, WAVEFORM_SAMPLES, (v) =>
        clampRange(v, -1, 1),
      ),
      onset: clamp01(num(audio.onset)),
    },
  };
}
