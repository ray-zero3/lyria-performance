// 観客送信の受付: { nickname, text } → 正規化 → 流量制限 → (キーワード抽出 ∥ AI 判定) → キューへ push。
//
// 公開面（Tailscale Funnel）に置かれる唯一の書き込み口なので、ここで多層に守る:
//   1) ペイロードサイズ（LLM を呼ぶ前に弾く）
//   2) 同一端末の連打（X-Client-Id / IP 単位）
//   3) 全体流量（Funnel 経由で送信元が tailscaled に潰れても効く主防壁）
//   4) 公演累計（API クレジット暴走消費の最後の栓）
//   5) AI モデレーション（nickname も対象。語リストでは拾えない文脈依存の攻撃を止める）

import { addCue } from "../utils/cue";
import { extractKeywords } from "../utils/keywords";
import { moderate } from "../utils/moderation";
import { createBucketLimiter, createTotalCounter } from "../utils/rateLimit";
import { normalizeMessage, normalizeNickname } from "../utils/textNormalize";

/** 本文の最大長（クライアントの maxlength と揃える）。 */
const MAX_TEXT_LEN = 300;
/** ニックネームの最大長。 */
const MAX_NICKNAME_LEN = 40;
/** リクエスト body の上限（実際の送信は数百バイト）。 */
const MAX_BODY_BYTES = 4 * 1024;

// --- 流量設計（小箱〜30人想定） ---
/** 全体で 1 分あたり何件許すか。 */
const TOTAL_PER_MIN = 10;
/** 全体のバースト許容（開演直後に集中しても数件は通す）。 */
const TOTAL_BURST = 5;
/**
 * 同一端末の最短送信間隔。
 * user の要望で「連投のインターバルは設けない」方針にしたため、ダブルタップ等による
 * 物理的な二重送信だけを弾く最小値にしてある（体感で待たされない範囲）。
 * 連投そのものの歯止めは全体流量（TOTAL_PER_MIN）と公演累計（SHOW_TOTAL_LIMIT）が担う。
 */
const CLIENT_INTERVAL_MS = 1_500;
/** 公演全体（プロセス起動からの通算）の上限。 */
const SHOW_TOTAL_LIMIT = 300;

const totalLimiter = createBucketLimiter({
  capacity: TOTAL_BURST,
  refillMs: Math.round(60_000 / TOTAL_PER_MIN),
});
const clientLimiter = createBucketLimiter({ capacity: 1, refillMs: CLIENT_INTERVAL_MS });
const showCounter = createTotalCounter(SHOW_TOTAL_LIMIT);

/** 端末の識別キー。X-Client-Id を優先し、無ければ IP。どちらも偽装可能なので副次的な防壁。 */
function clientKey(event: Parameters<typeof getRequestHeader>[0]): string {
  const id = getRequestHeader(event, "x-client-id");
  if (id && /^[A-Za-z0-9_-]{8,64}$/.test(id)) return `cid:${id}`;
  const ip = getRequestIP(event, { xForwardedFor: true }) || "unknown";
  return `ip:${ip}`;
}

export default defineEventHandler(async (event) => {
  // 1) ペイロードサイズ
  const declared = Number(getRequestHeader(event, "content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    throw createError({ statusCode: 413, statusMessage: "payload too large" });
  }

  const now = Date.now();

  // 2) 同一端末の連打（先に見る＝1人が全体枠を食い潰さないように）
  const perClient = clientLimiter.take(clientKey(event), now);
  if (!perClient.ok) {
    setResponseHeader(event, "Retry-After", Math.ceil(perClient.retryAfterMs / 1000));
    throw createError({ statusCode: 429, statusMessage: "please wait before sending again" });
  }

  // 3) 全体流量
  const total = totalLimiter.take("global", now);
  if (!total.ok) {
    setResponseHeader(event, "Retry-After", Math.ceil(total.retryAfterMs / 1000));
    throw createError({ statusCode: 429, statusMessage: "too many requests" });
  }

  // 4) 公演累計
  if (!showCounter.take().ok) {
    throw createError({ statusCode: 429, statusMessage: "request limit reached for this show" });
  }

  const body = await readBody<{ nickname?: string; text?: string }>(event);
  const nickname = normalizeNickname(body?.nickname, MAX_NICKNAME_LEN);
  const text = normalizeMessage(body?.text, MAX_TEXT_LEN);
  if (!text) {
    throw createError({ statusCode: 400, statusMessage: "text required" });
  }

  // 5) キーワード抽出と AI 判定を並列実行（直列にすると体感が倍になる）
  const [keywords, verdict] = await Promise.all([extractKeywords(text), moderate(text, nickname)]);

  if (verdict === null) {
    // 判定不能は fail-open（正常なリクエストを落とす方が公演では損失が大きい）。
    // moderated=false で cue に積むので、control 窓側で「未検査」として扱える。
    console.warn("[request] moderation unavailable — passing through unchecked");
  } else if (verdict.blocked) {
    // 観客には理由を返さない（回避のヒントを与えない）。
    console.warn(`[request] blocked by moderation: ${verdict.reason}`);
    throw createError({ statusCode: 400, statusMessage: "rejected" });
  }

  const item = addCue(nickname, keywords, verdict !== null);
  return { ok: true, item };
});
