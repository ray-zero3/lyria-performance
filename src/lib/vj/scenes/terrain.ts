import * as THREE from "three/webgpu";
import {
  float,
  vec2,
  vec3,
  sin,
  floor,
  hash,
  mix,
  mx_noise_float,
  instanceIndex,
  int,
  uv,
  smoothstep,
  length,
  mod,
  exp,
  clamp,
  saturate,
  uniform,
} from "three/tsl";
import { SPECTRUM_BINS } from "$lib/telemetry/constants";
import type { VisualParams } from "../visualMapping";
import type { SceneContext, SceneImpl } from "./types";
import {
  applyVisualParams,
  createAdditiveSpriteMaterial,
  createCommonUniforms,
  createParticleSprite,
} from "./sceneUtils";

/** グリッド一辺の粒子数（live 調整ポイント）。総数 = GRID^2。 */
export const TERRAIN_GRID = 88;
/** onset リップルを発火する burst 立ち上がりしきい値。 */
export const TERRAIN_BURST_EDGE = 0.55;

/** Terrain: spectrum で変位する高さ場。中心=低域/外周=高域。onset で同心円リップル。 */
export function createTerrainScene(): SceneImpl {
  const u = createCommonUniforms();
  const uRipplePhase = uniform(0);
  const uRippleAmp = uniform(0);
  let ctx: SceneContext | null = null;
  let sprite: THREE.Sprite | null = null;
  let material: THREE.SpriteNodeMaterial | null = null;
  let phase = 0;
  let rippleAmp = 0;
  let lastBurst = 0;
  let camT = 0;

  return {
    id: "terrain",
    init(c: SceneContext) {
      ctx = c;
      material = createAdditiveSpriteMaterial();
      const idx = float(instanceIndex);
      const g = float(TERRAIN_GRID);
      const ix = mod(idx, g);
      const iz = floor(idx.div(g));
      const x = ix.div(g.sub(1)).sub(0.5).mul(4.4);
      const zc = iz.div(g.sub(1)).sub(0.5).mul(4.4);
      const dist = length(vec2(x, zc));
      // 中心からの距離で bin 割当て（中心=低域, 外周=高域）
      const sBin = float(u.spectrum.element(int(clamp(dist.div(3.2), 0, 0.999).mul(SPECTRUM_BINS))));
      const nH = mx_noise_float(vec3(x.mul(0.8), zc.mul(0.8), u.time.mul(0.1)), 0.4);
      // onset リップル: 中心から拡がる同心円波
      const ripple = sin(dist.mul(7.5).sub(uRipplePhase)).mul(uRippleAmp).mul(exp(dist.mul(-0.9)));
      const y = sBin.mul(0.85).add(nH).add(ripple.mul(0.5)).sub(0.45);
      const scatter = vec3(
        hash(idx.add(1000)).sub(0.5),
        hash(idx.add(2000)).sub(0.5),
        hash(idx.add(3000)).sub(0.5),
      ).mul(u.dissolve.mul(3));
      material.positionNode = vec3(x, y, zc).add(scatter);
      // 高さで色を混ぜる（谷=colorA, 峰=colorB）
      const hNorm = saturate(y.add(0.6).mul(0.8));
      const glow = u.level.mul(0.5).add(0.3).add(u.burst.mul(0.5));
      material.colorNode = mix(u.colorA, u.colorB, hNorm)
        .mul(glow)
        .add(vec3(u.flash.mul(1.5)));
      const soft = smoothstep(0.12, 0.5, length(uv().sub(vec2(0.5)))).oneMinus();
      material.opacityNode = soft.mul(0.8).mul(u.dissolve.mul(0.55).oneMinus());
      material.scaleNode = float(0.012).add(u.level.mul(0.008)).mul(hash(idx).mul(0.5).add(0.7));
      sprite = createParticleSprite(material, TERRAIN_GRID * TERRAIN_GRID);
      c.root.add(sprite);
    },
    update(vp: VisualParams, dtMs: number) {
      applyVisualParams(u, vp, dtMs);
      // カメラの低速ドリフト（オービット）
      camT += (dtMs / 1000) * 0.05 * vp.speed;
      if (ctx) {
        ctx.camera.position.set(
          Math.sin(camT) * 3.8,
          1.7 + Math.sin(camT * 0.7) * 0.35,
          Math.cos(camT) * 3.8,
        );
        ctx.camera.lookAt(0, -0.1, 0);
      }
      // onset リップル（位相は常時進行、強度は onset で発火→減衰）
      if (vp.burst > TERRAIN_BURST_EDGE && lastBurst <= TERRAIN_BURST_EDGE) rippleAmp = 1;
      lastBurst = vp.burst;
      phase += (dtMs / 1000) * 3.5 * vp.speed;
      rippleAmp = Math.max(0, rippleAmp - dtMs / 700);
      uRipplePhase.value = phase;
      uRippleAmp.value = rippleAmp;
    },
    setDissolve(amount: number) {
      u.dissolve.value = amount;
    },
    flash() {
      u.flash.value = 1;
    },
    dispose() {
      if (sprite && ctx) ctx.root.remove(sprite);
      material?.dispose();
      sprite = null;
      material = null;
      ctx = null;
    },
  };
}
