export interface MidiMessage {
  kind: "cc" | "note";
  channel: number; // 0-15
  id: number; // CC番号 or ノート番号 0-127
  value: number; // CC値 or ベロシティ 0-127
  on: boolean; // note on/off
}

export type ContinuousTarget =
  | "bpm"
  | "guidance"
  | "density"
  | "brightness"
  | "temperature"
  // M5b: マスターFX（0..1）
  | "chaos"
  | "fxReverb"
  | "fxStutter"
  | "fxFilter"
  | "fxDelay"
  // M7: プロンプト空間カーソル（0..1。promptWeight はパッド置換で廃止）
  | "cursorX"
  | "cursorY"
  // VJ パラメータ（0..1）: カメラ激しさ / 星座線 / ポストエフェクト各種
  | "cameraEnergy"
  | "constellation"
  | "vjGlitch"
  | "vjSplit"
  | "vjRgbShift"
  | "vjBloom"
  | "vjScanline"
  | "vjTimemachine"
  | "vjBlob";

export type ActionTarget =
  | "reset_context"
  | "play_toggle"
  | "mute_bass"
  | "mute_drums"
  | "rotate"
  // M6: VJ シーン切替
  | "scene_next"
  // M7: 次ターゲットへ自動モーフ
  | "morph_next"
  // VJ トグル（トリガで ON/OFF 反転）
  | "floorReactive"
  | "vjHorizon";

export type MidiTarget = ContinuousTarget | ActionTarget;

/** key: "cc:ch:id" | "note:ch:id" → target */
export type MidiMapping = Record<string, MidiTarget>;

export const CONTINUOUS_TARGETS: ContinuousTarget[] = [
  "bpm",
  "guidance",
  "density",
  "brightness",
  "temperature",
  "chaos",
  "fxReverb",
  "fxStutter",
  "fxFilter",
  "fxDelay",
  "cursorX",
  "cursorY",
  "cameraEnergy",
  "constellation",
  "vjGlitch",
  "vjSplit",
  "vjRgbShift",
  "vjBloom",
  "vjScanline",
  "vjTimemachine",
  "vjBlob",
];

export const ACTION_TARGETS: ActionTarget[] = [
  "reset_context",
  "play_toggle",
  "mute_bass",
  "mute_drums",
  "rotate",
  "scene_next",
  "morph_next",
  "floorReactive",
  "vjHorizon",
];
