// 公開面のアクセス制御。`?k=<キー>` を持つ人だけ通し、以降は Cookie で省略できるようにする。
//
// なぜ必要か: Tailscale Funnel は TLS 証明書を発行するため、ホスト名が証明書透明性ログ（CT log）に
// 載る。実測で、公開から数分で自動スキャナが /.env /.env.local /.env.production /config などを
// 探索してきた。つまり「URL をランダムにして知られないようにする」は成立しない。
// そこで URL を隠す代わりに「キーを持つ人だけ通す」ことで、ボットを入口で断つ。
//
// 観客の導線: VJ 画面の QR に `?k=<キー>` 付き URL を載せる → 初回アクセスで Cookie が入り、
// 以降のリロードや遷移ではキー不要。
//
// 未設定（NUXT_ACCESS_KEY が空）なら無効。ローカル開発を妨げないため。

import { safeCompare } from "../utils/safeCompare";

/** キーを覚えておく Cookie 名。 */
const COOKIE_NAME = "lp_access";
/** Cookie の有効期間（公演当日をまるごとカバーする長さ）。 */
const COOKIE_MAX_AGE_S = 60 * 60 * 18;
/** 拒否ログをまとめて出す間隔（毎回出すとスキャナで溢れるため集約する）。 */
const DENY_REPORT_INTERVAL_MS = 60_000;

/** 拒否件数の集約カウンタ（プロセス内）。「今どれだけ叩かれているか」を把握するため。 */
let deniedCount = 0;
let deniedSince = Date.now();
/** 直近で拒否したパス（重複を除いた代表例。何を狙われているかの手掛かり）。 */
const deniedPaths = new Set<string>();

/** 拒否を記録し、一定間隔でまとめて1行出す。 */
function reportDenied(path: string): void {
  deniedCount += 1;
  if (deniedPaths.size < 8) deniedPaths.add(path.slice(0, 60));
  const now = Date.now();
  if (now - deniedSince < DENY_REPORT_INTERVAL_MS) return;
  const secs = Math.round((now - deniedSince) / 1000);
  console.warn(
    `[access] 鍵なしアクセスを ${deniedCount} 件拒否（直近 ${secs}s）例: ${[...deniedPaths].join(" ")}`,
  );
  deniedCount = 0;
  deniedSince = now;
  deniedPaths.clear();
}

export default defineEventHandler((event) => {
  const cfg = useRuntimeConfig();
  const expected = cfg.accessKey || process.env.NUXT_ACCESS_KEY || "";
  if (!expected) return; // 未設定＝この防御は無効

  // CORS プリフライトは通す（ここで 403 にすると cors.ts の 204 に届かず、
  // ブラウザからの POST が全滅する）。
  if (event.method === "OPTIONS") return;

  // cue API は control/VJ 窓が localhost から叩くもので、?k= を持たない。
  // こちらは X-Cue-Token（cueAuth）で別途守っているため対象外にする。
  const path = event.path || "";
  if (path.startsWith("/api/cue")) return;

  // すでにキーを持っている（Cookie）なら通す
  const cookie = getCookie(event, COOKIE_NAME);
  if (cookie && safeCompare(cookie, expected)) return;

  // クエリのキーが正しければ Cookie に覚えさせて通す
  const given = getQuery(event).k;
  if (typeof given === "string" && safeCompare(given, expected)) {
    setCookie(event, COOKIE_NAME, expected, {
      maxAge: COOKIE_MAX_AGE_S,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      // secure は付けない: Funnel は HTTPS なので通信は保護される一方、
      // secure を付けると localhost(HTTP) での動作確認時に Cookie が保存されず詰まるため。
    });
    return;
  }

  // 何をどれだけ弾いているかは記録する（返答には出さない）
  reportDenied(path);
  // 理由は返さない（キーの存在を推測させない）
  throw createError({ statusCode: 403, statusMessage: "forbidden" });
});
