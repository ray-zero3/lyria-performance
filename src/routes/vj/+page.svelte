<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { createTransport, type TelemetryTransport } from "$lib/telemetry/bus";
  import { createVjStore } from "$lib/vj/store";
  import { startScene } from "$lib/vj/scene";
  import { fetchCue, type CueItem } from "$lib/request/cueClient";
  import qrcode from "qrcode-generator";

  /**
   * 観客リクエストページの公開 URL（QR になる）。**必ず .env の VITE_REQUEST_URL で指定する。**
   *
   * フォールバックに実際の公開ホスト名を書かないこと: このリポジトリは公開されているため、
   * 実マシン名や tailnet 名をコードに残すと、Funnel のマシン名ランダム化（deploy-funnel.sh）が
   * 「本名を公開アドレスに出さない」ためにやっている意味が無くなる。
   * 未設定時は localhost にしておく（誰の環境も指さず、ローカル確認には使える）。
   * 設定漏れは npm run show:preflight が検出する。
   */
  const REQUEST_URL =
    (import.meta.env.VITE_REQUEST_URL as string | undefined) || "http://localhost:3000/";
  /** 作者表示。 */
  const ARTIST_NAME = "Rei Matsuda";
  /** 会場向けの明示（AI 生成であること）。 */
  const AI_NOTICE = "ALL MUSIC IS GENERATED IN REAL TIME BY AI";
  /** QR の 1 セルの描画サイズ（px）。小さすぎるとスキャンできない。 */
  const QR_CELL_SIZE = 4;
  /**
   * 左カラムに同時表示する cue の最大件数。
   * 古い順に上から並べ、新着は下へ積む。溢れたら古い方から表示外に落ちる。
   */
  const VJ_CUE_VISIBLE = 9;

  /** リクエストページの QR（起動時に一度だけ生成。失敗しても VJ は止めない）。 */
  const qrSvg: string = (() => {
    try {
      const qr = qrcode(0, "M"); // type 自動・誤り訂正 M
      qr.addData(REQUEST_URL);
      qr.make();
      return qr.createSvgTag({ cellSize: QR_CELL_SIZE, margin: 0 });
    } catch (e) {
      console.error("[vj] QR 生成に失敗（QR なしで継続）:", e);
      return "";
    }
  })();

  /** 投入時刻を HH:MM で表示。 */
  function hhmm(ms: number): string {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  let holder: HTMLElement;
  let overlay: HTMLElement;
  let panel: HTMLElement;
  let transport: TelemetryTransport | null = null;
  let stopScene: (() => void) | null = null;

  // 観客リクエスト Cue（表示のみ。追加は control 窓が管理）
  /** control 窓から送られた告知メッセージの最大長（control 側と揃える）。 */
  const MC_MESSAGE_MAX = 140;
  /** 画面中央に出す告知メッセージ（空なら非表示）。 */
  let mcMessage = $state("");

  let cueItems = $state<CueItem[]>([]);
  let toast = $state<CueItem | null>(null);
  let cueTimer: ReturnType<typeof setInterval> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let prevIds = new Set<string>();
  const CUE_POLL_MS = 1500;

  async function pollCue() {
    const items = await fetchCue();
    // 新着（前回のポーリングに無かった id）を検出 → 受信トースト
    const newest = items.find((it) => !prevIds.has(it.id));
    if (newest) {
      toast = newest;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (toast = null), 3600);
    }
    prevIds = new Set(items.map((it) => it.id));
    cueItems = items;
  }

  onMount(async () => {
    const store = createVjStore();
    transport = createTransport("vj");
    transport.onFrame((f) => store.applyFrame(f));
    transport.onEvent((e) => {
      store.pushEvent(e);
      // control 窓からの告知メッセージ（value>0 で表示、0 で消去）。
      // last-known ではないので、VJ 窓を後から開いた場合は control 窓から出し直す。
      if (e.kind === "control" && e.ctrl === "param" && e.id === "mc_message") {
        mcMessage = e.value > 0 ? (e.label ?? "").slice(0, MC_MESSAGE_MAX) : "";
      }
    });
    transport.onPromptSpace((s) => store.applyPromptSpace(s)); // M7: last-known 保持
    transport.onState((s) => store.applyState(s));
    // 遅れて起動しても現在状態に同期
    try {
      const s = await transport.getState();
      store.applyState(s);
    } catch {
      // ignore
    }
    stopScene = await startScene(holder, overlay, panel, store);
    void pollCue();
    cueTimer = setInterval(() => void pollCue(), CUE_POLL_MS);
  });

  onDestroy(() => {
    stopScene?.();
    if (cueTimer) clearInterval(cueTimer);
    if (toastTimer) clearTimeout(toastTimer);
    transport?.dispose();
  });
</script>

