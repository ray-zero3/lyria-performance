import { describe, expect, it } from "vitest";
import { safeCompare } from "./safeCompare";

describe("safeCompare", () => {
  it("同一の文字列は true", () => {
    expect(safeCompare("abc123", "abc123")).toBe(true);
  });

  it("内容が違えば false", () => {
    expect(safeCompare("abc123", "abc124")).toBe(false);
  });

  it("長さが違えば false（timingSafeEqual の例外を出さない）", () => {
    expect(safeCompare("abc", "abcd")).toBe(false);
    expect(safeCompare("abcd", "abc")).toBe(false);
  });

  it("空文字どうしは true、片方だけ空なら false", () => {
    expect(safeCompare("", "")).toBe(true);
    expect(safeCompare("", "a")).toBe(false);
  });

  it("マルチバイトでもバイト長で比較して例外にならない", () => {
    expect(safeCompare("あ", "あ")).toBe(true);
    expect(safeCompare("あ", "a")).toBe(false);
  });
});
