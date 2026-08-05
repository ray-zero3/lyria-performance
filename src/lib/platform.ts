/**
 * Tauri v2 のランタイム（webview）内で動作しているかを判定。
 *
 * Tauri v2 は `withGlobalTauri=false`（既定）だと `window.__TAURI__` を注入しない。
 * 一方、webview には常に `window.isTauri`（真偽フラグ）と `window.__TAURI_INTERNALS__` が
 * 注入される（`@tauri-apps/api` の invoke/listen はこれらを使う）。
 * そのため `"__TAURI__" in window` だけで判定するとブラウザ扱いに誤フォールバックする。
 * ここでは公式フラグ・内部グローバル・旧グローバルのいずれかで真とする。
 */
export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return w.isTauri === true || "__TAURI_INTERNALS__" in w || "__TAURI__" in w;
}
