#!/bin/sh
# 観客リクエストページの外部公開（Tailscale Funnel）を操作する。
# 使い方: sh scripts/funnel.sh {open|close|status}
set -u
cd "$(dirname "$0")/.." || exit 1

TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -x "$TS" ] || TS="$(command -v tailscale 2>/dev/null || true)"
if [ -z "$TS" ]; then
  echo "tailscale コマンドが見つかりません" >&2
  exit 1
fi
PORT=3000

case "${1:-status}" in
  open)
    # 本番サーバが上がっていない状態で公開すると観客に 502 が出るため先に確認する
    if ! curl -s -o /dev/null --max-time 3 "http://localhost:$PORT/" ; then
      echo "警告: localhost:$PORT が応答しません。先に npm run show:serve を実行してください" >&2
    fi
    "$TS" funnel --bg "$PORT"
    echo
    echo "QR に載る URL は .env の VITE_REQUEST_URL です。ホスト名を変えた場合は更新して Tauri を再起動:"
    grep -E '^VITE_REQUEST_URL=' .env 2>/dev/null | sed 's/?k=.*/?k=…(鍵は非表示)/' | sed 's/^/  /'
    ;;
  close)
    "$TS" funnel --https=443 off
    echo "公開を停止しました。"
    echo "マシン名を元に戻す場合: $TS set --hostname=<元のマシン名>"
    ;;
  status)
    "$TS" funnel status
    ;;
  *)
    echo "使い方: sh scripts/funnel.sh {open|close|status}" >&2
    exit 1
    ;;
esac
