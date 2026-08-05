import { describe, it, expect } from "vitest";
import {
  fmtClock,
  truncateJson,
  weightBar,
  formatLogLine,
  formatStreamTick,
  STREAM_FACETS,
  snapshotLines,
  LOG_PAYLOAD_MAX,
} from "./dataPanelFormat";
import { clampFrame, defaultHubState, type TelemetryEvent } from "$lib/telemetry/contract";
import { defaultPromptSpaceState } from "$lib/prompts/promptSpace";

const T = 1_753_340_000_123; // 固定タイムスタンプ

describe("fmtClock", () => {
  it("HH:MM:SS.mmm 形式（ローカル時刻）", () => {
    const s = fmtClock(T);
    expect(s).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    const d = new Date(T);
    expect(s.endsWith(`.${String(d.getMilliseconds()).padStart(3, "0")}`)).toBe(true);
  });
  it("不正値は 00:00:00.000", () => {
    expect(fmtClock(NaN)).toBe("00:00:00.000");
  });
});

describe("truncateJson", () => {
  it("短い値はそのまま JSON 化", () => {
    expect(truncateJson({ a: 1 })).toBe('{"a":1}');
  });
  it("長い値は max で切って … を付ける", () => {
    const long = { text: "x".repeat(500) };
    const s = truncateJson(long);
    expect(s.length).toBeLessThanOrEqual(LOG_PAYLOAD_MAX + 1);
    expect(s.endsWith("…")).toBe(true);
  });
  it("JSON 化できない値でも throw しない", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => truncateJson(cyc)).not.toThrow();
  });
});

describe("weightBar", () => {
  it("重みに比例した固定幅バー", () => {
    expect(weightBar(1, 10)).toBe("██████████");
    expect(weightBar(0, 10)).toBe("░░░░░░░░░░");
    expect(weightBar(0.5, 10)).toBe("█████░░░░░");
  });
  it("範囲外はクランプ", () => {
    expect(weightBar(7, 4)).toBe("████");
    expect(weightBar(-2, 4)).toBe("░░░░");
  });
});

describe("formatLogLine", () => {
  it("prompt_set は SENT", () => {
    const e: TelemetryEvent = {
      kind: "api",
      tMs: T,
      api: "prompt_set",
      payload: { weightedPrompts: [{ text: "pads", weight: 0.8 }] },
    };
    const line = formatLogLine(e);
    expect(line).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} SENT prompt_set /);
    expect(line).toContain('"pads"');
  });
  it("config_set は SENT", () => {
    const e: TelemetryEvent = { kind: "api", tMs: T, api: "config_set", payload: { bpm: 120 } };
    expect(formatLogLine(e)).toContain(" SENT config_set ");
  });
  it("chunk / session / rotate は RECV", () => {
    for (const api of ["chunk", "session", "rotate"] as const) {
      const e: TelemetryEvent = { kind: "api", tMs: T, api, payload: { n: 1 } };
      expect(formatLogLine(e)).toContain(` RECV ${api} `);
    }
  });
  it("control は CTRL（source/ctrl/id/value）", () => {
    const e: TelemetryEvent = {
      kind: "control",
      tMs: T,
      source: "midi",
      ctrl: "cc",
      id: 74,
      value: 0.52,
      label: "cc74",
    };
    const line = formatLogLine(e);
    expect(line).toMatch(/ CTRL midi cc74 = 0\.52$/);
  });
});

describe("formatStreamTick", () => {
  const f = clampFrame({
    tMs: T,
    seq: 42,
    audio: {
      level: 0.62,
      peak: 0.8,
      bands: { low: 0.5, mid: 0.4, high: 0.3 },
      spectrum: [0.1, 0.2, 0.95, 0.3],
      waveform: [],
      onset: 0.1,
    },
  });
  const st = defaultHubState();
  st.prompts = [
    { text: "warm analog pads", weight: 0.7 },
    { text: "driving techno", weight: 0.3 },
  ];
  const space = defaultPromptSpaceState();

  it("facet 0 = ANLY（lvl/pk/on）", () => {
    const line = formatStreamTick(f, st, space, 0);
    expect(line).toMatch(/ ANLY /);
    expect(line).toContain("lvl=0.62");
    expect(line).toContain("on=0.10");
  });
  it("facet 1 = BAND（lo/mid/hi）", () => {
    expect(formatStreamTick(f, st, space, 1)).toContain("BAND lo=0.50 mid=0.40 hi=0.30");
  });
  it("facet 2 = SPEC（ピーク bin）", () => {
    const line = formatStreamTick(f, st, space, 2);
    expect(line).toMatch(/ SPEC pk=b02 /); // spectrum[2]=0.95 が最大
    expect(line).toContain("v=0.95");
  });
  it("facet 3 = CURS（カーソル + active 数）", () => {
    const line = formatStreamTick(f, st, space, 3);
    expect(line).toMatch(/ CURS /);
    expect(line).toContain("act=2");
  });
  it("facet 4 = WGHT（最大重みの prompt）", () => {
    const line = formatStreamTick(f, st, space, 4);
    expect(line).toContain("WGHT warm analog pads=0.70");
  });
  it("facet は STREAM_FACETS で循環（負 tick も安全）", () => {
    expect(formatStreamTick(f, st, space, STREAM_FACETS)).toMatch(/ ANLY /);
    expect(() => formatStreamTick(f, st, null, -3)).not.toThrow();
  });
});

describe("snapshotLines", () => {
  it("prompts の重みバー・config・session・chaos・cursor を含む", () => {
    const st = defaultHubState();
    st.session.state = "playing";
    st.prompts = [
      { text: "warm analog pads", weight: 0.68 },
      { text: "driving techno", weight: 0.32 },
    ];
    st.controlParams = { chaos: 0.25 };
    const space = defaultPromptSpaceState();
    const lines = snapshotLines(st, space);
    const all = lines.join("\n");
    expect(all).toContain("playing");
    expect(all).toContain("warm analog pads");
    expect(all).toContain("█"); // 重みバー
    expect(all).toContain("0.68");
    expect(all).toContain("bpm 120");
    expect(all).toContain("chaos 0.25");
    expect(all).toContain("cursor (0.50, 0.50)");
    expect(all).toContain("pins 4");
  });
  it("space が null でも throw しない", () => {
    expect(() => snapshotLines(defaultHubState(), null)).not.toThrow();
  });
});
