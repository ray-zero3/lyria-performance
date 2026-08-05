// キュー項目の消費（controller が prompt space に入れた／破棄したとき）。
// 共有トークン必須（外部から正規リクエストを削除されるのを防ぐ）。
import { requireCueToken } from "../../utils/cueAuth";
import { consumeCue } from "../../utils/cue";

export default defineEventHandler(async (event) => {
  requireCueToken(event);
  const body = await readBody<{ id?: string }>(event);
  const id = (body?.id ?? "").toString();
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: "id required" });
  }
  return { ok: consumeCue(id) };
});
