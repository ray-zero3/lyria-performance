/// <reference types="@webgpu/types" />
import * as THREE from "three/webgpu";

export interface RendererBundle {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  resize: (w: number, h: number) => void;
  dispose: () => void;
}

/** WebGPU レンダラを初期化。失敗しても throw せず null を返す（VJ窓の堅牢性）。 */
export async function createRenderer(
  holder: HTMLElement,
): Promise<RendererBundle | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.gpu) return null;
    const renderer = new THREE.WebGPURenderer({ antialias: true });
    const w = holder.clientWidth || window.innerWidth;
    const h = holder.clientHeight || window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    await renderer.init();
    const backend = renderer.backend as { isWebGPUBackend?: boolean } | undefined;
    if (!backend?.isWebGPUBackend) {
      // WebGL フォールバックでも描画は継続可。ログのみ。
      console.warn("[vj] WebGPU backend 未使用（fallback）");
    }
    holder.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x030309);
    // 粒子世界を見る透視カメラ（アクティブシーンが毎フレーム位置を所有する）
    const camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 60);
    camera.position.set(0, 0, 3.4);

    const resize = (nw: number, nh: number) => {
      renderer.setSize(nw, nh);
      camera.aspect = nh > 0 ? nw / nh : 1;
      camera.updateProjectionMatrix();
    };
    const dispose = () => {
      renderer.dispose();
      renderer.domElement.remove();
    };
    return { renderer, scene, camera, resize, dispose };
  } catch (e) {
    console.error("[vj] createRenderer 失敗:", e);
    return null;
  }
}
