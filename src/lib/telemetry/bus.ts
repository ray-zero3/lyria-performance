import type { HubState, TelemetryEvent, TelemetryFrame } from "./contract";
import type { PromptSpaceState } from "$lib/prompts/promptSpace";
import { createBrowserTransport } from "./browserTransport";
import { createTauriTransport } from "./tauriTransport";
import { isTauriRuntime } from "$lib/platform";

export interface TelemetryTransport {
  pushFrame(frame: TelemetryFrame): void;
  pushEvent(event: TelemetryEvent): void;
  /** M7: プロンプト空間の不透明中継（control → vj、変更時＋ハートビート）。 */
  pushPromptSpace(space: PromptSpaceState): void;
  onFrame(cb: (f: TelemetryFrame) => void): void;
  onEvent(cb: (e: TelemetryEvent) => void): void;
  onPromptSpace(cb: (s: PromptSpaceState) => void): void;
  onState(cb: (s: HubState) => void): void;
  getState(): Promise<HubState>;
  setState(patch: Partial<HubState>): void;
  dispose(): void;
}

export function createTransport(role: "control" | "vj"): TelemetryTransport {
  return isTauriRuntime() ? createTauriTransport(role) : createBrowserTransport(role);
}
