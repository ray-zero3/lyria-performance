// M7: PromptSpace シーン（既定シーン）。
// 2D パッドのピン/カーソルを 3D 空間（x,z 平面・y=重みで浮上）に立ち上げ、
// ピン=グロー核＋周回粒子＋スキャンリング＋テキストラベル、カーソル=ダイヤ、
// カーソル→ピンの影響線（輝度=重み）＋ピン→カーソルの流れ粒子で「解析」演出。
// TSL は M6 と同じ手法（Sprite + count + SpriteNodeMaterial、uniformArray、element() は float()/vec3() ラップ）。
import * as THREE from "three/webgpu";
import {
  float,
  vec2,
  vec3,
  hash,
  mix,
  smoothstep,
  length,
  uv,
  floor,
  int,
  abs,
  fract,
  sin,
  cos,
  PI2,
  instanceIndex,
  uniform,
  uniformArray,
  texture,
  mx_noise_float,
} from "three/tsl";
import { SPECTRUM_BINS } from "$lib/telemetry/constants";
import { clamp01 } from "$lib/telemetry/contract";
import {
  normalizedPinWeights,
  VJ_OBJECT_KEYS,
  type Pin,
  type PromptSpaceState,
  type VjObjectKey,
} from "$lib/prompts/promptSpace";
import type { VisualParams } from "../visualMapping";
import { easeAlpha } from "../cameraRig";
import { objectTargets } from "../vjToggles";
import type { SceneContext, SceneImpl } from "./types";
import {
  applyVisualParams,
  createAdditiveSpriteMaterial,
  createCommonUniforms,
  createParticleSprite,
} from "./sceneUtils";

/** 可視化するピンの上限（uniformArray 固定長）。 */
export const MAX_VIS_PINS = 12;
/** ピン周回粒子の総数（live 調整ポイント）。 */
export const ORBIT_COUNT = 9000;
/** ピン→カーソルの流れ粒子数（live 調整ポイント）。 */
export const FLOW_COUNT = 2400;
/** パッド 0..1 → 世界座標のスケール。 */
export const PAD_SCALE = 3.2;
/** 重み 1 のピンの浮上高さ。 */
export const PIN_LIFT = 1.1;

// 星空（背景に多数の星。ピンはこの中から生まれ収束する）
export const STAR_COUNT = 26000; // 描画密度（live 調整ポイント）
export const BORN_SPREAD = 2.4; // 出現時にピン粒子が星のように広がる量（active→1 で収束）
// オーディオ反応フロア（ON 時のみ表示。平衡感覚用の GridHelper は常時）
export const FLOOR_GRID = 80; // グリッド解像度（FLOOR_GRID² セル）
export const FLOOR_SPAN = PAD_SCALE * 2.2;
export const FLOOR_HEIGHT = 0.9;

// アニメーション平滑（ms）。ピン移動/出現/消失・カーソル・カメラ激しさ・床反応を滑らかに繋ぐ。
export const POS_TAU = 220; // ピン/カーソル位置
export const AMT_TAU = 200; // 重み/active（=出現フェードイン/消失フェードアウト）
export const ENERGY_TAU = 500; // カメラ激しさ・床反応の ON/OFF

// M8: トグル・オブジェクト（表示強度 uniform を easeAlpha で補間。OFF→0 で不可視）
export const HORIZON_COUNT = 3200; // ワイヤードーム粒子（緯線リング）
export const OBJ_TAU = 420; // トグル ON/OFF のフェード時定数（ms）
// 星座線（流れ星）: 背景に描画される星（anchors）同士を尾を引く輝線で結ぶ。量はスライダー。
export const CONST_ANCHORS = 90; // 描画される背景星（結ぶ 2 点の候補）
export const MAX_CONST_LINES = 60; // 同時に走る流れ星ラインの上限（量=0..この数）
export const CONST_TRAIL = 0.14; // 流れ星の尾の長さ（0..1 の割合）

/** グリッド床の基準不透明度（setOpacity のクロスフェードで縮小される）。 */
export const GRID_OPACITY = 0.38;

/** シーン外部（scene.ts）から last-known プロンプト空間を注入する面。 */
export interface PromptSpaceSceneImpl extends SceneImpl {
  setPromptSpace(space: PromptSpaceState | null): void;
}

const padX = (x: number): number => (x - 0.5) * PAD_SCALE;
const padZ = (y: number): number => (y - 0.5) * PAD_SCALE;

const createOpacityUniform = () => uniform(1);
type OpacityUniform = ReturnType<typeof createOpacityUniform>;

interface LabelEntry {
  sprite: THREE.Sprite;
  mat: THREE.SpriteNodeMaterial;
  tex: THREE.CanvasTexture;
  text: string;
  sub: string; // 副次行（投入者名・時刻）。空なら1行。
  op: OpacityUniform;
  targetOp: number; // 目標不透明度（消えるピンは 0 へ）
  targetPos: THREE.Vector3; // 目標位置（滑らかに移動）
  fading: boolean; // 消失中（op≈0 で撤去）
}

/** epoch ms → HH:MM。 */
function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** リクエスト由来ピンの副次ラベル（`by nickname · HH:MM`）。通常ピンは空文字。 */
function subLabel(pin: Pin): string {
  if (!pin.nickname) return "";
  const when = typeof pin.tMs === "number" ? ` · ${hhmm(pin.tMs)}` : "";
  return `by ${pin.nickname}${when}`;
}

