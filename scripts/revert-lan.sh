#!/bin/sh
# deploy-lan.sh でやったことを元に戻す（.env の VITE_REQUEST_URL を復元）。
# Tailscale / Funnel は触らない（LAN モードでも触っていないため）。
#
# 使い方:
#   sh scripts/revert-lan.sh
set -u
cd "$(dirname "$0")/.." || exit 1

STATE=.lan-state

case "${1:-}" in
  -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "不明な引数: $1" >&2; exit 1 ;;
esac

NG=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; NG=$((NG + 1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

mask() { printf '%s' "$1" | sed -E 's/([?&]k=)[^&]+/\1***/g'; }

# 状態ファイルは source せずに grep で読む（値に任意の文字が入っていても安全に扱うため）
state_value() { grep -E "^$1=" "$STATE" 2>/dev/null | head -1 | cut -d= -f2-; }

echo "── 1. .env の VITE_REQUEST_URL を復元 ───────────"
if [ ! -f "$STATE" ]; then
  warn "$STATE がありません（LAN モードにしていない、または既に戻し済み）"
elif [ ! -f .env ]; then
  bad ".env がありません"
elif [ "$(state_value HAD_URL)" = "no" ]; then
  # LAN モードにする前は行そのものが無かったので、追加した行を消す
  if grep -qE '^VITE_REQUEST_URL=' .env; then
    grep -vE '^VITE_REQUEST_URL=' .env > "$STATE.tmp" && cat "$STATE.tmp" > .env && rm -f "$STATE.tmp" \
      && ok "追加した VITE_REQUEST_URL の行を削除しました" \
      || bad ".env の更新に失敗しました"
  else
    ok "VITE_REQUEST_URL は元から無い状態です"
  fi
else
  ORIG_URL=$(state_value ORIG_URL)
  ORIG_URL="$ORIG_URL" awk '
    /^VITE_REQUEST_URL=/ { print "VITE_REQUEST_URL=" ENVIRON["ORIG_URL"]; next }
    { print }
  ' .env > "$STATE.tmp" && cat "$STATE.tmp" > .env && rm -f "$STATE.tmp" \
    && ok "VITE_REQUEST_URL を復元しました: $(mask "$ORIG_URL")" \
    || bad ".env の復元に失敗しました"
fi

echo "── 2. 後片付け ─────────────────────────────────"
if [ "$NG" -eq 0 ] && [ -f "$STATE" ]; then
  rm -f "$STATE" && ok "$STATE を削除しました"
elif [ -f "$STATE" ]; then
  warn "$STATE は残しました（未解決の項目があるため。解消後に再実行してください）"
fi

echo "─────────────────────────────────────────────────"
if [ "$NG" -eq 0 ]; then
  printf '  \033[32m元に戻しました\033[0m\n'
  # 一発起動（demo-lan.sh）の後片付けから呼ばれた場合、Tauri は既に閉じているので案内しない。
  [ "${LAN_ONESHOT:-0}" = "1" ] || echo "  QR を使う場合は Tauri の再起動を忘れずに（npm run live）"
else
  printf '  \033[31m%d 件が未解決です。上の ✗ を見てください\033[0m\n' "$NG"
  exit 1
fi
