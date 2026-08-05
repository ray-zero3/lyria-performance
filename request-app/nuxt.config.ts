// 観客リクエストアプリ（Nuxt3/Nitro）。
// - フロント: 観客がスマホからアクセスする送信ページ
// - バックエンド: /api/request で OpenCode Go（OpenAI互換）にプロンプト処理→英単語抽出→キューへ
// 公開は Tailscale Funnel（localhost:3000 を対象）。鍵はサーバ専用 runtimeConfig（public には置かない）。
export default defineNuxtConfig({
  compatibilityDate: "2025-01-01",
  devServer: { port: 3000 },
  vite: {
    server: {
      // dev サーバをトンネル経由で外部公開するため、Host ヘッダの許可リストを広げる。
      // Vite 6 は DNS リバインディング対策として既定で localhost 以外の Host を 403 で弾くため、
      // これが無いと Cloudflare quick tunnel / Tailscale Funnel の URL が「Blocked request」になる。
      // 先頭ドットはサブドメインを含めた許可（*.trycloudflare.com / *.ts.net）。
      allowedHosts: [".trycloudflare.com", ".ts.net"],
    },
  },
  runtimeConfig: {
    // NUXT_OPENCODE_API_KEY で上書き（サーバ専用＝クライアントJSには出ない）。
    // 未設定時は util 側で process.env.OPENCODE_API_KEY にもフォールバック。
    opencodeApiKey: "",
    // NUXT_OPENCODE_MODEL で上書き。既定は hy3。
    // 実測（2026-07-25・本番同一条件 n=20）: hy3 は JSON 20/20・strict 20/20・p50 2.1s・出力13tok。
    // 他は思考が reasoning_content に溢れて content が空になり不安定:
    //   glm-5.2 → 3/5、glm-5.1 → 9/20（16s タイムアウトも）、deepseek-v4-flash/minimax-m2.5/mimo-v2.5 → 0/5、
    //   kimi-k2.5 → JSON 出さず地の文、qwen3.7-plus/qwen3.6-plus → 品質は良いが 16〜27s で実用外。
    opencodeModel: "hy3",
    // Go プランのクレジットが乗るエンドポイントは /zen/go/v1（pay-as-you-go の /zen/v1 とは別）。
    // NUXT_OPENCODE_BASE_URL で上書き可。
    opencodeBaseUrl: "https://opencode.ai/zen/go/v1",
    // cue API（GET /api/cue, POST /api/cue/consume）の共有トークン。NUXT_CUE_TOKEN で上書き。
    // Funnel は localhost:3000 を丸ごと公開するため、パスで隠せない cue API をこれで守る。
    // 未設定なら cue API は 503（fail-closed）。control/VJ 窓側は VITE_CUE_TOKEN に同じ値を持つ。
    cueToken: "",
    // 公開面のアクセスキー。NUXT_ACCESS_KEY で上書き。?k=<キー> を持つ人だけ通し、
    // 以降は Cookie で省略できる（server/middleware/accessKey.ts）。
    // Funnel の URL は CT log 経由で自動スキャナに即座に拾われるため、URL を隠す代わりにこれで守る。
    // 未設定なら無効（ローカル開発を妨げない）。
    accessKey: "",
  },
});
