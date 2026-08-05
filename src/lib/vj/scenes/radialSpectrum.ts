import * as THREE from "three/webgpu";
import {
  float,
  vec2,
  vec3,
  cos,
  sin,
  floor,
  hash,
  mix,
  mx_noise_float,
  PI2,
  instanceIndex,
  int,
  uv,
  smoothstep,
  length,
  mod,
  exp,
  abs,
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

/** 各 bin の粒子数（live 調整ポイント）。総数 = SPECTRUM_BINS * RADIAL_PER_BIN。 */
export const RADIAL_PER_BIN = 130;
/** onset 衝撃波を発火する burst 立ち上がりしきい値。 */
export const RADIAL_BURST_EDGE = 0.55;

/** RadialSpectrum: spectrum[48] を 48 セクタの同心リングへ。onset で拡大する衝撃波。 */
export function createRadialSpectrumScene(): SceneImpl {
  const u = createCommonUniforms();
  const uRing = uniform(0); // 衝撃波リング半径
  const uRingAmp = uniform(0); // 衝撃波強度 1→0
  let ctx: SceneContext | null = null;
  let sprite: THREE.Sprite | null = null;
  let material: THREE.SpriteNodeMaterial | null = null;
  let ring = 0;
  let ringAmp = 0;
  let lastBurst = 0;

  return {
    id: "radialSpectrum",
    init(c: SceneContext) {
      ctx = c;
      material = createAdditiveSpriteMaterial();
      const idx = float(instanceIndex);
      const per = float(RADIAL_PER_BIN);
      const binF = floor(idx.div(per)); // 0..47
      const sBin = float(u.spectrum.element(int(binF)));
      const j = mod(idx, per).div(per); // bin 内 0..1
      const h1 = hash(idx);
      const h2 = hash(idx.add(1000));
      const h3 = hash(idx.add(2000));
      // セクタ角: bin を円周へ、bin 内でジッタ。全体はゆっくり回転
      const ang = binF.add(j.mul(0.92)).div(SPECTRUM_BINS).mul(PI2).add(u.time.mul(0.06));
      const wob = mx_noise_float(vec3(cos(ang), sin(ang), u.time.mul(0.25)), 0.05);
      // 半径: 基準リング + bin 値の脈動 + 揺らぎ
      const rr = float(0.45).add(h1.mul(0.1)).add(sBin.mul(1.4)).add(wob);
      // 衝撃波: リング半径との距離で発光・押し出し
      const ringGlow = exp(abs(rr.sub(uRing)).mul(-10)).mul(uRingAmp);
      const r = rr.add(ringGlow.mul(0.15));
      const z = sBin.mul(0.4).add(h2.sub(0.5).mul(0.15));
      const scatter = vec3(
        hash(idx.add(3000)).sub(0.5),
        hash(idx.add(4000)).sub(0.5),
        hash(idx.add(5000)).sub(0.5),
      ).mul(u.dissolve.mul(3.2));
      material.positionNode = vec3(cos(ang).mul(r), sin(ang).mul(r), z).add(scatter);
      const glow = u.level.mul(0.5).add(0.3).add(sBin.mul(0.9)).add(ringGlow);
      material.colorNode = mix(u.colorA, u.colorB, binF.div(SPECTRUM_BINS))
        .mul(glow)
        .add(vec3(ringGlow.mul(0.6)))
        .add(vec3(u.flash.mul(1.5)));
      const soft = smoothstep(0.12, 0.5, length(uv().sub(vec2(0.5)))).oneMinus();
      material.opacityNode = soft.mul(0.85).mul(u.dissolve.mul(0.55).oneMinus());
      material.scaleNode = float(0.011)
        .add(sBin.mul(0.016))
        .add(u.burst.mul(0.012))
        .mul(h3.mul(0.8).add(0.6));
      sprite = createParticleSprite(material, SPECTRUM_BINS * RADIAL_PER_BIN);
      c.root.add(sprite);
    },
    update(vp: VisualParams, dtMs: number) {
      applyVisualParams(u, vp, dtMs);
      // onset 立ち上がりで衝撃波リングを発火（中心から拡大→減衰）
      if (vp.burst > RADIAL_BURST_EDGE && lastBurst <= RADIAL_BURST_EDGE) {
        ring = 0.35;
        ringAmp = 1;
      }
      lastBurst = vp.burst;
      ring += (dtMs / 1000) * vp.speed * 2.4;
      ringAmp = Math.max(0, ringAmp - dtMs / 500);
      uRing.value = ring;
      uRingAmp.value = ringAmp;
      if (ctx) {
        ctx.camera.position.set(0, 0, 3.2);
        ctx.camera.lookAt(0, 0, 0);
      }
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
