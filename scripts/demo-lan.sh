#!/bin/sh
# LAN デモを1コマンドで立ち上げる（サーバ起動 → QR を LAN アドレスに差し替え → control/VJ 窓）。
# Ctrl+C（または Tauri の窓を閉じる）で自動的に後片付けする（サーバ停止・.env の URL 復元）。
#
# 使い方:
#   sh scripts/demo-lan.sh [--ip <アドレス>] [--port <番号>]
#     --ip    使う IP を明示する（既定は Wi-Fi → デフォルトルートの順で自動検出）
#     --port  リクエストサーバのポート（既定 3000）
#
# 本番公演には使わない（HTTP・同一 LAN 限定）。外部公開は npm run show:deploy。
set -u
cd "$(dirname "$0")/.." || exit 1

PORT=3000
PASS_ARGS=""
LOG=lan-demo.log
# 後片付けの対象。自分が起動/変更したものだけを戻す（既に動いていたサーバは殺さない）。
SERVER_PID=""
STARTED_LAN=0
CLEANED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ip)   shift; PASS_ARGS="$PASS_ARGS --ip ${1:-}" ;;
    --port) shift; PORT="${1:-3000}"; PASS_ARGS="$PASS_ARGS --port $PORT" ;;
    -h|--help)
      sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "不明な引数: $1" >&2; exit 1 ;;
  esac
  shift
done

die()  { printf '\n  \033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
info() { printf '  \033[36m→\033[0m %s\n' "$1"; }

# 終了時（Ctrl+C・エラー・Tauri 終了のいずれでも）に必ず元の状態へ戻す。
# .env を書き換えたまま放置すると次回の公演で QR が LAN アドレスのままになるため、
# 「戻し忘れ」を人間の記憶に頼らない。
cleanup() {
  [ "$CLEANED" -eq 1 ] && return
  CLEANED=1
  echo
  echo "── 後片付け ────────────────────────────────────"
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    i=0
    while [ "$i" -lt 10 ] && kill -0 "$SERVER_PID" 2>/dev/null; do
      i=$((i + 1))
      sleep 1
    done
    kill -0 "$SERVER_PID" 2>/dev/null && kill -9 "$SERVER_PID" 2>/dev/null
    ok "リクエストサーバを停止しました"
  fi
  if [ "$STARTED_LAN" -eq 1 ]; then
    LAN_ONESHOT=1 sh scripts/revert-lan.sh || true
  fi
}
trap cleanup EXIT INT TERM

echo "── LAN デモを開始します ─────────────────────────"

if pgrep -f 'target/debug/lyria-vj' >/dev/null 2>&1; then
  die "Tauri（control/VJ 窓）が既に動いています。
    QR は起動時の .env を読むため、開いたままでは LAN の URL に切り替わりません。
    窓を閉じてから実行してください。"
fi

[ -f .env ] || die ".env がありません（cp .env.example .env）"
[ -f request-app/.env ] || die "request-app/.env がありません（cp request-app/.env.example request-app/.env）"

# 前回の異常終了で状態ファイルが残っている場合は、先に戻してから始める
# （残っていると deploy-lan.sh が二重適用を防ぐために止まる）。
if [ -f .lan-state ]; then
  info "前回の LAN モードが残っています。先に戻します"
  sh scripts/revert-lan.sh || die "前回の状態を戻せませんでした。手で sh scripts/revert-lan.sh を実行してください"
fi

if [ ! -f request-app/.output/server/index.mjs ]; then
  echo "── request-app をビルド ────────────────────────"
  npm --prefix request-app run build || die "ビルドに失敗しました"
fi

echo "── リクエストサーバ ────────────────────────────"
if curl -s -o /dev/null --max-time 3 "http://localhost:$PORT/"; then
  ok "localhost:${PORT} は既に起動済み（このスクリプトでは停止しません）"
else
  : > "$LOG"
  # npm 経由（npm run serve）ではなく node を直接 exec する。
  # npm を挟むと $! が npm のラッパー PID になり、それを kill しても実体の node が
  # ポートを掴んだまま残る（＝次回の起動が「既に起動済み」と誤判定される）。
  ( cd request-app && exec node --env-file=.env .output/server/index.mjs ) >> "$LOG" 2>&1 &
  SERVER_PID=$!
  i=0
  UP=0
  while [ "$i" -lt 30 ]; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "--- ${LOG} の末尾 ---" >&2
      tail -20 "$LOG" >&2
      die "リクエストサーバが起動直後に落ちました（上のログを確認してください）"
    fi
    curl -s -o /dev/null --max-time 2 "http://localhost:$PORT/" && { UP=1; break; }
    i=$((i + 1))
    sleep 1
  done
  [ "$UP" -eq 1 ] || die "localhost:${PORT} が 30 秒以内に応答しませんでした（${LOG} を確認してください）"
  ok "起動しました（pid ${SERVER_PID}・ログは ${LOG}）"
fi

echo "── QR を LAN アドレスに差し替え ────────────────"
# deploy-lan.sh に本体の判定（IP 検出・鍵・疎通確認）を任せる。ここで二重に持たない。
# shellcheck disable=SC2086
LAN_ONESHOT=1 sh scripts/deploy-lan.sh $PASS_ARGS || die "LAN モードへの切り替えに失敗しました"
STARTED_LAN=1

echo "── control / VJ 窓を起動 ───────────────────────"
info "終了は Ctrl+C（自動で後片付けします）"
echo
sh scripts/live.sh

# Tauri が終了したら trap（cleanup）が走って元に戻る