<div class="vj">
  <div class="stage">
    <div bind:this={holder} class="canvas"></div>
    <div bind:this={overlay} class="overlay"></div>
  </div>
  <div bind:this={panel} class="panel"></div>

  <!-- 左上: 会場向けの明示（AI 生成）＋作者名。dataLayer の状態テキストを撤去して空けた位置 -->
  <div class="topleft">
    <div class="ai-notice">{AI_NOTICE}</div>
    <div class="artist">{ARTIST_NAME}</div>
  </div>

  <!-- 左下: リクエスト QR（cue カラムの下に確保した領域） -->
  <div class="corner">
    {#if qrSvg}
      <!-- QR は自前生成（外部入力を描画しないので安全）。黒背景では読めないため白地に載せる -->
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      <div class="qr">{@html qrSvg}</div>
      <div class="qr-label">SCAN TO REQUEST</div>
    {/if}
  </div>

  <!-- 観客リクエスト: 受信トースト（新着の一瞬）＋左カラムに蓄積するキュー -->
  {#if toast}
    <div class="req-toast">
      <span class="rt-label">NEW REQUEST</span>
      <span class="rt-kw">{toast.text}</span>
      <span class="rt-nick">— {toast.nickname}</span>
    </div>
  {/if}
  {#if cueItems.length > 0}
    <div class="req-cue">
      <div class="rc-title">CUE <span class="rc-count">{cueItems.length}</span></div>
      <div class="rc-list">
        <!-- 古い順（上）→ 新しいものが下に積まれる。溢れたら古い方から画面外へ落とす -->
        {#each cueItems.slice(-VJ_CUE_VISIBLE) as item (item.id)}
          <div class="rc-item" in:fly={{ x: -30, y: -8, duration: 480, easing: cubicOut }}>
            <span class="rc-kw">{item.text}</span>
            <span class="rc-meta">{item.nickname} · {hhmm(item.tMs)}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
  <!-- control 窓からの告知メッセージ: 映像の上に重ねて画面中央に大きく出す -->
  {#if mcMessage}
    <div class="mc-overlay">
      <div class="mc-card">{mcMessage}</div>
    </div>
  {/if}
</div>

<style>
  :global(html, body) {
    margin: 0;
    background: #000;
    overflow: hidden;
  }
  .vj {
    position: fixed;
    inset: 0;
  }
  /* ビジュアルは画面全体を使う */
  .stage {
    position: absolute;
    inset: 0;
  }
  .canvas {
    position: absolute;
    inset: 0;
  }
  .canvas :global(canvas) {
    display: block;
    width: 100%;
    height: 100%;
  }
  .overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    font-family: ui-monospace, monospace;
    color: #cfe8ff;
  }
  /* M7→調整: 背景レイヤー無し。全画面ビジュアルの上に文字だけを載せる（幅は狭め）。 */
  .panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 22%;
    min-width: 200px;
    max-width: 380px;
    display: flex;
    flex-direction: column;
    font: 10px ui-monospace, Menlo, monospace;
    /* 明るい映像上でも読めるように文字に影を付ける（背景板は敷かない） */
    text-shadow:
      0 0 4px #000,
      0 0 2px #000;
    overflow: hidden;
    pointer-events: none;
  }

  /* 観客リクエスト: 受信トースト（上中央）＋キュー（左カラム）。全て表示のみ・非操作 */
  /* control 窓からの告知メッセージ。会場に読ませるものなので映像より前面・中央に大きく。
     暗幕は入れるが backdrop-filter は使わない（WebGPU 描画と重なると重いため）。 */
  .mc-overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 0 6%;
    background: rgba(0, 0, 0, 0.5);
    pointer-events: none;
    z-index: 30;
    animation: mcin 0.45s ease-out;
  }
  .mc-card {
    max-width: min(80%, 980px);
    padding: 26px 38px;
    border: 1px solid rgba(255, 255, 255, 0.3);
    background: rgba(8, 8, 10, 0.78);
    /* 日本語が入るのでプロポーショナル＋palt で字詰めを効かせる */
    font-family: system-ui, -apple-system, "Helvetica Neue", "Hiragino Sans", sans-serif;
    font-kerning: normal;
    font-feature-settings:
      "kern" 1,
      "palt" 1;
    font-size: clamp(22px, 3.2vw, 44px);
    font-weight: 500;
    line-height: 1.5;
    letter-spacing: 0.03em;
    text-align: center;
    color: rgba(255, 255, 255, 0.97);
    text-shadow: 0 0 24px rgba(0, 0, 0, 0.95);
    white-space: pre-wrap;
    word-break: break-word;
  }
  @keyframes mcin {
    from {
      opacity: 0;
      transform: scale(0.98);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  /* 受信トースト: 枠も背景も持たない無彩色の一行（映像を塗り潰さない）。 */
  .req-toast {
    position: absolute;
    top: 58px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: baseline;
    gap: 10px;
    font: 13px ui-monospace, Menlo, monospace;
    letter-spacing: 0.04em;
    color: rgba(255, 255, 255, 0.94);
    pointer-events: none;
    animation: reqpop 0.35s ease-out;
    text-shadow:
      0 0 10px rgba(0, 0, 0, 0.95),
      0 0 3px #000;
  }
  .rt-label {
    font-size: 9px;
    letter-spacing: 0.26em;
    color: rgba(255, 255, 255, 0.44);
  }
  .rt-kw {
    font-weight: 400;
  }
  .rt-nick {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.44);
  }
  @keyframes reqpop {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(-8px);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }
  /* 左上: dataLayer の状態テキスト（session/scene/rotate in）を撤去して空けた位置。
     進捗バー（dataLayer, top 66px）と重ならない高さに収める。 */
  .topleft {
    position: absolute;
    left: 20px;
    top: 15px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    pointer-events: none;
    /* 自動文字詰めを実際に効かせるため、ここだけプロポーショナルフォントにする。
       等幅（ui-monospace）は全字同幅が仕様でカーニング情報を持たないため、
       font-kerning / palt をいくら指定しても字詰めは起きない。
       palt は CJK 向けのプロポーショナル字形なので欧文には効かないが、
       日本語（ニックネーム等）が混ざったときのために入れてある。 */
    font-family: system-ui, -apple-system, "Helvetica Neue", "Hiragino Sans", sans-serif;
    font-kerning: normal;
    font-feature-settings:
      "kern" 1,
      "liga" 1,
      "palt" 1;
    text-rendering: optimizeLegibility;
  }
  .ai-notice {
    /* font ショートハンドを使うと font-family が上書きされ、親のプロポーショナル指定が
       効かなくなるので size/weight に分解している */
    font-size: 20px;
    font-weight: 500;
    /* 自動カーニングが効くようになったので、トラッキングは控えめでよい */
    letter-spacing: 0.13em;
    color: rgba(255, 255, 255, 0.96);
    text-shadow:
      0 0 16px rgba(0, 0, 0, 0.95),
      0 0 4px #000;
    white-space: nowrap;
    animation: aibreath 7s ease-in-out infinite;
  }
  @keyframes aibreath {
    0%,
    100% {
      opacity: 0.84;
    }
    50% {
      opacity: 1;
    }
  }

  /* 作者名は AI 表記より一段小さく。ただしクレジットとして読める濃さは保つ */
  .artist {
    font-size: 14px;
    font-weight: 400;
    letter-spacing: 0.07em;
    color: rgba(255, 255, 255, 0.82);
    text-shadow:
      0 0 10px rgba(0, 0, 0, 0.9),
      0 0 3px #000;
  }

  /* 左下: リクエスト QR。cue カラムの下端より下の領域を使う */
  .corner {
    position: absolute;
    left: 20px;
    bottom: 100px;
    width: 210px;
    display: flex;
    flex-direction: column;
    gap: 7px;
    pointer-events: none;
  }
  .qr {
    width: 104px;
    padding: 6px;
    background: #fff; /* スキャンには十分なコントラストが必要 */
    border-radius: 4px;
    line-height: 0;
  }
  .qr :global(svg) {
    display: block;
    width: 100%;
    height: auto;
  }
  .qr-label {
    font: 9px ui-monospace, Menlo, monospace;
    letter-spacing: 0.18em;
    color: #6ff0e8;
    text-shadow: 0 0 4px #000;
  }

  /* 左カラム: 左上のクレジット＋進捗バー(≈66px)を避け、下は QR ブロック(bottom 100px〜)の上まで */
  .req-cue {
    position: absolute;
    left: 20px;
    top: 80px;
    bottom: 248px;
    width: 210px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font: 12px ui-monospace, Menlo, monospace;
    pointer-events: none;
    overflow: hidden;
  }
  .rc-title {
    font-size: 10px;
    letter-spacing: 0.18em;
    color: #6ff0e8;
    display: flex;
    align-items: center;
    gap: 8px;
    text-shadow: 0 0 4px #000;
  }
  .rc-count {
    min-width: 20px;
    padding: 1px 7px;
    border-radius: 999px;
    background: rgba(79, 208, 216, 0.18);
    border: 1px solid rgba(79, 208, 216, 0.5);
    color: #eafcff;
    font-size: 11px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  /* 新着が上、下へ蓄積（＝溜まっていく） */
  .rc-list {
    display: flex;
    flex-direction: column;
    gap: 5px;
    overflow: hidden;
  }
  .rc-item {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 5px 9px;
    background: rgba(8, 16, 18, 0.42);
    border-left: 2px solid rgba(79, 208, 216, 0.55);
    border-radius: 0 8px 8px 0;
    text-shadow:
      0 0 4px #000,
      0 0 2px #000;
    animation: rcInject 1s ease-out;
  }
  .rc-kw {
    font-size: 14px;
    color: #eafcff;
    letter-spacing: 0.01em;
  }
  .rc-meta {
    font-size: 9.5px;
    color: #8fa2b4;
    font-variant-numeric: tabular-nums;
  }
  /* 投入された瞬間のグロー（枠が一瞬光ってから落ち着く） */
  @keyframes rcInject {
    0% {
      border-left-color: #eafcff;
      background: rgba(79, 208, 216, 0.28);
      box-shadow: -2px 0 16px rgba(79, 208, 216, 0.55);
    }
    100% {
      border-left-color: rgba(79, 208, 216, 0.55);
      background: rgba(8, 16, 18, 0.42);
      box-shadow: none;
    }
  }
</style>