/** ピンテキストの CanvasTexture ラベルを生成（DOM 無し環境では null）。sub があれば2行目に投入者/時刻。 */
function makeLabel(text: string, sub: string, sceneOp: OpacityUniform): LabelEntry | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  const measure = canvas.getContext("2d");
  if (!measure) return null;
  const mainFont = "500 28px ui-monospace, Menlo, monospace";
  const subFont = "400 18px ui-monospace, Menlo, monospace";
  measure.font = mainFont;
  const wMain = measure.measureText(text).width;
  measure.font = subFont;
  const wSub = sub ? measure.measureText(sub).width : 0;
  const w = Math.ceil(Math.max(wMain, wSub)) + 24;
  canvas.width = Math.max(2, Math.min(512, w));
  canvas.height = sub ? 66 : 44;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.textBaseline = "middle";
  ctx.font = mainFont; // width 変更でコンテキストがリセットされるため再設定
  ctx.fillStyle = "rgba(165, 243, 252, 0.92)"; // シアン系（キーワード）
  ctx.fillText(text, 12, sub ? 20 : 23);
  if (sub) {
    ctx.font = subFont;
    ctx.fillStyle = "rgba(143, 162, 180, 0.85)"; // 投入者/時刻は淡いグレー
    ctx.fillText(sub, 12, 48);
  }
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  const t = texture(tex);
  const op = createOpacityUniform();
  op.value = 0; // 出現はフェードイン
  mat.colorNode = vec3(t);
  mat.opacityNode = float(t.a).mul(op).mul(sceneOp); // クロスフェードにも追従
  const sprite = new THREE.Sprite(mat);
  const height = 0.16 * (canvas.height / 44); // 2行時は縦横比を保って少し大きく
  sprite.scale.set((canvas.width / canvas.height) * height, height, 1);
  return {
    sprite,
    mat,
    tex,
    text,
    sub,
    op,
    targetOp: 0,
    targetPos: new THREE.Vector3(),
    fading: false,
  };
}

