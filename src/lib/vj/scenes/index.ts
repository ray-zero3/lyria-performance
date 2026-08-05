// VJ シーンの生成と順序の単一定義。
// promptSpace（既定）と latentField（潜在プロンプト空間の飛行/ロックオン解析）の 2 シーン運用。
// 抽象4シーン（vortex/radialSpectrum/terrain/swarm）はファイルとして温存（scenes.test.ts で
// smoke 検証）するが、アプリのバンドルには含めない。
import type { SceneImpl } from "./types";
import { createPromptSpaceScene, type PromptSpaceSceneImpl } from "./promptSpace";
import { createLatentFieldScene, type LatentFieldSceneImpl } from "./latentField";

/** 既定シーン（M7: プロンプト空間）。 */
export const DEFAULT_SCENE_ID = "promptSpace";

export interface SceneBundle {
  /** 登録順のシーン一覧（= rotate 完了 / scene_next の巡回順）。 */
  impls: SceneImpl[];
  /** プロンプト空間シーン（setPromptSpace 注入用の具象参照）。 */
  promptSpace: PromptSpaceSceneImpl;
  /** 潜在プロンプト空間シーン（setPromptSpace / setHubState 注入用の具象参照）。 */
  latentField: LatentFieldSceneImpl;
}

/** シーンを生成（promptSpace → latentField の循環）。 */
export function createSceneBundle(): SceneBundle {
  const promptSpace = createPromptSpaceScene();
  const latentField = createLatentFieldScene();
  return { impls: [promptSpace, latentField], promptSpace, latentField };
}
