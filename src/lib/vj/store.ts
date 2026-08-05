import {
  clampFrame,
  defaultHubState,
  type HubState,
  type TelemetryEvent,
  type TelemetryFrame,
} from "$lib/telemetry/contract";
import { clampPromptSpaceState, type PromptSpaceState } from "$lib/prompts/promptSpace";

const EVENT_RING = 64;

export interface VjSnapshot {
  state: HubState;
  frame: TelemetryFrame;
  events: TelemetryEvent[];
  /** M7: last-known プロンプト空間（未受信は null）。 */
  promptSpace: PromptSpaceState | null;
  lastSeq: number;
  drops: number;
}

export interface VjStore {
  applyState(s: HubState): void;
  applyFrame(input: unknown): void;
  applyPromptSpace(input: unknown): void;
  pushEvent(e: TelemetryEvent): void;
  snapshot(): VjSnapshot;
}

export function createVjStore(): VjStore {
  let state: HubState = defaultHubState();
  let frame: TelemetryFrame = clampFrame(null); // seq=0 のゼロフレーム
  let promptSpace: PromptSpaceState | null = null;
  let lastSeq = 0;
  let drops = 0;
  const events: TelemetryEvent[] = [];

  return {
    applyState(s: HubState) {
      state = s;
    },
    applyPromptSpace(input: unknown) {
      // 境界で防御的に整形（不正入力でも throw せず last-known を更新）
      promptSpace = clampPromptSpaceState(input);
    },
    applyFrame(input: unknown) {
      const next = clampFrame(input);
      // seq が後退/同一なら stale として無視（last-known 維持）
      if (next.seq <= lastSeq) return;
      if (lastSeq > 0 && next.seq > lastSeq + 1) {
        drops += next.seq - lastSeq - 1;
      }
      lastSeq = next.seq;
      frame = next;
    },
    pushEvent(e: TelemetryEvent) {
      events.push(e);
      if (events.length > EVENT_RING) {
        events.splice(0, events.length - EVENT_RING);
      }
    },
    snapshot(): VjSnapshot {
      return { state, frame, events: events.slice(), promptSpace, lastSeq, drops };
    },
  };
}
