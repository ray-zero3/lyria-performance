import { LYRIA_SAMPLE_RATE } from "./config";
import type { WeightedPrompt } from "$lib/telemetry/contract";
import type { LyriaMusicConfig } from "./config";
import type { LyriaCallbacks, LyriaLike } from "./types";

const CHUNK_MS = 100;

/**
 * モック Lyria 音源。実 Lyria と同形（48kHz/16bit/stereo PCM）の合成チャンクを
 * ~100ms 間隔で吐き、API イベントも発火する。キー無しで再生経路を検証するため。
 */
export function createMockLyria(cb: LyriaCallbacks): LyriaLike {
  const framesPerChunk = Math.round((LYRIA_SAMPLE_RATE * CHUNK_MS) / 1000); // 4800
  let timer: ReturnType<typeof setInterval> | null = null;
  let phase = 0;
  let freq = 220;
  let chunkIndex = 0;

  const gen = () => {
    const bytes = new Uint8Array(framesPerChunk * 4);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < framesPerChunk; i++) {
      const s = Math.sin(phase) * 0.3 * (0.7 + 0.3 * Math.sin(phase * 0.01));
      phase += (2 * Math.PI * freq) / LYRIA_SAMPLE_RATE;
      const iv = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      view.setInt16(i * 4, iv, true);
      view.setInt16(i * 4 + 2, iv, true);
    }
    cb.onChunk(bytes);
    cb.onEvent?.({
      kind: "api",
      tMs: Date.now(),
      api: "chunk",
      payload: { chunkIndex: chunkIndex++, bytes: bytes.length },
    });
  };

  return {
    async start() {
      cb.onEvent?.({
        kind: "api",
        tMs: Date.now(),
        api: "session",
        payload: { state: "playing", mock: true },
      });
      timer = setInterval(gen, CHUNK_MS);
    },
    stop() {
      if (timer != null) clearInterval(timer);
      timer = null;
      cb.onEvent?.({
        kind: "api",
        tMs: Date.now(),
        api: "session",
        payload: { state: "closed", mock: true },
      });
    },
    setPrompts(prompts: WeightedPrompt[]) {
      freq = 180 + (prompts[0]?.weight ?? 0.5) * 320;
      cb.onEvent?.({ kind: "api", tMs: Date.now(), api: "prompt_set", payload: { prompts } });
    },
    setConfig(config: LyriaMusicConfig) {
      freq = 120 + config.bpm;
      cb.onEvent?.({ kind: "api", tMs: Date.now(), api: "config_set", payload: config });
    },
    resetContext() {
      phase = 0;
      cb.onEvent?.({ kind: "api", tMs: Date.now(), api: "rotate", payload: { reset: true } });
    },
  };
}
