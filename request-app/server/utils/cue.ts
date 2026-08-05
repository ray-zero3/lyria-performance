// リクエストキュー（in-memory・単一プロセスの真実の源泉）。
// 観客送信で push、controller が prompt space に入れたら consume。
// controller / VJ 窓は GET /api/cue でポーリング表示する。
export interface CueItem {
  id: string;
  nickname: string;
  keywords: string[];
  /** ピン化に使う 1〜2 語のフレーズ（keywords.join(" ")）。 */
  text: string;
  tMs: number;
  /**
   * AI モデレーションを通過したか。
   * false = 判定不能のまま通した（fail-open）＝control 窓で目視確認すべき項目。
   */
  moderated?: boolean;
}

const MAX_CUE = 100; // 暴走防止の防御上限
const cue: CueItem[] = [];
let counter = 0;

/** キューに追加して作成した項目を返す。 */
export function addCue(nickname: string, keywords: string[], moderated = false): CueItem {
  counter += 1;
  const item: CueItem = {
    id: `${Date.now().toString(36)}-${counter}`,
    nickname,
    keywords,
    text: keywords.join(" "),
    tMs: Date.now(),
    moderated,
  };
  cue.push(item);
  while (cue.length > MAX_CUE) cue.shift();
  return item;
}

/** 現在のキュー（古い順）のコピー。 */
export function listCue(): CueItem[] {
  return cue.slice();
}

/** 指定 id を消費（削除）。存在すれば true。 */
export function consumeCue(id: string): boolean {
  const i = cue.findIndex((c) => c.id === id);
  if (i >= 0) {
    cue.splice(i, 1);
    return true;
  }
  return false;
}
