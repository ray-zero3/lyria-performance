import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "$lib/platform";

/**
 * GEMINI_API_KEY を取得。Tauri は Rust の env（get_api_key）を優先し、
 * 空/失敗なら VITE_GEMINI_API_KEY にフォールバック（dev の .env 運用）。未設定は空文字。
 */
export async function getApiKey(): Promise<string> {
  if (isTauriRuntime()) {
    try {
      const k = await invoke<string>("get_api_key");
      if (k) return k; // Rust env に GEMINI_API_KEY があれば優先
    } catch {
      /* フォールバックへ */
    }
  }
  const env = import.meta.env as Record<string, string | undefined>;
  return env.VITE_GEMINI_API_KEY ?? "";
}
