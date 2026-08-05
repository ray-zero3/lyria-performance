export const SPECTRUM_BINS = 48;
export const WAVEFORM_SAMPLES = 256;
export const DURATION_CAP_MS = 600_000; // 10分
export const ROTATE_AT_MS = 480_000; // ~8分でローテ目標（M5）

// M5: クロスフェード・トランジションのタイミング（ms）
export const CROSSFADE_LEAD_MS = 2000; // ドラム消し＋リバーブwashの助走
export const CROSSFADE_FADE_MS = 4000; // equal-power クロスフェード本体（~4s）
export const CROSSFADE_TAIL_MS = 2000; // リバーブwashの余韻＋新セッションのドラム復帰
export const INCOMING_AUDIO_TIMEOUT_MS = 8000; // 新セッションの最初のチャンクが来ない時の中止

// M5: 手続き的リバーブ IR
export const REVERB_SECONDS = 2.5;
export const REVERB_DECAY = 2.0;

// M5b: マスターFXチェーン / カオス演出
export const CHAOS_PEAK = 0.8; // トランジションのカオス強度ピーク（plan.wetPeak に渡す）
export const STUTTER_DIVISION = 0.5; // ビートリピートのスライス長（拍の分数: 0.5=1/8音符）
export const DELAY_TIME_S = 0.18; // ディレイ時間（秒）
