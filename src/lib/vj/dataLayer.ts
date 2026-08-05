import type { VjSnapshot } from "./store";

/** テキスト更新のスロットル間隔（ms）。 */
const TEXT_INTERVAL_MS = 250;
/** ローテーション進捗バーの縦位置（左上のクレジット表示より下に置く）。 */
const PROGRESS_TOP_PX = 66;

export interface DataLayer {
  update(snap: VjSnapshot, nowMs: number, sceneId: string): void;
  dispose(): void;
}

/**
 * 読めるデータ層: prompt/bpm と波形リボンを控えめに重ねる。
 * 左上の状態テキスト（session/scene/経過/rotate in）は user の指示で撤去し、
 * その位置は VJ 窓側のクレジット表示（AI 生成の明示＋作者名）が使う。
 */
export function createDataLayer(overlay: HTMLElement): DataLayer {
  const progress = document.createElement("div");
  progress.style.cssText =
    `position:absolute;top:${PROGRESS_TOP_PX}px;left:20px;height:2px;width:0;` +
    "background:rgba(240,200,116,0.9);";
  const bottom = document.createElement("div");
  bottom.style.cssText =
    "position:absolute;bottom:52px;left:20px;right:20px;font:12px ui-monospace,monospace;" +
    "color:rgba(207,232,255,0.55);text-shadow:0 1px 4px #000;white-space:pre;line-height:1.6;";
  const canvas = document.createElement("canvas");
  canvas.style.cssText =
    "position:absolute;bottom:10px;left:20px;width:calc(100% - 40px);height:36px;opacity:0.5;";
  overlay.append(progress, bottom, canvas);
  const cx = canvas.getContext("2d");
  let lastTextAt = 0;

  return {
    update(snap, nowMs) {
      // 波形リボン（毎フレーム・細い1本線）
      if (cx) {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (w > 0 && (canvas.width !== w || canvas.height !== h)) {
          canvas.width = w;
          canvas.height = h;
        }
        cx.clearRect(0, 0, canvas.width, canvas.height);
        const wf = snap.frame.audio.waveform;
        if (wf.length > 1 && canvas.width > 0) {
          cx.beginPath();
          for (let i = 0; i < wf.length; i++) {
            const x = (i / (wf.length - 1)) * canvas.width;
            const y = canvas.height / 2 - wf[i] * (canvas.height / 2 - 1);
            if (i === 0) cx.moveTo(x, y);
            else cx.lineTo(x, y);
          }
          cx.strokeStyle = "rgba(143,233,255,0.9)";
          cx.lineWidth = 1;
          cx.stroke();
        }
      }
      // ローテーション進捗バー（rotating 中のみ）
      const prog = snap.state.controlParams.transitionProgress;
      const rotating = snap.state.session.state === "rotating";
      if (rotating && typeof prog === "number") {
        const w = Math.max(0, overlay.clientWidth - 40);
        progress.style.width = `${Math.max(0, Math.min(1, prog)) * w}px`;
      } else {
        progress.style.width = "0";
      }
      // テキスト（スロットル）
      if (nowMs - lastTextAt < TEXT_INTERVAL_MS) return;
      lastTextAt = nowMs;
      const { music, prompts } = snap.state;
      const promptLine = prompts.length
        ? prompts.map((p) => `${p.text} · w${p.weight.toFixed(1)}`).join("   ")
        : "";
      bottom.textContent =
        (promptLine ? `${promptLine}\n` : "") +
        `bpm ${music.bpm.toFixed(0)} · dens ${music.density.toFixed(2)} · bright ${music.brightness.toFixed(2)}` +
        `   seq ${snap.lastSeq} · drops ${snap.drops}`;
    },
    dispose() {
      progress.remove();
      bottom.remove();
      canvas.remove();
    },
  };
}
