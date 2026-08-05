import type { TelemetryEvent, WeightedPrompt } from "$lib/telemetry/contract";
import type { LyriaMusicConfig } from "./config";

export interface LyriaCallbacks {
  /** 16-bit LE stereo PCM のバイト列（player へ流す）。 */
  onChunk: (bytes: Uint8Array) => void;
  /** API テレメトリイベント（VJ の可視化用）。 */
  onEvent?: (e: TelemetryEvent) => void;
}

/** mock / 実 Lyria 共通の音源インターフェース。 */
export interface LyriaLike {
  start(): Promise<void>;
  stop(): void;
  setPrompts(prompts: WeightedPrompt[]): void;
  setConfig(config: LyriaMusicConfig): void;
  resetContext(): void;
}
