import { describe, it, expect } from "vitest";
import * as THREE from "three/webgpu";
import {
  accumulateHistory,
  buildAnalysisLines,
  buildNodeCatalog,
  cameraPose,
  createFlightState,
  hashString,
  hash01,
  nearestIndices,
  nodePosition,
  revealLines,
  selectNextTarget,
  stepFlight,
  ANALYZE_MS,
  CRUISE_MS,
  FIELD_Y_SQUASH,
  HISTORY_MAX,
  HUD_TEXT_MAX,
  KIND_RADIUS,
  LOCK_MS,
  MAX_NODES,
  MIN_NODES,
  RADIUS_JITTER,
  RELEASE_MS,
  type FlightState,
  type LatentNode,
  type Vec3Like,
} from "./latentFieldLogic";
import {
  createLatentFieldScene,
  KIND_HEAT,
  HUD_HEIGHT,
  RETICLE_HALF,
  RETICLE_LINE,
  RETICLE_SCALE,
} from "./latentField";
import { defaultHubState } from "$lib/telemetry/contract";
import { defaultPromptSpaceState, type PromptSpaceState } from "$lib/prompts/promptSpace";
import type { VisualParams } from "../visualMapping";

// ---- 純粋ロジック ----

describe("latentFieldLogic: hash / 配置", () => {
  it("hashString は決定的で、異なる文字列で異なる値", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
    expect(hashString("")).toBeTypeOf("number");
  });

  it("hash01 は 0..1 に収まる", () => {
    for (let i = 0; i < 200; i++) {
      const v = hash01(hashString(`seed-${i}`));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("nodePosition は決定的で、種別の半径殻（ジッタ込み）に収まる", () => {
    const a = nodePosition("pin:x", "pin");
    const b = nodePosition("pin:x", "pin");
    expect(a).toEqual(b);
    for (const kind of ["request", "pin", "target", "history", "latent"] as const) {
      for (let i = 0; i < 20; i++) {
        const p = nodePosition(`node-${i}`, kind);
        // y は FIELD_Y_SQUASH でつぶされているので復元して球半径を評価
        const r = Math.sqrt(p.x * p.x + (p.y / FIELD_Y_SQUASH) ** 2 + p.z * p.z);
        const base = KIND_RADIUS[kind];
        expect(r).toBeGreaterThanOrEqual(base * (1 - RADIUS_JITTER / 2) - 1e-9);
        expect(r).toBeLessThanOrEqual(base * (1 + RADIUS_JITTER / 2) + 1e-9);
      }
    }
  });
});

describe("latentFieldLogic: accumulateHistory", () => {
  it("新規プロンプトを追記し、既出テキストは重複させない", () => {
    const h1 = accumulateHistory([], [{ text: "warm pads", weight: 1 }], 1000);
    expect(h1).toEqual([{ text: "warm pads", tMs: 1000 }]);
    const h2 = accumulateHistory(h1, [{ text: "warm pads", weight: 0.5 }], 2000);
    expect(h2).toBe(h1); // 変化なし → 同一参照
    const h3 = accumulateHistory(h2, [{ text: "driving techno", weight: 0.5 }], 3000);
    expect(h3.map((e) => e.text)).toEqual(["warm pads", "driving techno"]);
  });

  it("空/空白テキストは無視する", () => {
    const h = accumulateHistory([], [{ text: "  ", weight: 1 }, { text: "", weight: 1 }], 0);
    expect(h).toEqual([]);
  });

  it("上限を超えたら古い順に破棄する", () => {
    let h: readonly { text: string; tMs: number }[] = [];
    for (let i = 0; i < HISTORY_MAX + 5; i++) {
      h = accumulateHistory(h, [{ text: `p-${i}`, weight: 1 }], i);
    }
    expect(h).toHaveLength(HISTORY_MAX);
    expect(h[0].text).toBe("p-5"); // 先頭 5 件が破棄されている
    expect(h[h.length - 1].text).toBe(`p-${HISTORY_MAX + 4}`);
  });
});

describe("latentFieldLogic: buildNodeCatalog", () => {
  const spaceWith = (over: Partial<PromptSpaceState>): PromptSpaceState => ({
    ...defaultPromptSpaceState(),
    ...over,
  });

  it("null 空間＋空履歴でも MIN_NODES の UNCHARTED ノードを返す（飛行が成立）", () => {
    const nodes = buildNodeCatalog({ space: null, history: [] });
    expect(nodes.length).toBeGreaterThanOrEqual(MIN_NODES);
    expect(nodes.every((n) => n.kind === "latent")).toBe(true);
    expect(nodes[0].text).toMatch(/^UNCHARTED-/);
  });

  it("nickname 付きピンは request、通常ピンは pin、targets は target になる", () => {
    const space = spaceWith({
      pins: [
        { id: "a", text: "warm pads", x: 0.2, y: 0.3, radius: 0.3 },
        { id: "b", text: "hard techno", x: 0.8, y: 0.7, radius: 0.3, nickname: "yuki", tMs: 0 },
      ],
      targets: [{ id: "t1", name: "T1", x: 0.5, y: 0.5 }],
    });
    const nodes = buildNodeCatalog({ space, history: [] });
    const req = nodes.find((n) => n.kind === "request");
    const pin = nodes.find((n) => n.kind === "pin");
    const tgt = nodes.find((n) => n.kind === "target");
    expect(req?.text).toBe("hard techno");
    expect(req?.sub).toMatch(/^by yuki · \d{2}:\d{2}$/);
    expect(pin?.text).toBe("warm pads");
    expect(tgt?.text).toBe("T1");
    // リクエストが先頭（優先度最上位）
    expect(nodes[0].kind).toBe("request");
  });

  it("履歴は history ノード（新しい順）、ピン 2 つ以上で latent ブレンドが生じる", () => {
    const space = spaceWith({
      pins: [
        { id: "a", text: "ambient", x: 0.2, y: 0.3, radius: 0.3 },
        { id: "b", text: "jazz", x: 0.8, y: 0.7, radius: 0.3 },
      ],
      targets: [],
    });
    const history = [
      { text: "old prompt", tMs: 1000 },
      { text: "new prompt", tMs: 2000 },
    ];
    const nodes = buildNodeCatalog({ space, history });
    const hists = nodes.filter((n) => n.kind === "history");
    expect(hists.map((n) => n.text)).toEqual(["new prompt", "old prompt"]); // 新しい順
    expect(hists[0].sub).toMatch(/^played \d{2}:\d{2}$/);
    const blend = nodes.find((n) => n.kind === "latent");
    expect(blend?.text).toBe("ambient × jazz");
    expect(blend?.sub).toBe("interpolation field");
  });

  it("空テキストのピンは無視され、maxNodes と id 一意性が守られる", () => {
    const pins = Array.from({ length: 32 }, (_, i) => ({
      id: `p${i}`,
      text: i % 2 === 0 ? `prompt ${i}` : "",
      x: 0.5,
      y: 0.5,
      radius: 0.3,
    }));
    const history = Array.from({ length: 24 }, (_, i) => ({ text: `h${i}`, tMs: i }));
    const nodes = buildNodeCatalog({ space: spaceWith({ pins, targets: [] }), history });
    expect(nodes.length).toBeLessThanOrEqual(MAX_NODES);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
    expect(nodes.some((n) => n.text === "")).toBe(false);
  });
});

describe("latentFieldLogic: 飛行状態機械", () => {
  const positions: Vec3Like[] = [
    { x: 0, y: 0, z: 0 },
    { x: 5, y: 0, z: 0 },
    { x: 0, y: 0, z: 5 },
    { x: -5, y: 0, z: -5 },
  ];
  const randOf = (values: number[]): (() => number) => {
    let i = 0;
    return () => values[i++ % values.length];
  };

  it("cruise → lock（lockSeq+1）→ analyze → release → cruise を巡回する", () => {
    let s = createFlightState();
    expect(s.phase).toBe("cruise");
    s = stepFlight(s, CRUISE_MS + 100, positions, randOf([0.9]));
    expect(s.phase).toBe("lock");
    expect(s.phaseMs).toBeCloseTo(100); // 余剰は持ち越し
    expect(s.lockSeq).toBe(1);
    s = stepFlight(s, LOCK_MS, positions, randOf([0.9]));
    expect(s.phase).toBe("analyze");
    s = stepFlight(s, ANALYZE_MS, positions, randOf([0.9]));
    expect(s.phase).toBe("release");
    const before = s.targetIndex;
    s = stepFlight(s, RELEASE_MS, positions, randOf([0.9]));
    expect(s.phase).toBe("cruise");
    expect(s.fromIndex).toBe(before); // 出発点 = 直前のロック対象
    expect(s.lockSeq).toBe(1); // release→cruise では増えない
  });

  it("巨大 dt で複数位相をまたいでも壊れない", () => {
    const s = stepFlight(createFlightState(), CRUISE_MS + LOCK_MS + 50, positions, randOf([0.5]));
    expect(s.phase).toBe("analyze");
    expect(s.phaseMs).toBeCloseTo(50);
  });

  it("positions が空なら state を据え置き、不正 dt では進まない", () => {
    const s = createFlightState();
    expect(stepFlight(s, 1000, [], randOf([0.5]))).toBe(s);
    expect(stepFlight(s, NaN, positions, randOf([0.5])).phaseMs).toBe(0);
    expect(stepFlight(s, -50, positions, randOf([0.5])).phaseMs).toBe(0);
  });

  it("selectNextTarget: current を避け、候補中で最遠のノードを選ぶ", () => {
    // rand が 0.30(→index1), 0.55(→index2), 0.80(→index3), 0.10(→index0=current) を返す
    const next = selectNextTarget(0, positions, randOf([0.3, 0.55, 0.8, 0.1]));
    // index1 は距離 25、index2 は 25、index3 は 50 → 最遠の 3
    expect(next).toBe(3);
    expect(selectNextTarget(0, [{ x: 0, y: 0, z: 0 }], randOf([0.5]))).toBe(0); // 単一ノード
    // 全候補が current → フォールバックで次の index
    expect(selectNextTarget(1, positions, randOf([0.26]))).not.toBe(1);
  });
});

describe("latentFieldLogic: cameraPose", () => {
  const positions: Vec3Like[] = [
    { x: 2, y: 0.5, z: -1 },
    { x: -4, y: -0.4, z: 3 },
    { x: 1, y: 1.2, z: 5 },
  ];
  const tSec = 12.34;
  const energy = 0.6;
  const poseOf = (phase: FlightState["phase"], phaseMs: number): ReturnType<typeof cameraPose> =>
    cameraPose(
      { phase, phaseMs, fromIndex: 0, targetIndex: 1, lockSeq: 1 },
      positions,
      tSec,
      energy,
    );
  const dist = (a: Vec3Like, b: Vec3Like): number =>
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  it("位相境界でカメラ位置が連続する（cruise→lock→analyze→release→次 cruise）", () => {
    expect(dist(poseOf("cruise", CRUISE_MS).pos, poseOf("lock", 0).pos)).toBeLessThan(1e-9);
    expect(dist(poseOf("lock", LOCK_MS).pos, poseOf("analyze", 0).pos)).toBeLessThan(1e-9);
    expect(dist(poseOf("analyze", ANALYZE_MS).pos, poseOf("release", 0).pos)).toBeLessThan(1e-9);
    // release 完了 → 次 cruise（from=旧 target）の始点
    const releaseEnd = poseOf("release", RELEASE_MS).pos;
    const nextCruise = cameraPose(
      { phase: "cruise", phaseMs: 0, fromIndex: 1, targetIndex: 2, lockSeq: 1 },
      positions,
      tSec,
      energy,
    ).pos;
    expect(dist(releaseEnd, nextCruise)).toBeLessThan(1e-9);
  });

  it("lock/analyze 中の注視点はターゲットノードに一致する", () => {
    expect(poseOf("analyze", 1000).look).toEqual(positions[1]);
    expect(poseOf("lock", 500).look).toEqual(positions[1]);
  });

  it("positions が空でも有限値のフォールバック経路を返す", () => {
    const p = cameraPose(createFlightState(), [], 5, 0);
    for (const v of [p.pos.x, p.pos.y, p.pos.z, p.look.x, p.look.y, p.look.z]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("全位相で有限値を返す（index が範囲外でもクランプ）", () => {
    for (const phase of ["cruise", "lock", "analyze", "release"] as const) {
      const p = cameraPose(
        { phase, phaseMs: 100, fromIndex: 10, targetIndex: 99, lockSeq: 1 },
        positions,
        tSec,
        energy,
      );
      for (const v of [p.pos.x, p.pos.y, p.pos.z, p.look.x, p.look.y, p.look.z]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});

describe("latentFieldLogic: 解析 HUD テキスト", () => {
  const node: LatentNode = {
    id: "req:abc",
    kind: "request",
    text: "hard techno",
    sub: "by yuki · 23:41",
    pos: { x: 1.2, y: -0.4, z: 2.1 },
  };

  it("buildAnalysisLines はミニマル 2 行（種別+ロック番号+由来 / プロンプト本文）", () => {
    const lines = buildAnalysisLines(node, 3, 12);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("REQUEST 03/12 · by yuki · 23:41");
    expect(lines[1]).toBe('"hard techno"');
  });

  it("長いテキストは HUD_TEXT_MAX で省略、sub 無しは種別行のみ", () => {
    const long: LatentNode = {
      id: "x",
      kind: "latent",
      text: "a".repeat(HUD_TEXT_MAX + 20),
      sub: "",
      pos: { x: 0, y: 0, z: 0 },
    };
    const lines = buildAnalysisLines(long, 1, 1);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("LATENT 01/01");
    expect(lines[1].length).toBeLessThanOrEqual(HUD_TEXT_MAX + 2); // 引用符込み
    expect(lines[1]).toContain("…");
  });

  it("revealLines は経過時間に応じて段階的に開示し、十分な時間で全行になる", () => {
    const lines = ["ABCDE", "FGHIJ"];
    expect(revealLines(lines, 0, 10)).toEqual([]);
    expect(revealLines(lines, 300, 10)).toEqual(["ABC"]); // 0.3s × 10cps = 3 文字
    expect(revealLines(lines, 700, 10)).toEqual(["ABCDE", "FG"]);
    expect(revealLines(lines, 60_000, 10)).toEqual(lines);
    expect(revealLines(lines, -100, 10)).toEqual([]); // 不正値は空
  });
});

describe("latentFieldLogic: nearestIndices", () => {
  const positions: Vec3Like[] = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 3, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
  ];

  it("自身を除き距離昇順で最大 k 個返す", () => {
    expect(nearestIndices(positions, 0, 2)).toEqual([1, 3]);
    expect(nearestIndices(positions, 0, 10)).toEqual([1, 3, 2]);
  });

  it("center が範囲外/空配列なら空を返す", () => {
    expect(nearestIndices(positions, -1, 2)).toEqual([]);
    expect(nearestIndices(positions, 4, 2)).toEqual([]);
    expect(nearestIndices([], 0, 2)).toEqual([]);
  });
});

// ---- シーン本体（TSL smoke。GPU 不要） ----

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

describe("latentField scene (TSL smoke)", () => {
  it("init/update/setDissolve/flash/dispose が throw しない", () => {
    const scene = createLatentFieldScene();
    expect(scene.id).toBe("latentField");
    const root = new THREE.Group();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 60);
    scene.init({ root, camera });
    const sprite = root.children.find((o) => (o as THREE.Sprite).isSprite) as
      | THREE.Sprite
      | undefined;
    expect(sprite).toBeDefined();
    expect((sprite as THREE.Sprite).count).toBeGreaterThan(1000);
    for (let i = 0; i < 5; i++) scene.update(vp(), 16.7);
    // カメラが飛行経路で更新されている（有限値）
    expect(Number.isFinite(camera.position.x)).toBe(true);
    scene.setDissolve(0.8);
    // クロスフェード用の不透明度制御（0..1 と範囲外）が throw しない
    scene.setOpacity?.(0.5);
    scene.update(vp(), 16.7);
    scene.setOpacity?.(0);
    scene.setOpacity?.(2); // clamp01 で 1 に丸められる
    scene.flash();
    scene.update(vp(), 16.7);
    scene.dispose();
    expect(root.children).toHaveLength(0);
  });

  it("setPromptSpace / setHubState（state / null / 同一参照）が throw せず反映される", () => {
    const scene = createLatentFieldScene();
    const root = new THREE.Group();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 60);
    scene.init({ root, camera });
    const space = defaultPromptSpaceState();
    scene.setPromptSpace(space);
    scene.setPromptSpace(space); // 同一参照は no-op
    const state = defaultHubState();
    scene.setHubState(state);
    scene.setHubState(state); // 同一参照は no-op
    scene.update(vp(), 16.7);
    // プロンプト履歴が入った新しい state → カタログ再構築が走る
    scene.setHubState({
      ...state,
      prompts: [{ text: "driving techno", weight: 1 }],
    });
    scene.update(vp(), 16.7);
    scene.setPromptSpace(null); // last-known 未受信でも安全
    scene.update(vp(), 16.7);
    scene.dispose();
    expect(root.children).toHaveLength(0);
  });

  it("ロックオン周期（cruise→lock→analyze→release）を跨いで update しても throw しない", () => {
    const scene = createLatentFieldScene();
    const root = new THREE.Group();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 60);
    scene.init({ root, camera });
    scene.setPromptSpace(defaultPromptSpaceState());
    // 大きな dt で全位相を複数周（ロック確定・HUD 組み立て・関係線張り替えを通過）
    for (let i = 0; i < 12; i++) scene.update(vp(), 3000);
    expect(Number.isFinite(camera.position.x)).toBe(true);
    scene.dispose();
    expect(root.children).toHaveLength(0);
  });
});

describe("latentField scene: KIND_HEAT", () => {
  it("リクエスト > ピン > ターゲット > 履歴 > 潜在 の順で熱量が下がる", () => {
    expect(KIND_HEAT.request).toBeGreaterThan(KIND_HEAT.pin);
    expect(KIND_HEAT.pin).toBeGreaterThan(KIND_HEAT.target);
    expect(KIND_HEAT.target).toBeGreaterThan(KIND_HEAT.history);
    expect(KIND_HEAT.history).toBeGreaterThan(KIND_HEAT.latent);
  });
});

describe("latentField scene: レティクル/HUD 定数（静的・細線・小型）", () => {
  it("レティクルの細線フレームがスプライト UV 内に収まる", () => {
    expect(RETICLE_SCALE).toBeGreaterThan(0);
    expect(RETICLE_LINE).toBeGreaterThan(0);
    expect(RETICLE_LINE).toBeLessThan(0.05); // 細線（UV 半幅）
    expect(RETICLE_HALF + RETICLE_LINE).toBeLessThanOrEqual(0.5); // フレームがはみ出ない
  });

  it("HUD は小型表示（旧 0.24 から縮小されている）", () => {
    expect(HUD_HEIGHT).toBeGreaterThan(0);
    expect(HUD_HEIGHT).toBeLessThanOrEqual(0.15);
  });
});
