import type { WeightedPrompt } from "$lib/telemetry/contract";

export const LYRIA_MODEL = "models/lyria-realtime-exp";
export const LYRIA_API_VERSION = "v1alpha";
export const LYRIA_SAMPLE_RATE = 48000; // 出力仕様: 48kHz
export const LYRIA_CHANNELS = 2; // stereo

export interface LyriaMusicConfig {
  bpm: number;
  guidance: number;
  density: number;
  brightness: number;
  temperature: number;
  muteBass: boolean;
  muteDrums: boolean;
}

export function defaultLyriaConfig(): LyriaMusicConfig {
  return {
    bpm: 120,
    guidance: 3,
    density: 0.5,
    brightness: 0.5,
    temperature: 1.0,
    muteBass: false,
    muteDrums: false,
  };
}

/** setMusicGenerationConfig 用ペイロード（mute は snake_case・実挙動は live 確認）。 */
export function toMusicGenerationConfigPayload(c: LyriaMusicConfig) {
  return {
    musicGenerationConfig: {
      bpm: c.bpm,
      guidance: c.guidance,
      density: c.density,
      brightness: c.brightness,
      temperature: c.temperature,
      mute_bass: c.muteBass,
      mute_drums: c.muteDrums,
    },
  };
}

/** setWeightedPrompts 用ペイロード（空テキストは除外）。 */
export function toWeightedPromptsPayload(prompts: WeightedPrompt[]) {
  return {
    weightedPrompts: prompts
      .filter((p) => p.text.trim().length > 0)
      .map((p) => ({ text: p.text, weight: p.weight })),
  };
}
