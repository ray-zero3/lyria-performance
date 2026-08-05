// 生成語の整形（純粋関数）。keywords.ts から分離してテスト可能にしている。
//
// ここが「観客の目に触れる語」の最終フィルタ。出力は英小文字 1〜2 語に強制されるため、
// プロンプトインジェクションで任意の文字列を Lyria/画面へ流すことは構造上できない。
// 残るリスクは「NG リストに無い不適切語が通る」ことなので、リストを実運用向けに拡充している。

/**
 * NG ワード（生成後フィルタ。プロンプト側でも抑制している）。
 * 方針: 差別・攻撃・性的・違法薬物は落とす。一方で **音楽表現として正当な語は落とさない**
 * （dark / death / evil / hell / doom / heavy / aggressive / brutal / hardcore / killer など）。
 * 文脈依存の攻撃（実名への攻撃など）は語単位で判定できないので moderation.ts の AI 判定が担う。
 */
const BAD_WORDS = new Set<string>([
  // 差別・ヘイト
  "nazi", "hitler", "racist", "racism", "nigger", "nigga", "chink", "spic", "kike", "gook",
  "jap", "wetback", "faggot", "fag", "tranny", "dyke", "retard", "retarded", "slur", "kkk",
  "holocaust",
  // 性的・わいせつ
  "sex", "sexy", "sexual", "porn", "porno", "nude", "naked", "orgasm", "penis", "vagina",
  "boobs", "tits", "dick", "cock", "cum", "whore", "slut", "hentai", "incest", "pedo",
  "pedophile", "bdsm", "erotic", "horny", "milf", "rape", "rapist",
  // 暴力・攻撃・脅迫
  "kill", "murder", "genocide", "terrorist", "terrorism", "lynch", "behead", "massacre",
  "suicide", "torture", "mutilate",
  // 罵倒
  "fuck", "fucking", "fucked", "shit", "bitch", "cunt", "asshole", "bastard", "motherfucker",
  "dumbass",
  // 違法薬物
  "cocaine", "heroin", "meth", "crackhead",
]);

/** JSON 構造トークン＋推論の地の文フィラー/ストップワード（生テキストから拾う際に混入させない）。 */
const STRUCTURAL = new Set<string>([
  // 構造
  "keywords", "json", "keyword", "word", "words",
  // 思考/指示の地の文フィラー
  "analyze", "message", "user", "convert", "output", "respond", "answer", "here",
  "into", "short", "english", "object", "nothing", "else", "the", "form", "would",
  "could", "should", "music", "fan", "vibe", "feeling", "based", "given",
  "input", "text", "describe", "description", "result", "final", "want", "wants",
  // 一般ストップワード
  "a", "an", "of", "to", "and", "or", "is", "it", "in", "on", "for", "with",
  "this", "that", "these", "those", "as", "at", "by", "be", "so", "we",
]);

/** 語が空になったときの代替（無音のピンを作らないため）。 */
const FALLBACK_WORD = "pulse";
/** 1語の最大長。 */
const MAX_WORD_LEN = 20;
/** 採用する語数。 */
const MAX_WORDS = 2;

/** 生成語を安全整形（小文字・英字のみ・最大 2 語・NG/構造語 除外・空はフォールバック）。 */
export function sanitizeWords(words: unknown): string[] {
  const joined = Array.isArray(words) ? words.join(" ") : String(words ?? "");
  const cleaned = joined
    .toLowerCase()
    // 記号は「除去」する（空白に置換すると te'ch#no → te ch no のように語が壊れる）。
    .replace(/[^a-z\s-]/g, "")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(
      (w) =>
        w.length > 0 && w.length <= MAX_WORD_LEN && !BAD_WORDS.has(w) && !STRUCTURAL.has(w),
    );
  const picked = cleaned.slice(0, MAX_WORDS);
  return picked.length > 0 ? picked : [FALLBACK_WORD];
}

/** モデル応答テキストから最初の JSON オブジェクトを取り出して keywords を得る（response_format 非依存）。 */
export function parseKeywords(content: string): string[] {
  const s = content.indexOf("{");
  const e = content.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try {
      const obj = JSON.parse(content.slice(s, e + 1)) as { keywords?: unknown };
      return sanitizeWords(obj.keywords);
    } catch {
      /* 下の生テキスト整形へ */
    }
  }
  return sanitizeWords(content); // JSON でなくても語を拾う
}
