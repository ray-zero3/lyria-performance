// latentField シーン: 「あり得るプロンプト空間全体」を点群で表現する VJ。
// 大量の塵粒子（潜在空間の密度場）の中に、履歴/ピン/リクエスト/ターゲット/潜在ブレンドの
// ノードが浮かび、カメラが空間を飛行 → ノードをロックオン → 解析 HUD を表示、を自律巡回する。
// TSL は promptSpace と同じ流儀（Sprite + count + SpriteNodeMaterial、uniformArray、element() ラップ）。
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
  abs,
  sin,
  cos,
  max,
  dot,
  PI2,
  instanceIndex,
  uniform,
  uniformArray,
  texture,
  mx_noise_vec3,
} from "three/tsl";
import { clamp01, type HubState } from "$lib/telemetry/contract";
import type { PromptSpaceState } from "$lib/prompts/promptSpace";
import type { VisualParams } from "../visualMapping";
import { easeAlpha } from "../cameraRig";
import type { SceneContext, SceneImpl } from "./types";
import {
  applyVisualParams,
  createAdditiveSpriteMaterial,
  createCommonUniforms,
  createParticleSprite,
} from "./sceneUtils";
import {
  accumulateHistory,
  buildAnalysisLines,
  buildNodeCatalog,
  cameraPose,
  createFlightState,
  MAX_NODES,
  nearestIndices,
  revealLines,
  stepFlight,
  type FlightState,
  type HistoryEntry,
  type LatentNode,
  type NodeKind,
  type Vec3Like,
} from "./latentFieldLogic";

// ---- live 調整ポイント（点群・演出の規模） ----
/** 背景の塵粒子（潜在空間の密度場）の数。 */
export const DUST_COUNT = 14000;
/** 塵のクラスタ数（小さいほど「銀河の腕」が太く塊状になる）。 */
export const DUST_CLUSTERS = 14;
/** 塵の分布半径。 */
export const FIELD_RADIUS = 8.5;
/** クラスタ内の広がり。 */
export const CLUSTER_SPREAD = 2.6;
/** ロックノードから近傍ノードへ張る関係線の本数。 */
export const LINK_COUNT = 4;

// ---- live 調整ポイント（アニメーション時定数 ms） ----
/** ノード出現/消失のフェード時定数。 */
export const NODE_TAU = 260;
/** ロック強度（レティクル/HUD/関係線）のフェード時定数。 */
export const LOCK_TAU = 180;
/** カメラの平滑時定数。カタログ再構築などの経路ジャンプを吸収する。 */
export const CAM_TAU = 140;

// ---- live 調整ポイント（HUD） ----
/** HUD 再描画間隔の下限（CanvasTexture 更新のスロットル）。 */
export const HUD_REDRAW_MS = 50;
/** HUD スプライトの高さ（world 単位）。小さくミニマルに（旧 0.24 の半分）。 */
export const HUD_HEIGHT = 0.12;
/** HUD のノードからのオフセット（カメラ右手方向・上方向）。 */
export const HUD_OFFSET_RIGHT = 0.62;
export const HUD_OFFSET_UP = 0.1;

// ---- live 調整ポイント（ロックオン・レティクル） ----
/** レティクルのスプライト一辺（world 単位）。 */
export const RETICLE_SCALE = 0.42;
/** フレーム線の位置（スプライト UV 中心からの Chebyshev 半距離。0.5 で外周いっぱい）。 */
export const RETICLE_HALF = 0.44;
/** フレーム線の細さ（UV 半幅。小さいほど細線）。 */
export const RETICLE_LINE = 0.006;

/** 種別 → 表示の熱量（1=リクエスト最重要 → 0.16=潜在仮説。色/サイズに反映）。 */
export const KIND_HEAT: Record<NodeKind, number> = {
  request: 1,
  pin: 0.78,
  target: 0.56,
  history: 0.36,
  latent: 0.16,
};

