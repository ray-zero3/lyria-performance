import { describe, it, expect } from "vitest";
import { createSceneBundle, DEFAULT_SCENE_ID } from "./index";
import { createSceneManager } from "../sceneManager";
import type { VisualParams } from "../visualMapping";

function vp(): VisualParams {
  return {
    burst: 0,
    spectrum: new Array<number>(48).fill(0),
    level: 0,
    bands: { low: 0, mid: 0, high: 0 },
    colorA: { r: 0, g: 0, b: 0 },
    colorB: { r: 0, g: 0, b: 0 },
    speed: 1,
  };
}

describe("scene bundle (promptSpace + latentField)", () => {
  it("promptSpace（既定）→ latentField の順で 2 シーンを返す", () => {
    const { impls, promptSpace, latentField } = createSceneBundle();
    expect(impls.map((s) => s.id)).toEqual(["promptSpace", "latentField"]);
    expect(impls[0]).toBe(promptSpace);
    expect(impls[1]).toBe(latentField);
    expect(DEFAULT_SCENE_ID).toBe("promptSpace");
    for (const s of impls) s.dispose();
  });

  it("sceneManager: 既定 promptSpace、next()（scene_next 相当）で latentField ↔ promptSpace を循環", () => {
    const { impls } = createSceneBundle();
    const manager = createSceneManager(impls.map((s) => ({ id: s.id, scene: s })));
    expect(manager.current()).toBe("promptSpace");
    manager.next();
    expect(manager.current()).toBe("latentField");
    manager.next();
    expect(manager.current()).toBe("promptSpace");
    for (const s of impls) s.dispose();
  });

  it("クロスフェード: 遷移中は新旧両シーンが可視、完了後は現在シーンのみ可視", () => {
    const { impls } = createSceneBundle();
    const manager = createSceneManager(
      impls.map((s) => ({ id: s.id, scene: s })),
      { fadeMs: 200 },
    );
    manager.next(); // promptSpace → latentField（実シーンの setOpacity を通す）
    manager.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 100);
    expect(manager.isVisible("promptSpace")).toBe(true);
    expect(manager.isVisible("latentField")).toBe(true);
    manager.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 300); // フェード完了
    expect(manager.isVisible("promptSpace")).toBe(false);
    expect(manager.isVisible("latentField")).toBe(true);
    for (const s of impls) s.dispose();
  });

  it("rotate 完了（rotating → playing）で自動的に次シーンへ切り替わる", () => {
    const { impls } = createSceneBundle();
    const manager = createSceneManager(
      impls.map((s) => ({ id: s.id, scene: s })),
      { autoSwitchOnRotate: true },
    );
    manager.frame(vp(), { sessionState: "rotating", dissolveTarget: 1 }, 16.7);
    manager.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 16.7);
    expect(manager.current()).toBe("latentField");
    manager.frame(vp(), { sessionState: "rotating", dissolveTarget: 1 }, 16.7);
    manager.frame(vp(), { sessionState: "playing", dissolveTarget: 0 }, 16.7);
    expect(manager.current()).toBe("promptSpace");
    for (const s of impls) s.dispose();
  });
});
