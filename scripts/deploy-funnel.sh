#!/bin/sh
# 観客リクエストページ（request-app / Nuxt）を、Tailscale のマシン名をランダム化してから
# Funnel で公開する。元に戻すのは scripts/revert-funnel.sh。
#
# 使い方:
#   sh scripts/deploy-funnel.sh [--build] [--prefix <接頭辞>] [--port <番号>]
#     --build   公開前に request-app を本番ビルドする（.svelte-kit は触らないので Tauri を閉じる必要なし）
#     --prefix  ランダムホスト名の接頭辞（既定 lp）
#     --port    公開するローカルポート（既定 3000）
#
# ランダムなマシン名を「秘密」として当てにしてはいけない:
#   Funnel は Let's Encrypt の証明書を取得するため、ホスト名は数分で Certificate
#   Transparency ログに公開され、誰でも列挙できる。実際のアクセス制御は
#   request-app/.env の NUXT_ACCESS_KEY（URL の ?k=）だけ。だからこのスクリプトは
#   NUXT_ACCESS_KEY が未設定なら公開せずに止まる。
set -u
cd "$(dirname "$0")/.." || exit 1

PREFIX=lp
PORT=3000
DO_BUILD=0
STATE=.funnel-state

while [ $# -gt 0 ]; do
  case "$1" in
    --build)  DO_BUILD=1 ;;
    --prefix) shift; PREFIX="${1:-lp}" ;;
    --port)   shift; PORT="${1:-3000}" ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "不明な引数: $1" >&2; exit 1 ;;
  esac
  shift
done

TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -x "$TS" ] || TS="$(command -v tailscale 2>/dev/null || true)"
if [ -z "$TS" ]; then
  echo "tailscale コマンドが見つかりません" >&2
  exit 1
fi

die()  { printf '\n  \033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
info() { printf '  \033[36m→\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

# URL 中のアクセスキーを隠す（ログや画面に鍵を出さないため）
mask() { printf '%s' "$1" | sed -E 's/([?&]k=)[^&]+/\1***/g'; }

# tailscale status から自機の FQDN を取り出す（末尾のドットは落とす）
self_fqdn() {
  "$TS" status --json 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const j = JSON.parse(s);
        process.stdout.write(((j.Self && j.Self.DNSName) || "").replace(/\.$/, ""));
      } catch { /* 未ログイン等は空文字を返す */ }
    })'
}

