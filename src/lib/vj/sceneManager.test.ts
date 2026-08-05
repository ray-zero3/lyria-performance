import { describe, it, expect } from "vitest";
import {
  advanceFade,
  createSceneManager,
  fadeProgress,
  sceneOpacities,
  sceneVisibilities,
  type FadeTransition,
  type ManagedScene,
} from "./sceneManager";
import type { VisualParams } from "./visualMapping";

function vp(): VisualParams {
  return {
    burst: 0,
    spectrum: new Array<number>(48).fill(0),
    level: 0.5,
    bands: { low: 0.2, mid: 0.3, high: 0.1 },
    colorA: { r: 0.2, g: 0.4, b: 0.9 },
    colorB: { r: 0.8, g: 0.3, b: 0.6 },
    speed: 1,
  };
}

interface Recorder {
  scene: ManagedScene;
  updates: number[];
  dissolves: number[];
  flashes: number;
  opacities: number[];
}
function recorder(): Recorder {
  const r: Recorder = {
    updates: [],
    dissolves: [],
    flashes: 0,
    opacities: [],
    scene: {
      update: (_vp, dt) => r.updates.push(dt),
      setDissolve: (a) => r.dissolves.push(a),
      setOpacity: (a) => r.opacities.push(a),
      flash: () => {
        r.flashes += 1;
      },
    },
  };
  return r;
}

function make(opts: Parameters<typeof createSceneManager>[1] = {}) {
  const a = recorder();
  const b = recorder();
  const c = recorder();
  const m = createSceneManager(
    [
      { id: "a", scene: a.scene },
      { id: "b", scene: b.scene },
      { id: "c", scene: c.scene },
    ],
    opts,
  );
  return { m, a, b, c };
}

describe("sceneManager", () => {
  it("シーン一覧と初期シーン", () => {
    const { m } = make();
    expect(m.ids()).toEqual(["a", "b", "c"]);
    expect(m.current()).toBe("a");
  });
  it("next() は巡回してラップする", () => {
    const { m } = make();
    m.next();
    expect(m.current()).toBe("b");
    m.next();
    expect(m.current()).toBe("c");
    m.next();
    expect(m.current()).toBe("a");
  });
  it("setScene は指定シーンへ。未知IDと同一IDは無視（flash 重複なし）", () => {
    const { m, c } = make();
    m.setScene("c");
    expect(m.current()).toBe("c");
    expect(c.flashes).toBe(1);
    m.setScene("zzz");
    expect(m.current()).toBe("c");
    m.setScene("c");
    expect(c.flashes).toBe(1);
  });
  it("手動切替は新シーンに flash を1回かける（クロスフェード+フラッシュ）", () => {
    const { m, b } = make();
    m.next();
    expect(b.flashes).toBe(1);
    expect(m.flashRemainingMs()).toBeGreaterThan(0);
  });
  it("frame は現在シーンだけを更新する", () => {
    const { m, a, b } = make();
    m.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 16);
    expect(a.updates).toEqual([16]);
    expect(a.dissolves).toHaveLength(1);
    expect(b.updates).toHaveLength(0);
  });
  it("rotating 中は dissolveTarget へ単調に近づく", () => {
    const { m, a } = make();
    for (let i = 0; i < 30; i++) {
      m.frame(vp(), { sessionState: "rotating", dissolveTarget: 0.8 }, 100);
    }
    const ds = a.dissolves;
    expect(ds[ds.length - 1]).toBeGreaterThan(0.7);
    for (let i = 1; i < ds.length; i++) {
      expect(ds[i]).toBeGreaterThanOrEqual(ds[i - 1]);
    }
  });
  it("rotate 完了後は 0 へ戻る（再結晶）", () => {
    const { m } = make({ autoSwitchOnRotate: false });
    for (let i = 0; i < 20; i++) {
      m.frame(vp(), { sessionState: "rotating", dissolveTarget: 1 }, 100);
    }
    expect(m.dissolve()).toBeGreaterThan(0.5);
    for (let i = 0; i < 60; i++) {
      m.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 100);
    }
    expect(m.dissolve()).toBeLessThan(0.05);
  });
  it("rotate 完了で自動的に次シーンへ（フラッシュ無しのシームレス切替）", () => {
    const { m, b } = make({ autoSwitchOnRotate: true });
    m.frame(vp(), { sessionState: "rotating", dissolveTarget: 1 }, 16);
    m.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 16);
    expect(m.current()).toBe("b");
    expect(b.flashes).toBe(0);
  });
  it("autoSwitchOnRotate=false なら rotate 完了でも同一シーン", () => {
    const { m } = make({ autoSwitchOnRotate: false });
    m.frame(vp(), { sessionState: "rotating", dissolveTarget: 1 }, 16);
    m.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 16);
    expect(m.current()).toBe("a");
  });
  it("フラッシュ残時間はフレームで減衰して 0 になる", () => {
    const { m } = make({ flashMs: 100 });
    m.next();
    expect(m.flashRemainingMs()).toBe(100);
    m.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 60);
    expect(m.flashRemainingMs()).toBe(40);
    m.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 60);
    expect(m.flashRemainingMs()).toBe(0);
  });
  it("空のシーン配列は例外", () => {
    expect(() => createSceneManager([])).toThrow();
  });
});

