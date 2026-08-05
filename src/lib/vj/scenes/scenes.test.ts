import { describe, it, expect } from "vitest";
import * as THREE from "three/webgpu";
import { createVortexScene } from "./vortex";
import { createRadialSpectrumScene } from "./radialSpectrum";
import { createTerrainScene } from "./terrain";
import { createSwarmScene } from "./swarm";
import { createPromptSpaceScene } from "./promptSpace";
import type { SceneImpl } from "./types";
import type { VisualParams } from "../visualMapping";
import { defaultPromptSpaceState, setVjObject, VJ_OBJECT_KEYS } from "$lib/prompts/promptSpace";

// TSL ノードグラフ構築の smoke テスト（GPU 不要）。
// 描画はできないが、init での TSL グラフ構築・update/dissolve/flash/dispose が
// 実行時に throw しないことと Sprite の配線を検証する。

function vp(): VisualParams {
  return {
    burst: 0.7,
    spectrum: new Array<number>(48).fill(0.4),
    level: 0.6,
    bands: { low: 0.5, mid: 0.4, high: 0.3 },
    colorA: { r: 0.2, g: 0.4, b: 0.9 },
    colorB: { r: 0.8, g: 0.3, b: 0.6 },
    speed: 1.2,
  };
}

const factories: Array<[string, () => SceneImpl]> = [
  ["vortex", createVortexScene],
  ["radialSpectrum", createRadialSpectrumScene],
  ["terrain", createTerrainScene],
  ["swarm", createSwarmScene],
  ["promptSpace", createPromptSpaceScene],
];

describe("scenes (TSL smoke)", () => {
  for (const [name, factory] of factories) {
    it(`${name}: init/update/setDissolve/flash/dispose が throw しない`, () => {
      const scene = factory();
      expect(scene.id).toBe(name);
      const root = new THREE.Group();
      const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 60);
      scene.init({ root, camera });
      // Sprite がグループに追加され、インスタンス数が設定されている
      const sprite = root.children.find((o) => (o as THREE.Sprite).isSprite) as
        | THREE.Sprite
        | undefined;
      expect(sprite).toBeDefined();
      expect((sprite as THREE.Sprite).count).toBeGreaterThan(1000);
      // 数フレーム分の更新（uniform 反映・カメラ操作・JS 側の演出状態）
      for (let i = 0; i < 5; i++) scene.update(vp(), 16.7);
      scene.setDissolve(0.8);
      scene.flash();
      scene.update(vp(), 16.7);
      scene.dispose();
      expect(root.children.filter((o) => (o as THREE.Sprite).isSprite)).toHaveLength(0);
    });
  }
});

describe("promptSpace scene (M7)", () => {
  it("setPromptSpace（state / null / 同一参照）が throw せず反映される", () => {
    const scene = createPromptSpaceScene();
    const root = new THREE.Group();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 60);
    scene.init({ root, camera });
    const space = defaultPromptSpaceState();
    scene.setPromptSpace(space);
    scene.setPromptSpace(space); // 同一参照はキャッシュで no-op
    scene.update(vp(), 16.7);
    scene.setPromptSpace(null); // last-known 未受信でも安全
    scene.update(vp(), 16.7);
    scene.setDissolve(0.5);
    scene.flash();
    scene.update(vp(), 16.7);
    scene.dispose();
    expect(root.children).toHaveLength(0); // 線・グリッド含め全撤去
  });

  it("M8: vjObjects 全 ON → 一部 OFF でも throw せず全撤去できる", () => {
    const scene = createPromptSpaceScene();
    const root = new THREE.Group();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 60);
    scene.init({ root, camera });
    let space = defaultPromptSpaceState();
    for (const k of VJ_OBJECT_KEYS) space = setVjObject(space, k, true);
    scene.setPromptSpace(space);
    for (let i = 0; i < 5; i++) scene.update(vp(), 16.7);
    scene.setPromptSpace(setVjObject(space, "horizon", false)); // OFF はフェードで消える
    scene.update(vp(), 16.7);
    scene.dispose();
    expect(root.children).toHaveLength(0);
  });
});
