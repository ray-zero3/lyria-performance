// M7 プロンプト空間の純粋ロジック。
// 2D パッド上のピン（prompt）とカーソル（音像位置）からガウシアン減衰の
// 重み付きプロンプトを計算し、モーフ補間と immutable CRUD を提供する。
// このファイルは three / DOM / Svelte に依存しない（Vitest で完全にテスト可能）。
import { clamp01, clampRange, type WeightedPrompt } from "$lib/telemetry/contract";

/** パッド上のプロンプトピン（x,y は 0..1 正規化座標、radius はガウシアン σ）。 */
export interface Pin {
  id: string;
  text: string;
  x: number;
  y: number;
  radius: number;
  color?: string;
  /** 観客リクエスト由来のピンの投入者名（VJ の球体に表示）。省略時は通常ピン。 */
  nickname?: string;
  /** 観客リクエストの投入時刻（epoch ms。VJ の球体に時刻表示）。 */
  tMs?: number;
}

/** カーソル（音像位置、0..1 正規化）。 */
export interface Cursor {
  x: number;
  y: number;
}

/** 保存されたカーソル位置スナップショット（自動モーフ先）。 */
export interface Target {
  id: string;
  name: string;
  x: number;
  y: number;
}

// ---- M8: VJ 展開（表示オブジェクト / ポストエフェクト）----

/** M8: 表示/非表示できる VJ オブジェクトのキー（nebula/scan/corePulse は撤去。星座線は量スライダー化）。 */
export const VJ_OBJECT_KEYS = ["horizon"] as const;
export type VjObjectKey = (typeof VJ_OBJECT_KEYS)[number];
export type VjObjects = Partial<Record<VjObjectKey, boolean>>;

/** M8: ポストエフェクトのキー（各 0..1 強度）。timemachine/blob は TouchDesigner 風スクリーンスペース。 */
export const VJ_EFFECT_KEYS = [
  "glitch",
  "split",
  "rgbShift",
  "bloom",
  "scanline",
  "timemachine",
  "blob",
] as const;
export type VjEffectKey = (typeof VJ_EFFECT_KEYS)[number];
export type VjEffects = Partial<Record<VjEffectKey, number>>;

/** 既定: 全オブジェクト非表示。 */
export function defaultVjObjects(): Record<VjObjectKey, boolean> {
  return { horizon: false };
}

/** 既定: 全エフェクト 0（透過）。 */
export function defaultVjEffects(): Record<VjEffectKey, number> {
  return { glitch: 0, split: 0, rgbShift: 0, bloom: 0, scanline: 0, timemachine: 0, blob: 0 };
}

/** プロンプト空間の全状態（トランスポート/localStorage を流れる形）。 */
export interface PromptSpaceState {
  pins: Pin[];
  cursor: Cursor;
  targets: Target[];
  /** VJ カメラの激しさ 0..1（0=控えめオービット, 1=縦横無尽）。省略時 0。 */
  cameraEnergy?: number;
  /** VJ 床面のオーディオ反応 ON/OFF（OFF でも平衡感覚用に床は描画）。省略時 false。 */
  floorReactive?: boolean;
  /** M8: VJ 表示オブジェクトの ON/OFF（省略時 全 false）。 */
  vjObjects?: VjObjects;
  /** M8: VJ ポストエフェクト強度 0..1（省略時 全 0）。 */
  vjEffects?: VjEffects;
  /** 星座線（背景の星同士を流れ星のように結ぶ）の量 0..1。0=無し。省略時 0。 */
  constellationLines?: number;
}

/** 正規化重みがこの値未満のピンは送信から除外。 */
export const WEIGHT_THRESHOLD = 0.02;
/** 同時送信する weighted prompts の上限（Lyria 実用上限）。 */
export const MAX_ACTIVE_PROMPTS = 6;
export const DEFAULT_PIN_RADIUS = 0.28;
export const MIN_PIN_RADIUS = 0.05;
export const MAX_PIN_RADIUS = 1;
/** 状態として保持するピン/ターゲット数の防御上限。 */
export const MAX_PINS = 32;
export const MAX_TARGETS = 16;
/** ピンテキストの防御上限（生ログ/ラベル描画の暴走防止）。 */
export const MAX_TEXT_LEN = 200;

