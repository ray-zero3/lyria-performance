// 現在のキュー一覧（controller / VJ 窓がポーリング取得）。
// 公開面に置かれるため共有トークン必須（観客のニックネーム一覧を外部に読ませない）。
import { requireCueToken } from "../utils/cueAuth";
import { listCue } from "../utils/cue";

export default defineEventHandler((event) => {
  requireCueToken(event);
  return { items: listCue() };
});
