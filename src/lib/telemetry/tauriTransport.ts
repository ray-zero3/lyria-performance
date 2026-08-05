import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { HubState, TelemetryEvent, TelemetryFrame } from "./contract";
import type { PromptSpaceState } from "$lib/prompts/promptSpace";
import type { TelemetryTransport } from "./bus";

/**
 * 本番トランスポート。
 * control: pushFrame/pushEvent → invoke("push_frame"/"push_event")（Rust hub が vj へ emit_to）。
 * vj: listen("frame"/"event"/"state")。getState → invoke("get_state")。
 * setState → invoke("set_state")（hub が state をブロードキャスト）。
 */
export function createTauriTransport(_role: "control" | "vj"): TelemetryTransport {
  const unlisteners: Array<Promise<() => void>> = [];

  return {
    pushFrame(frame) {
      void invoke("push_frame", { frame });
    },
    pushEvent(event) {
      void invoke("push_event", { event });
    },
    pushPromptSpace(space) {
      void invoke("push_prompt_space", { space });
    },
    onFrame(cb) {
      unlisteners.push(listen<TelemetryFrame>("frame", (e) => cb(e.payload)));
    },
    onEvent(cb) {
      unlisteners.push(listen<TelemetryEvent>("event", (e) => cb(e.payload)));
    },
    onPromptSpace(cb) {
      unlisteners.push(listen<PromptSpaceState>("prompt_space", (e) => cb(e.payload)));
    },
    onState(cb) {
      unlisteners.push(listen<HubState>("state", (e) => cb(e.payload)));
    },
    getState() {
      return invoke<HubState>("get_state");
    },
    setState(patch) {
      void invoke("set_state", { patch });
    },
    dispose() {
      for (const u of unlisteners) void u.then((fn) => fn());
    },
  };
}
