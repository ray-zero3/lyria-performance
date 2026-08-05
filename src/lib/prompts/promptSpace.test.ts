import { describe, it, expect } from "vitest";
import {
  computeWeights,
  normalizedPinWeights,
  morphStep,
  easeInOutCubic,
  makeId,
  defaultPromptSpaceState,
  clampPromptSpaceState,
  addPin,
  movePin,
  removePin,
  updatePinText,
  updatePinRadius,
  moveCursor,
  addTarget,
  removeTarget,
  WEIGHT_THRESHOLD,
  MAX_ACTIVE_PROMPTS,
  MIN_PIN_RADIUS,
  MAX_PIN_RADIUS,
  VJ_OBJECT_KEYS,
  VJ_EFFECT_KEYS,
  defaultVjObjects,
  defaultVjEffects,
  setVjObject,
  setVjEffect,
  type Pin,
  type PromptSpaceState,
} from "./promptSpace";

function pin(id: string, text: string, x: number, y: number, radius = 0.28): Pin {
  return { id, text, x, y, radius };
}

describe("computeWeights", () => {
  it("カーソルがピン直上なら単一ピン weight=1", () => {
    const w = computeWeights([pin("a", "pads", 0.5, 0.5)], { x: 0.5, y: 0.5 });
    expect(w).toHaveLength(1);
    expect(w[0].text).toBe("pads");
    expect(w[0].weight).toBeCloseTo(1, 6);
  });

  it("2ピンの中間で均等ブレンド（Σ=1）", () => {
    const w = computeWeights(
      [pin("a", "left", 0.2, 0.5), pin("b", "right", 0.8, 0.5)],
      { x: 0.5, y: 0.5 },
    );
    expect(w).toHaveLength(2);
    expect(w[0].weight).toBeCloseTo(0.5, 6);
    expect(w[1].weight).toBeCloseTo(0.5, 6);
    expect(w[0].weight + w[1].weight).toBeCloseTo(1, 6);
  });

  it("遠方の near-zero ピンは閾値で除外され残りが再正規化される", () => {
    // 半径小のピンを対角に置く → 正規化重みが閾値未満になり除外
    const w = computeWeights(
      [pin("a", "near", 0.5, 0.5, 0.2), pin("b", "far", 0.0, 0.0, 0.08)],
      { x: 0.5, y: 0.5 },
    );
    expect(w).toHaveLength(1);
    expect(w[0].text).toBe("near");
    expect(w[0].weight).toBeCloseTo(1, 6);
  });

  it("上位 K=6 件に制限され Σ=1", () => {
    // カーソル近傍に距離の異なる 9 ピン
    const pins = Array.from({ length: 9 }, (_, i) =>
      pin(`p${i}`, `t${i}`, 0.5 + i * 0.03, 0.5, 0.4),
    );
    const w = computeWeights(pins, { x: 0.5, y: 0.5 });
    expect(w.length).toBeLessThanOrEqual(MAX_ACTIVE_PROMPTS);
    const sum = w.reduce((s, e) => s + e.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
    // 最近傍が最大重み
    expect(w[0].text).toBe("t0");
  });

  it("空テキストのピンは除外される", () => {
    const w = computeWeights(
      [pin("a", "   ", 0.5, 0.5), pin("b", "keep", 0.6, 0.5)],
      { x: 0.5, y: 0.5 },
    );
    expect(w).toHaveLength(1);
    expect(w[0].text).toBe("keep");
  });

  it("ピン無しは空配列", () => {
    expect(computeWeights([], { x: 0.5, y: 0.5 })).toEqual([]);
  });

  it("全ピンがアンダーフローしても最近傍 weight=1 にフォールバック（無音化防止）", () => {
    // 極小半径×最大距離で exp が 0 に丸まるケースを模す
    const tiny = 1e-4;
    const w = computeWeights(
      [pin("a", "nearest", 0.9, 0.9, tiny), pin("b", "farther", 0.0, 0.0, tiny)],
      { x: 1, y: 1 },
    );
    expect(w).toHaveLength(1);
    expect(w[0].text).toBe("nearest");
    expect(w[0].weight).toBe(1);
  });

  it("閾値定数は 0.02", () => {
    expect(WEIGHT_THRESHOLD).toBe(0.02);
  });

  // 回帰テスト: 同一テキストのピンが複数あると weights に重複 text が入り、
  // keyed each（および Lyria への送信）で破綻していた（control 窓が真っ黒になる実障害）。
  it("同一テキストのピンは1エントリに合算される（text 一意・weight 合算・Σ=1）", () => {
    // 3ピンともカーソルから等距離（d=0.1）× 同半径 → raw が等しく、合算後は 2/3 : 1/3
    const w = computeWeights(
      [
        pin("a", "bright techno", 0.4, 0.5),
        pin("b", "bright techno", 0.6, 0.5),
        pin("c", "ambient", 0.5, 0.4),
      ],
      { x: 0.5, y: 0.5 },
    );
    const texts = w.map((e) => e.text);
    expect(new Set(texts).size).toBe(texts.length); // text は必ず一意
    expect(w).toHaveLength(2);
    const bt = w.find((e) => e.text === "bright techno");
    const am = w.find((e) => e.text === "ambient");
    expect(bt?.weight).toBeCloseTo(2 / 3, 6);
    expect(am?.weight).toBeCloseTo(1 / 3, 6);
  });

  it("trim 後に同一になるテキストもマージされる", () => {
    const w = computeWeights(
      [pin("a", "bright techno", 0.4, 0.5), pin("b", "  bright techno  ", 0.6, 0.5)],
      { x: 0.5, y: 0.5 },
    );
    expect(w).toHaveLength(1);
    expect(w[0].text).toBe("bright techno");
    expect(w[0].weight).toBeCloseTo(1, 6);
  });
});

describe("normalizedPinWeights", () => {
  it("ピン index に対応した正規化重み（Σ=1）を返す", () => {
    const pins = [pin("a", "l", 0.2, 0.5), pin("b", "r", 0.8, 0.5)];
    const w = normalizedPinWeights(pins, { x: 0.5, y: 0.5 });
    expect(w).toHaveLength(2);
    expect(w[0]).toBeCloseTo(0.5, 6);
    expect(w[1]).toBeCloseTo(0.5, 6);
  });

  it("空テキストのピンは重み 0（他は正規化）", () => {
    const pins = [pin("a", "", 0.5, 0.5), pin("b", "x", 0.5, 0.5)];
    const w = normalizedPinWeights(pins, { x: 0.5, y: 0.5 });
    expect(w[0]).toBe(0);
    expect(w[1]).toBeCloseTo(1, 6);
  });

  it("ピン無しは空配列・全滅時は全て 0", () => {
    expect(normalizedPinWeights([], { x: 0, y: 0 })).toEqual([]);
    const tiny = 1e-4;
    const w = normalizedPinWeights([pin("a", "x", 0, 0, tiny)], { x: 1, y: 1 });
    expect(w).toEqual([0]);
  });
});

describe("morphStep", () => {
  it("progress=0 でカーソル据え置き", () => {
    const c = morphStep({ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.8 }, 0);
    expect(c).toEqual({ x: 0.1, y: 0.2 });
  });
  it("progress=1 でターゲット一致", () => {
    const c = morphStep({ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.8 }, 1);
    expect(c.x).toBeCloseTo(0.9, 9);
    expect(c.y).toBeCloseTo(0.8, 9);
  });
  it("中間で線形補間", () => {
    const c = morphStep({ x: 0, y: 0 }, { x: 1, y: 0.5 }, 0.5);
    expect(c.x).toBeCloseTo(0.5, 9);
    expect(c.y).toBeCloseTo(0.25, 9);
  });
  it("progress は 0..1 にクランプ", () => {
    expect(morphStep({ x: 0, y: 0 }, { x: 1, y: 1 }, 2).x).toBe(1);
    expect(morphStep({ x: 0, y: 0 }, { x: 1, y: 1 }, -1).x).toBe(0);
  });
});

describe("easeInOutCubic", () => {
  it("端点は 0/1、中点は 0.5、単調", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 9);
    expect(easeInOutCubic(0.25)).toBeLessThan(0.25); // 序盤はゆっくり
    expect(easeInOutCubic(0.75)).toBeGreaterThan(0.75); // 終盤もゆっくり（対称）
  });
});

