import { describe, it, expect } from "vitest";
import * as THREE from "three/webgpu";
import {
  createPostFx,
  FX_TAU,
  BLOB_FRAME_INSET_PX,
  BLOB_FRAME_LINE_PX,
  BLOB_FRAME_LEVEL,
} from "./post";
import { VJ_EFFECT_KEYS } from "$lib/prompts/promptSpace";

// GPU 無しでの TSL グラフ構築 smoke。RenderPipeline のコンストラクタは
// renderer 参照の保持（toneMapping/outputColorSpace 読み出し）のみなので
// スタブで構築できる。render() は GPU 依存のため呼ばない（live 確認に委ねる）。
function fakeRenderer(): THREE.WebGPURenderer {
  return {
    toneMapping: THREE.NoToneMapping,
    outputColorSpace: THREE.SRGBColorSpace,
  } as unknown as THREE.WebGPURenderer;
}

describe("createPostFx（TSL グラフ構築 smoke）", () => {
  it("構築・setEffect（clamp 含む）・setSize・dispose が throw しない", () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 60);
    const post = createPostFx(fakeRenderer(), scene, camera);
    for (const k of VJ_EFFECT_KEYS) post.setEffect(k, 0.7);
    post.setEffect("glitch", 99); // 範囲外もクランプで安全
    post.setEffect("bloom", Number.NaN);
    post.setAudio(0.5); // 互換 API（現在は未使用）が throw しない
    post.setAudio(Number.NaN);
    post.setSize(1280, 720);
    post.dispose();
    expect(FX_TAU).toBeGreaterThan(0);
  });

  it("blob 検出枠は細線・静的表示の定数レンジに収まる", () => {
    expect(BLOB_FRAME_INSET_PX).toBeGreaterThanOrEqual(0);
    expect(BLOB_FRAME_LINE_PX).toBeGreaterThan(0);
    expect(BLOB_FRAME_LINE_PX).toBeLessThanOrEqual(4); // 細線（デバイス px）
    expect(BLOB_FRAME_LEVEL).toBeGreaterThan(0);
    expect(BLOB_FRAME_LEVEL).toBeLessThanOrEqual(1);
  });
});
