// Tauri webview（control/vj 窓）からの localhost:3000 fetch を許可する CORS。
// ローカルツール前提で緩め（* 許可）。OPTIONS プリフライトは 204 で即返す。
//
// 重要: cue API の認証ヘッダ `X-Cue-Token` はカスタムヘッダなので、これを
// Allow-Headers に載せないとプリフライトで弾かれ、control/VJ 窓の fetch が失敗する。
// cueClient は失敗を握りつぶして空配列を返す設計なので、載せ忘れると
// 「リクエストが届かない」という形で静かに機能が死ぬ（実際に一度やった）。
/** 許可するリクエストヘッダ。cue の認証と端末識別を含める。 */
const ALLOWED_HEADERS = "Content-Type, X-Cue-Token, X-Client-Id";

export default defineEventHandler((event) => {
  setResponseHeaders(event, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
  });
  if (event.method === "OPTIONS") {
    setResponseStatus(event, 204);
    return "";
  }
});
