#!/bin/sh
# 同じ LAN のスマホから観客リクエストページに入れるようにする（デモ用の簡易モード）。
# Tailscale / Funnel は一切触らない。QR の URL を http://<このMacのLAN IP>:3000/ に差し替えるだけ。
# 元に戻すのは scripts/revert-lan.sh。
#
# 使い方:
#   sh scripts/deploy-lan.sh [--ip <アドレス>] [--port <番号>]
#     --ip    使う IP を明示する（既定は Wi-Fi → デフォルトルートの順で自動検出）
#     --port  公開するローカルポート（既定 3000）
#
# Funnel 版（deploy-funnel.sh）との違い:
#   - HTTPS ではなく HTTP。証明書が無いので同一 LAN 内に限る前提
#   - マシン名のランダム化はしない（LAN 内には CT log 経由のスキャナが来ない）
#   - NUXT_ACCESS_KEY が無くても止めない（外部公開ではないため）。ただし
#     同じ Wi-Fi にいる人は誰でも叩ける＝裏の課金 API を叩けるので、鍵は入れておくのが安全
set -u
cd "$(dirname "$0")/.." || exit 1

PORT=3000
FORCE_IP=""
STATE=.lan-state

while [ $# -gt 0 ]; do
  case "$1" in
    --ip)   shift; FORCE_IP="${1:-}" ;;
    --port) shift; PORT="${1:-3000}" ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "不明な引数: $1" >&2; exit 1 ;;
  esac
  shift
done

