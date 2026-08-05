// トークン照合用の定数時間比較（純粋関数）。cueAuth / accessKey で共用する。
import { timingSafeEqual } from "node:crypto";

/**
 * 長さの違いを漏らさない文字列比較。
 * 先に長さを見て弾くので長さ自体は漏れるが、内容の一致位置は漏らさない。
 */
export function safeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
