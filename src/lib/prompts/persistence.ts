// プロンプト空間の localStorage 永続化（Storage 注入でテスト可能）。
import {
  clampPromptSpaceState,
  defaultPromptSpaceState,
  type PromptSpaceState,
} from "./promptSpace";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PROMPT_SPACE_KEY = "lyria-vj-prompt-space";

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** 保存済み状態を読む。無し/破損/不正値は default へフォールバック（決して throw しない）。 */
export function loadPromptSpace(
  storage: StorageLike | null = defaultStorage(),
): PromptSpaceState {
  try {
    const raw = storage?.getItem(PROMPT_SPACE_KEY);
    if (!raw) return defaultPromptSpaceState();
    return clampPromptSpaceState(JSON.parse(raw));
  } catch {
    return defaultPromptSpaceState();
  }
}

/** 状態を保存。失敗（容量/プライベートモード等）は握りつぶす。 */
export function savePromptSpace(
  state: PromptSpaceState,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.setItem(PROMPT_SPACE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}
