// M8: carry（vjObjects/vjEffects）→ VJ 側の目標値（0..1）への純粋マッピング。
// three / DOM 非依存（Vitest で完全にテスト可能）。補間（easeAlpha）は使用側で行う。
import { clamp01 } from "$lib/telemetry/contract";
import {
  VJ_EFFECT_KEYS,
  VJ_OBJECT_KEYS,
  type VjEffectKey,
  type VjEffects,
  type VjObjectKey,
  type VjObjects,
} from "$lib/prompts/promptSpace";

/** vjObjects → 各オブジェクトの表示目標（true→1、他→0）。 */
export function objectTargets(o: VjObjects | undefined): Record<VjObjectKey, number> {
  const out = {} as Record<VjObjectKey, number>;
  for (const k of VJ_OBJECT_KEYS) out[k] = o?.[k] === true ? 1 : 0;
  return out;
}

/** vjEffects → 各エフェクトの強度目標（clamp01、不正/未指定→0）。 */
export function effectTargets(e: VjEffects | undefined): Record<VjEffectKey, number> {
  const out = {} as Record<VjEffectKey, number>;
  for (const k of VJ_EFFECT_KEYS) {
    const v = e?.[k];
    out[k] = clamp01(typeof v === "number" ? v : NaN);
  }
  return out;
}
