import {
  defaultHubState,
  type HubState,
  type TelemetryEvent,
  type TelemetryFrame,
} from "./contract";
import type { PromptSpaceState } from "$lib/prompts/promptSpace";
import type { TelemetryTransport } from "./bus";

export interface ChannelLike {
  postMessage(data: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close(): void;
}

type Msg =
  | { t: "frame"; frame: TelemetryFrame }
  | { t: "event"; event: TelemetryEvent }
  | { t: "promptSpace"; space: PromptSpaceState } // M7: プロンプト空間中継
  | { t: "state"; state: HubState }
  | { t: "getState" }; // vj → control 要求。control は "state" で応答。

const CHANNEL_NAME = "lyria-vj-telemetry";

function defaultFactory(): ChannelLike {
  return new BroadcastChannel(CHANNEL_NAME) as unknown as ChannelLike;
}

/**
 * ブラウザ検証用トランスポート。
 * control ロールが hub を代行（HubState を保持し getState/state を応答）。
 */
export function createBrowserTransport(
  role: "control" | "vj",
  channelFactory: () => ChannelLike = defaultFactory,
): TelemetryTransport {
  const ch = channelFactory();
  const frameCbs: Array<(f: TelemetryFrame) => void> = [];
  const eventCbs: Array<(e: TelemetryEvent) => void> = [];
  const spaceCbs: Array<(s: PromptSpaceState) => void> = [];
  const stateCbs: Array<(s: HubState) => void> = [];
  let localState: HubState = defaultHubState(); // control が権威

  ch.onmessage = (ev) => {
    const m = ev.data as Msg;
    if (!m || typeof m !== "object") return;
    switch (m.t) {
      case "frame":
        for (const cb of frameCbs) cb(m.frame);
        break;
      case "event":
        for (const cb of eventCbs) cb(m.event);
        break;
      case "promptSpace":
        for (const cb of spaceCbs) cb(m.space);
        break;
      case "state":
        localState = m.state;
        for (const cb of stateCbs) cb(m.state);
        break;
      case "getState":
        if (role === "control") {
          ch.postMessage({ t: "state", state: localState } satisfies Msg);
        }
        break;
    }
  };

  return {
    pushFrame(frame) {
      ch.postMessage({ t: "frame", frame } satisfies Msg);
    },
    pushEvent(event) {
      ch.postMessage({ t: "event", event } satisfies Msg);
    },
    pushPromptSpace(space) {
      ch.postMessage({ t: "promptSpace", space } satisfies Msg);
    },
    onFrame(cb) {
      frameCbs.push(cb);
    },
    onEvent(cb) {
      eventCbs.push(cb);
    },
    onPromptSpace(cb) {
      spaceCbs.push(cb);
    },
    onState(cb) {
      stateCbs.push(cb);
    },
    getState() {
      if (role === "control") return Promise.resolve(localState);
      return new Promise<HubState>((resolve) => {
        let settled = false;
        const finish = (s: HubState) => {
          if (settled) return;
          settled = true;
          resolve(s);
        };
        const prev = ch.onmessage;
        ch.onmessage = (ev) => {
          prev?.(ev);
          const m = ev.data as Msg;
          if (m && m.t === "state") finish(m.state);
        };
        ch.postMessage({ t: "getState" } satisfies Msg);
        // 応答が無ければデフォルトへフォールバック
        setTimeout(() => finish(defaultHubState()), 300);
      });
    },
    setState(patch) {
      localState = { ...localState, ...patch } as HubState;
      ch.postMessage({ t: "state", state: localState } satisfies Msg);
      for (const cb of stateCbs) cb(localState);
    },
    dispose() {
      ch.close();
    },
  };
}