describe("sceneManager: クロスフェード（純粋ロジック）", () => {
  it("advanceFade: dt で進み、fadeMs 到達で null。不正 dt は進めない", () => {
    const t: FadeTransition = { fromIndex: 0, toIndex: 1, elapsedMs: 0 };
    const t2 = advanceFade(t, 100, 300);
    expect(t2).toEqual({ fromIndex: 0, toIndex: 1, elapsedMs: 100 });
    expect(advanceFade(t2, 200, 300)).toBeNull(); // 100+200 >= 300 で完了
    expect(advanceFade(null, 100, 300)).toBeNull();
    expect(advanceFade(t, NaN, 300)?.elapsedMs).toBe(0);
    expect(advanceFade(t, -50, 300)?.elapsedMs).toBe(0);
  });

  it("fadeProgress: 0→1 に単調増加（smoothstep）、遷移なしは 1", () => {
    expect(fadeProgress(null)).toBe(1);
    expect(fadeProgress({ fromIndex: 0, toIndex: 1, elapsedMs: 0 }, 300)).toBe(0);
    expect(fadeProgress({ fromIndex: 0, toIndex: 1, elapsedMs: 150 }, 300)).toBeCloseTo(0.5);
    expect(fadeProgress({ fromIndex: 0, toIndex: 1, elapsedMs: 300 }, 300)).toBe(1);
    let prev = 0;
    for (let e = 0; e <= 300; e += 25) {
      const p = fadeProgress({ fromIndex: 0, toIndex: 1, elapsedMs: e }, 300);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it("sceneOpacities: 遷移中は from 1→0 / to 0→1、他は 0。遷移なしは current のみ 1", () => {
    expect(sceneOpacities(3, 1, null)).toEqual([0, 1, 0]);
    expect(sceneOpacities(3, 1, { fromIndex: 0, toIndex: 1, elapsedMs: 0 }, 300)).toEqual([
      1, 0, 0,
    ]);
    const mid = sceneOpacities(3, 1, { fromIndex: 0, toIndex: 1, elapsedMs: 150 }, 300);
    expect(mid[0]).toBeCloseTo(0.5);
    expect(mid[1]).toBeCloseTo(0.5);
    expect(mid[2]).toBe(0);
    expect(sceneOpacities(3, 1, { fromIndex: 0, toIndex: 1, elapsedMs: 300 }, 300)).toEqual([
      0, 1, 0,
    ]);
  });

  it("sceneVisibilities: 遷移中は from/to の両方が可視、終盤は from が描画から外れる", () => {
    expect(sceneVisibilities(3, 1, null)).toEqual([false, true, false]);
    expect(sceneVisibilities(3, 1, { fromIndex: 0, toIndex: 1, elapsedMs: 150 }, 300)).toEqual([
      true, true, false,
    ]);
    // ほぼ完了 → from の不透明度が EPS を割り、描画から外れる（ムダな描画の回避）
    const tail = sceneVisibilities(3, 1, { fromIndex: 0, toIndex: 1, elapsedMs: 299.99 }, 300);
    expect(tail[0]).toBe(false);
    expect(tail[1]).toBe(true);
  });
});

describe("sceneManager: クロスフェード（manager 統合）", () => {
  it("next() 後は新旧両シーンが可視・更新され、完了で旧シーンが停止・不可視になる", () => {
    const { m, a, b } = make({ fadeMs: 300 });
    m.next(); // a → b
    m.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 100);
    expect(m.isVisible("a")).toBe(true);
    expect(m.isVisible("b")).toBe(true);
    expect(m.isVisible("zzz")).toBe(false); // 未知 id は不可視
    expect(a.updates).toHaveLength(1); // 退出側もフェード中は更新（フリーズ回避）
    expect(b.updates).toHaveLength(1);
    m.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 100);
    // a の不透明度は単調減少、b は単調増加
    for (let i = 1; i < a.opacities.length; i++) {
      expect(a.opacities[i]).toBeLessThanOrEqual(a.opacities[i - 1]);
      expect(b.opacities[i]).toBeGreaterThanOrEqual(b.opacities[i - 1]);
    }
    m.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 200); // 計 400 >= 300 → 完了
    expect(m.isVisible("a")).toBe(false);
    expect(m.isVisible("b")).toBe(true);
    expect(a.opacities[a.opacities.length - 1]).toBe(0);
    expect(b.opacities[b.opacities.length - 1]).toBe(1);
    const aUpdates = a.updates.length;
    m.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 16);
    expect(a.updates).toHaveLength(aUpdates); // 完了後は現在シーンのみ更新
  });

  it("rotate 完了の自動切替でもクロスフェードが走る", () => {
    const { m } = make({ fadeMs: 300, autoSwitchOnRotate: true });
    m.frame(vp(), { sessionState: "rotating", dissolveTarget: 1 }, 16);
    m.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 16);
    expect(m.current()).toBe("b");
    expect(m.isVisible("a")).toBe(true); // フェード中は旧シーンも可視
    expect(m.isVisible("b")).toBe(true);
    m.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 500); // フェード完了
    expect(m.isVisible("a")).toBe(false);
    expect(m.isVisible("b")).toBe(true);
  });
});
