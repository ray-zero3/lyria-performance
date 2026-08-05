// 観客入力の AI モデレーション。
//
// なぜ必要か: keywordSanitize の NG リストは「出力された英単語」しか見ない。しかし nickname は
// 生の文字列が VJ の球ラベルと Cue 一覧に表示されるため、語リストでは拾えない文脈依存の攻撃
// （実名への攻撃・婉曲な差別・嫌がらせ）が素通りする。そこで nickname と本文の両方を AI に判定させる。
//
// 設計: キーワード抽出と **並列** に呼ぶ（呼び出し側で Promise.all）ので追加レイテンシはほぼゼロ。
// 判定不能・API 失敗時は null を返し、呼び出し側で fail-open（通す）＋警告ログ。
// 小箱規模で control 窓に人が居る前提では、正常なリクエストを落とす方が損失が大きいため。

/**
 * 判定の待ち上限（これを超えたら判定不能扱い＝通す）。
 * 実測（2026-07-25, hy3）: 判定では必ず思考が入り 2.8〜10.4 秒かかる。prompt を短くしても減らない。
 */
const MODERATION_TIMEOUT_MS = 13_000;
/**
 * 思考ぶんの余裕。実測で nickname 攻撃の判定に completion 500 トークンを使い切ったため広く取る
 * （足りないと finish=length で JSON が出ず、判定不能＝素通りになる）。
 */
const MODERATION_MAX_TOKENS = 800;
/** reason はログ用途のみ。観客には返さない。 */
const MAX_REASON_LEN = 120;

const MODERATION_SYSTEM =
  "You are a content moderator for a live music event. The audience's nickname and message are shown" +
  " on a large screen and turned into music prompts." +
  " BLOCK if the input contains any of: slurs or discrimination based on race, ethnicity, nationality," +
  " religion, gender, or sexual orientation; attacks, threats, harassment, or defamation aimed at any" +
  " person or group (including real people's names); sexual or obscene content; graphic violence;" +
  " promotion of illegal drugs; or anything clearly against public decency." +
  " DO NOT BLOCK dark or intense MUSIC vocabulary — words like death metal, dark techno, hardcore," +
  " industrial, evil, doom, heavy, aggressive, brutal, chaos, noise are normal music requests." +
  " Also do not block ordinary nicknames or emotional expressions." +
  ' Respond with ONLY {"block":true|false,"reason":"<short english reason>"} and nothing else.' +
  " Do not think, reason, or explain — answer immediately.";

export interface ModerationVerdict {
  blocked: boolean;
  /** ログ用の短い理由（観客には返さない）。 */
  reason: string;
}

/** 真偽の揺れ（true/"true"/"yes"/1）を吸収する。判定不能なら null。 */
function coerceBlock(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "true" || v === "yes" || v === "1") return true;
    if (v === "false" || v === "no" || v === "0") return false;
  }
  return null;
}

/**
 * 応答メッセージから判定テキストを選ぶ。
 * hy3 は思考するため JSON が `reasoning` に入ることがある（`reasoning_content` は glm/deepseek 系の名前）。
 * どこに入るかがモデル依存なので、JSON を含む候補を優先して拾う。
 */
export function pickModerationText(msg: {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
}): string {
  const candidates = [msg?.content, msg?.reasoning, msg?.reasoning_content].map((s) =>
    (s ?? "").trim(),
  );
  const withJson = candidates.find((c) => c.includes("{") && /block/i.test(c));
  if (withJson) return withJson;
  return candidates.find((c) => c.length > 0) ?? "";
}

/** モデル応答から判定を取り出す。判定不能なら null（呼び出し側で fail-open）。 */
export function parseModeration(content: string): ModerationVerdict | null {
  const s = content.indexOf("{");
  const e = content.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  let obj: { block?: unknown; reason?: unknown };
  try {
    obj = JSON.parse(content.slice(s, e + 1)) as { block?: unknown; reason?: unknown };
  } catch {
    return null;
  }
  const blocked = coerceBlock(obj?.block);
  if (blocked === null) return null;
  return { blocked, reason: String(obj?.reason ?? "").slice(0, MAX_REASON_LEN) };
}

/**
 * nickname と本文を AI 判定する。
 * 判定不能（キー未設定・API 失敗・タイムアウト・応答不正）は null を返す＝呼び出し側で通す。
 */
export async function moderate(text: string, nickname: string): Promise<ModerationVerdict | null> {
  const cfg = useRuntimeConfig();
  const key = cfg.opencodeApiKey || process.env.OPENCODE_API_KEY || "";
  if (!key) return null;
  const base = cfg.opencodeBaseUrl || "https://opencode.ai/zen/go/v1";
  const model = cfg.opencodeModel || "hy3";

  try {
    const res = await $fetch<{
      choices?: Array<{
        // hy3 は `reasoning`、glm/deepseek 系は `reasoning_content` に思考を入れる。
        message?: { content?: string; reasoning?: string; reasoning_content?: string };
      }>;
    }>(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      timeout: MODERATION_TIMEOUT_MS,
      body: {
        model,
        messages: [
          { role: "system", content: MODERATION_SYSTEM },
          { role: "user", content: `nickname: ${nickname}\nmessage: ${text} /nothink` },
        ],
        // 判定は揺らさない。
        temperature: 0,
        max_tokens: MODERATION_MAX_TOKENS,
      },
    });
    return parseModeration(pickModerationText(res?.choices?.[0]?.message ?? {}));
  } catch {
    return null; // fail-open（呼び出し側で警告ログ）
  }
}
