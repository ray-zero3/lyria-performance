import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "$lib/platform";
import type { MidiMessage } from "./types";

export interface MidiBus {
  onMessage(cb: (m: MidiMessage) => void): void;
  listPorts(): Promise<string[]>;
  openPort(index: number): Promise<string>;
  closePort(): Promise<void>;
  /** 合成 MIDI（ブラウザ検証・実機なしテスト用）。 */
  inject(m: MidiMessage): void;
  dispose(): void;
}

export function createMidiBus(): MidiBus {
  const cbs: Array<(m: MidiMessage) => void> = [];
  let unlisten: Promise<() => void> | null = null;
  if (isTauriRuntime()) {
    unlisten = listen<MidiMessage>("midi", (e) => {
      for (const cb of cbs) cb(e.payload);
    });
  }
  return {
    onMessage(cb) {
      cbs.push(cb);
    },
    async listPorts() {
      if (isTauriRuntime()) {
        try {
          return await invoke<string[]>("list_midi_ports");
        } catch {
          return [];
        }
      }
      return ["(synthetic)"];
    },
    async openPort(index) {
      if (isTauriRuntime()) return await invoke<string>("open_midi_port", { index });
      return "(synthetic)";
    },
    async closePort() {
      if (isTauriRuntime()) {
        try {
          await invoke("close_midi_port");
        } catch {
          /* ignore */
        }
      }
    },
    inject(m) {
      for (const cb of cbs) cb(m);
    },
    dispose() {
      if (unlisten) void unlisten.then((fn) => fn());
    },
  };
}
