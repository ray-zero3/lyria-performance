#!/bin/sh
# deploy-funnel.sh でやったことを元に戻す（公開停止 → マシン名を復元 → .env を復元）。
#
# 使い方:
#   sh scripts/revert-funnel.sh [--hostname <元の名前>]
#     --hostname  .funnel-state が無い/壊れている場合に、戻す名前を明示する
#
# deploy が途中で失敗した場合でも使える。各手順は独立していて、
# 途中でコケても残りを続行し、最後にまとめて結果を報告する。
set -u
cd "$(dirname "$0")/.." || exit 1

STATE=.funnel-state
FORCE_HOST=""

while [ $# -gt 0 ]; do
  case "$1" in
    --hostname) shift; FORCE_HOST="${1:-}" ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
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

NG=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; NG=$((NG + 1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

mask() { printf '%s' "$1" | sed -E 's/([?&]k=)[^&]+/\1***/g'; }

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

# 状態ファイルは source せずに grep で読む（値に任意の文字が入っていても安全に扱うため）
state_value() { grep -E "^$1=" "$STATE" 2>/dev/null | head -1 | cut -d= -f2-; }

ORIG_HOST=""
HAD_URL=""
ORIG_URL=""
if [ -f "$STATE" ]; then
  ORIG_HOST=$(state_value ORIG_HOST)
  HAD_URL=$(state_value HAD_URL)
  ORIG_URL=$(state_value ORIG_URL)
else
  warn "$STATE がありません（deploy を通していない、または既に戻し済み）"
fi
[ -n "$FORCE_HOST" ] && ORIG_HOST="$FORCE_HOST"

echo "── 1. 公開を停止 ────────────────────────────────"
if "$TS" funnel --https=443 off >/dev/null 2>&1; then
  ok "Funnel を停止しました"
else
  warn "Funnel は既に停止しているか、停止に失敗しました（status で確認してください）"
fi

echo "── 2. マシン名を復元 ────────────────────────────"
if [ -z "$ORIG_HOST" ]; then
  bad "戻すマシン名が分かりません。--hostname <名前> を付けて再実行してください
    （元の名前は Tailscale の管理画面 https://login.tailscale.com/admin/machines でも確認できます）"
else
  CUR="$(self_fqdn)"
  if [ "${CUR%%.*}" = "$ORIG_HOST" ]; then
    ok "マシン名は既に $ORIG_HOST です"
  elif "$TS" set --hostname="$ORIG_HOST"; then
    i=0
    NEWCUR=""
    while [ "$i" -lt 30 ]; do
      NEWCUR=$(self_fqdn)
      [ "${NEWCUR%%.*}" = "$ORIG_HOST" ] && break
      i=$((i + 1))
      sleep 1
      NEWCUR=""
    done
    if [ -n "$NEWCUR" ]; then
      ok "マシン名を $ORIG_HOST に戻しました"
    else
      bad "改名は通りましたが反映を確認できませんでした（$TS status で確認してください）"
    fi
  else
    bad "マシン名の復元に失敗しました（手動: $TS set --hostname=${ORIG_HOST}）"
  fi
fi

echo "── 3. .env の VITE_REQUEST_URL を復元 ───────────"
if [ ! -f "$STATE" ]; then
  warn "状態ファイルが無いため .env は触りません（必要なら手で戻してください）"
elif [ ! -f .env ]; then
  bad ".env がありません"
elif [ "$HAD_URL" = "no" ]; then
  # deploy 前は行そのものが無かったので、追加した行を消す
  if grep -qE '^VITE_REQUEST_URL=' .env; then
    grep -vE '^VITE_REQUEST_URL=' .env > "$STATE.tmp" && cat "$STATE.tmp" > .env && rm -f "$STATE.tmp" \
      && ok "追加した VITE_REQUEST_URL の行を削除しました" \
      || bad ".env の更新に失敗しました"
  else
    ok "VITE_REQUEST_URL は元から無い状態です"
  fi
else
  ORIG_URL="$ORIG_URL" awk '
    /^VITE_REQUEST_URL=/ { print "VITE_REQUEST_URL=" ENVIRON["ORIG_URL"]; next }
    { print }
  ' .env > "$STATE.tmp" && cat "$STATE.tmp" > .env && rm -f "$STATE.tmp" \
    && ok "VITE_REQUEST_URL を復元しました: $(mask "$ORIG_URL")" \
    || bad ".env の復元に失敗しました"
fi

echo "── 4. 後片付け ─────────────────────────────────"
if [ "$NG" -eq 0 ] && [ -f "$STATE" ]; then
  rm -f "$STATE" && ok "$STATE を削除しました"
elif [ -f "$STATE" ]; then
  warn "$STATE は残しました（未解決の項目があるため。解消後に再実行してください）"
fi

echo "─────────────────────────────────────────────────"
if [ "$NG" -eq 0 ]; then
  printf '  \033[32m元に戻しました\033[0m\n'
  echo "  QR を使う場合は Tauri の再起動を忘れずに（npm run live）"
else
  printf '  \033[31m%d 件が未解決です。上の ✗ を見てください\033[0m\n' "$NG"
  exit 1
fi
