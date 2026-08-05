import { defineConfig } from "vitest/config";

// Nitro の auto-import に依存しない「純粋ロジックのみ」を対象にする。
// （useRuntimeConfig / createError を使うファイルは E2E（curl）側で検証する）
export default defineConfig({
  test: {
    include: ["server/**/*.test.ts"],
    environment: "node",
  },
});