# .env の1行を値だけ取り出す（= を含む値も壊さない）
env_value() { grep -E "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2-; }

# .env の VITE_REQUEST_URL を差し替える。元ファイルの inode を保つため
# リダイレクトで上書きする（パーミッションを維持したいので mv は使わない）
set_request_url() {
  new_url="$1"
  if grep -qE '^VITE_REQUEST_URL=' .env; then
    NEW_URL="$new_url" awk '
      /^VITE_REQUEST_URL=/ { print "VITE_REQUEST_URL=" ENVIRON["NEW_URL"]; next }
      { print }
    ' .env > "$STATE.tmp" || return 1
  else
    { cat .env; echo "VITE_REQUEST_URL=$new_url"; } > "$STATE.tmp" || return 1
  fi
  cat "$STATE.tmp" > .env && rm -f "$STATE.tmp"
}

echo "── 0. 事前チェック ──────────────────────────────"
[ -f .env ] || die ".env がありません（cp .env.example .env）"
[ -f request-app/.env ] || die "request-app/.env がありません（cp request-app/.env.example request-app/.env）"

ACCESS_KEY=$(env_value request-app/.env NUXT_ACCESS_KEY)
[ -n "$ACCESS_KEY" ] || die "NUXT_ACCESS_KEY が未設定です。
    このまま公開すると観客ページが鍵なしで全世界に開きます（裏に課金 API があります）。
    生成して request-app/.env に入れてください:
      openssl rand -hex 24
    合わせて .env の VITE_REQUEST_URL の ?k= も同じ値にします（このスクリプトがホスト部分は直します）。"
ok "NUXT_ACCESS_KEY あり"

if [ -z "$(env_value request-app/.env NUXT_CUE_TOKEN)" ] || [ -z "$(env_value .env VITE_CUE_TOKEN)" ]; then
  warn "cue トークンが片方または両方未設定 → 観客リクエストが control 窓に出ません（公開自体は可能）"
fi

if [ "$DO_BUILD" -eq 1 ]; then
  echo "── 1. ビルド（request-app）──────────────────────"
  npm --prefix request-app run build || die "ビルドに失敗しました"
else
  [ -f request-app/.output/server/index.mjs ] || die "request-app が未ビルドです（--build を付けるか npm run show:build）"
  ok "ビルド成果物あり"
fi

echo "── 2. ローカルサーバの確認 ──────────────────────"
curl -s -o /dev/null --max-time 3 "http://localhost:$PORT/" \
  || die "localhost:$PORT が応答しません。別ターミナルで npm run show:serve を起動してから再実行してください
    （応答しないまま公開すると観客に 502 が出ます）"
ok "localhost:$PORT 応答あり"

if pgrep -f 'nuxi dev' >/dev/null 2>&1; then
  die "dev サーバ（nuxi dev）が動いています。dev を Funnel に出すと /@vite/client 等が外部に露出します。
    停止して npm run show:serve（本番ビルド）で起動してください。"
fi

echo "── 3. 現在の状態を保存 ──────────────────────────"
if [ -f "$STATE" ]; then
  die "$STATE が既にあります（前回の公開が戻されていない可能性）。
    先に sh scripts/revert-funnel.sh を実行してください。"
fi

ORIG_FQDN=$(self_fqdn)
[ -n "$ORIG_FQDN" ] || die "tailscale の状態を取得できません（ログインしていない可能性）"
ORIG_HOST="${ORIG_FQDN%%.*}"
ORIG_URL=$(env_value .env VITE_REQUEST_URL)
if grep -qE '^VITE_REQUEST_URL=' .env; then HAD_URL=yes; else HAD_URL=no; fi

umask 077
{
  echo "# scripts/deploy-funnel.sh が作成。revert-funnel.sh が読んで元に戻す。"
  echo "ORIG_HOST=$ORIG_HOST"
  echo "HAD_URL=$HAD_URL"
  echo "ORIG_URL=$ORIG_URL"
  echo "PORT=$PORT"
} > "$STATE" || die "$STATE を書けません"
chmod 600 "$STATE"
ok "元のマシン名 $ORIG_HOST を $STATE に保存"

echo "── 4. マシン名をランダム化 ──────────────────────"
# 先に Funnel を落としてから改名する（旧ホスト名の公開設定を残さないため）
"$TS" funnel --https=443 off >/dev/null 2>&1 || true

RAND=$(openssl rand -hex 5 2>/dev/null) || die "openssl が使えません"
NEW_HOST="${PREFIX}${RAND}"
"$TS" set --hostname="$NEW_HOST" || die "マシン名の変更に失敗しました（$STATE を削除して再実行してください）"

# Tailscale は名前衝突時に -1 等を付けるため、思い込まず実際の FQDN を読み直す
NEW_FQDN=""
i=0
while [ "$i" -lt 30 ]; do
  NEW_FQDN=$(self_fqdn)
  case "$NEW_FQDN" in
    "$NEW_HOST".*) break ;;
    "$NEW_HOST"-*) break ;;
  esac
  i=$((i + 1))
  sleep 1
  NEW_FQDN=""
done
[ -n "$NEW_FQDN" ] || die "改名後の FQDN を確認できませんでした。sh scripts/revert-funnel.sh で戻してください"
ok "マシン名: $ORIG_HOST → ${NEW_FQDN%%.*}"

echo "── 5. QR の URL を更新 ──────────────────────────"
# 既存の ?k=… などのクエリは維持したまま、ホスト部分だけ差し替える
case "$ORIG_URL" in
  *\?*) QUERY="?${ORIG_URL#*\?}" ;;
  *)    QUERY="?k=$ACCESS_KEY" ;;
esac
NEW_URL="https://$NEW_FQDN/$QUERY"
set_request_url "$NEW_URL" || die ".env の更新に失敗しました"
ok "VITE_REQUEST_URL=$(mask "$NEW_URL")"

echo "── 6. 公開 ─────────────────────────────────────"
"$TS" funnel --bg "$PORT" || die "funnel の開始に失敗しました。sh scripts/revert-funnel.sh で戻してください"

# 新ホスト名の証明書は初回アクセス時に発行されるため、応答するまで待つ
info "証明書の発行を待っています（最大90秒）…"
C1=000
i=0
while [ "$i" -lt 18 ]; do
  C1=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$NEW_FQDN/" || echo 000)
  [ "$C1" != "000" ] && break
  i=$((i + 1))
done
C2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$NEW_FQDN/$QUERY" || echo 000)

[ "$C1" = "403" ] && ok "鍵なしは 403（ボットを弾いている）" || warn "鍵なしが ${C1}（想定は 403）"
[ "$C2" = "200" ] && ok "鍵ありは 200（観客が入れる）" || warn "鍵ありが ${C2}（想定は 200）"

echo "─────────────────────────────────────────────────"
printf '  \033[32m公開しました\033[0m  %s\n' "$(mask "$NEW_URL")"
echo
echo "  次にやること:"
echo "    1. Tauri を再起動（npm run live）… QR は起動時の .env を読むため、再起動しないと旧 URL のまま"
echo "    2. npm run show:preflight で最終確認"
echo
echo "  公演後: sh scripts/revert-funnel.sh（公開停止・マシン名と .env を元に戻す）"
