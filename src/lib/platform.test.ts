import { describe, it, expect, vi, afterEach } from "vitest";
import { isTauriRuntime } from "./platform";

// vitest 環境は node（window 無し）。window をスタブして各グローバルの有無を検証する。
describe("isTauriRuntime（Tauri v2 検出）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("window 無し（node/SSR）は false", () => {
    expect(isTauriRuntime()).toBe(false);
  });

  it("window はあるがフラグ無し（ブラウザ dev）は false", () => {
    vi.stubGlobal("window", {});
    expect(isTauriRuntime()).toBe(false);
  });

  it("window.isTauri === true で true（公式フラグ）", () => {
    vi.stubGlobal("window", { isTauri: true });
    expect(isTauriRuntime()).toBe(true);
  });

  it("__TAURI_INTERNALS__ 注入で true（withGlobalTauri=false でも webview に存在）", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    expect(isTauriRuntime()).toBe(true);
  });

  it("旧 __TAURI__ グローバルでも true（withGlobalTauri=true / v1 互換）", () => {
    vi.stubGlobal("window", { __TAURI__: {} });
    expect(isTauriRuntime()).toBe(true);
  });
});
