import { describe, expect, it } from "vitest";
import { normalizeMessage, normalizeNickname } from "./textNormalize";

// 不可視文字をソースに直接書くと差分が読めず、NUL を含むと git がバイナリ扱いする。
// そのためコードポイントから組み立てる（何を検証しているかも明確になる）。
const NUL = String.fromCharCode(0x00); // C0 制御
const SOH = String.fromCharCode(0x01); // C0 制御
const ZWSP = String.fromCharCode(0x200b); // ゼロ幅スペース（NG ワードの分断に使われる）
const RLO = String.fromCharCode(0x202e); // RTL override（表示の反転偽装）
const PDF = String.fromCharCode(0x202c); // 双方向制御の終端

describe("normalizeMessage", () => {
  it("前後の空白を落とし、連続空白を1つに圧縮する", () => {
    expect(normalizeMessage("  踊りたい   テクノ  ")).toBe("踊りたい テクノ");
  });

  it("改行・タブを空白に変換する（VJ 表示の崩れとログ汚染を防ぐ）", () => {
    expect(normalizeMessage("踊りたい\n\nテクノ\tで")).toBe("踊りたい テクノ で");
  });

  it("制御文字とゼロ幅文字を除去する", () => {
    expect(normalizeMessage(`テク${SOH}ノ${ZWSP}で`)).toBe("テクノで");
  });

  it("双方向制御文字（RTL override）を除去する", () => {
    expect(normalizeMessage(`${RLO}テクノ${PDF}`)).toBe("テクノ");
  });

  it("NFKC で全角英数を半角に正規化する", () => {
    expect(normalizeMessage("ＴＥＣＨＮＯ")).toBe("TECHNO");
  });

  it("最大長で切り詰める", () => {
    expect(normalizeMessage("あ".repeat(400), 300)).toHaveLength(300);
  });

  it("空文字・空白のみは空文字になる", () => {
    expect(normalizeMessage("   \n\t ")).toBe("");
    expect(normalizeMessage(undefined)).toBe("");
  });
});

describe("normalizeNickname", () => {
  it("空なら anon にフォールバックする", () => {
    expect(normalizeNickname("")).toBe("anon");
    expect(normalizeNickname("   ")).toBe("anon");
    expect(normalizeNickname(undefined)).toBe("anon");
  });

  it("日本語の名前はそのまま通す", () => {
    expect(normalizeNickname("まつだ")).toBe("まつだ");
  });

  it("制御文字・ゼロ幅・RTL override を除去する（VJ の球ラベルに生表示されるため）", () => {
    expect(normalizeNickname(`matsu${ZWSP}da${RLO}${NUL}`)).toBe("matsuda");
  });

  it("改行を空白にして1行に潰す", () => {
    expect(normalizeNickname("matsu\nda")).toBe("matsu da");
  });

  it("40文字で切り詰める", () => {
    expect(normalizeNickname("あ".repeat(80))).toHaveLength(40);
  });
});
