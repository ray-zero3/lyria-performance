import { describe, it, expect } from "vitest";
import { createVjStore } from "./store";
import { defaultHubState } from "$lib/telemetry/contract";

function frame(seq: number, level = 0.5) {
  return {
    tMs: seq * 16,
    seq,
    audio: {
      level,
      peak: level,
      bands: { low: 0, mid: 0, high: 0 },
      spectrum: [],
      waveform: [],
      onset: 0,
    },
  };
}

describe("vj store", () => {
  it("starts with default state and zero frame", () => {
    const s = createVjStore();
    const snap = s.snapshot();
    expect(snap.state.session.state).toBe("idle");
    expect(snap.frame.seq).toBe(0);
    expect(snap.events.length).toBe(0);
  });

  it("applies newer frames and ignores stale seq", () => {
    const s = createVjStore();
    s.applyFrame(frame(1, 0.3));
    s.applyFrame(frame(2, 0.7));
    s.applyFrame(frame(1, 0.9)); // stale → 無視
    expect(s.snapshot().frame.seq).toBe(2);
    expect(s.snapshot().frame.audio.level).toBe(0.7);
  });

  it("counts dropped frames via seq gaps", () => {
    const s = createVjStore();
    s.applyFrame(frame(1));
    s.applyFrame(frame(4)); // 2,3 が欠落 → drops += 2
    expect(s.snapshot().drops).toBe(2);
  });

  it("holds last-known frame when given garbage", () => {
    const s = createVjStore();
    s.applyFrame(frame(5, 0.6));
    s.applyFrame(null); // 破損 → seq=0 は stale 扱いで last-known 維持
    expect(s.snapshot().frame.seq).toBe(5);
    expect(s.snapshot().frame.audio.level).toBe(0.6);
  });

  it("keeps event ring bounded", () => {
    const s = createVjStore();
    for (let i = 0; i < 100; i++) {
      s.pushEvent({
        kind: "control",
        tMs: i,
        source: "ui",
        ctrl: "cc",
        id: i,
        value: 0.1,
      });
    }
    expect(s.snapshot().events.length).toBe(64);
    // 最新が末尾
    const last = s.snapshot().events[63];
    expect(last.kind === "control" && last.id).toBe(99);
  });

  it("holds last-known prompt space (M7)", () => {
    const s = createVjStore();
    expect(s.snapshot().promptSpace).toBeNull();
    s.applyPromptSpace({
      pins: [{ id: "a", text: "pads", x: 0.2, y: 0.3, radius: 0.28 }],
      cursor: { x: 0.5, y: 0.5 },
      targets: [],
    });
    expect(s.snapshot().promptSpace?.pins[0].text).toBe("pads");
    // 不正入力でも throw せず整形されて保持（last-known は壊れない）
    s.applyPromptSpace({ pins: [{ id: "b", text: "next", x: 9, y: -1, radius: 0.2 }], cursor: {}, targets: [] });
    expect(s.snapshot().promptSpace?.pins[0].x).toBe(1);
    expect(s.snapshot().promptSpace?.pins[0].text).toBe("next");
  });

  it("applies hub state", () => {
    const s = createVjStore();
    const st = defaultHubState();
    st.session.state = "playing";
    st.prompts = [{ text: "warm pads", weight: 0.8 }];
    s.applyState(st);
    expect(s.snapshot().state.session.state).toBe("playing");
    expect(s.snapshot().state.prompts[0].text).toBe("warm pads");
  });
});
