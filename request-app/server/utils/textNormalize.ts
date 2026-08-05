// 観客入力の正規化（純粋関数）。
// 目的: VJ/control 窓の表示崩れ・なりすまし・ログ汚染・見えない文字での NG ワード回避を防ぐ。
// 方針: 文字種は制限しない（日本語のニックネームを弾かないため）。危険な「不可視・制御」だけを落とす。
// 実装メモ: 正規表現に不可視文字を直接書くとソースが読めなくなるので、コードポイント数値で判定する。

/** 見えない文字（ゼロ幅・双方向制御）。NG ワードの分断や表示偽装に使われる。 */
const INVISIBLE = new Set<number>([
  0x200b, // ZERO WIDTH SPACE
  0x200c, // ZERO WIDTH NON-JOINER
  0x200d, // ZERO WIDTH JOINER
  0x2060, // WORD JOINER
  0xfeff, // ZERO WIDTH NO-BREAK SPACE (BOM)
  0x200e, // LEFT-TO-RIGHT MARK
  0x200f, // RIGHT-TO-LEFT MARK
  0x202a, // LRE
  0x202b, // RLE
  0x202c, // PDF
  0x202d, // LRO
  0x202e, // RLO（RTL override＝表示の反転偽装）
  0x2066, // LRI
  0x2067, // RLI
  0x2068, // FSI
  0x2069, // PDI
]);

/** 除去対象か（C0/C1 制御と不可視文字。ただし 0x09〜0x0d は空白へ変換するので除外）。 */
function isStripped(c: number): boolean {
  if (c <= 0x08) return true;
  if (c >= 0x0e && c <= 0x1f) return true;
  if (c >= 0x7f && c <= 0x9f) return true;
  return INVISIBLE.has(c);
}

/** 空白へ倒す制御文字か（tab/LF/VT/FF/CR）。 */
function isWhitespaceControl(c: number): boolean {
  return c >= 0x09 && c <= 0x0d;
}

/**
 * メッセージ本文を正規化する。
 * NFKC → 不可視/制御を除去 → 改行・タブを空白へ → 連続空白を圧縮 → trim → 切り詰め。
 */
export function normalizeMessage(raw: string | undefined | null, maxLen = 300): string {
  const src = (raw ?? "").toString().normalize("NFKC");
  let out = "";
  for (const ch of src) {
    const c = ch.codePointAt(0) ?? 0;
    if (isStripped(c)) continue;
    out += isWhitespaceControl(c) ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, maxLen);
}

/** ニックネームを正規化する（空なら anon）。VJ の球ラベルにそのまま出るため本文と同じ強度で洗う。 */
export function normalizeNickname(raw: string | undefined | null, maxLen = 40): string {
  return normalizeMessage(raw, maxLen) || "anon";
}
