import { describe, expect, it } from "vitest";
import { parseModeration, pickModerationText } from "./moderation";

// hy3 は判定時に思考し、JSON が content ではなく `reasoning` に入ることがある。
// （message のキーは content / reasoning / reasoning_details / refusal / role。
//   `reasoning_content` は glm/deepseek 系の名前で hy3 には存在しない）
describe("pickModerationText", () => {
  it("content に JSON があればそれを使う", () => {
    expect(pickModerationText({ content: '{"block":false}', reasoning: "考え中" })).toBe(
      '{"block":false}',
    );
  });

  it("content が空なら reasoning から JSON を拾う（hy3 の思考パターン）", () => {
    expect(
      pickModerationText({ content: "", reasoning: '{"block":false,"reason":"music"}' }),
    ).toBe('{"block":false,"reason":"music"}');
  });

  it("reasoning_content（glm/deepseek 系）からも拾える", () => {
    expect(pickModerationText({ content: "", reasoning_content: '{"block":true}' })).toBe(
      '{"block":true}',
    );
  });

  it("content に JSON が無く reasoning に JSON がある場合は reasoning を選ぶ", () => {
    expect(
      pickModerationText({ content: "Sure, let me check.", reasoning: '{"block":true}' }),
    ).toBe('{"block":true}');
  });

  it("どこにも JSON が無ければ空でない最初の値を返す", () => {
    expect(pickModerationText({ content: "", reasoning: "思考の途中で切れた" })).toBe(
      "思考の途中で切れた",
    );
  });

  it("全て空なら空文字", () => {
    expect(pickModerationText({})).toBe("");
  });
});

describe("parseModeration", () => {
  it("block:true と理由を取り出す", () => {
    expect(parseModeration('{"block":true,"reason":"hate"}')).toEqual({
      blocked: true,
      reason: "hate",
    });
  });

  it("block:false を通過として扱う", () => {
    expect(parseModeration('{"block":false}')).toEqual({ blocked: false, reason: "" });
  });

  it("前後に地の文があっても JSON を拾う", () => {
    expect(parseModeration('Sure! {"block":true,"reason":"attack"} done')).toEqual({
      blocked: true,
      reason: "attack",
    });
  });

  it("文字列の \"true\"/\"yes\" も真として扱う（モデルの揺れを吸収）", () => {
    expect(parseModeration('{"block":"true"}').blocked).toBe(true);
    expect(parseModeration('{"block":"yes"}').blocked).toBe(true);
  });

  it("文字列の \"false\"/\"no\" は偽として扱う", () => {
    expect(parseModeration('{"block":"false"}').blocked).toBe(false);
    expect(parseModeration('{"block":"no"}').blocked).toBe(false);
  });

  it("判定不能なら null を返す（呼び出し側で fail-open にする）", () => {
    expect(parseModeration("")).toBeNull();
    expect(parseModeration("わかりません")).toBeNull();
    expect(parseModeration("{壊れた")).toBeNull();
  });

  it("reason は表示に使わないので長すぎる場合は切り詰める", () => {
    const r = parseModeration(`{"block":true,"reason":"${"x".repeat(300)}"}`);
    expect(r?.reason.length).toBeLessThanOrEqual(120);
  });
});