describe("immutable CRUD", () => {
  function base(): PromptSpaceState {
    return {
      pins: [pin("a", "one", 0.2, 0.2), pin("b", "two", 0.8, 0.8)],
      cursor: { x: 0.5, y: 0.5 },
      targets: [{ id: "t1", name: "intro", x: 0.1, y: 0.1 }],
    };
  }

  it("addPin は元 state を変更せず追加後の新 state を返す", () => {
    const s = base();
    const next = addPin(s, pin("c", "three", 0.5, 0.5));
    expect(s.pins).toHaveLength(2);
    expect(next.pins).toHaveLength(3);
    expect(next).not.toBe(s);
  });

  it("movePin は座標を 0..1 にクランプして更新（元は不変）", () => {
    const s = base();
    const next = movePin(s, "a", 1.5, -0.5);
    expect(next.pins[0].x).toBe(1);
    expect(next.pins[0].y).toBe(0);
    expect(s.pins[0].x).toBe(0.2);
  });

  it("removePin / updatePinText / updatePinRadius", () => {
    const s = base();
    expect(removePin(s, "a").pins.map((p) => p.id)).toEqual(["b"]);
    expect(updatePinText(s, "b", "changed").pins[1].text).toBe("changed");
    const r = updatePinRadius(s, "b", 99);
    expect(r.pins[1].radius).toBe(MAX_PIN_RADIUS);
    expect(updatePinRadius(s, "b", 0).pins[1].radius).toBe(MIN_PIN_RADIUS);
    expect(s.pins[1].text).toBe("two"); // 元は不変
  });

  it("moveCursor / addTarget / removeTarget", () => {
    const s = base();
    const c = moveCursor(s, 2, -1);
    expect(c.cursor).toEqual({ x: 1, y: 0 });
    expect(s.cursor.x).toBe(0.5);
    const t = addTarget(s, { id: "t2", name: "drop", x: 0.9, y: 0.9 });
    expect(t.targets).toHaveLength(2);
    expect(removeTarget(t, "t1").targets.map((x) => x.id)).toEqual(["t2"]);
  });

  it("存在しない id への操作は同等の state を返す（throw しない）", () => {
    const s = base();
    expect(movePin(s, "zzz", 0.5, 0.5).pins).toEqual(s.pins);
    expect(removePin(s, "zzz").pins).toHaveLength(2);
  });
});

