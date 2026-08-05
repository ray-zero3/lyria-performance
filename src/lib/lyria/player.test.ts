import { describe, it, expect } from "vitest";
import { nextStart } from "./player";

describe("nextStart", () => {
  it("keeps scheduled time when it is in the future", () => {
    expect(nextStart(10, 5)).toBe(10);
  });
  it("jumps ahead of now on underrun", () => {
    expect(nextStart(3, 5, 0.05)).toBeCloseTo(5.05, 5);
  });
});
