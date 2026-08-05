import type * as THREE from "three/webgpu";
import type { ManagedScene } from "../sceneManager";

/** シーンへ渡す three コンテキスト。root はシーン専有（表示切替は scene.ts が visible で制御）。 */
export interface SceneContext {
  root: THREE.Group;
  camera: THREE.PerspectiveCamera;
}

/** 各 VJ シーンの実装面。ManagedScene（update/setDissolve/flash）＋ライフサイクル。 */
export interface SceneImpl extends ManagedScene {
  readonly id: string;
  init(ctx: SceneContext): void;
  dispose(): void;
}
