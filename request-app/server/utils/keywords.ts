// キーワード抽出（観客の自由文 → 安全な英単語 1〜2 語）。
// バックエンドは OpenCode Zen（OpenAI 互換 /v1/chat/completions、Bearer 認証）。
// 一次情報: https://opencode.ai/docs/zen/ ・ https://opencode.ai/zen/go/v1/models
// 鍵はサーバ専用（runtimeConfig / process.env）。クライアントには渡さない。
//
// 語の整形（NG リスト・2語制限・フォールバック）は keywordSanitize.ts に分離＝単体テスト対象。

import { parseKeywords } from "./keywordSanitize";

/** 既定モデル（実測で最安定。詳細は nuxt.config.ts のコメント）。 */
const DEFAULT_MODEL = "hy3";
/** 思考モデルが reasoning に使う分の余裕（sanitize で 2 語に絞る）。 */
const MAX_TOKENS = 300;
/** 抽出は多少揺らいだ方が表現が単調にならない。 */
const TEMPERATURE = 0.7;
/** レート制限・瞬断に対するリトライ回数。 */
const MAX_ATTEMPTS = 3;

const SYSTEM_INSTRUCTION =
  "You convert a music fan's free-form message into 1-2 short English keywords for a live music" +
  " visual/prompt system. Output ONLY safe-for-work, evocative descriptors such as mood, texture," +
  " genre, color, or energy. Rules: lowercase; no personal names; no profanity, hate, sexual or" +
  " violent content; no personal data; prefer a single word, at most two words total." +
  ' Respond with ONLY a JSON object of the form {"keywords":["word"]} and nothing else.' +
  " Do not think, reason, or explain — answer immediately.";

/**
 * 観客テキスト → 安全な英単語 1〜2 語。
 * 鍵未設定・API 失敗時は例外（呼び出し側で 4xx/5xx に）。
 */
export async function extractKeywords(text: string): Promise<string[]> {
  const cfg = useRuntimeConfig();
  const key = cfg.opencodeApiKey || process.env.OPENCODE_API_KEY || "";
  if (!key) {
    throw createError({ statusCode: 500, statusMessage: "OpenCode API key not configured" });
  }
  const base = cfg.opencodeBaseUrl || "https://opencode.ai/zen/go/v1";
  const model = cfg.opencodeModel || DEFAULT_MODEL;

  // 応答本文がエラー文（rate limit / 残高不足）を含む場合はリトライ対象とみなす。
  const isErrorish = (s: string): boolean =>
    /rate limit|insufficient balance|error from provider/i.test(s);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await $fetch<{
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      }>(`${base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: {
          model,
          messages: [
            { role: "system", content: SYSTEM_INSTRUCTION },
            // /nothink: GLM/Qwen 系の思考を抑制（推論でトークンを使い切り content が空になるのを防ぐ）。
            { role: "user", content: `${text} /nothink` },
          ],
          temperature: TEMPERATURE,
          max_tokens: MAX_TOKENS,
        },
      });
      const msg = res?.choices?.[0]?.message;
      let content = (msg?.content ?? "").trim();
      // 稀に思考が溢れて content が空のとき、reasoning に JSON があれば拾う（保険）。
      const rc = msg?.reasoning_content ?? "";
      if ((!content || isErrorish(content)) && /\{[^}]*keywords/i.test(rc)) {
        content = rc;
      }
      if (content && !isErrorish(content)) return parseKeywords(content);
      lastErr = new Error(content || "empty response");
    } catch (e) {
      lastErr = e; // 非 2xx（429/レート制限等）→ リトライ
    }
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); // 300/600/900ms バックオフ
  }
  throw createError({
    statusCode: 502,
    statusMessage: "keyword provider failed",
    data: lastErr instanceof Error ? lastErr.message : String(lastErr),
  });
}
