<script lang="ts">
  // M7: プロンプト空間 2D パッド。ピン配置/ドラッグ/編集、カーソルドラッグ=live モーフ、
  // ターゲット保存＋自動モーフ。変更のたび computeWeights → onWeights（~120ms スロットル）
  // ＋ onSpace（変更時＋~2Hz ハートビート）。localStorage 永続。
  import { onMount, onDestroy } from "svelte";
  import { clamp01, type WeightedPrompt } from "$lib/telemetry/contract";
  import {
    addPin,
    addTarget,
    computeWeights,
    DEFAULT_PIN_RADIUS,
    easeInOutCubic,
    makeId,
    MAX_PIN_RADIUS,
    MAX_TEXT_LEN,
    MIN_PIN_RADIUS,
    morphStep,
    moveCursor,
    movePin,
    normalizedPinWeights,
    removePin,
    removeTarget,
    setCameraEnergy,
    setFloorReactive,
    setConstellationLines,
    setVjEffect,
    setVjObject,
    updatePinRadius,
    updatePinText,
    VJ_EFFECT_KEYS,
    VJ_OBJECT_KEYS,
    type Pin,
    type PromptSpaceState,
    type Target,
    type VjEffectKey,
    type VjObjectKey,
  } from "./promptSpace";
  import { loadPromptSpace, savePromptSpace } from "./persistence";
  import Knob from "$lib/ui/Knob.svelte";

  // M8: VJ 展開パネルの表示ラベル
  const VJ_OBJECT_LABELS: Record<VjObjectKey, string> = {
    horizon: "horizon",
  };
  const VJ_EFFECT_LABELS: Record<VjEffectKey, string> = {
    glitch: "glitch",
    split: "split",
    rgbShift: "rgbShift",
    bloom: "bloom",
    scanline: "scanline",
    timemachine: "timemachine",
    blob: "blob tracking",
  };

  const SEND_THROTTLE_MS = 120; // driver/transport への送信スロットル
  const SAVE_THROTTLE_MS = 500; // localStorage 保存スロットル
  const HEARTBEAT_MS = 500; // ~2Hz（後発 VJ 窓の同期用）
  const PIN_HIT_DIST = 0.055; // パッド正規化座標でのピン当たり判定

  let {
    onWeights,
    onSpace,
    onRequestPlaced,
  }: {
    /** 重み変化（スロットル済み）。driver.setPrompts へ。空にはならない。 */
    onWeights: (w: WeightedPrompt[]) => void;
    /** 空間状態（変更時＋ハートビート）。transport.pushPromptSpace へ。 */
    onSpace: (s: PromptSpaceState) => void;
    /** 観客リクエストの配置が完了した（＝呼び出し側はここで cue を消費する）。 */
    onRequestPlaced?: (cueId: string) => void;
  } = $props();

  let space = $state<PromptSpaceState>(loadPromptSpace());
  let selectedId = $state<string | null>(null);
  let placing = $state(false);
  let newPinText = $state("");
  /**
   * クリック配置待ちの観客リクエスト（placing 中に保持）。
   * これがあるとき placing のクリックは「新規ピン」ではなくこのリクエストを配置する。
   */
  let pendingRequest = $state<{
    cueId: string;
    text: string;
    nickname?: string;
    tMs?: number;
  } | null>(null);
  let targetName = $state("");
  let morphDurationS = $state(4);
  let morphingTargetId = $state<string | null>(null);

  let svgEl: SVGSVGElement;
  let dragging: { kind: "pin"; id: string } | { kind: "cursor" } | null = null;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let morphRaf = 0;
  let lastTargetIdx = -1;

  // 表示用の派生値（純粋関数）
  const weights = $derived(computeWeights(space.pins, space.cursor));
  const pinW = $derived(normalizedPinWeights(space.pins, space.cursor));
  const selectedPin = $derived(space.pins.find((p) => p.id === selectedId) ?? null);

  /** $state プロキシは structuredClone 不可 → 境界は必ず snapshot。 */
  function snap(): PromptSpaceState {
    return $state.snapshot(space) as PromptSpaceState;
  }

  function sendNow(): void {
    const s = snap();
    const w = computeWeights(s.pins, s.cursor);
    if (w.length > 0) onWeights(w);
    onSpace(s);
  }

  function scheduleSend(): void {
    if (sendTimer) return; // trailing 予約済み（最新 state はタイマ発火時に読む）
    sendTimer = setTimeout(() => {
      sendTimer = null;
      sendNow();
    }, SEND_THROTTLE_MS);
  }

  function scheduleSave(): void {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      savePromptSpace(snap());
    }, SAVE_THROTTLE_MS);
  }

  /** immutable 更新の単一入口: state 差し替え → 保存＋送信をスケジュール。 */
  function commit(next: PromptSpaceState): void {
    space = next;
    scheduleSave();
    scheduleSend();
  }

  function toNorm(e: PointerEvent): { x: number; y: number } {
    const rect = svgEl.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - rect.left) / Math.max(1, rect.width)),
      y: clamp01((e.clientY - rect.top) / Math.max(1, rect.height)),
    };
  }

  function nearestPin(pos: { x: number; y: number }): Pin | null {
    let best: Pin | null = null;
    let bestD = Infinity;
    for (const p of space.pins) {
      const d = Math.hypot(p.x - pos.x, p.y - pos.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best && bestD <= PIN_HIT_DIST ? best : null;
  }

  function onPadPointerDown(e: PointerEvent): void {
    e.preventDefault();
    const pos = toNorm(e);
    if (placing) {
      // 配置待ちの観客リクエストがあればそれを、無ければ新規ピンをクリック位置に置く。
      const req = pendingRequest;
      const pin: Pin = {
        id: makeId(req ? "req" : "pin"),
        text: req ? req.text : newPinText.trim() || "new prompt",
        x: pos.x,
        y: pos.y,
        radius: DEFAULT_PIN_RADIUS,
      };
      if (req?.nickname) pin.nickname = req.nickname;
      if (req && typeof req.tMs === "number" && Number.isFinite(req.tMs)) pin.tMs = req.tMs;
      commit(addPin(snap(), pin));
      selectedId = pin.id;
      placing = false;
      pendingRequest = null;
      if (req) onRequestPlaced?.(req.cueId); // 配置できたので cue から消費させる
      return;
    }
    const hit = nearestPin(pos);
    if (hit) {
      dragging = { kind: "pin", id: hit.id };
      selectedId = hit.id;
    } else {
      stopMorph();
      dragging = { kind: "cursor" };
      commit(moveCursor(snap(), pos.x, pos.y));
    }
    svgEl.setPointerCapture(e.pointerId);
  }

  function onPadPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    const pos = toNorm(e);
    if (dragging.kind === "pin") commit(movePin(snap(), dragging.id, pos.x, pos.y));
    else commit(moveCursor(snap(), pos.x, pos.y));
  }

  function onPadPointerUp(e: PointerEvent): void {
    dragging = null;
    try {
      svgEl.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  function deleteSelected(): void {
    if (!selectedId) return;
    commit(removePin(snap(), selectedId));
    selectedId = null;
  }

  function saveTargetHere(): void {
    const s = snap();
    const name = targetName.trim() || `T${s.targets.length + 1}`;
    commit(addTarget(s, { id: makeId("target"), name, x: s.cursor.x, y: s.cursor.y }));
    targetName = "";
  }

  function startMorph(target: Target): void {
    stopMorph();
    const from = { ...snap().cursor };
    const durMs = Math.max(100, morphDurationS * 1000);
    const t0 = performance.now();
    morphingTargetId = target.id;
    const step = (): void => {
      const p = Math.min(1, (performance.now() - t0) / durMs);
      const cur = morphStep(from, target, easeInOutCubic(p));
      commit(moveCursor(snap(), cur.x, cur.y));
      if (p < 1) {
        morphRaf = requestAnimationFrame(step);
      } else {
        morphingTargetId = null;
      }
    };
    morphRaf = requestAnimationFrame(step);
  }

  function stopMorph(): void {
    cancelAnimationFrame(morphRaf);
    morphingTargetId = null;
  }

  /** MIDI CC などから外部制御（null の軸は据え置き）。親が bind:this 経由で呼ぶ。 */
  export function setCursorNorm(x: number | null, y: number | null): void {
    stopMorph();
    const c = space.cursor;
    commit(moveCursor(snap(), x ?? c.x, y ?? c.y));
  }

  /** 次の保存ターゲットへ自動モーフ（MIDI morph_next / UI ボタン）。 */
  export function morphNextTarget(): void {
    if (space.targets.length === 0) return;
    lastTargetIdx = (lastTargetIdx + 1) % space.targets.length;
    startMorph($state.snapshot(space.targets[lastTargetIdx]) as Target);
  }

  // --- VJ パラメータの外部制御（MIDI 経由。親が bind:this で呼ぶ。commit 経由でUI/送信/永続に反映）---
  /** VJ ポストエフェクト強度（0..1）を設定。 */
  export function setVjEffectValue(key: VjEffectKey, value: number): void {
    commit(setVjEffect(snap(), key, value));
  }
  /** VJ カメラ激しさ（0..1）を設定。 */
  export function setCameraEnergyValue(value: number): void {
    commit(setCameraEnergy(snap(), value));
  }
  /** 星座線（流れ星）の量（0..1）を設定。 */
  export function setConstellationValue(value: number): void {
    commit(setConstellationLines(snap(), value));
  }
  /** 床面オーディオ反応の ON/OFF を反転。 */
  export function toggleFloorReactive(): void {
    commit(setFloorReactive(snap(), !(space.floorReactive ?? false)));
  }
  /** VJ 表示オブジェクト（horizon 等）の ON/OFF を反転。 */
  export function toggleVjObject(key: VjObjectKey): void {
    commit(setVjObject(snap(), key, !(space.vjObjects?.[key] ?? false)));
  }

  /**
   * 観客リクエスト（Cue）を「クリック配置待ち」にする（placing モードを起動）。
   * 以前は黄金角で即座に置いていたが、狙った場所に置けないため新規ピンと同じ操作感に統一した。
   * 配置が完了した時点で onRequestPlaced(cueId) を呼ぶので、呼び出し側はそこで cue を消費する。
   * nickname/tMs を持たせると VJ の球体に投入者名・時刻が表示される。
   */
  export function queueRequestPin(
    cueId: string,
    text: string,
    nickname?: string,
    tMs?: number,
  ): void {
    const t = text.trim().slice(0, MAX_TEXT_LEN);
    if (!t) return;
    const n = nickname?.trim().slice(0, MAX_TEXT_LEN);
    pendingRequest = { cueId, text: t, nickname: n || undefined, tMs };
    placing = true;
  }

  /** 配置待ちを取り消す（cue には残したまま）。 */
  export function cancelPendingRequest(): void {
    pendingRequest = null;
    placing = false;
  }

  /** 配置モードのトグル（配置待ちのリクエストがあれば取り消す）。 */
  function togglePlacing(): void {
    if (placing) {
      cancelPendingRequest();
      return;
    }
    placing = true;
  }

  onMount(() => {
    heartbeat = setInterval(() => onSpace(snap()), HEARTBEAT_MS);
  });
  onDestroy(() => {
    if (heartbeat) clearInterval(heartbeat);
    if (sendTimer) clearTimeout(sendTimer);
    if (saveTimer) clearTimeout(saveTimer);
    stopMorph();
    savePromptSpace(snap()); // 最終状態を確実に保存
  });
</script>

<div class="pad-editor">
  <div class="pad-col">
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <svg
      bind:this={svgEl}
      viewBox="0 0 100 100"
      role="application"
      aria-label="プロンプト空間パッド"
      class:placing
      onpointerdown={onPadPointerDown}
      onpointermove={onPadPointerMove}
      onpointerup={onPadPointerUp}
      onpointercancel={onPadPointerUp}
    >
      <rect x="0" y="0" width="100" height="100" class="bg" />
      {#each [10, 20, 30, 40, 50, 60, 70, 80, 90] as g (g)}
        <line x1={g} y1="0" x2={g} y2="100" class="grid" />
        <line x1="0" y1={g} x2="100" y2={g} class="grid" />
      {/each}
      {#each space.targets as t (t.id)}
        <g class="target" class:morphing={morphingTargetId === t.id}>
          <line x1={t.x * 100 - 1.6} y1={t.y * 100 - 1.6} x2={t.x * 100 + 1.6} y2={t.y * 100 + 1.6} />
          <line x1={t.x * 100 - 1.6} y1={t.y * 100 + 1.6} x2={t.x * 100 + 1.6} y2={t.y * 100 - 1.6} />
          <text x={t.x * 100 + 2.4} y={t.y * 100 - 2}>{t.name}</text>
        </g>
      {/each}
      {#each space.pins as p, i (p.id)}
        <g class="pin" class:selected={p.id === selectedId}>
          <!-- カーソル→ピンの影響線（不透明度=重み） -->
          <line
            x1={space.cursor.x * 100}
            y1={space.cursor.y * 100}
            x2={p.x * 100}
            y2={p.y * 100}
            class="influence"
            style="opacity:{0.08 + (pinW[i] ?? 0) * 0.85}"
          />
          <circle cx={p.x * 100} cy={p.y * 100} r={p.radius * 100} class="sigma" />
          <circle cx={p.x * 100} cy={p.y * 100} r={1.8 + (pinW[i] ?? 0) * 2.6} class="dot" />
          <text x={p.x * 100} y={p.y * 100 - 3.2} class="label">{p.text}</text>
        </g>
      {/each}
      <g
        class="cursor"
        transform="translate({space.cursor.x * 100} {space.cursor.y * 100}) rotate(45)"
      >
        <rect x="-1.7" y="-1.7" width="3.4" height="3.4" />
      </g>
    </svg>
    <div class="under">
      <span class="weights">
        <!-- 表示専用の派生リストなのでキーは付けない。text をキーにすると重複時に
             each_key_duplicate で mount ごと落ちて control 窓が真っ黒になる（実障害）。
             computeWeights が text 一意を保証するが、キー無しなら万一の重複でも壊れない。 -->
        {#each weights as w}
          <span class="w">{w.text} <b>{w.weight.toFixed(2)}</b></span>
        {/each}
      </span>
    </div>
  </div>

  <div class="side">
    <!-- 追加（新規ピン）: 編集/削除とは別ボックスに分離してミス防止 -->
    <div class="box addbox">
      <div class="boxtitle">add</div>
      <div class="row">
        <input class="text" bind:value={newPinText} placeholder="new prompt" />
        <button class:active={placing} onclick={togglePlacing}>
          {placing ? "cancel" : "+ pin"}
        </button>
      </div>
      <!-- 観客リクエストの配置待ち: どれを置こうとしているか明示（誤配置とロスト防止） -->
      {#if pendingRequest}
        <p class="place-hint">
          <span class="ph-label">click pad to place</span>
          <strong class="ph-text">{pendingRequest.text}</strong>
          {#if pendingRequest.nickname}<span class="ph-nick">— {pendingRequest.nickname}</span>{/if}
        </p>
      {/if}
    </div>

    <!-- 編集/削除（選択ピン）: 常に表示する。選択時だけ現れるとレイアウトが動いて
         他のボタンの位置がズレるため、未選択でも場所を確保して無効状態で置いておく。 -->
    <div class="box edit" class:inactive={!selectedPin}>
      <div class="boxtitle">
        edit{#if !selectedPin}<span class="bt-hint"> — pin を選択</span>{/if}
      </div>
      <input
        class="text"
        value={selectedPin?.text ?? ""}
        disabled={!selectedPin}
        placeholder="パッドの pin をクリック"
        oninput={(e) => {
          if (selectedPin) commit(updatePinText(snap(), selectedPin.id, e.currentTarget.value));
        }}
      />
      <div class="editfoot">
        <Knob
          label="radius"
          value={selectedPin?.radius ?? DEFAULT_PIN_RADIUS}
          min={MIN_PIN_RADIUS}
          max={MAX_PIN_RADIUS}
          step={0.01}
          disabled={!selectedPin}
          onInput={(v) => {
            if (selectedPin) commit(updatePinRadius(snap(), selectedPin.id, v));
          }}
        />
        <button class="danger" disabled={!selectedPin} onclick={deleteSelected}>delete</button>
      </div>
    </div>

    <div class="box targets">
      <div class="boxtitle">targets</div>
      <div class="row">
        <input class="text" bind:value={targetName} placeholder="target" />
        <button onclick={saveTargetHere}>save</button>
      </div>
      <!-- 0 件でも場所を確保しておく（保存した瞬間に要素が増えて下がズレるのを防ぐ） -->
      <div class="knobrow">
        <Knob label="morph" bind:value={morphDurationS} min={0.5} max={20} step={0.5} unit="s" />
        <button disabled={space.targets.length === 0} onclick={morphNextTarget}>morph next</button>
      </div>
      <div class="row wrap tlist">
        {#if space.targets.length === 0}
          <span class="tempty">no targets</span>
        {:else}
          {#each space.targets as t (t.id)}
            <span class="tchip" class:morphing={morphingTargetId === t.id}>
              <button onclick={() => startMorph($state.snapshot(t) as Target)}>{t.name}</button>
              <button class="x" onclick={() => commit(removeTarget(snap(), t.id))}>×</button>
            </span>
          {/each}
        {/if}
      </div>
    </div>

    <div class="box view">
      <div class="boxtitle">view</div>
      <div class="knobrow">
        <Knob
          label="camera"
          value={space.cameraEnergy ?? 0}
          min={0}
          max={1}
          step={0.01}
          onInput={(v) => commit(setCameraEnergy(snap(), v))}
        />
      </div>
      <label class="check">
        <input
          type="checkbox"
          checked={space.floorReactive ?? false}
          onchange={(e) => commit(setFloorReactive(snap(), e.currentTarget.checked))}
        />
        floor reactive
      </label>
    </div>

    <div class="box vjdev">
      <div class="boxtitle">vj</div>
      <div class="row wrap">
        {#each VJ_OBJECT_KEYS as k (k)}
          <label class="check">
            <input
              type="checkbox"
              checked={space.vjObjects?.[k] ?? false}
              onchange={(e) => commit(setVjObject(snap(), k, e.currentTarget.checked))}
            />
            {VJ_OBJECT_LABELS[k]}
          </label>
        {/each}
      </div>
      <div class="knobrow wrap">
        <Knob
          label="constellation"
          value={space.constellationLines ?? 0}
          min={0}
          max={1}
          step={0.01}
          onInput={(v) => commit(setConstellationLines(snap(), v))}
        />
        {#each VJ_EFFECT_KEYS as k (k)}
          <Knob
            label={VJ_EFFECT_LABELS[k]}
            value={space.vjEffects?.[k] ?? 0}
            min={0}
            max={1}
            step={0.01}
            onInput={(v) => commit(setVjEffect(snap(), k, v))}
          />
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  /* ダークモード（VJ と同系統: 濃色パネル、シアン/グリーン accent。Max 風ノブ/トグル） */
  /* control 窓を1画面に収めるため、折り返さず横並びを保ち親の残り高さに収める */
  .pad-editor {
    display: flex;
    gap: 12px;
    flex-wrap: nowrap;
    align-items: stretch;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    color: #cdd3dd;
  }
  .pad-col {
    flex: 1 1 420px;
    min-width: 280px;
    max-width: 500px;
    max-height: 100%;
    overflow: hidden;
  }
  /* ディスプレイ（黒枠のみ） */
  svg {
    width: 100%;
    aspect-ratio: 1 / 1;
    display: block;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 4px;
    touch-action: none;
    cursor: crosshair;
  }
  svg.placing {
    cursor: copy;
  }
  .knobrow {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    align-items: flex-start;
  }
  .bg {
    fill: #04090c;
  }
  .grid {
    stroke: #0a2a30;
    stroke-width: 0.2;
  }
  .pin .sigma {
    fill: rgba(34, 211, 238, 0.04);
    stroke: rgba(34, 211, 238, 0.28);
    stroke-width: 0.25;
    stroke-dasharray: 1.4 1.4;
  }
  .pin .dot {
    fill: #34d399;
    stroke: #a7f3d0;
    stroke-width: 0.3;
  }
  .pin.selected .dot {
    fill: #f0c674;
    stroke: #fff;
  }
  .pin .label {
    fill: #a5f3fc;
    font: 3.2px ui-monospace, monospace;
    text-anchor: middle;
    pointer-events: none;
  }
  .pin .influence {
    stroke: #22d3ee;
    stroke-width: 0.35;
  }
  .cursor rect {
    fill: rgba(103, 232, 249, 0.25);
    stroke: #67e8f9;
    stroke-width: 0.45;
  }
  .target line {
    stroke: #557;
    stroke-width: 0.35;
  }
  .target.morphing line {
    stroke: #f0c674;
  }
  .target text {
    fill: #778;
    font: 2.8px ui-monospace, monospace;
  }
  .under {
    min-height: 20px;
    margin-top: 6px;
    font: 11px ui-monospace, monospace;
    color: #6ff0e8;
  }
  .weights .w {
    margin-right: 10px;
  }
  .weights b {
    color: #5fe08a;
  }
  .side {
    flex: 1 1 260px;
    min-width: 240px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
    /* add/edit/targets/VJ展開 と項目が多いので、収まらない分はここだけスクロールさせる
       （ページ全体をスクロールさせないための逃げ場） */
    min-height: 0;
    overflow-y: auto;
    padding-right: 2px;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .row.wrap {
    flex-wrap: wrap;
  }
  /* コンパクトなテキストウィジェット */
  .text {
    flex: 1;
    min-width: 120px;
    padding: 5px 8px;
    background: #0e1116;
    color: #cdd3dd;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 4px;
  }
  .text::placeholder { color: #556; }
  /* フラットなボタンウィジェット */
  button {
    padding: 5px 12px;
    font: 12px ui-monospace, Menlo, monospace;
    background: #1b1f27;
    color: #cdd3dd;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 5px;
    cursor: pointer;
  }
  button:hover {
    border-color: #4fd0d8;
    color: #eafcff;
  }
  button:active,
  button.active {
    background: #14312e;
    border-color: #4fd0d8;
    color: #6ff0e8;
  }
  button.danger {
    border-color: #7d3a3a;
    color: #f0a68e;
  }
  /* 0 件でもチップ1個分の高さを保ち、保存時に下の要素がズレないようにする */
  .tlist {
    min-height: 22px;
    align-items: center;
  }
  .tempty {
    font-size: 11px;
    color: #5c6675;
  }
  .tchip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  /* bang（円ボタン） */
  .tchip .x {
    width: 22px;
    height: 22px;
    padding: 0;
    border-radius: 50%;
    line-height: 1;
  }
  .tchip.morphing button {
    border-color: #4fd0d8;
    color: #6ff0e8;
  }
  label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-variant-numeric: tabular-nums;
  }
  /* トグル: 四角、ON で X 印 */
  input[type="checkbox"] {
    appearance: none;
    width: 14px;
    height: 14px;
    margin: 0 4px 0 0;
    border: 1px solid #4a5361;
    border-radius: 3px;
    background: #0e1116;
    cursor: pointer;
    flex: none;
  }
  input[type="checkbox"]:checked {
    background: #0e1116
      url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8" stroke="%234fd0d8" stroke-width="2"/></svg>')
      center / 10px 10px no-repeat;
  }
  /* サブパネル（濃色区画）。add / edit / targets / view / vj を明確に分離 */
  .box {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 8px 10px;
    background: #1b1f27;
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 6px;
  }
  /* add は誤操作防止でアクセント縁取り */
  .addbox {
    border-color: rgba(79, 208, 216, 0.28);
  }
  /* 観客リクエストの配置待ち表示（何を置こうとしているか） */
  .place-hint {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px;
    margin: 7px 0 0;
    padding: 6px 8px;
    background: rgba(79, 208, 216, 0.1);
    border-left: 2px solid rgba(79, 208, 216, 0.7);
    border-radius: 0 4px 4px 0;
  }
  .ph-label {
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #6ff0e8;
  }
  .ph-text {
    font-size: 12px;
    color: #eafcff;
  }
  .ph-nick {
    font-size: 10px;
    color: #7f8b9c;
  }
  /* edit は削除を含むため警戒色の縁取り */
  .edit {
    border-color: rgba(125, 58, 58, 0.5);
  }
  /* pin 未選択時: 場所は保ったまま、触れないことを見た目で示す */
  .edit.inactive {
    border-color: rgba(255, 255, 255, 0.07);
    opacity: 0.5;
  }
  .bt-hint {
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
    color: #5c6675;
  }
  .editfoot {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
  }
  .boxtitle {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #7f8b9c;
  }
</style>
