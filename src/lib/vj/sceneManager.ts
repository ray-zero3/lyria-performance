import { clamp01, type SessionState } from "$lib/telemetry/contract";
import type { VisualParams } from "./visualMapping";

/** manager から見たシーン操作面（three 非依存）。 */
export interface ManagedScene {
  update(vp: VisualParams, dtMs: number): void;
  setDissolve(amount: number): void;
  flash(): void;
  /** シーン全体の不透明度 0..1（クロスフェード用）。未実装のシーンはフェードせず常時全表示。 */
  setOpacity?(amount: number): void;
}

export interface SceneEntry {
  id: string;
  scene: ManagedScene;
}

export interface SceneManagerOptions {
  /** 手動切替フラッシュの継続時間（ms）。 */
  flashMs?: number;
  /** rotate 完了時に次シーンへ自動切替（溶解中に入れ替わるシームレス演出）。 */
  autoSwitchOnRotate?: boolean;
  /** 溶解の追従時定数（ms）。 */
  dissolveEaseMs?: number;
  /** シーン切替クロスフェードの時間（ms）。 */
  fadeMs?: number;
}

export interface SceneFrameInput {
  sessionState: SessionState;
  /** chaosToDissolve 済みの目標溶解量 0..1。 */
  dissolveTarget: number;
}

export interface SceneManager {
  ids(): readonly string[];
  current(): string;
  next(): void;
  setScene(id: string): void;
  frame(vp: VisualParams, input: SceneFrameInput, dtMs: number): void;
  dissolve(): number;
  flashRemainingMs(): number;
  /** クロスフェードを考慮した可視判定（遷移中は新旧 2 シーンが true）。 */
  isVisible(id: string): boolean;
}

export const DEFAULT_FLASH_MS = 250;
export const DEFAULT_DISSOLVE_EASE_MS = 600;
/** シーン切替クロスフェードの既定時間（ms、live 調整ポイント）。 */
export const DEFAULT_SCENE_FADE_MS = 900;
/** この不透明度未満のシーンは描画から外す（ムダな描画の回避）。 */
export const FADE_VISIBLE_EPS = 0.001;

// ---- クロスフェード遷移の純粋ロジック（three 非依存・テスト可能） ----

/** シーン・クロスフェードの遷移状態（純データ）。null = 遷移なし。 */
export interface FadeTransition {
  fromIndex: number;
  toIndex: number;
  /** 遷移開始からの経過 ms。 */
  elapsedMs: number;
}

/** 遷移を dt だけ進める。完了（elapsed >= fadeMs）で null。不正 dt は進めない。純粋。 */
export function advanceFade(
  t: FadeTransition | null,
  dtMs: number,
  fadeMs: number = DEFAULT_SCENE_FADE_MS,
): FadeTransition | null {
  if (!t) return null;
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
  const elapsed = t.elapsedMs + dt;
  return elapsed >= fadeMs ? null : { ...t, elapsedMs: elapsed };
}

/** 遷移の進行度 0..1（smoothstep 整形）。遷移なしは 1（=完了）。純粋。 */
export function fadeProgress(
  t: FadeTransition | null,
  fadeMs: number = DEFAULT_SCENE_FADE_MS,
): number {
  if (!t) return 1;
  const u = clamp01(t.elapsedMs / Math.max(1, fadeMs));
  return u * u * (3 - 2 * u); // smoothstep（両端で速度 0 の滑らかな立ち上がり）
}

/**
 * 各シーン index の不透明度。遷移中: from は 1→0、to は 0→1、他は 0。
 * 遷移なし: currentIndex のみ 1。純粋。
 */
export function sceneOpacities(
  count: number,
  currentIndex: number,
  t: FadeTransition | null,
  fadeMs: number = DEFAULT_SCENE_FADE_MS,
): number[] {
  const out = new Array<number>(count).fill(0);
  if (count <= 0) return out;
  const clampIdx = (i: number): number => Math.min(count - 1, Math.max(0, i));
  if (!t) {
    out[clampIdx(currentIndex)] = 1;
    return out;
  }
  const p = fadeProgress(t, fadeMs);
  const from = clampIdx(t.fromIndex);
  const to = clampIdx(t.toIndex);
  out[from] = Math.max(out[from], 1 - p);
  out[to] = Math.max(out[to], p);
  return out;
}