die()  { printf '\n  \033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
info() { printf '  \033[36m→\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

# URL 中のアクセスキーを隠す（ログや画面に鍵を出さないため）
mask() { printf '%s' "$1" | sed -E 's/([?&]k=)[^&]+/\1***/g'; }

# .env の1行を値だけ取り出す（= を含む値も壊さない）
env_value() { grep -E "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2-; }

# .env の VITE_REQUEST_URL を差し替える。元ファイルの inode とパーミッションを保つため
# mv ではなくリダイレクトで上書きする（deploy-funnel.sh と同じ方式）
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

# 自機の LAN IP。Wi-Fi を優先する（スマホは Wi-Fi 側にいるため）。
# 見つからなければデフォルトルートの interface、最後に en0..en9 を順に見る。
wifi_device()    { networksetup -listallhardwareports 2>/dev/null | awk '/Hardware Port: Wi-Fi/{getline; print $2}'; }
default_device() { route -n get default 2>/dev/null | awk '/interface:/{print $2}'; }

detect_ip() {
  for dev in $(wifi_device) $(default_device) en0 en1 en2 en3 en4 en5 en6 en7 en8 en9; do
    [ -n "$dev" ] || continue
    addr=$(ipconfig getifaddr "$dev" 2>/dev/null)
    [ -n "$addr" ] && { printf '%s\t%s' "$dev" "$addr"; return; }
  done
}

# プライベートアドレス（RFC1918）か。公開 IP を QR に載せると Funnel を通さずに
# 平文で全世界に開くことになるため、自動検出結果は private のみ通す。
is_private_ip() {
  case "$1" in
    10.*|192.168.*|169.254.*) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
    *) return 1 ;;
  esac
}

echo "── 0. 事前チェック ──────────────────────────────"
[ -f .env ] || die ".env がありません（cp .env.example .env）"
[ -f request-app/.env ] || die "request-app/.env がありません（cp request-app/.env.example request-app/.env）"

if [ -f .funnel-state ]; then
  die "Funnel 公開中の状態ファイル（.funnel-state）が残っています。
    先に sh scripts/revert-funnel.sh で戻してから LAN モードにしてください
    （両方が .env の VITE_REQUEST_URL を書き換えるため、混ぜると復元できなくなります）。"
fi

ACCESS_KEY=$(env_value request-app/.env NUXT_ACCESS_KEY)
if [ -n "$ACCESS_KEY" ]; then
  ok "NUXT_ACCESS_KEY あり（URL に ?k= を付けます）"
else
  warn "NUXT_ACCESS_KEY 未設定 → 同じ Wi-Fi にいる人は誰でも送信できます（裏は課金 API）"
fi

if [ -z "$(env_value request-app/.env NUXT_CUE_TOKEN)" ] || [ -z "$(env_value .env VITE_CUE_TOKEN)" ]; then
  warn "cue トークンが片方または両方未設定 → 観客リクエストが control 窓に出ません"
fi

echo "── 1. ローカルサーバの確認 ──────────────────────"
[ -f request-app/.output/server/index.mjs ] || die "request-app が未ビルドです（npm run show:build）"
curl -s -o /dev/null --max-time 3 "http://localhost:$PORT/" \
  || die "localhost:$PORT が応答しません。別ターミナルで npm run show:serve を起動してから再実行してください。"
ok "localhost:$PORT 応答あり"

if pgrep -f 'nuxi dev' >/dev/null 2>&1; then
  warn "dev サーバ（nuxi dev）が動いています。LAN 限定なら動きますが、本番は show:serve を使ってください"
fi

echo "── 2. LAN アドレスの決定 ────────────────────────"
if [ -n "$FORCE_IP" ]; then
  IP="$FORCE_IP"
  is_private_ip "$IP" || warn "$IP はプライベートアドレスではありません（LAN 外に開いていないか確認してください）"
  ok "IP: ${IP}（--ip 指定）"
else
  DETECTED=$(detect_ip)
  [ -n "$DETECTED" ] || die "LAN アドレスを検出できません（Wi-Fi に繋がっていますか）。--ip で明示もできます。"
  DEV=$(printf '%s' "$DETECTED" | cut -f1)
  IP=$(printf '%s' "$DETECTED" | cut -f2)
  is_private_ip "$IP" || die "検出した ${IP}（${DEV}）はプライベートアドレスではありません。
    このアドレスを QR に載せると Funnel を通さず平文で外部に開く可能性があります。
    意図した構成なら --ip $IP を明示してください。"
  ok "IP: ${IP}（${DEV}）"
  # 複数 NIC があると「どれがスマホから見えるか」が変わるので候補を出す
  for dev in en0 en1 en2 en3 en4 en5 en6 en7 en8 en9; do
    addr=$(ipconfig getifaddr "$dev" 2>/dev/null)
    [ -n "$addr" ] && [ "$addr" != "$IP" ] && info "他の候補: ${addr}（${dev}）… 繋がらなければ --ip $addr で再実行"
  done
fi

echo "── 3. 現在の状態を保存 ──────────────────────────"
if [ -f "$STATE" ]; then
  die "$STATE が既にあります（前回の LAN モードが戻されていない可能性）。
    先に sh scripts/revert-lan.sh を実行してください。"
fi

ORIG_URL=$(env_value .env VITE_REQUEST_URL)
if grep -qE '^VITE_REQUEST_URL=' .env; then HAD_URL=yes; else HAD_URL=no; fi

umask 077
{
  echo "# scripts/deploy-lan.sh が作成。revert-lan.sh が読んで元に戻す。"
  echo "HAD_URL=$HAD_URL"
  echo "ORIG_URL=$ORIG_URL"
  echo "PORT=$PORT"
  echo "IP=$IP"
} > "$STATE" || die "$STATE を書けません"
chmod 600 "$STATE"
ok "元の VITE_REQUEST_URL を $STATE に保存"

echo "── 4. QR の URL を更新 ──────────────────────────"
if [ -n "$ACCESS_KEY" ]; then
  QUERY="?k=$ACCESS_KEY"
else
  QUERY=""
fi
NEW_URL="http://$IP:$PORT/$QUERY"
set_request_url "$NEW_URL" || die ".env の更新に失敗しました（sh scripts/revert-lan.sh で戻せます）"
ok "VITE_REQUEST_URL=$(mask "$NEW_URL")"

echo "── 5. 疎通確認 ─────────────────────────────────"
C1=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$IP:$PORT/" || echo 000)
if [ "$C1" = "000" ]; then
  warn "この Mac 自身から http://$IP:$PORT/ に届きません（サーバが LAN 側に出ていない可能性）"
elif [ -n "$ACCESS_KEY" ]; then
  [ "$C1" = "403" ] && ok "鍵なしは 403" || warn "鍵なしが ${C1}（想定は 403）"
  C2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$IP:$PORT/$QUERY" || echo 000)
  [ "$C2" = "200" ] && ok "鍵ありは 200（観客が入れる）" || warn "鍵ありが ${C2}（想定は 200）"
else
  [ "$C1" = "200" ] && ok "200（観客が入れる）" || warn "$C1 が返りました（想定は 200）"
fi

FW=/usr/libexec/ApplicationFirewall/socketfilterfw
if [ -x "$FW" ] && "$FW" --getglobalstate 2>/dev/null | grep -q 'State = 1'; then
  warn "macOS のファイアウォールが有効です。node への受信接続を許可しないとスマホから繋がりません
    （システム設定 → ネットワーク → ファイアウォール → オプション）"
fi

echo "─────────────────────────────────────────────────"
printf '  \033[32mLAN モードにしました\033[0m  %s\n' "$(mask "$NEW_URL")"
echo
# 一発起動（demo-lan.sh）から呼ばれた場合は、サーバ起動と後片付けを呼び出し側が
# 面倒みるため「次にやること」を出さない（矛盾した案内を出さないため）。
if [ "${LAN_ONESHOT:-0}" != "1" ]; then
  echo "  次にやること:"
  echo "    1. Tauri を再起動（npm run live）… QR は起動時の .env を読むため、再起動しないと旧 URL のまま"
  echo "    2. スマホを「この Mac と同じ Wi-Fi」に繋いで VJ 画面の QR を読む"
  echo
fi
echo "  繋がらないとき:"
echo "    - 別の SSID / ゲスト用 Wi-Fi に繋いでいないか（5GHz/2.4GHz の別 SSID も別扱いのことがある）"
echo "    - Wi-Fi の端末間通信がブロックされていないか（ゲスト Wi-Fi や社内 AP は既定で遮断されることが多い）"
echo "      → その場合は Mac のインターネット共有かスマホのテザリングで同じ網に入れるのが早い"
echo "    - 上に出た「他の候補」のアドレスで再実行（--ip <アドレス>）"
if [ "${LAN_ONESHOT:-0}" != "1" ]; then
  echo
  echo "  終わったら: npm run show:lan:off（.env の URL を元に戻す）"
fi
