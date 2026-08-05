// 右側の生データパネル（DOM オーバーレイ）。
// 上=現在状態スナップショット、下=SENT/RECV/CTRL/ANLY のタイムスタンプ付き生ストリームログ。
// 行整形は dataPanelFormat.ts の純粋関数（テスト済み）に委譲し、ここは DOM とリング管理のみ。
import type { TelemetryEvent } from "$lib/telemetry/contract";
import type { VjSnapshot } from "./store";
import { formatStreamTick, formatLogLine, snapshotLines } from "./dataPanelFormat";

/** ログリングの最大行数（多めに流して密度を出す）。 */
export const LOG_RING = 340;
/** テキスト描画のスロットル間隔（~20Hz）。 */
export const RENDER_INTERVAL_MS = 50;
/** ストリームティックの間隔（ms）。速く流して「高速に多種のデータが送受信されている」感を出す。 */
export const STREAM_TICK_MS = 38;

export interface DataPanel {
  update(snap: VjSnapshot, nowMs: number): void;
  dispose(): void;
}

/** panelRoot（右カラム要素）内にスナップショット＋ストリームログを構築する。 */
export function createDataPanel(panelRoot: HTMLElement): DataPanel {
  const snapshotEl = document.createElement("div");
  snapshotEl.style.cssText =
    "flex:0 0 auto;padding:14px 14px 10px;white-space:pre;overflow:hidden;" +
    "color:#67e8f9;border-bottom:1px solid #0e2a2f;line-height:1.55;";
  const logEl = document.createElement("div");
  logEl.style.cssText =
    "flex:1 1 0;padding:10px 14px;white-space:pre;overflow-y:auto;overflow-x:hidden;" +
    "color:#4ade80;line-height:1.45;scrollbar-width:thin;";
  panelRoot.append(snapshotEl, logEl);

  const ring: string[] = [];
  let lastEvent: TelemetryEvent | null = null;
  let lastTickAt = 0;
  let lastRenderAt = 0;
  let tickIndex = 0;

  const push = (line: string): void => {
    ring.push(line);
    if (ring.length > LOG_RING) ring.splice(0, ring.length - LOG_RING);
  };

  return {
    update(snap, nowMs) {
      // 新イベント検出: 前回最後に見た event の参照位置から後を追記
      const events = snap.events;
      const from = lastEvent ? events.lastIndexOf(lastEvent) + 1 : 0;
      for (let i = from; i < events.length; i++) push(formatLogLine(events[i]));
      if (events.length > 0) lastEvent = events[events.length - 1];
      // 高速ストリームティック（受信 frame があるときのみ・facet ローテーションで多種のデータ）
      if (snap.lastSeq > 0 && nowMs - lastTickAt >= STREAM_TICK_MS) {
        lastTickAt = nowMs;
        push(formatStreamTick(snap.frame, snap.state, snap.promptSpace, tickIndex));
        tickIndex += 1;
      }
      // DOM 反映は ~10Hz にスロットル
      if (nowMs - lastRenderAt < RENDER_INTERVAL_MS) return;
      lastRenderAt = nowMs;
      snapshotEl.textContent = snapshotLines(snap.state, snap.promptSpace).join("\n");
      logEl.textContent = ring.join("\n");
      logEl.scrollTop = logEl.scrollHeight; // auto-scroll
    },
    dispose() {
      snapshotEl.remove();
      logEl.remove();
    },
  };
}
