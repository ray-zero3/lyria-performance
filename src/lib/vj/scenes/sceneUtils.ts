import * as THREE from "three/webgpu";
import { uniform, uniformArray } from "three/tsl";
import { SPECTRUM_BINS } from "$lib/telemetry/constants";
import type { VisualParams } from "../visualMapping";

/** フラッシュ uFlash の 1→0 減衰時間（ms）（live 調整ポイント）。 */
export const FLASH_DECAY_MS = 220;

/** 全シーン共通の TSL uniforms 束。JS 側から毎フレーム値を流し込む。 */
export function createCommonUniforms() {
  return {
    time: uniform(0), // speed 反映済みのシーン内時間（秒）
    burst: uniform(0), // onset エンベロープ 0..1
    level: uniform(0),
    low: uniform(0),
    mid: uniform(0),
    high: uniform(0),
    dissolve: uniform(0), // 溶解 0..1
    flash: uniform(0), // フラッシュ 1→0
    colorA: uniform(new THREE.Color(0.25, 0.45, 0.95)),
    colorB: uniform(new THREE.Color(0.85, 0.35, 0.65)),
    spectrum: uniformArray<"float">(new Array<number>(SPECTRUM_BINS).fill(0), "float"),
  };
}
export type CommonUniforms = ReturnType<typeof createCommonUniforms>;

/** VisualParams を共通 uniforms に反映（time は speed 込みで積算、flash は減衰）。 */
export function applyVisualParams(u: CommonUniforms, vp: VisualParams, dtMs: number): void {
  u.time.value += (dtMs / 1000) * vp.speed;
  u.burst.value = vp.burst;
  u.level.value = vp.level;
  u.low.value = vp.bands.low;
  u.mid.value = vp.bands.mid;
  u.high.value = vp.bands.high;
  u.flash.value = Math.max(0, u.flash.value - dtMs / FLASH_DECAY_MS);
  u.colorA.value.setRGB(vp.colorA.r, vp.colorA.g, vp.colorA.b);
  u.colorB.value.setRGB(vp.colorB.r, vp.colorB.g, vp.colorB.b);
  const arr = u.spectrum.array as number[];
  for (let i = 0; i < SPECTRUM_BINS; i++) arr[i] = vp.spectrum[i] ?? 0;
}

/** 加算合成のスプライト用マテリアル既定値。 */
export function createAdditiveSpriteMaterial(): THREE.SpriteNodeMaterial {
  const m = new THREE.SpriteNodeMaterial();
  m.transparent = true;
  m.depthWrite = false;
  m.blending = THREE.AdditiveBlending;
  return m;
}

/** WebGPU インスタンシングで count 個描画する Sprite（WebGPU では Points が 1px 固定のため）。 */
export function createParticleSprite(
  material: THREE.SpriteNodeMaterial,
  count: number,
): THREE.Sprite {
  const sprite = new THREE.Sprite(material);
  sprite.count = count;
  sprite.frustumCulled = false;
  return sprite;
}
