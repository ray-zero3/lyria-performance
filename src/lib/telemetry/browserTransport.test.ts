import { describe, it, expect, vi } from "vitest";
import { createBrowserTransport, type ChannelLike } from "./browserTransport";
import { defaultHubState } from "./contract";

/** BroadcastChannel を模す最小の共有バス（同一プロセス内の複数チャネルを繋ぐ）。 */
function makeFakeBus() {
  const peers: FakeChannel[] = [];
  class FakeChannel implements ChannelLike {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    constructor() {
      peers.push(this);
    }
    postMessage(data: unknown) {
      for (const p of peers) {
        if (p !== this) p.onmessage?.({ data: structuredClone(data) });
      }
    }
    close() {
      const i = peers.indexOf(this);
      if (i >= 0) peers.splice(i, 1);
    }
  }
  return () => new FakeChannel();
}

describe("browserTransport", () => {
  it("relays frames from control to vj", () => {
    const factory = makeFakeBus();
    const control = createBrowserTransport("control", factory);
    const vj = createBrowserTransport("vj", factory);
    const got = vi.fn();
    vj.onFrame(got);
    control.pushFrame({
      tMs: 1,
      seq: 1,
      audio: {
        level: 0.5,
        peak: 0.5,
        bands: { low: 0, mid: 0, high: 0 },
        spectrum: [],
        waveform: [],
        onset: 0,
      },
    });
    expect(got).toHaveBeenCalledTimes(1);
    expect(got.mock.calls[0][0].seq).toBe(1);
    control.dispose();
    vj.dispose();
  });

  it("control answers getState for vj", async () => {
    const factory = makeFakeBus();
    const control = createBrowserTransport("control", factory);
    const vj = createBrowserTransport("vj", factory);
    const st = defaultHubState();
    st.session.state = "playing";
    control.setState(st);
    const fetched = await vj.getState();
    expect(fetched.session.state).toBe("playing");
    control.dispose();
    vj.dispose();
  });

  it("relays prompt space from control to vj (M7)", () => {
    const factory = makeFakeBus();
    const control = createBrowserTransport("control", factory);
    const vj = createBrowserTransport("vj", factory);
    const got = vi.fn();
    vj.onPromptSpace(got);
    control.pushPromptSpace({
      pins: [{ id: "a", text: "pads", x: 0.2, y: 0.3, radius: 0.28 }],
      cursor: { x: 0.5, y: 0.5 },
      targets: [],
    });
    expect(got).toHaveBeenCalledTimes(1);
    expect(got.mock.calls[0][0].pins[0].text).toBe("pads");
    expect(got.mock.calls[0][0].cursor.x).toBe(0.5);
    control.dispose();
    vj.dispose();
  });

  it("broadcasts state changes to vj onState", () => {
    const factory = makeFakeBus();
    const control = createBrowserTransport("control", factory);
    const vj = createBrowserTransport("vj", factory);
    const onState = vi.fn();
    vj.onState(onState);
    const st = defaultHubState();
    st.prompts = [{ text: "x", weight: 1 }];
    control.setState(st);
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState.mock.calls[0][0].prompts[0].text).toBe("x");
    control.dispose();
    vj.dispose();
  });
});
