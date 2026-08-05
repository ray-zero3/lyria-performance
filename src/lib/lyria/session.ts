import {
  LYRIA_MODEL,
  LYRIA_API_VERSION,
  defaultLyriaConfig,
  toMusicGenerationConfigPayload,
  toWeightedPromptsPayload,
  type LyriaMusicConfig,
} from "./config";
import { base64ToBytes } from "./pcm";
import type { WeightedPrompt } from "$lib/telemetry/contract";
import type { LyriaCallbacks, LyriaLike } from "./types";

// @google/genai の live music は experimental。呼ぶメソッドだけを最小型で表し、
// 実接続の正しさは live 検証（キー＋allowlist 前提）で確認する。build は型で縛らない。
interface LiveMusicSession {
  setWeightedPrompts(p: unknown): Promise<void> | void;
  setMusicGenerationConfig(p: unknown): Promise<void> | void;
  play(): Promise<void> | void;
  stop?(): Promise<void> | void;
  close?(): Promise<void> | void;
  resetContext?(): Promise<void> | void;
  reset_context?(): Promise<void> | void;
}
interface LiveMusicApi {
  connect(opts: {
    model: string;
    callbacks: {
      onmessage: (m: unknown) => void;
      onerror: (e: unknown) => void;
      onclose: () => void;
    };
  }): Promise<LiveMusicSession>;
}

function extractChunkDatas(message: unknown): string[] {
  const m = message as {
    serverContent?: { audioChunks?: Array<{ data?: string }> };
  };
  const chunks = m?.serverContent?.audioChunks;
  if (!Array.isArray(chunks)) return [];
  return chunks
    .map((c) => c?.data)
    .filter((d): d is string => typeof d === "string");
}

export function createLyriaSession(apiKey: string, cb: LyriaCallbacks): LyriaLike {
  let session: LiveMusicSession | null = null;
  let prompts: WeightedPrompt[] = [{ text: "ambient pads", weight: 1 }];
  let config: LyriaMusicConfig = defaultLyriaConfig();

  const emit = (
    api: "prompt_set" | "config_set" | "chunk" | "session" | "rotate",
    payload: unknown,
  ) => cb.onEvent?.({ kind: "api", tMs: Date.now(), api, payload });

  return {
    async start() {
      emit("session", { state: "connecting" });
      // SDK は使用時のみ動的 import（ブラウザ束縛・experimental 型を回避）。
      const mod = await import("@google/genai");
      const GGA = (
        mod as unknown as {
          GoogleGenAI: new (o: { apiKey: string; apiVersion?: string }) => unknown;
        }
      ).GoogleGenAI;
      const client = new GGA({ apiKey, apiVersion: LYRIA_API_VERSION });
      const liveMusic = (client as { live: { music: LiveMusicApi } }).live.music;
      session = await liveMusic.connect({
        model: LYRIA_MODEL,
        callbacks: {
          onmessage: (message) => {
            const datas = extractChunkDatas(message);
            for (const d of datas) cb.onChunk(base64ToBytes(d));
            if (datas.length) emit("chunk", { count: datas.length });
          },
          onerror: (e) => emit("session", { error: String(e) }),
          onclose: () => emit("session", { state: "closed" }),
        },
      });
      await session.setWeightedPrompts(toWeightedPromptsPayload(prompts));
      await session.setMusicGenerationConfig(toMusicGenerationConfigPayload(config));
      await session.play();
      emit("session", { state: "playing" });
    },
    stop() {
      const s = session;
      session = null;
      try {
        void s?.stop?.();
      } catch {
        /* ignore */
      }
      try {
        void s?.close?.();
      } catch {
        /* ignore */
      }
      emit("session", { state: "closed" });
    },
    setPrompts(p: WeightedPrompt[]) {
      prompts = p;
      void session?.setWeightedPrompts(toWeightedPromptsPayload(p));
      emit("prompt_set", { prompts: p });
    },
    setConfig(c: LyriaMusicConfig) {
      config = c;
      void session?.setMusicGenerationConfig(toMusicGenerationConfigPayload(c));
      emit("config_set", c);
    },
    resetContext() {
      void (session?.resetContext?.() ?? session?.reset_context?.());
      emit("rotate", { reset: true });
    },
  };
}
