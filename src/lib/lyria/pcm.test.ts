import { describe, it, expect } from "vitest";
import { base64ToBytes, decodePcm16Stereo } from "./pcm";
import {
  toMusicGenerationConfigPayload,
  toWeightedPromptsPayload,
  defaultLyriaConfig,
} from "./config";

describe("base64ToBytes", () => {
  it("decodes zero bytes", () => {
    const b = base64ToBytes("AAAA"); // 3 bytes of 0x00
    expect(b.length).toBe(3);
    expect([...b]).toEqual([0, 0, 0]);
  });
});

describe("decodePcm16Stereo", () => {
  it("decodes interleaved 16-bit LE to L/R floats", () => {
    // frame0: L=16384(0.5), R=-16384(-0.5) / frame1: L=-32768(-1), R=32767(~1)
    const bytes = new Uint8Array([
      0x00, 0x40, // 16384 LE
      0x00, 0xc0, // -16384 LE
      0x00, 0x80, // -32768 LE
      0xff, 0x7f, // 32767 LE
    ]);
    const { left, right } = decodePcm16Stereo(bytes);
    expect(left.length).toBe(2);
    expect(right.length).toBe(2);
    expect(left[0]).toBeCloseTo(0.5, 4);
    expect(right[0]).toBeCloseTo(-0.5, 4);
    expect(left[1]).toBeCloseTo(-1, 4);
    expect(right[1]).toBeCloseTo(0.99997, 4);
  });
  it("ignores trailing partial frame", () => {
    const bytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0x11]); // 4 valid + 1 stray
    const { left } = decodePcm16Stereo(bytes);
    expect(left.length).toBe(1);
  });
});

describe("config payloads", () => {
  it("maps music config to payload", () => {
    const p = toMusicGenerationConfigPayload(defaultLyriaConfig());
    expect(p.musicGenerationConfig.bpm).toBe(120);
    expect(p.musicGenerationConfig.temperature).toBe(1.0);
  });
  it("filters empty prompts", () => {
    const p = toWeightedPromptsPayload([
      { text: "warm pads", weight: 0.8 },
      { text: "   ", weight: 0.5 },
    ]);
    expect(p.weightedPrompts.length).toBe(1);
    expect(p.weightedPrompts[0].text).toBe("warm pads");
  });
});
