// cue エンドポイントの共有トークン認証。
//
// なぜ必要か: Tailscale Funnel は localhost:3000 を丸ごと公開するため、パス単位で cue API を隠せない
// （--set-path は公開 URL 側のプレフィックス指定であって、localhost 側のパス制限ではない）。
// 無防備だと外部から GET /api/cue でニックネーム一覧が読め、POST /api/cue/consume で
// 正規のリクエストを削除できてしまう。よってアプリ側で守る。
//
// 方針は fail-closed: トークン未設定なら 503 で機能を止める（設定忘れが「無防備」ではなく
// 「明確な故障」として現れる方が安全）。

import type { H3Event } from "h3";
import { safeCompare } from "./safeCompare";

/** control/VJ 窓からのアクセスであることを検証する。不一致は 401、未設定は 503。 */
export function requireCueToken(event: H3Event): void {
  const cfg = useRuntimeConfig();
  const expected = cfg.cueToken || process.env.NUXT_CUE_TOKEN || "";
  if (!expected) {
    throw createError({
      statusCode: 503,
      statusMessage: "cue token not configured (set NUXT_CUE_TOKEN)",
    });
  }
  const given = getRequestHeader(event, "x-cue-token") ?? "";
  if (!given || !safeCompare(given, expected)) {
    throw createError({ statusCode: 401, statusMessage: "unauthorized" });
  }
}
