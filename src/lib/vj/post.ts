// M8: ポストエフェクトチェーン（three/webgpu RenderPipeline ＋ TSL）。
// glitch/split/rgbShift/scanline は 1 パスの自作 TSL 合成（uniform 0..1、0=完全透過）、
// bloom は three/addons の既製 BloomNode（strength に uniform ノードを直結）。
// TouchDesigner 風の 2 種を追加:
//  - timemachine: afterImage（フィードバック蓄積）の履歴テクスチャを、時間スクロールする
//    per-pixel ワープ UV で再サンプル → 時間バッファが溶けて尾を引く（GITS 風スリットスキャン）。
//  - blob: 最終スクリーンスペースに対する blob tracking。輝度しきい値でブロブを検出し、
//    検出セルを細線の閉じた矩形で静的に囲う（明滅・走査線なし。検出結果の提示のみ）。
//
// 【確認済み export（three 0.185.1 実物）】
// - three/webgpu: RenderPipeline（旧 PostProcessing。r183 で改名、旧名は deprecated wrapper）
// - RenderPipeline.renderAsync() は r181 で deprecated → renderer.init() 済み前提で render() を使用
// - three/tsl: pass / Fn / uv / uniform / hash / time / step / fract / floor / mix /
//   smoothstep / abs / min / max / sin / cos / vec2 / vec3 / vec4 / float / convertToTexture
// - three/addons/tsl/display/BloomNode.js: bloom(node, strength, radius, threshold)
// - three/addons/tsl/display/AfterImageNode.js: afterImage(node, damp) → 履歴 texture node（.sample 可）
// - pass() の RenderTarget は毎フレーム drawing buffer サイズへ自動追従（setSize は即時反映用）
import * as THREE from "three/webgpu";
import {
  Fn,
  convertToTexture,
  cos,
  float,
  floor,
  fract,
  hash,
  min,
  mix,
  pass,
  sin,
  smoothstep,
  step,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { afterImage } from "three/addons/tsl/display/AfterImageNode.js";
import { VJ_EFFECT_KEYS, type VjEffectKey } from "$lib/prompts/promptSpace";
import { easeAlpha } from "./cameraRig";

/** エフェクト強度の平滑時定数（ms）（live 調整ポイント）。 */
export const FX_TAU = 260;
/** amount=1 のときの BloomNode strength（live 調整ポイント）。 */
export const BLOOM_MAX_STRENGTH = 1.35;
/** split の最大タイル数（1 軸あたり。amount=1 でこの数まで分割）。 */
export const SPLIT_MAX_TILES = 8;
/** timemachine: amount=1 での afterImage 蓄積量（0..1。高いほど尾が長く残る）。 */
export const TIME_MACHINE_MAX_DAMP = 0.94;
/** timemachine: amount=1 での履歴サンプルの最大ワープ量（uv 単位）。 */
export const TIME_MACHINE_WARP = 0.055;
/** blob: 検出グリッドのセル数（横・縦）。多いほど細かく追跡枠が出る。 */
export const BLOB_GRID_X = 22;
export const BLOB_GRID_Y = 13;
/** blob: 検出の輝度しきい値（静的。音による脈動はしない）。 */
export const BLOB_THRESHOLD = 0.34;
/** blob: セル追跡の保持減衰（afterImage damp。高いほど検出が消えても長くロックが残る）。
 *  ≈ ln(0.1)/ln(damp) フレーム保持。0.972 ≈ 81f ≈ 1.35s @60fps。 */
export const BLOB_HOLD_DAMP = 0.972;
/** blob: 検出枠のセル境界からの内側マージン（デバイス px。live 調整ポイント）。 */
export const BLOB_FRAME_INSET_PX = 3;
/** blob: 検出枠の線の太さ（デバイス px。live 調整ポイント）。 */
export const BLOB_FRAME_LINE_PX = 1.5;
/** blob: 検出枠の明るさ（0..1 のグレー階調。live 調整ポイント）。 */
export const BLOB_FRAME_LEVEL = 0.85;

export interface PostFx {
  /** carry(vjEffects) からの目標強度（0..1、clamp）。内部で easeAlpha 平滑。 */
  setEffect(name: VjEffectKey, amount: number): void;
  /** オーディオ level（0..1）を渡す（blob 静的表示化に伴い現在は未使用。呼び出し互換のため受理）。 */
  setAudio(level: number): void;
  /** ポストエフェクト込みで 1 フレーム描画。 */
  renderAsync(): Promise<void>;
  /** リサイズ伝播（pass は毎フレーム自動追従もするが即時反映のため呼ぶ）。 */
  setSize(w: number, h: number): void;
  dispose(): void;
}

/** PostFx を構築。TSL グラフ構築のみで GPU は要求しない（実描画は renderAsync 時）。 */
export function createPostFx(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): PostFx {
  // 目標/現在値（renderAsync 毎に easeAlpha で追従 → uniform へ）
  const tgt: Record<VjEffectKey, number> = {
    glitch: 0,
    split: 0,
    rgbShift: 0,
    bloom: 0,
    scanline: 0,
    timemachine: 0,
    blob: 0,
  };
  const cur: Record<VjEffectKey, number> = { ...tgt };
  const uGlitch = uniform(0);
  const uSplit = uniform(0);
  const uRgb = uniform(0);
  const uScan = uniform(0);
  const uBloomStrength = uniform(0);
  const uTimeMachine = uniform(0);
  const uBlob = uniform(0);
  const uTexel = uniform(new THREE.Vector2(1 / 1280, 1 / 720)); // 1px 相当の uv（枠線の px 換算）

  const scenePass = pass(scene, camera);
  const sceneTex = scenePass.getTextureNode();

  // 自作合成: split（ハードタイル）→ scanline 微歪み → glitch（行ずらし）→ rgbShift サンプル → 走査線減光
  const composed = Fn(() => {
    const u0 = uv();
    // split: ハード反復タイル（amount→整数タイル数 1..SPLIT_MAX_TILES）。シームレスに繋げない（各タイルは全画面の複製）。
    // mix で 0=元 UV（完全透過）。BPM には非連動（uSplit のみで決まる）。
    const tiles = floor(float(1).add(uSplit.mul(SPLIT_MAX_TILES - 1)));
    const tiled = fract(u0.mul(tiles));
    const uvS = mix(u0, tiled, smoothstep(0.01, 0.2, uSplit));
    // scanline のわずかな水平歪み
    const wobble = sin(uvS.y.mul(90).add(time.mul(3))).mul(uScan.mul(0.0025));
    // glitch: 行ブロックの水平ずらし（~8Hz で更新、強度で行数/対象行/量が増える）
    const rows = floor(uvS.y.mul(mix(float(10), float(36), uGlitch)));
    const seed = floor(time.mul(8));
    const r1 = hash(rows.add(seed.mul(131)));
    const r2 = hash(rows.add(seed.mul(113)).add(51));
    const gate = step(float(1).sub(uGlitch.mul(0.92)), r1);
    const shift = r2.sub(0.5).mul(0.5).mul(uGlitch).mul(gate);
    const uvG = vec2(fract(uvS.x.add(shift).add(wobble)), uvS.y);
    // rgbShift: 色収差（方向は緩く回転、glitch 行では追加分離）。0 でオフセット 0 = 透過
    const ang = time.mul(0.6);
    const off = vec2(cos(ang), sin(ang)).mul(uRgb.mul(0.012)).add(vec2(shift.mul(0.35), 0));
    const cr = sceneTex.sample(uvG.add(off));
    const cg = sceneTex.sample(uvG);
    const cb = sceneTex.sample(uvG.sub(off));
    const col = vec3(cr.r, cg.g, cb.b).toVar();
    // scanline: 走査線の減光（0 で無効）
    const scan = sin(uvG.y.mul(640).add(time.mul(6))).mul(0.5).add(0.5);
    col.mulAssign(float(1).sub(uScan.mul(0.4).mul(scan)));
    return vec4(col, 1);
  })();

  // 合成結果を 1 枚のテクスチャに焼き（timemachine の履歴入力・blob の検出元・最終 mix で共用）
  const baseTex = convertToTexture(composed);
  // timemachine: afterImage で履歴蓄積（damp=amount×MAX）。amount=0 で damp=0 → 履歴は当該フレームに一致。
  const uDamp = uTimeMachine.mul(TIME_MACHINE_MAX_DAMP);
  const ghost = afterImage(baseTex, uDamp);
  // afterImage() は AfterImageNode を返す（.sample 不可）→ テクスチャ化して任意 uv で読めるようにする
  const ghostTex = convertToTexture(ghost);

  // 輝度（Rec.709）
  const luma = (c: ReturnType<typeof baseTex.sample>) =>
    c.r.mul(0.2126).add(c.g.mul(0.7152)).add(c.b.mul(0.0722));

  const blobGrid = vec2(BLOB_GRID_X, BLOB_GRID_Y);

  // blob 検出フィールド（各 texel = そのセル中心の瞬時検出 0..1）。しきい値は静的。
  // afterImage で蓄積し、検出が消えても緩やかに減衰＝長時間トラッキング（点滅解消）。
  const detField = Fn(() => {
    const u0 = uv();
    const cell = floor(u0.mul(blobGrid));
    const centerUv = cell.add(0.5).div(blobGrid);
    const lc = luma(baseTex.sample(centerUv));
    const detected = smoothstep(float(BLOB_THRESHOLD), float(BLOB_THRESHOLD + 0.1), lc);
    return vec4(vec3(detected), 1);
  })();
  // afterImage(damp) が max(new, old*damp) で保持 → セルごとに検出信頼度が緩やかに減衰。
  const blobHold = afterImage(detField, BLOB_HOLD_DAMP);
  const heldTex = convertToTexture(blobHold);

  // blob tracking HUD（vec3。0=何も足さない）。検出セルを細線の閉じた矩形で静かに囲う。
  // 明滅・脈動・走査線は置かない（動きは保持減衰によるフェードのみ）。モノクロ（グレー階調）。
  const blobHud = (u0: ReturnType<typeof uv>) => {
    const cell = floor(u0.mul(blobGrid));
    const cellUv = fract(u0.mul(blobGrid));
    const centerUv = cell.add(0.5).div(blobGrid);
    const conf = luma(heldTex.sample(centerUv)); // 保持された検出信頼度 0..1（緩やかに減衰）
    // セル境界までの距離をデバイス px に換算し、境界から INSET_PX 内側に太さ LINE_PX の
    // 閉じた矩形枠を描く（4 辺が繋がった細線。縦横で px が揃うようアスペクト補正済み）。
    const pxX = min(cellUv.x, float(1).sub(cellUv.x)).div(uTexel.x.mul(BLOB_GRID_X));
    const pxY = min(cellUv.y, float(1).sub(cellUv.y)).div(uTexel.y.mul(BLOB_GRID_Y));
    const edgePx = min(pxX, pxY); // セル枠までの矩形距離（px）
    const frame = step(float(BLOB_FRAME_INSET_PX), edgePx).mul(
      step(edgePx, float(BLOB_FRAME_INSET_PX + BLOB_FRAME_LINE_PX)),
    );
    // 信頼度が十分なセルにだけ枠を出す（出現/消失は保持減衰に伴う緩やかなフェード）
    const gate = smoothstep(float(0.25), float(0.5), conf);
    return vec3(BLOB_FRAME_LEVEL).mul(frame).mul(gate);
  };

  // 最終合成: timemachine（履歴を warp 再サンプル）→ blob HUD を上乗せ
  const finalColor = Fn(() => {
    const u0 = uv();
    const base = baseTex.sample(u0);
    // timemachine: 履歴を時間スクロールするワープ UV で読む（amount=0 でワープ 0＝base に一致）
    const warp = vec2(
      sin(u0.y.mul(11).add(time.mul(0.5))).add(sin(u0.x.mul(7).sub(time.mul(0.3)))),
      cos(u0.x.mul(9).add(time.mul(0.42))).add(sin(u0.y.mul(5).add(time.mul(0.6)))),
    ).mul(uTimeMachine.mul(TIME_MACHINE_WARP));
    const ghostCol = ghostTex.sample(u0.add(warp));
    const tmBlend = smoothstep(float(0.001), float(0.03), uTimeMachine);
    const col = mix(base, ghostCol, tmBlend);
    // blob tracking を上乗せ（uBlob=0 で寄与ゼロ＝透過）
    const rgb = col.rgb.add(blobHud(u0).mul(uBlob));
    return vec4(rgb, 1);
  })();

  // bloom は最終結果へ加算（strength=0 で寄与ゼロ＝透過）
  const bloomNode = bloom(finalColor, uBloomStrength, 0.4, 0.55);
  const pipeline = new THREE.RenderPipeline(renderer, finalColor.add(bloomNode));

  let lastT = typeof performance !== "undefined" ? performance.now() : 0;

  return {
    setEffect(name: VjEffectKey, amount: number): void {
      if (!VJ_EFFECT_KEYS.includes(name)) return;
      tgt[name] = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : 0));
    },
    setAudio(level: number): void {
      // blob の静的表示化（しきい値の脈動廃止）に伴い現在は未使用。互換のため受理のみ。
      void level;
    },
    async renderAsync(): Promise<void> {
      const now = performance.now();
      const dt = Math.min(100, Math.max(0, now - lastT));
      lastT = now;
      const a = easeAlpha(dt, FX_TAU);
      for (const k of VJ_EFFECT_KEYS) cur[k] += (tgt[k] - cur[k]) * a;
      uGlitch.value = cur.glitch;
      uSplit.value = cur.split;
      uRgb.value = cur.rgbShift;
      uScan.value = cur.scanline;
      uBloomStrength.value = cur.bloom * BLOOM_MAX_STRENGTH;
      uTimeMachine.value = cur.timemachine;
      uBlob.value = cur.blob;
      pipeline.render();
    },
    setSize(w: number, h: number): void {
      scenePass.setSize(w, h);
      uTexel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
    },
    dispose(): void {
      pipeline.dispose();
      bloomNode.dispose();
      ghost.dispose();
      blobHold.dispose();
      scenePass.dispose();
    },
  };
}