/** ピンごとの生ガウシアン値 exp(-d²/(2σ²))。空テキストは 0。 */
function rawWeights(pins: readonly Pin[], cursor: Cursor): number[] {
  return pins.map((p) => {
    if (p.text.trim().length === 0) return 0;
    const dx = p.x - cursor.x;
    const dy = p.y - cursor.y;
    const d2 = dx * dx + dy * dy;
    const r = p.radius > 0 && Number.isFinite(p.radius) ? p.radius : 1e-6;
    return Math.exp(-d2 / (2 * r * r));
  });
}

/**
 * 同一 text のエントリを1つに束ね、weight を合算する（出現順は先勝ち）。
 * 同じテキストのピンは複数置けるが、送信・表示の weighted prompts では text を一意にする。
 * （重複 text は Lyria への送信として無意味なうえ、text をキーにした keyed each を
 * 破綻させ control 窓が真っ黒になる実障害を起こした。）
 */
function mergeByText(entries: readonly { text: string; w: number }[]): { text: string; w: number }[] {
  const byText = new Map<string, { text: string; w: number }>();
  for (const e of entries) {
    const cur = byText.get(e.text);
    byText.set(e.text, cur ? { text: e.text, w: cur.w + e.w } : e);
  }
  return [...byText.values()];
}

/**
 * ピン＋カーソル → 送信用 weighted prompts。純粋。
 * 手順: 空テキスト除外 → ガウシアン raw → Σ正規化 → 同一 text 合算 → 閾値未満除外 → 上位 K → 再正規化（Σ=1）。
 * 全滅（アンダーフロー等）時は最近傍ピン weight=1 にフォールバック（無音化防止）。
 * 返り値の text は一意であることを保証する。
 */
export function computeWeights(pins: readonly Pin[], cursor: Cursor): WeightedPrompt[] {
  const usable = pins.filter((p) => p.text.trim().length > 0);
  if (usable.length === 0) return [];
  const raws = rawWeights(usable, cursor);
  const total = raws.reduce((s, v) => s + v, 0);
  const dist2 = (p: Pin): number => {
    const dx = p.x - cursor.x;
    const dy = p.y - cursor.y;
    return dx * dx + dy * dy;
  };
  if (!(total > 0)) {
    let nearest = usable[0];
    for (const p of usable) if (dist2(p) < dist2(nearest)) nearest = p;
    return [{ text: nearest.text.trim(), weight: 1 }];
  }
  const kept = mergeByText(usable.map((p, i) => ({ text: p.text.trim(), w: raws[i] / total })))
    .filter((e) => e.w >= WEIGHT_THRESHOLD)
    .sort((a, b) => b.w - a.w)
    .slice(0, MAX_ACTIVE_PROMPTS);
  if (kept.length === 0) {
    // 全ピンが閾値未満（多数の等距離ピン等）→ 最大 raw のみ残す
    let bi = 0;
    for (let i = 1; i < raws.length; i++) if (raws[i] > raws[bi]) bi = i;
    return [{ text: usable[bi].text.trim(), weight: 1 }];
  }
  const sum = kept.reduce((s, e) => s + e.w, 0);
  return kept.map((e) => ({ text: e.text, weight: e.w / sum }));
}

/**
 * ピン index に対応した正規化重み（Σ=1、閾値/topK 適用前）。純粋。
 * VJ シーンのピン可視化（浮上高さ・粒子量）用。空テキスト/全滅は 0。
 */
export function normalizedPinWeights(pins: readonly Pin[], cursor: Cursor): number[] {
  const raws = rawWeights(pins, cursor);
  const total = raws.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return raws.map(() => 0);
  return raws.map((v) => v / total);
}