/** シーン外部（scene.ts）からデータを注入する面。 */
export interface LatentFieldSceneImpl extends SceneImpl {
  setPromptSpace(space: PromptSpaceState | null): void;
  setHubState(state: HubState): void;
}

// HUD キャンバスの寸法（デバイス px）。ミニマル 2 行（種別行＋プロンプト本文）。
// 表示サイズ（HUD_HEIGHT）に対して高解像度に取り、縮小表示でも文字をクリスプに保つ。
const HUD_CANVAS_W = 1000;
const HUD_CANVAS_H = 160;
const HUD_PAD_X = 28;
const HUD_HEAD_Y = 28; // 1 行目（種別・由来）の y
const HUD_BODY_Y = 76; // 2 行目（プロンプト本文）の y
const HUD_HEAD_FONT_PX = 30; // 種別行のフォントサイズ（canvas px）
const HUD_BODY_FONT_PX = 44; // 本文のフォントサイズ（canvas px）
const HUD_RULE_W = 2; // 左端の細ルール幅（canvas px。唯一の区切り線）

const createOpacityUniform = () => uniform(0);
type OpacityUniform = ReturnType<typeof createOpacityUniform>;

interface HudEntry {
  sprite: THREE.Sprite;
  mat: THREE.SpriteNodeMaterial;
  tex: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  op: OpacityUniform;
  renderedText: string;
}

