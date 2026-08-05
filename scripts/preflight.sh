#!/bin/sh
# 本番前チェック（当日これを最初に走らせる）。
# 設定漏れ・ビルド漏れ・公開状態を1画面で確認する。壊す操作はしない。
set -u
cd "$(dirname "$0")/.." || exit 1

TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -x "$TS" ] || TS="$(command -v tailscale 2>/dev/null || true)"
PORT=3000
NG=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; NG=$((NG + 1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

echo "── 1. .env の必須項目 ────────────────────────────"
if [ -f .env ]; then
  grep -qE '^VITE_GEMINI_API_KEY=.+' .env && ok "VITE_GEMINI_API_KEY（Lyria）" || bad "VITE_GEMINI_API_KEY が未設定 → Lyria に繋がりません"
  grep -qE '^VITE_CUE_TOKEN=.+' .env && ok "VITE_CUE_TOKEN（cue 取得）" || bad "VITE_CUE_TOKEN が未設定 → リクエストが control 窓に出ません"
  grep -qE '^VITE_REQUEST_URL=.+' .env && ok "VITE_REQUEST_URL（QR）" || warn "VITE_REQUEST_URL が未設定 → QR が既定 URL になります"
else
  bad ".env がありません（cp .env.example .env）"
fi
if [ -f request-app/.env ]; then
  grep -qE '^NUXT_OPENCODE_API_KEY=.+' request-app/.env && ok "NUXT_OPENCODE_API_KEY（キーワード抽出）" || bad "NUXT_OPENCODE_API_KEY が未設定 → 送信が全て 500"
  grep -qE '^NUXT_CUE_TOKEN=.+' request-app/.env && ok "NUXT_CUE_TOKEN（cue 認証）" || bad "NUXT_CUE_TOKEN が未設定 → cue API が 503"
  grep -qE '^NUXT_ACCESS_KEY=.+' request-app/.env && ok "NUXT_ACCESS_KEY（公開面の鍵）" || warn "NUXT_ACCESS_KEY 未設定 → 誰でもアクセスできます"
else
  bad "request-app/.env がありません（cp request-app/.env.example request-app/.env）"
fi

echo "── 2. 鍵の一致（ここがズレると静かに壊れる）──────"
node -e '
const fs=require("fs");
const rd=p=>{try{return fs.readFileSync(p,"utf8")}catch{return ""}};
const root=rd(".env"), app=rd("request-app/.env");
const g=(s,re)=>{const m=s.match(re);return m?m[1]:""};
const cueA=g(root,/^VITE_CUE_TOKEN=(\S+)$/m), cueB=g(app,/^NUXT_CUE_TOKEN=(\S+)$/m);
const akA=g(root,/^VITE_REQUEST_URL=\S*[?&]k=([^&\s]+)$/m), akB=g(app,/^NUXT_ACCESS_KEY=(\S+)$/m);
const p=(okk,msg)=>console.log(okk?"  \x1b[32m✓\x1b[0m "+msg:"  \x1b[31m✗\x1b[0m "+msg);
p(!!cueA&&cueA===cueB,"cue トークンが両 .env で一致"+(cueA&&cueA!==cueB?"していない → cue が 401":""));
if(akB) p(!!akA&&akA===akB,"QR の ?k= とアクセスキーが一致"+(akA!==akB?"していない → 観客が 403":""));
else console.log("  \x1b[33m!\x1b[0m アクセスキー未使用（QR に ?k= なし）");
' || NG=$((NG + 1))

echo "── 3. ビルド成果物 ──────────────────────────────"
[ -f request-app/.output/server/index.mjs ] && ok "request-app の本番ビルドあり" || bad "request-app が未ビルド → npm run show:build"
[ -d build ] && ok "VJ/control のビルドあり（Tauri dev では未使用）" || warn "VJ 側は未ビルド（dev 起動なら不要）"

echo "── 4. プロセス ─────────────────────────────────"
pgrep -f '.output/server/index.mjs' >/dev/null && ok "リクエストサーバ稼働中（port ${PORT}）" || warn "リクエストサーバ停止中 → npm run show:serve"
pgrep -f 'target/debug/lyria-vj' >/dev/null && ok "Tauri（control/VJ）稼働中" || warn "Tauri 停止中 → npm run live"
pgrep -f 'nuxi dev' >/dev/null && bad "dev サーバが動いています → 本番は show:serve を使う（dev は外部に出さない）"

echo "── 5. 公開状態 ─────────────────────────────────"
# QR の URL が http:// なら LAN モード（scripts/deploy-lan.sh）、それ以外は Funnel 前提で見る。
REQ_URL=$(grep -E '^VITE_REQUEST_URL=' .env 2>/dev/null | head -1 | cut -d= -f2-)
KEY=$(grep -E '^NUXT_ACCESS_KEY=' request-app/.env 2>/dev/null | cut -d= -f2)
case "$REQ_URL" in
  http://*)
    BASE="${REQ_URL%%\?*}"
    ok "LAN モード（QR = $BASE ／ 同じ Wi-Fi のスマホからのみ）"
    if [ -n "${KEY:-}" ]; then
      C1=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE" || echo 000)
      C2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$REQ_URL" || echo 000)
      [ "$C1" = "403" ] && ok "鍵なしは 403" || bad "鍵なしが ${C1}（想定は 403。000 ならサーバが LAN 側に出ていない）"
      [ "$C2" = "200" ] && ok "鍵ありは 200（観客が入れる）" || bad "鍵ありが ${C2}（想定は 200）→ 観客が入れません"
    else
      C1=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE" || echo 000)
      [ "$C1" = "200" ] && ok "200（観客が入れる。鍵なし＝同じ Wi-Fi の全員が送信可）" || bad "${C1}（想定は 200）"
    fi
    if [ -n "$TS" ] && "$TS" funnel status 2>/dev/null | grep -q 'Funnel on'; then
      warn "Funnel も公開中。LAN モードなら不要 → npm run show:close で閉じる"
    fi
    ;;
  *)
    if [ -n "$TS" ]; then
      if "$TS" funnel status 2>/dev/null | grep -q 'Funnel on'; then
        URL=$("$TS" funnel status 2>/dev/null | grep -oE 'https://[a-z0-9.-]+' | head -1)
        ok "公開中（Funnel）: $URL"
        if [ -n "${KEY:-}" ]; then
          C1=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL/" || echo 000)
          C2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL/?k=$KEY" || echo 000)
          [ "$C1" = "403" ] && ok "鍵なしは 403（ボットを弾いている）" || bad "鍵なしが ${C1}（想定は 403）"
          [ "$C2" = "200" ] && ok "鍵ありは 200（観客が入れる）" || bad "鍵ありが ${C2}（想定は 200）→ 観客が入れません"
        fi
      else
        warn "未公開 → npm run show:deploy（外部公開）／ npm run show:lan（同一 LAN のデモ）"
      fi
    else
      warn "tailscale コマンドが見つかりません"
    fi
    ;;
esac

echo "─────────────────────────────────────────────────"
if [ "$NG" -eq 0 ]; then
  printf '  \033[32m問題なし。本番に進んで OK\033[0m\n'
else
  printf '  \033[31m%d 件の問題あり。上の ✗ を解消してください\033[0m\n' "$NG"
  exit 1
fi