/** カーソル→ターゲットの線形補間（progress 0..1 クランプ）。純粋。 */
export function morphStep(
  cursor: Cursor,
  target: { x: number; y: number },
  progress: number,
): Cursor {
  const t = clamp01(progress);
  return {
    x: cursor.x + (target.x - cursor.x) * t,
    y: cursor.y + (target.y - cursor.y) * t,
  };
}

/** ease-in-out（cubic）。自動モーフの進行に使う。純粋。 */
export function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

let idCounter = 0;
/** 衝突しにくい ID を生成（prefix-時刻36進-連番）。 */
export function makeId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** 初期状態: すぐ遊べるスターター4ピン＋中央カーソル（ID は決定的）。 */
export function defaultPromptSpaceState(): PromptSpaceState {
  return {
    pins: [
      { id: "pin-1", text: "warm analog pads", x: 0.2, y: 0.25, radius: DEFAULT_PIN_RADIUS },
      { id: "pin-2", text: "driving techno", x: 0.8, y: 0.25, radius: DEFAULT_PIN_RADIUS },
      { id: "pin-3", text: "ambient drone", x: 0.2, y: 0.75, radius: DEFAULT_PIN_RADIUS },
      { id: "pin-4", text: "jazzy chords", x: 0.8, y: 0.75, radius: DEFAULT_PIN_RADIUS },
    ],
    cursor: { x: 0.5, y: 0.5 },
    targets: [],
    cameraEnergy: 0,
    floorReactive: false,
    vjObjects: defaultVjObjects(),
    vjEffects: defaultVjEffects(),
    constellationLines: 0,
  };
}

function coerceString(v: unknown, fallback: string): string {
  if (typeof v === "string") return v.slice(0, MAX_TEXT_LEN);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function coerceNum01(v: unknown): number {
  return clamp01(typeof v === "number" ? v : NaN);
}

/** M8: vjObjects の防御整形（厳密 bool 化・未知キー破棄・未指定はデフォルト）。 */
function clampVjObjects(v: unknown): Record<VjObjectKey, boolean> {
  const o = (v ?? {}) as Record<string, unknown>;
  const out = defaultVjObjects();
  for (const k of VJ_OBJECT_KEYS) out[k] = o[k] === true;
  return out;
}

/** M8: vjEffects の防御整形（clamp01・未知キー破棄・未指定はデフォルト）。 */
function clampVjEffects(v: unknown): Record<VjEffectKey, number> {
  const o = (v ?? {}) as Record<string, unknown>;
  const out = defaultVjEffects();
  for (const k of VJ_EFFECT_KEYS) out[k] = coerceNum01(o[k]);
  return out;
}

/** 任意入力（transport/localStorage）を安全な PromptSpaceState に整形。決して throw しない。 */
export function clampPromptSpaceState(input: unknown): PromptSpaceState {
  if (input == null || typeof input !== "object") return defaultPromptSpaceState();
  const o = input as Record<string, unknown>;
  const pinsIn = Array.isArray(o.pins) ? o.pins.slice(0, MAX_PINS) : [];
  const pins: Pin[] = pinsIn.map((raw, i) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const radius =
      typeof p.radius === "number" && !Number.isNaN(p.radius)
        ? clampRange(p.radius, MIN_PIN_RADIUS, MAX_PIN_RADIUS)
        : DEFAULT_PIN_RADIUS;
    return {
      id: coerceString(p.id, `pin-${i}`),
      text: coerceString(p.text, ""),
      x: coerceNum01(p.x),
      y: coerceNum01(p.y),
      radius,
      ...(typeof p.color === "string" ? { color: p.color } : {}),
      ...(typeof p.nickname === "string" ? { nickname: p.nickname.slice(0, MAX_TEXT_LEN) } : {}),
      ...(typeof p.tMs === "number" && Number.isFinite(p.tMs) ? { tMs: p.tMs } : {}),
    };
  });
  const c = (o.cursor ?? {}) as Record<string, unknown>;
  const targetsIn = Array.isArray(o.targets) ? o.targets.slice(0, MAX_TARGETS) : [];
  const targets: Target[] = targetsIn.map((raw, i) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    return {
      id: coerceString(t.id, `target-${i}`),
      name: coerceString(t.name, `T${i + 1}`),
      x: coerceNum01(t.x),
      y: coerceNum01(t.y),
    };
  });
  return {
    pins,
    cursor: { x: coerceNum01(c.x), y: coerceNum01(c.y) },
    targets,
    cameraEnergy: coerceNum01(o.cameraEnergy),
    floorReactive: o.floorReactive === true,
    vjObjects: clampVjObjects(o.vjObjects),
    vjEffects: clampVjEffects(o.vjEffects),
    constellationLines: coerceNum01(o.constellationLines),
  };
}

