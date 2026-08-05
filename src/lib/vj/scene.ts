import * as THREE from "three/webgpu";
import { SPECTRUM_BINS } from "$lib/telemetry/constants";
import { createRenderer } from "./renderer";
import type { VjStore } from "./store";
import {
  bandsToColor,
  chaosToDissolve,
  hslToRgb,
  motionSpeed,
  onsetEnvelope,
  secondaryColor,
  smoothSpectrum,
  type VisualParams,
} from "./visualMapping";
import { createSceneManager } from "./sceneManager";
import { createDataLayer } from "./dataLayer";
import { createDataPanel } from "./dataPanel";
import { createSceneBundle } from "./scenes/index";
import { VJ_EFFECT_KEYS, type PromptSpaceState } from "$lib/prompts/promptSpace";
import { effectTargets } from "./vjToggles";
import { createPostFx, type PostFx } from "./post";

/** VJ シーンを開始。dispose 関数を返す。描画不可時も throw しない。 */
export async function startScene(
  holder: HTMLElement,
  overlay: HTMLElement,
  panel: HTMLElement,
  store: VjStore,
): Promise<() => void> {
  const bundle = await createRenderer(holder);
  if (!bundle) {
    overlay.textContent = "WebGPU 初期化に失敗しました（描画停止）";
    return () => {};
  }
  const { renderer, scene, camera, resize, dispose } = bundle;

  // M8: ポストエフェクト（構築失敗時は素のレンダにフォールバックして継続）
  let post: PostFx | null = null;
  try {
    post = createPostFx(renderer, scene, camera);
  } catch (e) {
    console.error("[vj] PostFx 構築失敗（素のレンダで継続）:", e);
  }

  // M7: promptSpace を既定シーンに（先頭）。各専有グループへ init（表示は visible で切替＝カット）
  const { impls, promptSpace, latentField } = createSceneBundle();
  const groups = new Map<string, THREE.Group>();
  for (const impl of impls) {
    const g = new THREE.Group();
    g.visible = false;
    scene.add(g);
    impl.init({ root: g, camera });
    groups.set(impl.id, g);
  }
  const manager = createSceneManager(
    impls.map((s) => ({ id: s.id, scene: s })),
    { autoSwitchOnRotate: true },
  );
  const dataLayer = createDataLayer(overlay);
  const dataPanel = createDataPanel(panel);

  // 視覚マッピングの状態（フレーム間で保持）
  let env = 0;
  let spec: number[] = new Array<number>(SPECTRUM_BINS).fill(0);
  let lastSceneEventT = Date.now(); // 開始前に積まれた scene_next は無視
  let lastT = performance.now();
  let lastFxSpace: PromptSpaceState | null | undefined; // M8: undefined = 未注入

  let raf = 0;
  let running = true;
  const onResize = () => {
    resize(holder.clientWidth, holder.clientHeight);
    post?.setSize(holder.clientWidth, holder.clientHeight);
  };
  window.addEventListener("resize", onResize);

  const loop = () => {
    if (!running) return;
    const nowMs = performance.now();
    const dtMs = Math.min(100, Math.max(0, nowMs - lastT));
    lastT = nowMs;
    try {
      const snap = store.snapshot();
      // scene_next イベント（control 窓の MIDI/ボタン発）でシーン切替
      for (const e of snap.events) {
        if (
          e.kind === "control" &&
          e.ctrl === "param" &&
          e.id === "scene_next" &&
          e.tMs > lastSceneEventT
        ) {
          manager.next();
          lastSceneEventT = e.tMs;
        }
      }
      // frame + state → 視覚パラメータ（純粋関数）
      const { audio } = snap.frame;
      env = onsetEnvelope(env, audio.onset, dtMs);
      spec = smoothSpectrum(spec, audio.spectrum, dtMs);
      const hsl = bandsToColor(audio.bands);
      const vp: VisualParams = {
        burst: env,
        spectrum: spec,
        level: audio.level,
        bands: audio.bands,
        colorA: hslToRgb(hsl.h, hsl.s, hsl.l),
        colorB: secondaryColor(hsl),
        speed: motionSpeed(snap.state.music.bpm),
      };
      const dissolveTarget = chaosToDissolve(snap.state.controlParams.chaos ?? 0);
      promptSpace.setPromptSpace(snap.promptSpace); // last-known（同一参照はシーン側でキャッシュ）
      latentField.setPromptSpace(snap.promptSpace); // 同上（ピン/リクエスト/ターゲット → ノード化）
      latentField.setHubState(snap.state); // prompts の変化を履歴として蓄積（同一参照はスキップ）
      // M8: carry(vjEffects) → PostFx 目標強度（同一参照はスキップ。補間は post 内 easeAlpha）
      if (post && snap.promptSpace !== lastFxSpace) {
        lastFxSpace = snap.promptSpace;
        const fxT = effectTargets(snap.promptSpace?.vjEffects);
        for (const k of VJ_EFFECT_KEYS) post.setEffect(k, fxT[k]);
      }
      manager.frame(vp, { sessionState: snap.state.session.state, dissolveTarget }, dtMs);
      // クロスフェード中は新旧 2 シーンが可視（不透明度は manager が setOpacity で配布済み）
      for (const [id, g] of groups) g.visible = manager.isVisible(id);
      dataLayer.update(snap, nowMs, manager.current());
      dataPanel.update(snap, nowMs);
      // M8: ポストエフェクト経由で描画（PostFx 不成立時は素のレンダ）
      if (post) {
        // blob の閾値脈動をやめたため現在は no-op（将来の音反応用に呼び出しは残す）
        post.setAudio(vp.level);
        void post.renderAsync();
      } else void renderer.renderAsync(scene, camera);
    } catch (e) {
      // ライブ堅牢性: ループ内例外を握りつぶして継続
      console.error("[vj] loop error:", e);
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return () => {
    running = false;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", onResize);
    for (const impl of impls) impl.dispose();
    dataLayer.dispose();
    dataPanel.dispose();
    post?.dispose();
    dispose();
  };
}