/** 各シーン index の可視性。現在シーンは常に true、他は不透明度 > EPS のみ true。純粋。 */
export function sceneVisibilities(
  count: number,
  currentIndex: number,
  t: FadeTransition | null,
  fadeMs: number = DEFAULT_SCENE_FADE_MS,
): boolean[] {
  const ops = sceneOpacities(count, currentIndex, t, fadeMs);
  const ci = Math.min(count - 1, Math.max(0, currentIndex));
  return ops.map((v, i) => i === ci || v > FADE_VISIBLE_EPS);
}

/** シーン切替（クロスフェード）/フラッシュ/溶解→再結晶の状態機械。three 操作は ManagedScene 注入で分離。 */
export function createSceneManager(
  entries: readonly SceneEntry[],
  opts: SceneManagerOptions = {},
): SceneManager {
  if (entries.length === 0) throw new Error("sceneManager: シーンが空です");
  const flashMs = opts.flashMs ?? DEFAULT_FLASH_MS;
  const autoSwitch = opts.autoSwitchOnRotate ?? true;
  const easeMs = opts.dissolveEaseMs ?? DEFAULT_DISSOLVE_EASE_MS;
  const fadeMs = opts.fadeMs ?? DEFAULT_SCENE_FADE_MS;

  let index = 0;
  let dissolve = 0;
  let flashLeft = 0;
  let wasRotating = false;
  let fade: FadeTransition | null = null;

  const switchTo = (i: number, withFlash: boolean): void => {
    if (i !== index) {
      // クロスフェード開始（scene_next 手動 / rotate 自動の両方で共通）
      fade = { fromIndex: index, toIndex: i, elapsedMs: 0 };
    }
    index = i;
    if (withFlash) {
      entries[index].scene.flash();
      flashLeft = flashMs;
    }
  };

  return {
    ids: () => entries.map((e) => e.id),
    current: () => entries[index].id,
    next() {
      switchTo((index + 1) % entries.length, true);
    },
    setScene(id: string) {
      const i = entries.findIndex((e) => e.id === id);
      if (i < 0 || i === index) return;
      switchTo(i, true);
    },
    frame(vp, input, dtMs) {
      const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
      const rotating = input.sessionState === "rotating";
      // rotate 完了エッジ → 再結晶（任意で次シーンへ。フラッシュ無しのシームレス切替）
      if (wasRotating && !rotating && autoSwitch) {
        switchTo((index + 1) % entries.length, false);
      }
      wasRotating = rotating;
      // 溶解: rotating 中は target へ、それ以外は 0 へ指数追従（再結晶）
      const target = rotating ? clamp01(input.dissolveTarget) : 0;
      dissolve += (target - dissolve) * (1 - Math.exp(-dt / easeMs));
      flashLeft = Math.max(0, flashLeft - dt);
      // クロスフェード進行 → 各シーンへ不透明度を配る
      fade = advanceFade(fade, dt, fadeMs);
      const ops = sceneOpacities(entries.length, index, fade, fadeMs);
      for (let i = 0; i < entries.length; i++) entries[i].scene.setOpacity?.(ops[i]);
      // 遷移中は退出側も更新し続ける（フェード中のフリーズ回避）。
      // カメラ等の共有状態は後に更新する現行シーンが勝つ。
      if (fade && fade.fromIndex !== index) {
        const from = entries[fade.fromIndex].scene;
        from.setDissolve(dissolve);
        from.update(vp, dt);
      }
      const cur = entries[index].scene;
      cur.setDissolve(dissolve);
      cur.update(vp, dt);
    },
    dissolve: () => dissolve,
    flashRemainingMs: () => flashLeft,
    isVisible(id: string) {
      const i = entries.findIndex((e) => e.id === id);
      if (i < 0) return false;
      return sceneVisibilities(entries.length, index, fade, fadeMs)[i];
    },
  };
}
