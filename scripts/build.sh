#!/bin/sh
# 本番ビルド一式（型チェック → テスト → VJ/control → request-app）。
#
# 重要: dev サーバ稼働中に実行してはいけない。
# vite dev と本番ビルドは .svelte-kit を共有しているため、ビルドが生成物を作り直すと
# 稼働中の webview に大量の page reload が飛び、Tauri の窓が白くなって操作できなくなる
# （実際にやって control 窓が真っ白になった）。そのため先にプロセスを検出して止める。
set -e
cd "$(dirname "$0")/.." || exit 1

if pgrep -f 'target/debug/lyria-vj' >/dev/null 2>&1 || pgrep -f 'vite dev' >/dev/null 2>&1; then
  echo "" >&2
  echo "  ✗ Tauri / vite dev が稼働中です。ビルドすると webview が壊れます。" >&2
  echo "    先に Tauri の窓を閉じてから実行してください（あとで npm run live で戻せます）。" >&2
  echo "" >&2
  exit 1
fi

echo "── 型チェック ──"
npm run check
echo "── テスト（VJ/control）──"
npm test
echo "── テスト（request-app）──"
npm --prefix request-app test
echo "── ビルド（VJ/control）──"
npm run build
echo "── ビルド（request-app）──"
npm --prefix request-app run build
echo ""
echo "  ✓ ビルド完了。起動は npm run show:serve（ターミナル1）と npm run live（ターミナル2）"
