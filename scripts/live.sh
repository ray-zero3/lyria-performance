#!/bin/sh
# control 窓 + VJ 窓（Tauri）を起動する。
# Rust 側は process env の GEMINI_API_KEY を読むため、.env の VITE_GEMINI_API_KEY を渡し直す
# （フロント側の VITE_* は Vite が .env から自動で読む）。
set -u
cd "$(dirname "$0")/.." || exit 1

if [ ! -f .env ]; then
  echo ".env がありません（cp .env.example .env して鍵を入れてください）" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

if [ -z "${VITE_GEMINI_API_KEY:-}" ]; then
  echo "警告: VITE_GEMINI_API_KEY が空です。Lyria には繋がりません（MockLyria なら動きます）" >&2
fi
if [ -z "${VITE_CUE_TOKEN:-}" ]; then
  echo "警告: VITE_CUE_TOKEN が空です。観客リクエストが control 窓に表示されません" >&2
fi

GEMINI_API_KEY="${GEMINI_API_KEY:-${VITE_GEMINI_API_KEY:-}}" exec npm run tauri dev
