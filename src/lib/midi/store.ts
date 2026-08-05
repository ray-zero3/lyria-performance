import { midiKey } from "./mapping";
import type { MidiMapping, MidiMessage, MidiTarget } from "./types";

const KEY = "lyria-vj-midi-mapping";

export function loadMapping(): MidiMapping {
  try {
    const s = localStorage.getItem(KEY);
    return s ? (JSON.parse(s) as MidiMapping) : {};
  } catch {
    return {};
  }
}

export function saveMapping(m: MidiMapping): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

/** 指定 msg を target に束縛した新しいマップを返す（同一 target の既存束縛は解除）。純粋。 */
export function bind(
  mapping: MidiMapping,
  msg: Pick<MidiMessage, "kind" | "channel" | "id">,
  target: MidiTarget,
): MidiMapping {
  const next: MidiMapping = {};
  for (const [k, v] of Object.entries(mapping)) {
    if (v !== target) next[k] = v;
  }
  next[midiKey(msg)] = target;
  return next;
}

/** 指定 target の束縛を解除した新しいマップを返す（未束縛なら実質そのまま）。純粋。 */
export function unbind(mapping: MidiMapping, target: MidiTarget): MidiMapping {
  const next: MidiMapping = {};
  for (const [k, v] of Object.entries(mapping)) {
    if (v !== target) next[k] = v;
  }
  return next;
}
