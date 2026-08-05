// 観客リクエストキュー（Nuxt request-app）への薄いクライアント。
// control/vj 窓は同一 Mac 上なので localhost:3000 を直接ポーリング。
// request-app 未起動でも失敗を握りつぶして空配列を返す（機能はグレースフルに無効化）。
//
// cue API は共有トークン必須（Funnel 公開時に外部から一覧閲覧／削除されるのを防ぐため）。
// トークンは .env の VITE_CUE_TOKEN。control/VJ 窓はローカル専用で配布物ではないため
// フロントに露出しても実害はない（request-app 側の NUXT_CUE_TOKEN と同一値）。

/** Nuxt 側 CueItem と同型。 */
export interface CueItem {
  id: string;
  nickname: string;
  keywords: string[];
  text: string;
  tMs: number;
  /** AI モデレーション済みか（false = 未検査で通した項目＝目視確認したい）。 */
  moderated?: boolean;
}

/** リクエストアプリのベース URL（同一マシン）。 */
export const CUE_BASE = "http://localhost:3000";

const CUE_TOKEN = (import.meta.env.VITE_CUE_TOKEN as string | undefined) ?? "";

let warnedMissingToken = false;

/** 認証ヘッダ。未設定なら一度だけ警告する（cue が静かに死ぬのを防ぐ）。 */
function authHeaders(): Record<string, string> {
  if (!CUE_TOKEN && !warnedMissingToken) {
    warnedMissingToken = true;
    console.warn(
      "[cue] VITE_CUE_TOKEN が未設定です。request-app の cue API は 401/503 を返すため" +
        " リクエスト機能が無効になります（.env に request-app の NUXT_CUE_TOKEN と同じ値を設定）。",
    );
  }
  return { "X-Cue-Token": CUE_TOKEN };
}

/** 現在のキューを取得（失敗時は空配列）。 */
export async function fetchCue(): Promise<CueItem[]> {
  try {
    const res = await fetch(`${CUE_BASE}/api/cue`, { method: "GET", headers: authHeaders() });
    if (!res.ok) return [];
    const json = (await res.json()) as { items?: unknown };
    return Array.isArray(json.items) ? (json.items as CueItem[]) : [];
  } catch {
    return [];
  }
}

/** 指定 id を消費（prompt space に入れた／破棄した後）。失敗は無視。 */
export async function consumeCue(id: string): Promise<void> {
  try {
    await fetch(`${CUE_BASE}/api/cue/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ id }),
    });
  } catch {
    /* request-app 未起動等は無視 */
  }
}
