import { describe, it, expect } from "vitest";
import { loadPromptSpace, savePromptSpace, PROMPT_SPACE_KEY, type StorageLike } from "./persistence";
import { defaultPromptSpaceState, type PromptSpaceState } from "./promptSpace";

function makeFakeStorage(): StorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, v);
    },
  };
}

describe("promptSpace persistence", () => {
  it("save → load で round-trip する", () => {
    const st = makeFakeStorage();
    const state: PromptSpaceState = {
      pins: [{ id: "a", text: "pads", x: 0.3, y: 0.4, radius: 0.2 }],
      cursor: { x: 0.6, y: 0.7 },
      targets: [{ id: "t", name: "drop", x: 0.9, y: 0.1 }],
      cameraEnergy: 0.4,
      floorReactive: true,
      // M8: VJ 展開（clamp は全キー埋めで出力するため round-trip は全キー指定）
      vjObjects: { horizon: true },
      vjEffects: {
        glitch: 0.3,
        split: 0,
        rgbShift: 0.8,
        bloom: 0.5,
        scanline: 1,
        timemachine: 0.4,
        blob: 0.7,
      },
      constellationLines: 0.6,
    };
    savePromptSpace(state, st);
    expect(st.store.has(PROMPT_SPACE_KEY)).toBe(true);
    const loaded = loadPromptSpace(st);
    expect(loaded).toEqual(state);
  });

  it("保存が無ければ default を返す", () => {
    expect(loadPromptSpace(makeFakeStorage())).toEqual(defaultPromptSpaceState());
  });

  it("破損 JSON は default にフォールバック", () => {
    const st = makeFakeStorage();
    st.store.set(PROMPT_SPACE_KEY, "{not json");
    expect(loadPromptSpace(st)).toEqual(defaultPromptSpaceState());
  });

  it("storage 無し（null）でも throw せず default / no-op", () => {
    expect(loadPromptSpace(null)).toEqual(defaultPromptSpaceState());
    expect(() => savePromptSpace(defaultPromptSpaceState(), null)).not.toThrow();
  });

  it("不正な保存値は clamp されて返る", () => {
    const st = makeFakeStorage();
    st.store.set(
      PROMPT_SPACE_KEY,
      JSON.stringify({ pins: [{ id: "a", text: "x", x: 5, y: -5, radius: 0.2 }], cursor: {}, targets: [] }),
    );
    const s = loadPromptSpace(st);
    expect(s.pins[0].x).toBe(1);
    expect(s.pins[0].y).toBe(0);
  });
});
