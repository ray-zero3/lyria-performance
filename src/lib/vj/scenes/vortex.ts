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

/** 粒子数（live 調整ポイント）。 */
export const VORTEX_COUNT = 6000;

/** Vortex: noise flow field の渦。spectrum で半径脈動、onset で放射バースト、chaos で溶解。 */
export function createVortexScene(): SceneImpl {
  const u = createCommonUniforms();
  let ctx: SceneContext | null = null;
  let sprite: THREE.Sprite | null = null;
  let material: THREE.SpriteNodeMaterial | null = null;

  return {
    id: "vortex",
    init(c: SceneContext) {
      ctx = c;
      material = createAdditiveSpriteMaterial();
      const idx = float(instanceIndex);
      const h1 = hash(idx);
      const h2 = hash(idx.add(1000));
      const h3 = hash(idx.add(2000));
      const h4 = hash(idx.add(3000));
      // 粒子ごとの担当 bin。その bin 値で半径が脈動する
      // （element() の戻りは chainable でないため float() でラップ）
      const sBin = float(u.spectrum.element(int(floor(h4.mul(SPECTRUM_BINS)))));
      const r0 = h1.mul(1.8).add(0.3);
      // 内側ほど速い回転（渦）
      const ang = h2.mul(PI2).add(u.time.mul(float(1.4).div(r0.add(0.4))));
      // flow field: 位置依存ノイズで半径/奥行きを乱す
      const nz = mx_noise_float(vec3(cos(ang).mul(r0), sin(ang).mul(r0), u.time.mul(0.15)), 0.5);
      const rBurst = u.burst.mul(h2.mul(0.5).add(0.35)); // onset の放射押し出し
      const r = r0.add(sBin.mul(0.55)).add(nz.mul(0.3)).add(rBurst);
      const z = h3.sub(0.5).mul(1.1).add(nz.mul(0.35));
      // 溶解: 粒子ごとのランダム方向へ飛散
      const scatter = vec3(
        hash(idx.add(4000)).sub(0.5),
        hash(idx.add(5000)).sub(0.5),
        hash(idx.add(6000)).sub(0.5),
      ).mul(u.dissolve.mul(3.5));
      material.positionNode = vec3(cos(ang).mul(r), sin(ang).mul(r), z).add(scatter);
      const glow = u.level.mul(0.7).add(0.25).add(u.burst.mul(0.9)).add(sBin.mul(0.6));
      material.colorNode = mix(u.colorA, u.colorB, h2.mul(0.6).add(sBin.mul(0.4)))
        .mul(glow)
        .add(vec3(u.flash.mul(1.5)));
      // 丸くソフトな粒子（uv 距離でマスク）＋溶解で減光
      const soft = smoothstep(0.12, 0.5, length(uv().sub(vec2(0.5)))).oneMinus();
      material.opacityNode = soft.mul(0.85).mul(u.dissolve.mul(0.55).oneMinus());
      material.scaleNode = float(0.014)
        .add(u.level.mul(0.012))
        .add(u.burst.mul(0.02))
        .mul(h3.mul(0.9).add(0.55));
      sprite = createParticleSprite(material, VORTEX_COUNT);
      c.root.add(sprite);
    },
    update(vp: VisualParams, dtMs: number) {
      applyVisualParams(u, vp, dtMs);
      if (ctx) {
        ctx.camera.position.set(0, 0, 3.4);
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