/** latentField シーンを生成。 */
export function createLatentFieldScene(): LatentFieldSceneImpl {
  const u = createCommonUniforms();
  const uNodePos = uniformArray<"vec3">(
    Array.from({ length: MAX_NODES }, () => new THREE.Vector3(0, -50, 0)),
    "vec3",
  );
  const uNodeAmp = uniformArray<"float">(new Array<number>(MAX_NODES).fill(0), "float");
  const uNodeHeat = uniformArray<"float">(new Array<number>(MAX_NODES).fill(0), "float");
  const uLockPos = uniform(new THREE.Vector3(0, -50, 0));
  const uLockAmp = uniform(0);
  const uSceneOp = uniform(1); // シーン全体の不透明度（クロスフェード。manager が毎フレーム配布）

  // シーン固有パレット（全面モノクロ＝無彩色階調。種別・音の反応は明度/コントラスト/サイズで表現）
  const GRAY_DIM = vec3(0.3, 0.3, 0.3);
  const WHITE = vec3(1, 1, 1);
  // 音の色（colorA）は色相を捨て、Rec.709 輝度だけを明度へ反映するための係数
  const LUMA_WEIGHTS = vec3(0.2126, 0.7152, 0.0722);

  let ctx: SceneContext | null = null;
  let lastSpace: PromptSpaceState | null | undefined; // undefined = 未注入
  let lastState: HubState | undefined; // undefined = 未注入
  let history: readonly HistoryEntry[] = [];
  let catalog: LatentNode[] = [];
  let positions: Vec3Like[] = [];
  let catalogDirty = true;
  let flight: FlightState = createFlightState();
  let lockSeqSeen = 0;
  let lockedNode: LatentNode | null = null;
  let lockedLines: string[] = [];
  let curLock = 0;
  let sceneOp = 1; // クロスフェードの JS 側キャッシュ（LineBasicMaterial の opacity 用）
  let hud: HudEntry | null = null;
  let hudAccum = 0;
  let linkGeo: THREE.BufferGeometry | null = null;
  let linkMat: THREE.LineBasicMaterial | null = null;
  let camInit = false;
  let errorLogged = false;
  const curCamPos = new THREE.Vector3();
  const curLook = new THREE.Vector3();
  const tmpPos = new THREE.Vector3();
  const tmpLook = new THREE.Vector3();
  const tmpRight = new THREE.Vector3();

  // ノードスロット（id で安定割当。カタログ再構築で並びが変わっても飛ばない）
  const slotId: (string | null)[] = new Array<string | null>(MAX_NODES).fill(null);
  const slotFading: boolean[] = new Array<boolean>(MAX_NODES).fill(false);
  const tgtAmp = new Array<number>(MAX_NODES).fill(0);
  const tgtHeat = new Array<number>(MAX_NODES).fill(0);

  const objects: THREE.Object3D[] = [];
  const disposables: Array<{ dispose(): void }> = [];
  const addObject = (o: THREE.Object3D, ...d: Array<{ dispose(): void }>): void => {
    objects.push(o);
    disposables.push(...d);
    ctx?.root.add(o);
  };

  /** 背景の塵粒子（クラスタ状に濃淡のある潜在空間の密度場、1 ドロー）。 */
  const buildDust = (): void => {
    const material = createAdditiveSpriteMaterial();
    const idx = float(instanceIndex);
    const h1 = hash(idx);
    const h2 = hash(idx.add(101));
    const h3 = hash(idx.add(202));
    const h4 = hash(idx.add(303));
    // 所属クラスタ（決定的）。中心を球状に散らして「銀河の腕」の濃淡を作る
    const ck = floor(h1.mul(DUST_CLUSTERS));
    const ch1 = hash(ck.add(0.5));
    const ch2 = hash(ck.add(70.5));
    const ch3 = hash(ck.add(140.5));
    const cr = ch1.mul(FIELD_RADIUS * 0.85).add(FIELD_RADIUS * 0.15);
    const cAz = ch2.mul(PI2);
    const center = vec3(
      cos(cAz).mul(cr),
      ch3.sub(0.5).mul(FIELD_RADIUS).mul(0.7),
      sin(cAz).mul(cr),
    );
    // クラスタ内オフセット（sign(t)·t² で中心寄りに濃く）
    const t1 = h2.sub(0.5).mul(2);
    const t2 = h3.sub(0.5).mul(2);
    const t3 = h4.sub(0.5).mul(2);
    const off = vec3(t1.mul(abs(t1)), t2.mul(abs(t2)).mul(0.6), t3.mul(abs(t3))).mul(CLUSTER_SPREAD);
    // ゆるいドリフト（潜在空間が生きている感じ）＋溶解時の散乱
    const drift = mx_noise_vec3(vec3(h2.mul(40), h3.mul(40), u.time.mul(0.05)), 1).mul(0.3);
    const scatter = vec3(
      hash(idx.add(404)).sub(0.5),
      hash(idx.add(505)).sub(0.5),
      hash(idx.add(606)).sub(0.5),
    ).mul(u.dissolve.mul(5));
    material.positionNode = center.add(off).add(drift).add(scatter);
    const tw = sin(u.time.mul(h4.mul(1.4).add(0.25)).add(h1.mul(PI2))).mul(0.5).add(0.5);
    const bright = float(0.1).add(tw.mul(0.3)).add(u.level.mul(0.35)).add(u.burst.mul(0.25));
    // モノクロ: 塵はグレー階調。音の色（colorA）は輝度だけを取り出して明度へ加算（色相は使わない）
    const audioLuma = dot(u.colorA.rgb, LUMA_WEIGHTS);
    material.colorNode = mix(vec3(0.4, 0.4, 0.4), vec3(0.9, 0.9, 0.9), h2)
      .mul(bright)
      .add(vec3(audioLuma.mul(tw.mul(0.15))))
      .add(vec3(u.flash.mul(0.7)));
    const soft = smoothstep(0.16, 0.5, length(uv().sub(vec2(0.5)))).oneMinus();
    material.opacityNode = soft
      .mul(float(0.35).add(tw.mul(0.45)))
      .mul(u.dissolve.mul(0.5).oneMinus())
      .mul(uSceneOp);
    material.scaleNode = float(0.008).add(h3.mul(0.014)).add(u.burst.mul(0.006));
    addObject(createParticleSprite(material, DUST_COUNT), material);
  };

  /** ノード核（1 ノード = 1 インスタンス。熱量で色/サイズ、amp でフェード）。 */
  const buildNodeCores = (): void => {
    const material = createAdditiveSpriteMaterial();
    const k = instanceIndex;
    const idxF = float(k);
    const amp = float(uNodeAmp.element(k));
    const heat = float(uNodeHeat.element(k));
    const p = vec3(uNodePos.element(k));
    const scatter = vec3(
      hash(idxF.add(11)).sub(0.5),
      hash(idxF.add(22)).sub(0.5),
      hash(idxF.add(33)).sub(0.5),
    ).mul(u.dissolve.mul(4));
    material.positionNode = p.add(scatter);
    const c = uv().sub(vec2(0.5));
    const d = length(c);
    const core = smoothstep(0.42, 0.03, d);
    // ダイヤ輪郭（データノードらしい硬質さ）
    const m = abs(float(c.x)).add(abs(float(c.y)));
    const edge = smoothstep(0.5, 0.44, m).mul(smoothstep(0.36, 0.42, m));
    // モノクロ: 種別の熱量は明度で表現（リクエスト=白へ、潜在=暗いグレー。最重要は白を上乗せ）
    const kindColor = mix(GRAY_DIM, WHITE, heat).add(
      WHITE.mul(smoothstep(0.75, 1.0, heat).mul(0.5)),
    );
    const pulse = float(1).add(u.burst.mul(0.8)).add(u.level.mul(0.3));
    material.colorNode = kindColor.mul(pulse).mul(heat.mul(1.2).add(0.35)).add(vec3(u.flash));
    material.opacityNode = core
      .add(edge.mul(0.8))
      .mul(amp)
      .mul(u.dissolve.oneMinus())
      .mul(uSceneOp);
    material.scaleNode = float(0.07).add(heat.mul(0.06)).add(u.burst.mul(heat).mul(0.03));
    addObject(createParticleSprite(material, MAX_NODES), material);
  };

  /** ロックオン・レティクル（細線の閉じた正方形フレーム＋中心ドット。静的・無回転）。 */
  const buildReticle = (): void => {
    const material = createAdditiveSpriteMaterial();
    material.positionNode = uLockPos;
    const c = uv().sub(vec2(0.5));
    const cheb = max(abs(float(c.x)), abs(float(c.y)));
    // 4 辺が繋がった細線フレーム（RETICLE_HALF の位置に半幅 RETICLE_LINE のライン）
    const frame = smoothstep(RETICLE_LINE, 0.0, abs(cheb.sub(RETICLE_HALF)));
    const centerDot = smoothstep(0.035, 0.0, length(c));
    // 動きは付けない（フェードは uLockAmp のみ）。flash はシーン全体イベントなので追従。
    material.colorNode = WHITE.add(vec3(u.flash));
    material.opacityNode = frame
      .add(centerDot.mul(0.9))
      .mul(uLockAmp)
      .mul(u.dissolve.oneMinus())
      .mul(uSceneOp);
    material.scaleNode = float(RETICLE_SCALE);
    addObject(createParticleSprite(material, 1), material);
  };

  /** 関係線（ロックノード → 近傍ノード。解析の「参照網」表現）。 */
  const buildLinkLines = (): void => {
    linkGeo = new THREE.BufferGeometry();
    linkGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(new Float32Array(LINK_COUNT * 2 * 3), 3),
    );
    linkGeo.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(new Float32Array(LINK_COUNT * 2 * 3), 3),
    );
    linkMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(linkGeo, linkMat);
    lines.frustumCulled = false;
    addObject(lines, linkGeo, linkMat);
  };

  /** 解析 HUD（CanvasTexture スプライト。DOM 無し環境では作らない）。 */
  const buildHud = (): void => {
    if (typeof document === "undefined") return;
    const canvas = document.createElement("canvas");
    canvas.width = HUD_CANVAS_W;
    canvas.height = HUD_CANVAS_H;
    const g = canvas.getContext("2d");
    if (!g) return;
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    const t = texture(tex);
    const op = createOpacityUniform();
    mat.colorNode = vec3(t);
    mat.opacityNode = float(t.a).mul(op).mul(uSceneOp); // クロスフェードにも追従
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set((canvas.width / canvas.height) * HUD_HEIGHT, HUD_HEIGHT, 1);
    sprite.position.set(0, -50, 0);
    hud = { sprite, mat, tex, canvas, g, op, renderedText: "" };
    addObject(sprite, tex, mat);
  };

  /** HUD キャンバスを描画（テキストが変わった時のみ。座布団なし: 左端の細ルール＋文字のみ）。 */
  const drawHud = (lines: readonly string[]): void => {
    if (!hud) return;
    const textKey = lines.join("\n");
    if (textKey === hud.renderedText) return;
    hud.renderedText = textKey;
    const g = hud.g;
    const W = hud.canvas.width;
    const H = hud.canvas.height;
    g.clearRect(0, 0, W, H);
    g.shadowColor = "transparent";
    g.shadowBlur = 0;
    g.fillStyle = "rgba(255, 255, 255, 0.4)";
    g.fillRect(0, 0, HUD_RULE_W, H); // 左端の細ルール（唯一の区切り。背景板は置かない）
    g.textBaseline = "top";
    // 背景板の代わりに軽いドロップシャドウで点群上の可読性を確保
    g.shadowColor = "rgba(0, 0, 0, 0.85)";
    g.shadowBlur = 6;
    lines.forEach((line, i) => {
      if (i === 0) {
        g.font = `400 ${HUD_HEAD_FONT_PX}px ui-monospace, Menlo, monospace`;
        g.fillStyle = "rgba(185, 185, 185, 0.85)"; // 種別・由来（小さく淡いグレー）
        g.fillText(line, HUD_PAD_X, HUD_HEAD_Y);
      } else {
        g.font = `500 ${HUD_BODY_FONT_PX}px ui-monospace, Menlo, monospace`;
        g.fillStyle = "rgba(245, 245, 245, 0.95)"; // プロンプト本文（白）
        g.fillText(line, HUD_PAD_X, HUD_BODY_Y);
      }
    });
    hud.tex.needsUpdate = true;
  };

  /** カタログを再構築し、ノードスロットへ id 安定で反映（位置は決定的なので即時設定）。 */
  const applyCatalog = (): void => {
    catalog = buildNodeCatalog({ space: lastSpace ?? null, history, maxNodes: MAX_NODES });
    positions = catalog.map((nd) => nd.pos);
    const desired = new Set(catalog.map((nd) => nd.id));
    const posArr = uNodePos.array as THREE.Vector3[];
    // 1) desired に無い占有スロットは fade out
    for (let s = 0; s < MAX_NODES; s++) {
      const id = slotId[s];
      if (id !== null && !desired.has(id)) {
        slotFading[s] = true;
        tgtAmp[s] = 0;
      }
    }
    // 2) 各ノードをスロットへ（既存 id は維持、無ければ空き/フェード中を確保）
    for (const node of catalog) {
      let s = slotId.indexOf(node.id);
      if (s < 0) {
        s = slotId.indexOf(null);
        if (s < 0) s = slotFading.indexOf(true);
        if (s < 0) continue; // 空き無し（catalog<=MAX_NODES で通常起きない）
        slotId[s] = node.id;
        (uNodeAmp.array as number[])[s] = 0; // 新規は 0 からフェードイン
      }
      slotFading[s] = false;
      posArr[s].set(node.pos.x, node.pos.y, node.pos.z);
      tgtAmp[s] = 1;
      tgtHeat[s] = KIND_HEAT[node.kind];
    }
  };

  /** 関係線の端点を張り替え（ロック確定時のみ。輝度は毎フレーム material.opacity で制御）。 */
  const refreshLinks = (centerIndex: number): void => {
    if (!linkGeo) return;
    const near = nearestIndices(positions, centerIndex, LINK_COUNT);
    const c = positions[centerIndex];
    const pAttr = linkGeo.getAttribute("position") as THREE.BufferAttribute;
    const cAttr = linkGeo.getAttribute("color") as THREE.BufferAttribute;
    for (let i = 0; i < LINK_COUNT; i++) {
      const o = i * 2;
      if (i < near.length && c) {
        const q = positions[near[i]];
        pAttr.setXYZ(o, c.x, c.y, c.z);
        pAttr.setXYZ(o + 1, q.x, q.y, q.z);
        cAttr.setXYZ(o, 0.95, 0.95, 0.95); // ロック側=白
        cAttr.setXYZ(o + 1, 0.25, 0.25, 0.25); // 近傍側=暗いグレー（モノクロ階調）
      } else {
        pAttr.setXYZ(o, 0, -50, 0);
        pAttr.setXYZ(o + 1, 0, -50, 0);
        cAttr.setXYZ(o, 0, 0, 0);
        cAttr.setXYZ(o + 1, 0, 0, 0);
      }
    }
    pAttr.needsUpdate = true;
    cAttr.needsUpdate = true;
  };

  /** HUD のテキスト/不透明度/位置を更新（再描画はスロットル）。 */
  const updateHud = (dtMs: number): void => {
    if (!hud) return;
    const hudTgt = flight.phase === "analyze" ? 1 : flight.phase === "lock" ? 0.55 : 0;
    const op = hud.op.value as number;
    hud.op.value = op + (hudTgt - op) * easeAlpha(dtMs, LOCK_TAU);
    hudAccum += dtMs;
    if (hudAccum >= HUD_REDRAW_MS) {
      hudAccum = 0;
      if (flight.phase === "lock") {
        const dots = ".".repeat(1 + (Math.floor(flight.phaseMs / 280) % 3));
        drawHud([`LOCKING ${dots}`]);
      } else if (flight.phase === "analyze" && lockedNode) {
        const lines = revealLines(lockedLines, flight.phaseMs);
        const done =
          lines.length === lockedLines.length &&
          lines[lines.length - 1] === lockedLines[lockedLines.length - 1];
        if (!done && lines.length > 0) lines[lines.length - 1] += "▌"; // タイプ中カーソル
        drawHud(lines);
      }
    }
    // 位置: ロックノードのカメラ右手側（スプライトなので常に正面を向く）
    if (lockedNode && ctx) {
      tmpRight.set(1, 0, 0).applyQuaternion(ctx.camera.quaternion);
      hud.sprite.position.set(
        lockedNode.pos.x + tmpRight.x * HUD_OFFSET_RIGHT,
        lockedNode.pos.y + HUD_OFFSET_UP + tmpRight.y * HUD_OFFSET_RIGHT,
        lockedNode.pos.z + tmpRight.z * HUD_OFFSET_RIGHT,
      );
    }
  };

  /** 毎フレーム: スロット/ロック強度/関係線輝度/HUD を目標へ補間。 */
  const animate = (dtMs: number): void => {
    const aAmp = easeAlpha(dtMs, NODE_TAU);
    const ampArr = uNodeAmp.array as number[];
    const heatArr = uNodeHeat.array as number[];
    const posArr = uNodePos.array as THREE.Vector3[];
    for (let s = 0; s < MAX_NODES; s++) {
      ampArr[s] += (tgtAmp[s] - ampArr[s]) * aAmp;
      heatArr[s] += (tgtHeat[s] - heatArr[s]) * aAmp;
      if (slotFading[s] && ampArr[s] < 0.01) {
        // フェード完了 → スロット解放
        slotId[s] = null;
        slotFading[s] = false;
        ampArr[s] = 0;
        tgtAmp[s] = 0;
        posArr[s].set(0, -50, 0);
      }
    }
    // ロック強度（レティクル/関係線/HUD 共通のフェード）
    const aLock = easeAlpha(dtMs, LOCK_TAU);
    const lockTgt = flight.phase === "lock" ? 0.85 : flight.phase === "analyze" ? 1 : 0;
    curLock += (lockTgt - curLock) * aLock;
    uLockAmp.value = curLock;
    if (linkMat) {
      linkMat.opacity = curLock * 0.8 * (1 - (u.dissolve.value as number) * 0.6) * sceneOp;
    }
    updateHud(dtMs);
  };

  return {
    id: "latentField",
    init(c: SceneContext) {
      ctx = c;
      buildDust(); // 背景の塵（最多インスタンス）
      buildNodeCores();
      buildLinkLines();
      buildReticle();
      buildHud();
    },
    setPromptSpace(space: PromptSpaceState | null) {
      if (space === lastSpace) return; // store は同一オブジェクトを保持 → 参照でキャッシュ
      lastSpace = space;
      catalogDirty = true;
    },
    setHubState(state: HubState) {
      if (state === lastState) return; // 参照キャッシュ（applyState は state を丸ごと差し替える）
      lastState = state;
      const next = accumulateHistory(history, state.prompts, Date.now());
      if (next !== history) {
        history = next;
        catalogDirty = true;
      }
    },
    update(vp: VisualParams, dtMs: number) {
      try {
        applyVisualParams(u, vp, dtMs);
        if (catalogDirty) {
          catalogDirty = false;
          applyCatalog();
        }
        // 飛行状態を進め、ロック番号の変化で解析対象を確定 → HUD/レティクル/関係線を準備
        flight = stepFlight(flight, dtMs, positions, Math.random);
        if (flight.lockSeq !== lockSeqSeen && catalog.length > 0) {
          lockSeqSeen = flight.lockSeq;
          const idx = ((flight.targetIndex % catalog.length) + catalog.length) % catalog.length;
          lockedNode = catalog[idx];
          lockedLines = buildAnalysisLines(lockedNode, flight.lockSeq, catalog.length);
          (uLockPos.value as THREE.Vector3).set(
            lockedNode.pos.x,
            lockedNode.pos.y,
            lockedNode.pos.z,
          );
          refreshLinks(idx);
        }
        animate(dtMs);
        // カメラ: 純粋計算の経路へ平滑追従（カタログ再構築の不連続も吸収）
        if (ctx) {
          const energy = lastSpace?.cameraEnergy ?? 0;
          const pose = cameraPose(flight, positions, u.time.value as number, energy);
          tmpPos.set(pose.pos.x, pose.pos.y, pose.pos.z);
          tmpLook.set(pose.look.x, pose.look.y, pose.look.z);
          if (!camInit) {
            camInit = true;
            curCamPos.copy(tmpPos);
            curLook.copy(tmpLook);
          }
          const a = easeAlpha(dtMs, CAM_TAU);
          curCamPos.lerp(tmpPos, a);
          curLook.lerp(tmpLook, a);
          ctx.camera.position.copy(curCamPos);
          ctx.camera.lookAt(curLook);
        }
      } catch (e) {
        // ライブ堅牢性: シーン内例外でレンダループを殺さない（ログは初回のみ）
        if (!errorLogged) {
          errorLogged = true;
          console.error("[vj] latentField update error:", e);
        }
      }
    },
    setDissolve(amount: number) {
      u.dissolve.value = amount;
    },
    setOpacity(amount: number) {
      // クロスフェード: TSL 側は uSceneOp、関係線（LineBasicMaterial）は animate で opacity に反映
      const o = clamp01(amount);
      uSceneOp.value = o;
      sceneOp = o;
    },
    flash() {
      u.flash.value = 1;
    },
    dispose() {
      for (const o of objects) ctx?.root.remove(o);
      for (const d of disposables) d.dispose();
      objects.length = 0;
      disposables.length = 0;
      linkGeo = null;
      linkMat = null;
      hud = null;
      slotId.fill(null);
      slotFading.fill(false);
      tgtAmp.fill(0);
      tgtHeat.fill(0);
      (uNodeAmp.array as number[]).fill(0);
      (uNodeHeat.array as number[]).fill(0);
      history = [];
      catalog = [];
      positions = [];
      catalogDirty = true;
      flight = createFlightState();
      lockSeqSeen = 0;
      lockedNode = null;
      lockedLines = [];
      curLock = 0;
      sceneOp = 1;
      uSceneOp.value = 1;
      hudAccum = 0;
      camInit = false;
      errorLogged = false;
      ctx = null;
      lastSpace = undefined;
      lastState = undefined;
    },
  };
}
