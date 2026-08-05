import { describe, expect, it } from "vitest";
import { parseKeywords, sanitizeWords } from "./keywordSanitize";

describe("sanitizeWords", () => {
  it("小文字の英単語を最大2語まで返す", () => {
    expect(sanitizeWords(["Frantic", "DrumAndBass", "extra"])).toEqual(["frantic", "drumandbass"]);
  });

  it("英字とハイフン以外を除去する", () => {
    expect(sanitizeWords(["te'ch#no!"])).toEqual(["techno"]);
  });

  it("空になったらフォールバックを返す（無音のピンを作らない）", () => {
    expect(sanitizeWords([])).toEqual(["pulse"]);
    expect(sanitizeWords(["１２３"])).toEqual(["pulse"]);
  });

  it("構造語・フィラーを落とす", () => {
    expect(sanitizeWords(["keywords", "json", "the", "techno"])).toEqual(["techno"]);
  });

  it("20文字を超える語は落とす", () => {
    expect(sanitizeWords(["a".repeat(21), "techno"])).toEqual(["techno"]);
  });

  // --- NG 語（拡充分）: 観客の目に触れさせない ---
  it("差別・ヘイト語を落とす", () => {
    for (const w of ["nazi", "hitler", "racist", "nigger", "faggot", "retard"]) {
      expect(sanitizeWords([w, "techno"])).toEqual(["techno"]);
    }
  });

  it("性的な語を落とす", () => {
    for (const w of ["porn", "nude", "hentai", "pedo", "orgasm", "whore"]) {
      expect(sanitizeWords([w, "techno"])).toEqual(["techno"]);
    }
  });

  it("攻撃・脅迫の語を落とす", () => {
    for (const w of ["kill", "rape", "genocide", "terrorist", "lynch", "behead"]) {
      expect(sanitizeWords([w, "techno"])).toEqual(["techno"]);
    }
  });

  it("罵倒語を落とす", () => {
    for (const w of ["fuck", "shit", "bitch", "cunt", "asshole"]) {
      expect(sanitizeWords([w, "techno"])).toEqual(["techno"]);
    }
  });

  // --- 音楽表現として正当な語は殺さない（表現の幅を守る） ---
  it("音楽ジャンル・雰囲気として正当な語は通す", () => {
    for (const w of ["dark", "death", "evil", "hell", "doom", "heavy", "aggressive", "industrial"]) {
      expect(sanitizeWords([w])).toEqual([w]);
    }
  });
});

describe("parseKeywords", () => {
  it("JSON オブジェクトから keywords を取り出す", () => {
    expect(parseKeywords('{"keywords":["frantic","drumandbass"]}')).toEqual([
      "frantic",
      "drumandbass",
    ]);
  });

  it("前後に地の文があっても JSON を拾う", () => {
    expect(parseKeywords('Here: {"keywords":["techno"]} ok')).toEqual(["techno"]);
  });

  it("JSON でなくても生テキストから語を拾う", () => {
    expect(parseKeywords("frantic drumandbass")).toEqual(["frantic", "drumandbass"]);
  });

  it("NG 語しか無い応答はフォールバックになる", () => {
    expect(parseKeywords('{"keywords":["fuck","nazi"]}')).toEqual(["pulse"]);
  });
});