describe("makeId / default / clamp", () => {
  it("makeId は prefix 付きで毎回異なる", () => {
    const a = makeId("pin");
    const b = makeId("pin");
    expect(a.startsWith("pin")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("defaultPromptSpaceState はスターターピンと中央カーソル", () => {
    const s = defaultPromptSpaceState();
    expect(s.pins.length).toBeGreaterThanOrEqual(2);
    expect(s.cursor).toEqual({ x: 0.5, y: 0.5 });
    expect(s.targets).toEqual([]);
    for (const p of s.pins) expect(p.text.trim().length).toBeGreaterThan(0);
  });

  it("clampPromptSpaceState: 非オブジェクトは default、値は防御的にクランプ", () => {
    expect(clampPromptSpaceState(null)).toEqual(defaultPromptSpaceState());
    expect(clampPromptSpaceState("junk")).toEqual(defaultPromptSpaceState());
    const dirty = {
      pins: [{ id: 7, text: 42, x: 9, y: -3, radius: 100 }],
      cursor: { x: "a", y: 0.7 },
      targets: [{ id: null, name: 8, x: 2, y: 2 }],
    };
    const s = clampPromptSpaceState(dirty);
    expect(s.pins).toHaveLength(1);
    expect(typeof s.pins[0].id).toBe("string");
    expect(typeof s.pins[0].text).toBe("string");
    expect(s.pins[0].x).toBe(1);
    expect(s.pins[0].y).toBe(0);
    expect(s.pins[0].radius).toBe(MAX_PIN_RADIUS);
    expect(s.cursor.x).toBe(0); // 非数値 → 0
    expect(s.cursor.y).toBe(0.7);
    expect(s.targets[0].x).toBe(1);
    expect(typeof s.targets[0].name).toBe("string");
  });

  it("clampPromptSpaceState は vjObjects/vjEffects を防御整形（bool 化・clamp01・未指定デフォルト）", () => {
    const dirty = {
      pins: [],
      cursor: { x: 0.5, y: 0.5 },
      targets: [],
      vjObjects: { horizon: true, junk: true },
      vjEffects: { glitch: 5, split: -1, rgbShift: "a", bloom: 0.5 },
    };
    const s = clampPromptSpaceState(dirty);
    // 未知キー破棄・厳密 bool 化（horizon のみ）
    expect(s.vjObjects).toEqual({ horizon: true });
    expect(s.vjEffects).toEqual({
      glitch: 1,
      split: 0,
      rgbShift: 0,
      bloom: 0.5,
      scanline: 0,
      timemachine: 0,
      blob: 0,
    });
    // 未指定はデフォルト（旧保存データの後方互換）
    const s2 = clampPromptSpaceState({ pins: [], cursor: {}, targets: [] });
    expect(s2.vjObjects).toEqual(defaultVjObjects());
    expect(s2.vjEffects).toEqual(defaultVjEffects());
  });

  it("clampPromptSpaceState: 過剰なピン/ターゲットは上限で切る", () => {
    const many = {
      pins: Array.from({ length: 100 }, (_, i) => ({
        id: `p${i}`, text: "x", x: 0.5, y: 0.5, radius: 0.2,
      })),
      cursor: { x: 0.5, y: 0.5 },
      targets: Array.from({ length: 100 }, (_, i) => ({
        id: `t${i}`, name: "n", x: 0.5, y: 0.5,
      })),
    };
    const s = clampPromptSpaceState(many);
    expect(s.pins.length).toBeLessThanOrEqual(32);
    expect(s.targets.length).toBeLessThanOrEqual(16);
  });

  it("clampPromptSpaceState: リクエスト由来ピンの nickname/tMs を往復保持、通常ピンは付与しない", () => {
    const s = clampPromptSpaceState({
      pins: [
        { id: "req-1", text: "night drive", x: 0.5, y: 0.5, radius: 0.28, nickname: "rei", tMs: 1234567890 },
        { id: "p-2", text: "pads", x: 0.2, y: 0.2, radius: 0.28 },
      ],
      cursor: { x: 0.5, y: 0.5 },
      targets: [],
    });
    expect(s.pins[0].nickname).toBe("rei");
    expect(s.pins[0].tMs).toBe(1234567890);
    // 通常ピンには nickname/tMs キーを付けない
    expect("nickname" in s.pins[1]).toBe(false);
    expect("tMs" in s.pins[1]).toBe(false);
    // 不正な tMs（非数）は破棄
    const s2 = clampPromptSpaceState({
      pins: [{ id: "x", text: "t", x: 0.5, y: 0.5, radius: 0.28, nickname: 5, tMs: "no" }],
      cursor: {},
      targets: [],
    });
    expect("nickname" in s2.pins[0]).toBe(false); // nickname は string のみ
    expect("tMs" in s2.pins[0]).toBe(false);
  });
});

describe("M8 vjObjects / vjEffects", () => {
  it("defaultPromptSpaceState は全オブジェクト false・全エフェクト 0", () => {
    const s = defaultPromptSpaceState();
    for (const k of VJ_OBJECT_KEYS) expect(s.vjObjects?.[k]).toBe(false);
    for (const k of VJ_EFFECT_KEYS) expect(s.vjEffects?.[k]).toBe(0);
  });

  it("setVjObject は immutable に ON/OFF を設定（未指定 state にも安全）", () => {
    const s = defaultPromptSpaceState();
    const next = setVjObject(s, "horizon", true);
    expect(next.vjObjects?.horizon).toBe(true);
    expect(s.vjObjects?.horizon).toBe(false); // 元は不変
    expect(next).not.toBe(s);
    const legacy = { ...s, vjObjects: undefined }; // 旧保存データ相当
    expect(setVjObject(legacy, "horizon", true).vjObjects?.horizon).toBe(true);
  });

  it("setVjEffect は clamp01 で immutable に設定", () => {
    const s = defaultPromptSpaceState();
    expect(setVjEffect(s, "glitch", 1.5).vjEffects?.glitch).toBe(1);
    expect(setVjEffect(s, "bloom", -3).vjEffects?.bloom).toBe(0);
    expect(setVjEffect(s, "split", 0.4).vjEffects?.split).toBeCloseTo(0.4, 9);
    expect(s.vjEffects?.glitch).toBe(0); // 元は不変
  });
});