/** PromptSpace シーンを生成。 */
export function createPromptSpaceScene(): PromptSpaceSceneImpl {
  const u = createCommonUniforms();
  const uPinPos = uniformArray<"vec3">(
    Array.from({ length: MAX_VIS_PINS }, () => new THREE.Vector3(0, -10, 0)),
    "vec3",
  );
  const uPinWeight = uniformArray<"float">(new Array<number>(MAX_VIS_PINS).fill(0), "float");
  const uPinActive = uniformArray<"float">(new Array<number>(MAX_VIS_PINS).fill(0), "float");
  const uCursor = uniform(new THREE.Vector3(0, 0.09, 0));
  const uFloorReactive = uniform(0); // 床のオーディオ反応 0..1（curFloor を滑らかに反映）
  const uSceneOp = uniform(1); // シーン全体の不透明度（クロスフェード。manager が毎フレーム配布）

  // M8: トグル・オブジェクトの表示強度（0..1、curObj を滑らかに反映）
  const uObjHorizon = uniform(0);
  // 星座線が結ぶ背景星（描画される 2 点）: 位置を uniformArray で保持
  const uAnchor = uniformArray<"vec3">(
    Array.from({ length: CONST_ANCHORS }, () => new THREE.Vector3()),
    "vec3",
  );

  let ctx: SceneContext | null = null;
  let lastSpace: PromptSpaceState | null | undefined; // undefined = 未注入
  const labels = new Map<string, LabelEntry>();
  const disposables: Array<{ dispose(): void }> = [];
  const objects: THREE.Object3D[] = [];
  let lineGeo: THREE.BufferGeometry | null = null;
  let lineMat: THREE.LineBasicMaterial | null = null; // 影響線（opacity はクロスフェードで制御）
  let gridMat: THREE.LineBasicMaterial | null = null; // グリッド床（同上）
  let camT = 0;

  // --- アニメーション状態（uPin* が current、tgt* が目標。毎フレーム補間で滑らかに繋ぐ）---
  // スロットは pin.id で安定割当（並びが変わっても飛ばない）。消えたスロットは fade out 後に解放。
  const slotId: (string | null)[] = new Array<string | null>(MAX_VIS_PINS).fill(null);
  const slotFading: boolean[] = new Array<boolean>(MAX_VIS_PINS).fill(false);
  const tgtPos: THREE.Vector3[] = Array.from(
    { length: MAX_VIS_PINS },
    () => new THREE.Vector3(0, -10, 0),
  );
  const tgtW = new Array<number>(MAX_VIS_PINS).fill(0);
  const tgtA = new Array<number>(MAX_VIS_PINS).fill(0);
  const tgtCursor = new THREE.Vector3(0, 0.09, 0);
  // カメラは中央を注視し続ける（注視点は動かさない）。位置のオービットのみ激しさで可変。
  let curEnergy = 0; // カメラ激しさ（tgtEnergy へ追従）
  let tgtEnergy = 0;
  let curFloor = 0; // 床反応 0..1（tgtFloor へ追従＝ON/OFF を滑らかに）
  let tgtFloor = 0;
  // M8: トグル・オブジェクトの current/target（applyTargets が目標、animate が補間）
  const curObj: Record<VjObjectKey, number> = { horizon: 0 };
  const tgtObj: Record<VjObjectKey, number> = { ...curObj };
  // 星座線（流れ星）: 背景星 anchors のペア間を尾を引いて走る輝線
  let constGeo: THREE.BufferGeometry | null = null;
  let constMat: THREE.LineBasicMaterial | null = null;
  const constStars: THREE.Vector3[] = []; // anchors（描画される背景星）
  const constPairA = new Array<number>(MAX_CONST_LINES).fill(0);
  const constPairB = new Array<number>(MAX_CONST_LINES).fill(0);
  const constPhase = new Array<number>(MAX_CONST_LINES).fill(0);
  const constSpeed = new Array<number>(MAX_CONST_LINES).fill(0);
  let curConstLines = 0;
  let tgtConstLines = 0;
  let constClock = 0; // BPM 非依存の実時間クロック（流れ星の動きは BPM に反応させない）

  // シーン固有パレット（黒背景にシアン/緑/白）
  const CYAN = vec3(0.25, 0.85, 0.95);
  const GREEN = vec3(0.35, 0.95, 0.55);

  const addObject = (o: THREE.Object3D, ...d: Array<{ dispose(): void }>): void => {
    objects.push(o);
    disposables.push(...d);
    ctx?.root.add(o);
  };

  /** ピン周回粒子（重みに比例した量感、spectrum/onset で「解析」脈動）。 */
  const buildOrbitSprite = (): void => {
    const material = createAdditiveSpriteMaterial();
    const idx = float(instanceIndex);
    const h1 = hash(idx);
    const h2 = hash(idx.add(1000));
    const h3 = hash(idx.add(2000));
    const h4 = hash(idx.add(3000));
    const k = int(floor(h1.mul(MAX_VIS_PINS)));
    const pinP = vec3(uPinPos.element(k));
    const w = float(uPinWeight.element(k));
    const act = float(uPinActive.element(k));
    const sBin = float(u.spectrum.element(int(floor(h4.mul(SPECTRUM_BINS)))));
    // 球殻状に分布（方位角=回転、傾斜角=ノイズゆらぎ）。重みで半径が太く、spectrum/onset で脈動。
    const az = h2.mul(PI2).add(u.time.mul(h3.mul(0.7).add(0.3))); // 方位角（y 軸周りに回転）
    const incWob = mx_noise_float(vec3(h2.mul(30), h3.mul(30), u.time.mul(0.3)), 1).mul(0.4);
    const inc = h3.mul(Math.PI).add(incWob); // 傾斜角 0..π（ゆらぎ）
    const si = sin(inc);
    const rad = float(0.12)
      .add(w.mul(0.55))
      .add(sBin.mul(w.mul(0.35)))
      .add(u.burst.mul(w.mul(0.4)));
    const local = vec3(
      si.mul(cos(az)).mul(rad),
      cos(inc).mul(rad),
      si.mul(sin(az)).mul(rad),
    );
    const scatter = vec3(
      hash(idx.add(4000)).sub(0.5),
      hash(idx.add(5000)).sub(0.5),
      hash(idx.add(6000)).sub(0.5),
    ).mul(u.dissolve.mul(3.5));
    // 出現演出: active が低い（生まれたて）ほど星のように広がり、act→1 で収束
    const born = vec3(
      hash(idx.add(7000)).sub(0.5),
      hash(idx.add(8000)).sub(0.5),
      hash(idx.add(9000)).sub(0.5),
    ).mul(act.oneMinus().mul(BORN_SPREAD));
    material.positionNode = pinP.add(local).add(scatter).add(born);
    const glow = w.mul(1.3).add(0.12).add(u.burst.mul(w).mul(1.2)).add(u.level.mul(0.25));
    material.colorNode = mix(CYAN, GREEN, h2).mul(glow).add(vec3(u.flash.mul(1.5)));
    const soft = smoothstep(0.12, 0.5, length(uv().sub(vec2(0.5)))).oneMinus();
    material.opacityNode = soft
      .mul(act)
      .mul(w.mul(0.8).add(0.08))
      .mul(u.dissolve.mul(0.55).oneMinus())
      .mul(uSceneOp);
    material.scaleNode = float(0.011)
      .add(w.mul(0.018))
      .add(u.burst.mul(w).mul(0.012))
      .mul(h3.mul(0.8).add(0.6));
    addObject(createParticleSprite(material, ORBIT_COUNT), material);
  };

  /** ピン→カーソルの流れ粒子（データがカーソルへ吸い込まれる演出、輝度=重み）。 */
  const buildFlowSprite = (): void => {
    const material = createAdditiveSpriteMaterial();
    const idx = float(instanceIndex);
    const h1 = hash(idx);
    const h2 = hash(idx.add(1000));
    const h3 = hash(idx.add(2000));
    const k = int(floor(h1.mul(MAX_VIS_PINS)));
    const pinP = vec3(uPinPos.element(k));
    const w = float(uPinWeight.element(k));
    const act = float(uPinActive.element(k));
    const t = fract(h2.add(u.time.mul(w.mul(0.5).add(0.15))));
    const side = vec3(
      hash(idx.add(3000)).sub(0.5),
      hash(idx.add(4000)).sub(0.5),
      hash(idx.add(5000)).sub(0.5),
    ).mul(sin(t.mul(Math.PI)).mul(0.08));
    const scatter = vec3(
      hash(idx.add(6000)).sub(0.5),
      hash(idx.add(7000)).sub(0.5),
      hash(idx.add(8000)).sub(0.5),
    ).mul(u.dissolve.mul(3));
    material.positionNode = mix(pinP, uCursor, t).add(side).add(scatter);
    material.colorNode = mix(GREEN, CYAN, t)
      .mul(w.mul(2).add(0.2))
      .add(vec3(u.flash.mul(1.2)));
    const soft = smoothstep(0.1, 0.5, length(uv().sub(vec2(0.5)))).oneMinus();
    const endFade = sin(t.mul(Math.PI)); // 両端でフェード
    material.opacityNode = soft
      .mul(act)
      .mul(w.mul(1.1).add(0.02))
      .mul(endFade)
      .mul(u.dissolve.mul(0.6).oneMinus())
      .mul(uSceneOp);
    material.scaleNode = float(0.009).add(w.mul(0.012)).mul(h3.mul(0.7).add(0.5));
    addObject(createParticleSprite(material, FLOW_COUNT), material);
  };

  /** ピンのグロー核（1 ピン = 1 インスタンス）。 */
  const buildCoreSprite = (): void => {
    const material = createAdditiveSpriteMaterial();
    const k = instanceIndex;
    const w = float(uPinWeight.element(k));
    const act = float(uPinActive.element(k));
    material.positionNode = vec3(uPinPos.element(k));
    const d = length(uv().sub(vec2(0.5)));
    const core = smoothstep(0.5, 0.05, d);
    material.colorNode = mix(CYAN, vec3(1, 1, 1), w.mul(0.6))
      .mul(w.mul(1.6).add(0.3))
      .add(vec3(u.flash));
    material.opacityNode = core
      .mul(act)
      .mul(w.mul(0.8).add(0.2))
      .mul(u.dissolve.oneMinus())
      .mul(uSceneOp);
    material.scaleNode = float(0.1).add(w.mul(0.16)).add(u.burst.mul(w).mul(0.06));
    addObject(createParticleSprite(material, MAX_VIS_PINS), material);
  };

  /** 「解析中」スキャンリング（拡大しながら減衰、onset で増光）。 */
  const buildScanRings = (): void => {
    const material = createAdditiveSpriteMaterial();
    const k = instanceIndex;
    const w = float(uPinWeight.element(k));
    const act = float(uPinActive.element(k));
    const phase = fract(u.time.mul(0.55).add(float(k).mul(0.37)));
    material.positionNode = vec3(uPinPos.element(k));
    const d = length(uv().sub(vec2(0.5)));
    const ringR = mix(float(0.08), float(0.48), phase);
    const ring = smoothstep(0.035, 0.0, abs(d.sub(ringR)));
    material.colorNode = GREEN.mul(1.6).add(vec3(u.flash));
    material.opacityNode = ring
      .mul(act)
      .mul(phase.oneMinus())
      .mul(w.mul(1.2).add(0.1))
      .mul(u.burst.mul(1.6).add(0.3))
      .mul(u.dissolve.oneMinus())
      .mul(uSceneOp);
    material.scaleNode = float(0.34).add(w.mul(0.55));
    addObject(createParticleSprite(material, MAX_VIS_PINS), material);
  };

  /** カーソルのダイヤ型マーカー。 */
  const buildCursorSprite = (): void => {
    const material = createAdditiveSpriteMaterial();
    material.positionNode = uCursor;
    const c = uv().sub(vec2(0.5));
    const m = abs(float(c.x)).add(abs(float(c.y))); // マンハッタン距離 → ダイヤ
    const edge = smoothstep(0.46, 0.4, m).mul(smoothstep(0.3, 0.37, m)); // 輪郭
    const core = smoothstep(0.14, 0.0, m).mul(0.9);
    material.colorNode = vec3(0.75, 1, 1)
      .mul(float(1.1).add(u.level.mul(1.4)))
      .add(vec3(u.flash));
    material.opacityNode = edge.add(core).mul(u.dissolve.mul(0.4).oneMinus()).mul(uSceneOp);
    material.scaleNode = float(0.24).add(u.level.mul(0.06)).add(u.burst.mul(0.05));
    addObject(createParticleSprite(material, 1), material);
  };

  /** カーソル→各ピンの影響線（輝度=重み。線幅は WebGPU 非対応のため輝度＋流れ粒子で表現）。 */
  const buildLines = (): void => {
    lineGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(MAX_VIS_PINS * 2 * 3);
    const colors = new Float32Array(MAX_VIS_PINS * 2 * 3);
    lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    lineGeo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    lineMat = mat;
    const lines = new THREE.LineSegments(lineGeo, mat);
    lines.frustumCulled = false;
    addObject(lines, lineGeo, mat);
  };

  /** 星空（背景に多数の星。緩く回転・twinkle、level/onset に微反応）。ピンはこの中から生まれる。 */
  const buildStarfield = (): void => {
    const material = createAdditiveSpriteMaterial();
    const idx = float(instanceIndex);
    const h1 = hash(idx);
    const h2 = hash(idx.add(11));
    const h3 = hash(idx.add(22));
    const h4 = hash(idx.add(33));
    const rr = float(6).add(h1.mul(10)); // 半径 6..16 の球殻
    const ph = h3.mul(Math.PI); // 0..PI
    const sph = sin(ph);
    const drift = u.time.mul(0.02).mul(h4.mul(0.5).add(0.5)); // ごく緩い回転
    const ang = h2.mul(PI2).add(drift);
    const base = vec3(
      sph.mul(cos(ang)).mul(rr),
      cos(ph).mul(rr).mul(0.7).add(1.5), // 上下つぶし＋やや持ち上げ
      sph.mul(sin(ang)).mul(rr),
    );
    const scatter = vec3(
      hash(idx.add(44)).sub(0.5),
      hash(idx.add(55)).sub(0.5),
      hash(idx.add(66)).sub(0.5),
    ).mul(u.dissolve.mul(4));
    material.positionNode = base.add(scatter);
    const tw = sin(u.time.mul(h4.mul(1.5).add(0.3)).add(h2.mul(PI2))).mul(0.5).add(0.5);
    const bright = float(0.12).add(tw.mul(0.5)).add(u.level.mul(0.4)).add(u.burst.mul(0.3));
    material.colorNode = mix(vec3(0.6, 0.8, 1), vec3(1, 1, 1), h1).mul(bright).add(vec3(u.flash.mul(0.6)));
    const soft = smoothstep(0.16, 0.5, length(uv().sub(vec2(0.5)))).oneMinus();
    material.opacityNode = soft
      .mul(float(0.5).add(tw.mul(0.5)))
      .mul(u.dissolve.mul(0.5).oneMinus())
      .mul(uSceneOp);
    material.scaleNode = float(0.01).add(h3.mul(0.02)).add(u.burst.mul(0.01));
    addObject(createParticleSprite(material, STAR_COUNT), material);
  };

  /** オーディオ反応フロア（ON 時のみ表示）。列=周波数のスペクトログラム床＋onset リップル。 */
  const buildReactiveFloor = (): void => {
    const material = createAdditiveSpriteMaterial();
    const gi = float(instanceIndex);
    const row = floor(gi.div(FLOOR_GRID));
    const col = gi.sub(row.mul(FLOOR_GRID));
    const gx = col.div(FLOOR_GRID).sub(0.5); // -0.5..0.5
    const gz = row.div(FLOOR_GRID).sub(0.5);
    const x = gx.mul(FLOOR_SPAN);
    const z = gz.mul(FLOOR_SPAN);
    const binF = col.div(FLOOR_GRID).mul(SPECTRUM_BINS); // 列→周波数 bin（<SPECTRUM_BINS で安全）
    const sBin = float(u.spectrum.element(int(floor(binF))));
    const d = length(vec2(gx, gz));
    const ripple = sin(d.mul(22).sub(u.time.mul(3))).mul(u.burst); // onset の同心円リップル
    const h = sBin.mul(FLOOR_HEIGHT).add(ripple.mul(0.4)).add(u.level.mul(0.15));
    material.positionNode = vec3(x, h.mul(uFloorReactive), z);
    const glow = sBin.mul(1.6).add(u.level.mul(0.5)).add(abs(ripple).mul(1.2)).add(0.06);
    material.colorNode = mix(vec3(0.1, 0.5, 0.55), GREEN, sBin).mul(glow).add(vec3(u.flash.mul(0.8)));
    const soft = smoothstep(0.2, 0.5, length(uv().sub(vec2(0.5)))).oneMinus();
    material.opacityNode = soft
      .mul(uFloorReactive)
      .mul(sBin.mul(0.7).add(0.12))
      .mul(u.dissolve.oneMinus())
      .mul(uSceneOp);
    material.scaleNode = float(0.012).add(sBin.mul(0.02));
    addObject(createParticleSprite(material, FLOOR_GRID * FLOOR_GRID), material);
  };

  /** グリッド床（データ空間の基準面）。 */
  const buildGrid = (): void => {
    const grid = new THREE.GridHelper(PAD_SCALE, 16, 0x1a6d78, 0x0a2e34);
    const mat = grid.material as THREE.LineBasicMaterial;
    mat.transparent = true;
    mat.opacity = GRID_OPACITY;
    mat.depthWrite = false;
    gridMat = mat;
    addObject(grid, grid.geometry, mat);
  };

  /** M8 horizon: 地平線リング＋ワイヤードーム（緯線リング状の粒子、空間の広がり）。 */
  const buildHorizon = (): void => {
    const material = createAdditiveSpriteMaterial();
    const idx = float(instanceIndex);
    const h1 = hash(idx);
    const h2 = hash(idx.add(77));
    const RINGS = 5;
    const ring = floor(h1.mul(RINGS)); // 0..4 の緯線リング（0=地平線）
    const lat = ring.div(RINGS).mul(0.45 * Math.PI);
    const R = float(7.5);
    const az = h2.mul(PI2).add(u.time.mul(0.04).mul(ring.mul(0.3).add(0.4)));
    material.positionNode = vec3(
      cos(lat).mul(cos(az)).mul(R),
      sin(lat).mul(R).mul(0.55),
      cos(lat).mul(sin(az)).mul(R),
    );
    const tw = sin(u.time.mul(1.2).add(h1.mul(PI2))).mul(0.5).add(0.5);
    material.colorNode = mix(CYAN, vec3(0.5, 0.65, 1), h1)
      .mul(float(0.5).add(tw.mul(0.4)).add(u.mid.mul(0.6)))
      .add(vec3(u.flash.mul(0.7)));
    const soft = smoothstep(0.14, 0.5, length(uv().sub(vec2(0.5)))).oneMinus();
    material.opacityNode = soft
      .mul(uObjHorizon)
      .mul(float(0.35).add(tw.mul(0.3)))
      .mul(u.dissolve.mul(0.6).oneMinus())
      .mul(uSceneOp);
    material.scaleNode = float(0.015).add(h2.mul(0.012)).add(u.burst.mul(0.008));
    addObject(createParticleSprite(material, HORIZON_COUNT), material);
  };

  /** 星座線が結ぶ背景星（描画される anchors）。緩く twinkle、level/onset に微反応。 */
  const buildConstAnchors = (): void => {
    // 決定的に球状分布（黄金角スパイラル）。位置は uAnchor と constStars の両方に保持。
    for (let i = 0; i < CONST_ANCHORS; i++) {
      const ga = i * 2.399963; // 黄金角
      const yy = 1 - (i / Math.max(1, CONST_ANCHORS - 1)) * 2; // -1..1
      const rr = Math.sqrt(Math.max(0, 1 - yy * yy));
      const rad = 5 + ((i * 0.613) % 1) * 8; // 半径 5..13
      const v = new THREE.Vector3(
        Math.cos(ga) * rr * rad,
        yy * rad * 0.7 + 1.2,
        Math.sin(ga) * rr * rad,
      );
      constStars.push(v);
      (uAnchor.array as THREE.Vector3[])[i].copy(v);
    }
    // 流れ星ラインのペア/位相/速度（決定的・BPM 非依存）
    for (let i = 0; i < MAX_CONST_LINES; i++) {
      constPairA[i] = (i * 3) % CONST_ANCHORS;
      let b = (i * 3 + 7 + (i % 5)) % CONST_ANCHORS;
      if (b === constPairA[i]) b = (b + 1) % CONST_ANCHORS;
      constPairB[i] = b;
      constPhase[i] = (i * 0.373) % 1;
      constSpeed[i] = 0.12 + ((i * 0.081) % 1) * 0.28; // 周期 ~2.5..8s
    }
    // anchors スプライト（背景星として常時描画）
    const material = createAdditiveSpriteMaterial();
    const k = float(instanceIndex);
    material.positionNode = vec3(uAnchor.element(instanceIndex));
    const tw = sin(u.time.mul(hash(k).mul(1.2).add(0.3)).add(hash(k.add(9)).mul(PI2))).mul(0.5).add(0.5);
    material.colorNode = mix(vec3(0.6, 0.85, 1), vec3(1, 1, 1), hash(k.add(3)))
      .mul(float(0.5).add(tw.mul(0.5)).add(u.level.mul(0.5)))
      .add(vec3(u.flash.mul(0.5)));
    const soft = smoothstep(0.14, 0.5, length(uv().sub(vec2(0.5)))).oneMinus();
    material.opacityNode = soft
      .mul(float(0.5).add(tw.mul(0.5)))
      .mul(u.dissolve.mul(0.5).oneMinus())
      .mul(uSceneOp);
    material.scaleNode = float(0.018).add(hash(k.add(5)).mul(0.02)).add(u.burst.mul(0.01));
    addObject(createParticleSprite(material, CONST_ANCHORS), material);
  };

  /** 流れ星ライン（anchors ペア間を尾を引いて走る。頂点色で頭=明・尾=暗。張り替えは animate）。 */
  const buildConstLines = (): void => {
    constGeo = new THREE.BufferGeometry();
    constGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(new Float32Array(MAX_CONST_LINES * 2 * 3), 3),
    );
    constGeo.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(new Float32Array(MAX_CONST_LINES * 2 * 3), 3),
    );
    constMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(constGeo, constMat);
    lines.frustumCulled = false;
    addObject(lines, constGeo, constMat);
  };

  const removeLabel = (id: string): void => {
    const l = labels.get(id);
    if (!l) return;
    ctx?.root.remove(l.sprite);
    l.tex.dispose();
    l.mat.dispose();
    labels.delete(id);
  };

  const labelY = (w: number): number => 0.05 + w * PIN_LIFT + 0.27;

  /** ラベルの目標（位置/不透明度）を設定。出現/移動/消失は animate() で滑らかに補間。 */
  const setLabelTargets = (pins: readonly Pin[], weights: readonly number[]): void => {
    if (typeof document === "undefined" || !ctx) return;
    const seen = new Set<string>();
    pins.forEach((p, i) => {
      seen.add(p.id);
      const text = p.text.trim() || "(empty)";
      const sub = subLabel(p); // 投入者名・時刻（通常ピンは空）
      const w = weights[i] ?? 0;
      let l = labels.get(p.id);
      if (l && (l.text !== text || l.sub !== sub)) {
        // テキスト/副次行変更: 位置/不透明度を引き継いで作り直し（ポップ回避）
        const prevOp = l.op.value as number;
        const prevPos = l.sprite.position.clone();
        removeLabel(p.id);
        const made = makeLabel(text, sub, uSceneOp);
        if (!made) return;
        made.op.value = prevOp;
        made.sprite.position.copy(prevPos);
        labels.set(p.id, made);
        ctx?.root.add(made.sprite);
        l = made;
      }
      if (!l) {
        const made = makeLabel(text, sub, uSceneOp);
        if (!made) return;
        made.sprite.position.set(padX(p.x), labelY(w), padZ(p.y)); // 目標位置に出現→op 0 からフェード
        labels.set(p.id, made);
        ctx?.root.add(made.sprite);
        l = made;
      }
      l.fading = false;
      l.targetPos.set(padX(p.x), labelY(w), padZ(p.y));
      l.targetOp = 0.3 + 0.7 * w;
    });
    // 消えたピンのラベルは fade out（op≈0 で animate が撤去）
    for (const [id, l] of labels) {
      if (!seen.has(id)) {
        l.fading = true;
        l.targetOp = 0;
      }
    }
  };

  /** last-known 状態から「目標」を設定（uniforms への即時反映はしない。補間は animate）。 */
  const applyTargets = (space: PromptSpaceState | null): void => {
    const pins = space?.pins ?? [];
    const weights = space ? normalizedPinWeights(space.pins, space.cursor) : [];
    const n = Math.min(pins.length, MAX_VIS_PINS);
    const desiredIds = new Set<string>();
    for (let i = 0; i < n; i++) desiredIds.add(pins[i].id);

    const posArr = uPinPos.array as THREE.Vector3[];
    const wArr = uPinWeight.array as number[];
    const aArr = uPinActive.array as number[];

    // 1) desired に無い占有スロットは fade out（位置は据え置きで消える）
    for (let s = 0; s < MAX_VIS_PINS; s++) {
      const id = slotId[s];
      if (id !== null && !desiredIds.has(id)) {
        slotFading[s] = true;
        tgtA[s] = 0;
        tgtW[s] = 0;
      }
    }
    // 2) desired 各ピンをスロットへ（既存 id は維持＝並び替えで飛ばない、無ければ空き/フェード中を確保）
    for (let i = 0; i < n; i++) {
      const p = pins[i];
      const w = weights[i] ?? 0;
      const act = p.text.trim().length > 0 ? 1 : 0.35; // 空テキストは薄く存在表示
      const px = padX(p.x);
      const pz = padZ(p.y);
      const py = 0.05 + w * PIN_LIFT;
      let s = slotId.indexOf(p.id);
      if (s < 0) {
        s = slotId.indexOf(null);
        if (s < 0) s = slotFading.indexOf(true);
        if (s < 0) continue; // 空き無し（n<=MAX_VIS_PINS で通常起きない）
        // 新規占有: 目標位置に置き、w/a を 0 からフェードイン（出現がゆるやか）
        slotId[s] = p.id;
        slotFading[s] = false;
        posArr[s].set(px, py, pz);
        wArr[s] = 0;
        aArr[s] = 0;
      } else {
        slotFading[s] = false;
      }
      tgtPos[s].set(px, py, pz);
      tgtW[s] = w;
      tgtA[s] = act;
    }
    // 3) カーソル目標
    tgtCursor.set(padX(space?.cursor.x ?? 0.5), 0.09, padZ(space?.cursor.y ?? 0.5));
    // 4) カメラ激しさ / 床反応の目標
    tgtEnergy = space?.cameraEnergy ?? 0;
    tgtFloor = space?.floorReactive ? 1 : 0;
    // 4b) M8: トグル・オブジェクト（horizon）の表示目標＋星座線の量（補間は animate）
    Object.assign(tgtObj, objectTargets(space?.vjObjects));
    tgtConstLines = space?.constellationLines ?? 0;
    // 5) ラベル目標
    setLabelTargets(pins.slice(0, n), weights);
  };

  /** 毎フレーム: 目標へ滑らかに補間し uniforms/線/ラベル/注視点/カメラ激しさを更新。 */
  const animate = (dtMs: number): void => {
    const posA = easeAlpha(dtMs, POS_TAU);
    const amtA = easeAlpha(dtMs, AMT_TAU);
    const posArr = uPinPos.array as THREE.Vector3[];
    const wArr = uPinWeight.array as number[];
    const aArr = uPinActive.array as number[];

    for (let s = 0; s < MAX_VIS_PINS; s++) {
      posArr[s].lerp(tgtPos[s], posA);
      wArr[s] += (tgtW[s] - wArr[s]) * amtA;
      aArr[s] += (tgtA[s] - aArr[s]) * amtA;
      if (slotFading[s] && aArr[s] < 0.01) {
        // フェード完了 → スロット解放
        slotId[s] = null;
        slotFading[s] = false;
        posArr[s].set(0, -10, 0);
        tgtPos[s].set(0, -10, 0);
        wArr[s] = 0;
        aArr[s] = 0;
        tgtW[s] = 0;
        tgtA[s] = 0;
      }
    }
    const cur = uCursor.value as THREE.Vector3;
    cur.lerp(tgtCursor, posA);

    // 影響線（current 値から。輝度=重み×active）
    if (lineGeo) {
      const pAttr = lineGeo.getAttribute("position") as THREE.BufferAttribute;
      const cAttr = lineGeo.getAttribute("color") as THREE.BufferAttribute;
      for (let i = 0; i < MAX_VIS_PINS; i++) {
        const o = i * 2;
        if (aArr[i] > 0.02) {
          pAttr.setXYZ(o, cur.x, cur.y, cur.z);
          pAttr.setXYZ(o + 1, posArr[i].x, posArr[i].y, posArr[i].z);
          const b = (0.06 + wArr[i] * 0.94) * aArr[i];
          cAttr.setXYZ(o, 0.3 * b, 0.95 * b, 1 * b);
          cAttr.setXYZ(o + 1, 0.25 * b, 0.8 * b, 0.9 * b);
        } else {
          pAttr.setXYZ(o, cur.x, cur.y, cur.z);
          pAttr.setXYZ(o + 1, cur.x, cur.y, cur.z);
          cAttr.setXYZ(o, 0, 0, 0);
          cAttr.setXYZ(o + 1, 0, 0, 0);
        }
      }
      pAttr.needsUpdate = true;
      cAttr.needsUpdate = true;
    }

    // ラベル: 不透明度/位置を補間、fade 完了で撤去
    const toRemove: string[] = [];
    for (const [id, l] of labels) {
      const op = l.op.value as number;
      l.op.value = op + (l.targetOp - op) * amtA;
      l.sprite.position.lerp(l.targetPos, posA);
      if (l.fading && (l.op.value as number) < 0.01) toRemove.push(id);
    }
    for (const id of toRemove) removeLabel(id);

    // カメラ激しさ・床反応（スライダー/トグル変更も滑らかに）
    const eA = easeAlpha(dtMs, ENERGY_TAU);
    curEnergy += (tgtEnergy - curEnergy) * eA;
    curFloor += (tgtFloor - curFloor) * eA;
    uFloorReactive.value = curFloor;

    // M8: トグル・オブジェクト（horizon）の表示強度（ON/OFF を滑らかに。0 で不可視）
    const oA = easeAlpha(dtMs, OBJ_TAU);
    for (const k of VJ_OBJECT_KEYS) curObj[k] += (tgtObj[k] - curObj[k]) * oA;
    uObjHorizon.value = curObj.horizon;

    // 星座線（流れ星）: 背景星ペア間を尾を引いて走る。量はスライダー、動きは BPM 非依存（constClock）。
    curConstLines += (tgtConstLines - curConstLines) * oA;
    constClock += dtMs / 1000;
    if (constGeo && constMat) {
      const active = Math.round(curConstLines * MAX_CONST_LINES);
      const pAttr = constGeo.getAttribute("position") as THREE.BufferAttribute;
      const cAttr = constGeo.getAttribute("color") as THREE.BufferAttribute;
      const lvl = u.level.value as number;
      const brst = u.burst.value as number;
      const bright = 0.5 + lvl * 0.6 + brst * 0.9;
      for (let i = 0; i < MAX_CONST_LINES; i++) {
        const o = i * 2;
        if (i < active) {
          const a = constStars[constPairA[i]];
          const b = constStars[constPairB[i]];
          const raw = constClock * constSpeed[i] + constPhase[i];
          const hh = raw - Math.floor(raw); // 頭の位置 0..1
          const tl = Math.max(0, hh - CONST_TRAIL); // 尾の位置
          pAttr.setXYZ(o, a.x + (b.x - a.x) * tl, a.y + (b.y - a.y) * tl, a.z + (b.z - a.z) * tl);
          pAttr.setXYZ(o + 1, a.x + (b.x - a.x) * hh, a.y + (b.y - a.y) * hh, a.z + (b.z - a.z) * hh);
          cAttr.setXYZ(o, 0.06, 0.14, 0.26); // 尾（暗い寒色）
          cAttr.setXYZ(o + 1, 0.55 * bright, 0.85 * bright, bright); // 頭（明るい）
        } else {
          pAttr.setXYZ(o, 0, -10, 0);
          pAttr.setXYZ(o + 1, 0, -10, 0);
          cAttr.setXYZ(o, 0, 0, 0);
          cAttr.setXYZ(o + 1, 0, 0, 0);
        }
      }
      pAttr.needsUpdate = true;
      cAttr.needsUpdate = true;
    }
  };

  return {
    id: "promptSpace",
    init(c: SceneContext) {
      ctx = c;
      buildStarfield(); // 背景の星空（最多インスタンス）
      buildGrid(); // 平衡感覚用の床グリッド（常時）
      buildReactiveFloor(); // オーディオ反応フロア（ON 時のみ表示）
      // M8: トグル・オブジェクト（常時構築、uObj*=0 で不可視）
      buildHorizon();
      buildConstAnchors(); // 星座線が結ぶ背景星（描画される 2 点）
      buildConstLines(); // 流れ星ライン（量スライダー）
      buildLines();
      buildOrbitSprite();
      buildFlowSprite();
      buildCoreSprite();
      buildScanRings();
      buildCursorSprite();
      applyTargets(null);
    },
    setPromptSpace(space: PromptSpaceState | null) {
      if (space === lastSpace) return; // store は同一オブジェクトを保持 → 参照でキャッシュ
      lastSpace = space;
      applyTargets(space);
    },
    update(vp: VisualParams, dtMs: number) {
      applyVisualParams(u, vp, dtMs);
      animate(dtMs); // 目標へ滑らかに補間（ピン/カーソル/線/ラベル/注視点/激しさ）
      if (ctx) {
        // カメラの激しさ curEnergy: 0=控えめオービット, 1=半径ゆらぎ+上下+横揺れで縦横無尽
        const e = curEnergy;
        camT += (dtMs / 1000) * vp.speed * (0.12 + e * 0.45);
        const r = 3.8 + e * Math.sin(camT * 0.53) * 1.6;
        // もっと下から回る: 基準を低く（0.8）、上下スイングを広げ、下は 0.1 まで許容
        const height = Math.max(
          0.1,
          0.8 + Math.sin(camT * 0.6) * 0.55 + e * Math.sin(camT * 0.37 + 1.3) * 2.4,
        );
        const swayX = e * Math.sin(camT * 0.83) * 1.3;
        const swayZ = e * Math.cos(camT * 0.67) * 1.3;
        ctx.camera.position.set(
          Math.sin(camT) * r + swayX,
          height,
          Math.cos(camT) * r + swayZ,
        );
        ctx.camera.lookAt(0, 0.35, 0); // 注視点は中央固定
      }
    },
    setDissolve(amount: number) {
      u.dissolve.value = amount;
    },
    setOpacity(amount: number) {
      // クロスフェード: TSL 側は uSceneOp、LineBasicMaterial 系は material.opacity で追従
      const o = clamp01(amount);
      uSceneOp.value = o;
      if (gridMat) gridMat.opacity = GRID_OPACITY * o;
      if (lineMat) lineMat.opacity = o;
      if (constMat) constMat.opacity = o;
    },
    flash() {
      u.flash.value = 1;
    },
    dispose() {
      for (const id of [...labels.keys()]) removeLabel(id);
      for (const o of objects) ctx?.root.remove(o);
      for (const d of disposables) d.dispose();
      objects.length = 0;
      disposables.length = 0;
      lineGeo = null;
      lineMat = null;
      gridMat = null;
      constGeo = null;
      constMat = null;
      constStars.length = 0;
      ctx = null;
      lastSpace = undefined;
    },
  };
}
