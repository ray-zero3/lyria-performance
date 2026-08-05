import * as THREE from "three/webgpu";
import {
  float,
  vec2,
  vec3,
  hash,
  mix,
  mx_noise_vec3,
  instanceIndex,
  int,
  floor,
  uv,
  smoothstep,
  length,
  normalize,
  uniform,
  uniformArray,
} from "three/tsl";
import type { VisualParams } from "../visualMapping";
import type { SceneContext, SceneImpl } from "./types";
import {
  applyVisualParams,
  createAdditiveSpriteMaterial,
  createCommonUniforms,
  createParticleSprite,
} from "./sceneUtils";

/** 粒子数とアトラクタ数（live 調整ポイント）。 */
export const SWARM_COUNT = 5200;
export const SWARM_ATTRACTORS = 8;

const TAU = Math.PI * 2;
// アトラクタごとのリサージュ係数（決定的）
const ORBITS = Array.from({ length: SWARM_ATTRACTORS }, (_, i) => ({
  fx: 0.045 + 0.011 * i,
  fy: 0.038 + 0.009 * ((i * 3) % SWARM_ATTRACTORS),
  fz: 0.031 + 0.01 * ((i * 5) % SWARM_ATTRACTORS),
  px: i * 0.7,
  py: i * 1.3,
  pz: i * 2.1,
}));

/** Swarm: アトラクタ群れ（boids 簡略）。onset で散開、low=塊の大きさ、high=速度。 */
export function createSwarmScene(): SceneImpl {
  const u = createCommonUniforms();
  const uSpread = uniform(0.5); // 塊の大きさ（bands.low 連動）
  const uAttractors = uniformArray<"vec3">(
    Array.from({ length: SWARM_ATTRACTORS }, () => new THREE.Vector3()),
    "vec3",
  );
  let ctx: SceneContext | null = null;
  let sprite: THREE.Sprite | null = null;
  let material: THREE.SpriteNodeMaterial | null = null;
  let t = 0;
  let swayT = 0;

  return {
    id: "swarm",
    init(c: SceneContext) {
      ctx = c;
      material = createAdditiveSpriteMaterial();
      const idx = float(instanceIndex);
      const h1 = hash(idx);
      const h2 = hash(idx.add(1000));
      // 担当アトラクタ（element() の戻りは chainable でないため vec3() でラップ）
      const attr = vec3(uAttractors.element(int(floor(h1.mul(SWARM_ATTRACTORS)))));
      // アトラクタ周りのノイズ軌道（時間で流れる）
      const wob = mx_noise_vec3(
        vec3(hash(idx.add(2000)).mul(60), hash(idx.add(3000)).mul(60), u.time.mul(0.5)),
        1,
      );
      const orbit = wob.mul(uSpread.mul(h2.mul(0.75).add(0.25)));
      // onset で外向きに散開（溶解も同方向へ大きく）
      const dir = normalize(
        vec3(
          hash(idx.add(4000)).sub(0.5),
          hash(idx.add(5000)).sub(0.5),
          hash(idx.add(6000)).sub(0.5),
        ),
      );
      const burstPush = dir.mul(u.burst.mul(h1.mul(0.8).add(0.5)).mul(1.7));
      const scatter = dir.mul(u.dissolve.mul(3.5));
      material.positionNode = attr.add(orbit).add(burstPush).add(scatter);
      const glow = u.level.mul(0.6).add(0.3).add(u.burst.mul(0.7));
      material.colorNode = mix(u.colorA, u.colorB, h2)
        .mul(glow)
        .add(vec3(u.flash.mul(1.5)));
      const soft = smoothstep(0.12, 0.5, length(uv().sub(vec2(0.5)))).oneMinus();
      material.opacityNode = soft.mul(0.85).mul(u.dissolve.mul(0.55).oneMinus());
      material.scaleNode = float(0.013).add(u.level.mul(0.01)).mul(h1.mul(0.7).add(0.5));
      sprite = createParticleSprite(material, SWARM_COUNT);
      c.root.add(sprite);
    },
    update(vp: VisualParams, dtMs: number) {
      applyVisualParams(u, vp, dtMs);
      // 群れの移動速度: 高域で機敏に
      t += (dtMs / 1000) * vp.speed * (0.6 + vp.bands.high * 1.2);
      const arr = uAttractors.array as THREE.Vector3[];
      for (let i = 0; i < SWARM_ATTRACTORS; i++) {
        const o = ORBITS[i];
        arr[i].set(
          Math.sin(t * TAU * o.fx + o.px) * 1.35,
          Math.sin(t * TAU * o.fy + o.py) * 0.75,
          Math.sin(t * TAU * o.fz + o.pz) * 0.9,
        );
      }
      // 塊の大きさ: 低域で膨らむ
      uSpread.value = 0.22 + 0.85 * vp.bands.low;
      swayT += dtMs / 1000;
      if (ctx) {
        ctx.camera.position.set(Math.sin(swayT * 0.35) * 0.3, 0, 3.6);
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