// ---- immutable CRUD（すべて新しい state を返し、元は変更しない） ----

export function addPin(s: PromptSpaceState, pin: Pin): PromptSpaceState {
  if (s.pins.length >= MAX_PINS) return { ...s, pins: s.pins.slice() };
  return { ...s, pins: [...s.pins, { ...pin }] };
}

export function movePin(s: PromptSpaceState, id: string, x: number, y: number): PromptSpaceState {
  return {
    ...s,
    pins: s.pins.map((p) => (p.id === id ? { ...p, x: clamp01(x), y: clamp01(y) } : p)),
  };
}

export function removePin(s: PromptSpaceState, id: string): PromptSpaceState {
  return { ...s, pins: s.pins.filter((p) => p.id !== id) };
}

export function updatePinText(s: PromptSpaceState, id: string, text: string): PromptSpaceState {
  const t = text.slice(0, MAX_TEXT_LEN);
  return { ...s, pins: s.pins.map((p) => (p.id === id ? { ...p, text: t } : p)) };
}

export function updatePinRadius(
  s: PromptSpaceState,
  id: string,
  radius: number,
): PromptSpaceState {
  const r = clampRange(radius, MIN_PIN_RADIUS, MAX_PIN_RADIUS);
  return { ...s, pins: s.pins.map((p) => (p.id === id ? { ...p, radius: r } : p)) };
}

export function moveCursor(s: PromptSpaceState, x: number, y: number): PromptSpaceState {
  return { ...s, cursor: { x: clamp01(x), y: clamp01(y) } };
}

/** VJ カメラの激しさ（0..1）を設定した新状態を返す。 */
export function setCameraEnergy(s: PromptSpaceState, energy: number): PromptSpaceState {
  return { ...s, cameraEnergy: clamp01(energy) };
}

/** VJ 床面のオーディオ反応 ON/OFF を設定した新状態を返す。 */
export function setFloorReactive(s: PromptSpaceState, on: boolean): PromptSpaceState {
  return { ...s, floorReactive: on };
}

/** 星座線（流れ星）の量 0..1 を設定した新状態を返す。 */
export function setConstellationLines(s: PromptSpaceState, amount: number): PromptSpaceState {
  return { ...s, constellationLines: clamp01(amount) };
}

/** M8: VJ 表示オブジェクトの ON/OFF を設定した新状態を返す（未指定キーはデフォルトで埋める）。 */
export function setVjObject(s: PromptSpaceState, key: VjObjectKey, on: boolean): PromptSpaceState {
  return { ...s, vjObjects: { ...defaultVjObjects(), ...s.vjObjects, [key]: on } };
}

/** M8: VJ ポストエフェクト強度（0..1 clamp）を設定した新状態を返す。 */
export function setVjEffect(
  s: PromptSpaceState,
  key: VjEffectKey,
  amount: number,
): PromptSpaceState {
  return { ...s, vjEffects: { ...defaultVjEffects(), ...s.vjEffects, [key]: clamp01(amount) } };
}

export function addTarget(s: PromptSpaceState, target: Target): PromptSpaceState {
  if (s.targets.length >= MAX_TARGETS) return { ...s, targets: s.targets.slice() };
  return { ...s, targets: [...s.targets, { ...target }] };
}

export function removeTarget(s: PromptSpaceState, id: string): PromptSpaceState {
  return { ...s, targets: s.targets.filter((t) => t.id !== id) };
}
