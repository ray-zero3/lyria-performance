<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { createTransport, type TelemetryTransport } from "$lib/telemetry/bus";
  import type { WeightedPrompt } from "$lib/telemetry/contract";
  import { startAudioDriver, type AudioDriver, type SourceKind } from "$lib/audio/driver";
  import { defaultLyriaConfig, type LyriaMusicConfig } from "$lib/lyria/config";
  import PadEditor from "$lib/prompts/PadEditor.svelte";
  import type { PromptSpaceState, VjEffectKey, VjObjectKey } from "$lib/prompts/promptSpace";
  import Knob from "$lib/ui/Knob.svelte";
  import { fetchCue, consumeCue, type CueItem } from "$lib/request/cueClient";
  import { getApiKey } from "$lib/lyria/apiKey";
  import { createMidiBus, type MidiBus } from "$lib/midi/midiBus";
  import { applyMidi, midiKey } from "$lib/midi/mapping";
  import { loadMapping, saveMapping, bind, unbind } from "$lib/midi/store";
  import {
    CONTINUOUS_TARGETS,
    ACTION_TARGETS,
    type ContinuousTarget,
    type ActionTarget,
    type MidiMapping,
    type MidiMessage,
    type MidiTarget,
  } from "$lib/midi/types";

  let transport: TelemetryTransport | null = null;
  let driver: AudioDriver | null = null;
  let sourceKind = $state<SourceKind>("lyria");
  let running = $state(false);
  let starting = $state(false);
  let fps = $state(0);
  let errorMsg = $state("");
  let showSettings = $state(false);
  let concealing = $state(false); // 緊急回避モード（Lyria 瞬断時の自動回避）が発動中か

  // Lyria/MockLyria
  let cfg: LyriaMusicConfig = $state(defaultLyriaConfig());
  let apiKeyPresent = $state(false);

  // M7: プロンプト空間パッド（単一 prompt 入力を置換）
  interface PadHandle {
    setCursorNorm(x: number | null, y: number | null): void;
    morphNextTarget(): void;
    setVjEffectValue(key: VjEffectKey, value: number): void;
    setCameraEnergyValue(value: number): void;
    setConstellationValue(value: number): void;
    toggleFloorReactive(): void;
    toggleVjObject(key: VjObjectKey): void;
    /** 観客リクエストをクリック配置待ちにする（配置完了は onRequestPlaced で通知される）。 */
    queueRequestPin(cueId: string, text: string, nickname?: string, tMs?: number): void;
    /** 配置待ちの取り消し。 */
    cancelPendingRequest(): void;
  }
  let pad = $state<PadHandle | null>(null);
  // パッドから届いた最新の重み（start 時の初期 prompts にも使用）
  let latestWeights: WeightedPrompt[] = [{ text: "warm analog pads", weight: 1 }];

  function handlePadWeights(w: WeightedPrompt[]) {
    latestWeights = w;
    driver?.setPrompts(w);
  }
  function handlePadSpace(s: PromptSpaceState) {
    transport?.pushPromptSpace(s);
  }

  // M5b: マスターFX（カオスマクロ＋各FX個別 base、0..1）
  let chaos = $state(0);
  let fx = $state({ reverb: 0, stutter: 0, filter: 0, delay: 0 });

  // MIDI
  let midiBus: MidiBus | null = null;
  let midiPorts = $state<string[]>([]);
  let midiPortIndex = $state(0);
  let midiOpenName = $state("");
  let mapping = $state<MidiMapping>({});
  let learning = $state<MidiTarget | null>(null);
  let lastMidi = $state("");
  // 合成インジェクタ
  let synCc = $state(74);
  let synVal = $state(64);
  let synNote = $state(36);

  // 観客リクエスト Cue（Nuxt request-app をポーリング）
  let cueItems = $state<CueItem[]>([]);
  let cueTimer: ReturnType<typeof setInterval> | null = null;
  const CUE_POLL_MS = 1500;
  /** 新着トーストの表示時間。 */
  const CUE_TOAST_MS = 4200;
  /**
   * cue リストに実際に並べる最大件数。超えた分は件数だけ出す。
   * control 窓は 1 画面に収めたいので、リストを伸ばさずここで打ち止めにする。
   */
  const CUE_VISIBLE_MAX = 5;
  /** 新着リクエストのトースト（操作 UI を邪魔しない右下に一瞬出す）。 */
  let cueToast = $state<CueItem | null>(null);
  let cueToastTimer: ReturnType<typeof setTimeout> | null = null;
  let seenCueIds = new Set<string>();
  /** 初回ポーリングは既存分なのでトーストを出さない。 */
  let cueFirstPoll = true;

  async function pollCue() {
    const items = await fetchCue();
    const fresh = items.filter((it) => !seenCueIds.has(it.id));
    if (!cueFirstPoll && fresh.length > 0) {
      cueToast = fresh[fresh.length - 1]; // 同時に複数来たら最新を出す
      if (cueToastTimer) clearTimeout(cueToastTimer);
      cueToastTimer = setTimeout(() => (cueToast = null), CUE_TOAST_MS);
    }
    cueFirstPoll = false;
    seenCueIds = new Set(items.map((it) => it.id));
    cueItems = items;
  }
  /**
   * Cue 項目を prompt space へ「クリック配置待ち」にする。
   * 即座にピン化せず、user がパッドでクリックした位置に置く（新規ピン追加と同じ操作感）。
   * 実際の消費は配置完了後（handleRequestPlaced）。
   */
  function useCueItem(item: CueItem) {
    pad?.queueRequestPin(item.id, item.text, item.nickname, item.tMs);
  }
  /** PadEditor が配置を完了した → cue から消費する。 */
  function handleRequestPlaced(cueId: string) {
    cueItems = cueItems.filter((c) => c.id !== cueId); // 楽観的に除去
    void consumeCue(cueId);
  }
  /** Cue 項目を破棄（ピン化せず消費）。 */
  function dismissCueItem(item: CueItem) {
    cueItems = cueItems.filter((c) => c.id !== item.id);
    void consumeCue(item.id);
  }
  /** 先頭（最古）の Cue 項目を配置待ちにする（手動 pop）。 */
  function popNextCue() {
    const item = cueItems[0];
    if (item) useCueItem(item);
  }

  /** 残りが少ないと警告色にするしきい値。 */
  const SESSION_WARN_MS = 60_000;
  /** 次の自動セッションローテーションまでの残り（非ローテーション音源では null）。 */
  let sessionLeftMs = $state<number | null>(null);
  let sessionTransitioning = $state(false);
  let sessionTimer: ReturnType<typeof setInterval> | null = null;

  /** driver からセッションのタイミングを取り直す（1Hz）。 */
  function tickSessionTiming() {
    const t = driver?.sessionTiming() ?? null;
    sessionLeftMs = t ? Math.max(0, t.rotateAtMs - Date.now()) : null;
    sessionTransitioning = t?.transitioning ?? false;
  }

  /** mm:ss 表示。 */
  function mmss(ms: number): string {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  async function start() {
    if (running || starting || !transport) return;
    starting = true;
    errorMsg = "";
    try {
      const apiKey = sourceKind === "lyria" ? await getApiKey() : "";
      if (sourceKind === "lyria" && !apiKey) {
        throw new Error("GEMINI_API_KEY が未設定です（env で渡すか MockLyria を使用）");
      }
      driver = await startAudioDriver({
        source: sourceKind,
        transport,
        onFps: (n) => (fps = n),
        onConceal: (a) => (concealing = a),
        apiKey,
        prompts: latestWeights,
        config: $state.snapshot(cfg),
      });
      running = true;
    } catch (e) {
      errorMsg = `開始に失敗: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      starting = false;
    }
  }

  function stop() {
    driver?.stop();
    driver = null;
    running = false;
    fps = 0;
    concealing = false;
  }

  // guidance/density/brightness/temperature はノブ操作で即 live 反映（Lyria は reset 不要で滑らかに追従）。
  function applyConfigLive() {
    driver?.setConfig($state.snapshot(cfg));
  }

  // bpm は Lyria の「ハード変更」= setConfig 後に resetContext が必要。ドラッグ解放(onChange)で 1 回。
  function applyBpmLive() {
    driver?.setConfig($state.snapshot(cfg));
    driver?.resetContext();
  }

  function resetCtx() {
    driver?.resetContext();
  }

  // --- MIDI ---
  // M5b: FX 連続ターゲット → driver.setFx の名前対応
  const FX_TARGET_MAP: Partial<Record<ContinuousTarget, "reverb" | "stutter" | "filter" | "delay">> = {
    fxReverb: "reverb",
    fxStutter: "stutter",
    fxFilter: "filter",
    fxDelay: "delay",
  };
  // VJ 連続ターゲット → VJ エフェクトキー
  const VJ_FX_TARGET_MAP: Partial<Record<ContinuousTarget, VjEffectKey>> = {
    vjGlitch: "glitch",
    vjSplit: "split",
    vjRgbShift: "rgbShift",
    vjBloom: "bloom",
    vjScanline: "scanline",
    vjTimemachine: "timemachine",
    vjBlob: "blob",
  };

  function applyContinuous(target: ContinuousTarget, value: number) {
    // M7: MIDI CC でカーソル操作（音像モーフ）。パッドが重み再計算→送信まで行う。
    if (target === "cursorX") {
      pad?.setCursorNorm(value, null);
      return;
    }
    if (target === "cursorY") {
      pad?.setCursorNorm(null, value);
      return;
    }
    if (target === "chaos") {
      chaos = value;
      driver?.setChaos(value);
      return;
    }
    const fxName = FX_TARGET_MAP[target];
    if (fxName) {
      fx[fxName] = value;
      driver?.setFx(fxName, value);
      return;
    }
    // VJ 連続ターゲット（パッド経由で carry 更新→transport 送信＋永続＋ノブ反映）
    if (target === "cameraEnergy") {
      pad?.setCameraEnergyValue(value);
      return;
    }
    if (target === "constellation") {
      pad?.setConstellationValue(value);
      return;
    }
    const vjKey = VJ_FX_TARGET_MAP[target];
    if (vjKey) {
      pad?.setVjEffectValue(vjKey, value);
      return;
    }
    // 残りは cfg の数値パラメータ（bpm/guidance/density/brightness/temperature）
    if (
      target === "bpm" ||
      target === "guidance" ||
      target === "density" ||
      target === "brightness" ||
      target === "temperature"
    ) {
      cfg[target] = value;
      driver?.setConfig($state.snapshot(cfg));
    }
  }

  /** VJ に出す告知メッセージの最大長（画面に収まる範囲）。 */
  const MC_MESSAGE_MAX = 140;
  /** 入力モーダルの開閉。 */
  let showMcInput = $state(false);
  /** 入力中の本文。 */
  let mcText = $state("");
  /** いま VJ に出している本文（空なら非表示）。control 窓側の状態表示に使う。 */
  let mcShown = $state("");

  /** VJ へ告知メッセージの表示/非表示を送る（既存の control イベント経路に載せる）。 */
  function pushMcMessage(text: string) {
    transport?.pushEvent({
      kind: "control",
      tMs: Date.now(),
      source: "ui",
      ctrl: "param",
      id: "mc_message",
      value: text ? 1 : 0,
      label: text,
    });
    mcShown = text;
  }
  function sendMcMessage() {
    const t = mcText.trim().slice(0, MC_MESSAGE_MAX);
    if (!t) return;
    pushMcMessage(t);
    showMcInput = false;
  }
  function clearMcMessage() {
    pushMcMessage("");
    showMcInput = false;
  }

  // M6: VJ シーン切替（イベント経由で VJ 窓へ通知。音源不問・稼働不問で使える）
  function sceneNext() {
    transport?.pushEvent({
      kind: "control",
      tMs: Date.now(),
      source: "ui",
      ctrl: "param",
      id: "scene_next",
      value: 1,
      label: "scene_next",
    });
  }

  function applyAction(action: ActionTarget) {
    switch (action) {
      case "reset_context":
        driver?.resetContext();
        break;
      case "play_toggle":
        if (running) stop();
        else void start();
        break;
      case "mute_bass":
        cfg.muteBass = !cfg.muteBass;
        driver?.setConfig($state.snapshot(cfg));
        break;
      case "mute_drums":
        cfg.muteDrums = !cfg.muteDrums;
        driver?.setConfig($state.snapshot(cfg));
        break;
      case "rotate":
        driver?.rotate();
        break;
      case "scene_next":
        sceneNext();
        break;
      case "morph_next":
        pad?.morphNextTarget();
        break;
      case "floorReactive":
        pad?.toggleFloorReactive();
        break;
      case "vjHorizon":
        pad?.toggleVjObject("horizon");
        break;
    }
  }

  function handleMidi(m: MidiMessage) {
    lastMidi = `${midiKey(m)} v${m.value}${m.kind === "note" ? (m.on ? " on" : " off") : ""}`;
    // 全 MIDI 入力を VJ フラッシュへ（操作の動きの可視化）
    transport?.pushEvent({
      kind: "control",
      tMs: Date.now(),
      source: "midi",
      ctrl: m.kind,
      id: m.id,
      value: m.value / 127,
      label: `${m.kind}${m.id}`,
    });
    if (learning) {
      mapping = bind(mapping, m, learning);
      saveMapping(mapping);
      learning = null;
      return;
    }
    const r = applyMidi(m, mapping);
    if (!r) return;
    if (r.continuous) applyContinuous(r.continuous.target, r.continuous.value);
    else if (r.action) applyAction(r.action);
  }

  async function refreshPorts() {
    if (!midiBus) return;
    midiPorts = await midiBus.listPorts();
    // 前回開いたポート名が一覧にあれば、その index を選び直す（index はデバイス着脱でズレるため名前で追従）
    const last = loadLastPort();
    if (last) {
      const idx = midiPorts.indexOf(last);
      if (idx >= 0) midiPortIndex = idx;
    }
  }
  async function openPort() {
    if (!midiBus) return;
    try {
      midiOpenName = await midiBus.openPort(midiPortIndex);
      if (midiOpenName) saveLastPort(midiOpenName); // 次回起動時に自動再オープン
      errorMsg = "";
    } catch (e) {
      errorMsg = `MIDI ポート開けず: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  /** settings を開く（毎回ポートを再取得して最新デバイスを反映）。 */
  function openSettings() {
    showSettings = true;
    void refreshPorts();
  }
  const MIDI_PORT_KEY = "lyria-vj-midi-port";
  function saveLastPort(name: string): void {
    try {
      localStorage.setItem(MIDI_PORT_KEY, name);
    } catch {
      /* ignore */
    }
  }
  function loadLastPort(): string {
    try {
      return localStorage.getItem(MIDI_PORT_KEY) ?? "";
    } catch {
      return "";
    }
  }
  async function closePort() {
    await midiBus?.closePort();
    midiOpenName = "";
  }
  function bindingFor(target: MidiTarget): string {
    const k = Object.keys(mapping).find((key) => mapping[key] === target);
    return k ?? "—";
  }
  function clearBinding(target: MidiTarget) {
    mapping = unbind(mapping, target);
    saveMapping(mapping);
    if (learning === target) learning = null;
  }
  function injectCc() {
    midiBus?.inject({ kind: "cc", channel: 0, id: synCc, value: synVal, on: true });
  }
  function injectNote(on: boolean) {
    midiBus?.inject({ kind: "note", channel: 0, id: synNote, value: on ? 100 : 0, on });
  }

  function onWindowKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    if (showMcInput) showMcInput = false;
    else if (showSettings) showSettings = false;
  }

  onMount(async () => {
    transport = createTransport("control");
    apiKeyPresent = (await getApiKey()).length > 0;
    mapping = loadMapping();
    midiBus = createMidiBus();
    midiBus.onMessage(handleMidi);
    await refreshPorts();
    // 前回のポートが接続済みなら自動で開く（マッピングは保存されるが接続は毎起動で開き直す必要があるため）
    const last = loadLastPort();
    if (last) {
      const idx = midiPorts.indexOf(last);
      if (idx >= 0) {
        midiPortIndex = idx;
        await openPort();
      }
    }
    // 観客リクエスト Cue のポーリング開始（request-app 未起動でも空配列で無害）
    void pollCue();
    cueTimer = setInterval(() => void pollCue(), CUE_POLL_MS);
    // セッション残り時間（停止中は driver が無いので null のまま）
    tickSessionTiming();
    sessionTimer = setInterval(tickSessionTiming, 1000);
  });
  onDestroy(() => {
    stop();
    if (cueTimer) clearInterval(cueTimer);
    if (cueToastTimer) clearTimeout(cueToastTimer);
    if (sessionTimer) clearInterval(sessionTimer);
    void midiBus?.closePort();
    midiBus?.dispose();
    transport?.dispose();
  });
</script>

<svelte:window onkeydown={onWindowKey} />

<main>
  <header class="topbar">
    <div class="brand"><span class="dot" class:live={running}></span> LYRIA · control</div>
    <div class="topctl">
      {#if concealing}
        <span class="conceal-badge" title="Lyria 瞬断 → 緊急回避（逆再生グラニュラー）発動中">⚠ CONCEAL</span>
      {/if}
      <span class="midi" class:on={midiOpenName} title={midiOpenName || "no midi port"}>
        midi {midiOpenName ? "●" : "—"}
      </span>
      <!-- セッション残り（次の自動ローテーションまで）。ライブ中は常に見えていたい情報 -->
      {#if sessionLeftMs != null}
        <span
          class="sess"
          class:warn={sessionLeftMs < SESSION_WARN_MS}
          class:rot={sessionTransitioning}
          title="次のセッション自動ローテーションまでの残り時間"
        >
          {sessionTransitioning ? "rotating…" : `session ${mmss(sessionLeftMs)}`}
        </span>
      {/if}
      <span class="fps">{fps} fps</span>
      {#if running}
        <button class="tbtn stop" onclick={stop}>stop</button>
      {:else}
        <button class="tbtn go" onclick={start} disabled={starting}>{starting ? "starting…" : "start"}</button>
      {/if}
      <button class="gear" title="settings" aria-label="settings" onclick={openSettings}>⚙</button>
    </div>
  </header>

  <!-- 1画面に収める2カラム: 左=prompt space（内部で pad＋サイド）、右=cue/config/fx/transport。
       main（position:fixed + overflow:hidden）で viewport に固定し、ページ自体はスクロールさせない。 -->
  <div class="workspace">
  <section class="panel pad">
    <div class="ptitle">prompt space</div>
    <!-- 防御: pad 内の描画エラーで control 窓全体が真っ黒になるのを防ぐ最終防衛線。
         エラー時はこのパネルだけ差し替わり、transport/cue 等は操作可能なまま残る。 -->
    <svelte:boundary>
      <PadEditor
        bind:this={pad}
        onWeights={handlePadWeights}
        onSpace={handlePadSpace}
        onRequestPlaced={handleRequestPlaced}
      />
      {#snippet failed(error, reset)}
        <div class="pad-failed">
          <p class="err">prompt space の描画でエラー: {error instanceof Error ? error.message : String(error)}</p>
          <button class="tbtn" onclick={reset}>再試行</button>
        </div>
      {/snippet}
    </svelte:boundary>
  </section>

  <div class="rightcol">
    <section class="panel col">
      <div class="ptitle">lyria config</div>
      <div class="knobs">
        <Knob label="bpm" bind:value={cfg.bpm} min={60} max={200} step={1} onChange={applyBpmLive} />
        <Knob label="guidance" bind:value={cfg.guidance} min={0} max={6} step={0.1} onInput={applyConfigLive} />
        <Knob label="density" bind:value={cfg.density} min={0} max={1} step={0.01} onInput={applyConfigLive} />
        <Knob label="brightness" bind:value={cfg.brightness} min={0} max={1} step={0.01} onInput={applyConfigLive} />
        <Knob label="temp" bind:value={cfg.temperature} min={0} max={2} step={0.05} onInput={applyConfigLive} />
        <div class="toggles">
          <button
            class="sq"
            class:on={cfg.muteBass}
            onclick={() => { cfg.muteBass = !cfg.muteBass; applyConfigLive(); }}
          >mute bass</button>
          <button
            class="sq"
            class:on={cfg.muteDrums}
            onclick={() => { cfg.muteDrums = !cfg.muteDrums; applyConfigLive(); }}
          >mute drums</button>
        </div>
      </div>
    </section>

    <section class="panel col">
      <div class="ptitle">master fx</div>
      <div class="knobs">
        <Knob label="chaos" bind:value={chaos} min={0} max={1} step={0.01} onInput={(v) => driver?.setChaos(v)} />
        <Knob label="reverb" bind:value={fx.reverb} min={0} max={1} step={0.01} onInput={(v) => driver?.setFx("reverb", v)} />
        <Knob label="stutter" bind:value={fx.stutter} min={0} max={1} step={0.01} onInput={(v) => driver?.setFx("stutter", v)} />
        <Knob label="filter" bind:value={fx.filter} min={0} max={1} step={0.01} onInput={(v) => driver?.setFx("filter", v)} />
        <Knob label="delay" bind:value={fx.delay} min={0} max={1} step={0.01} onInput={(v) => driver?.setFx("delay", v)} />
      </div>
    </section>

  <div class="transport">
    <button class="tbtn" onclick={resetCtx} disabled={!running}>reset ctx</button>
    <button class="tbtn" onclick={() => driver?.rotate()} disabled={!running}>rotate</button>
    <button class="tbtn" onclick={() => pad?.morphNextTarget()}>morph next</button>
    <button class="tbtn" onclick={sceneNext}>scene next</button>
    <!-- VJ 画面への告知メッセージ。off ボタンは常設（出現でボタン位置がズレないように） -->
    <button class="tbtn" class:on={!!mcShown} onclick={() => (showMcInput = true)}>
      message{mcShown ? " ●" : ""}
    </button>
    <button class="tbtn" disabled={!mcShown} onclick={clearMcMessage}>message off</button>
  </div>

  <!-- requests は右列の最下部。残り高さを占めるので、件数が増減しても上のパネルが動かない -->
  <section class="panel cue-panel">
    <div class="cue-head">
      <div class="ptitle">requests — audience cue（{cueItems.length}）</div>
      <button class="tbtn" disabled={cueItems.length === 0} onclick={popNextCue}>pop next → pin</button>
    </div>
    {#if cueItems.length === 0}
      <p class="cue-empty">no requests</p>
    {:else}
      <div class="cue-list">
        {#each cueItems.slice(0, CUE_VISIBLE_MAX) as item, i (item.id)}
          <div class="cue-item" class:next={i === 0}>
            <span class="cue-idx">{i === 0 ? "▶" : i + 1}</span>
            <span class="cue-kw">{item.text}</span>
            <span class="cue-nick">{item.nickname}</span>
            <button class="cue-add" title="prompt space に追加" onclick={() => useCueItem(item)}>→ pin</button>
            <button class="cue-x" title="破棄" aria-label="dismiss" onclick={() => dismissCueItem(item)}>×</button>
          </div>
        {/each}
      </div>
      <!-- 溢れた分は件数のみ（リストを伸ばして画面外に出さないため） -->
      {#if cueItems.length > CUE_VISIBLE_MAX}
        <p class="cue-more">＋{cueItems.length - CUE_VISIBLE_MAX} 件 待機中（古い順に処理）</p>
      {/if}
    {/if}
  </section>
  </div><!-- /.rightcol -->
  </div><!-- /.workspace -->

  {#if errorMsg}<p class="err">{errorMsg}</p>{/if}
</main>

<!-- 新着リクエストのトースト: 操作 UI に重ならない右下・非操作。数秒で自動的に消える -->
{#if cueToast}
  <div class="cue-toast">
    <span class="ct-label">NEW REQUEST</span>
    <span class="ct-kw">{cueToast.text}</span>
    <span class="ct-nick">{cueToast.nickname}</span>
  </div>
{/if}

<!-- VJ 画面に出す告知メッセージの入力（Esc / ✕ / 背景クリックで閉じる） -->
{#if showMcInput}
  <div
    class="backdrop"
    role="button"
    tabindex="-1"
    aria-label="close message input"
    onclick={() => (showMcInput = false)}
    onkeydown={(e) => { if (e.key === "Enter") showMcInput = false; }}
  ></div>
  <div class="modal" role="dialog" aria-modal="true" aria-label="VJ メッセージ">
    <div class="mhead">
      <span>VJ に出すメッセージ</span>
      <button class="x" aria-label="close" onclick={() => (showMcInput = false)}>✕</button>
    </div>
    <div class="mbody">
      <div class="sgroup">
        <div class="sglabel">本文（{mcText.length} / {MC_MESSAGE_MAX}）</div>
        <!-- svelte-ignore a11y_autofocus -->
        <textarea
          class="mc-input"
          bind:value={mcText}
          maxlength={MC_MESSAGE_MAX}
          rows="3"
          autofocus
          placeholder="例: 次で最後の曲です / リクエストは QR から"
        ></textarea>
        <div class="row">
          <button class="tbtn go" disabled={!mcText.trim()} onclick={sendMcMessage}>VJ に表示</button>
          <button class="tbtn" disabled={!mcShown} onclick={clearMcMessage}>いま出ているのを消す</button>
        </div>
        {#if mcShown}
          <p class="mc-current">表示中: {mcShown}</p>
        {:else}
          <p class="mc-current dim">現在 VJ には何も出ていません</p>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if showSettings}
  <div
    class="backdrop"
    role="button"
    tabindex="-1"
    aria-label="close settings"
    onclick={() => (showSettings = false)}
    onkeydown={(e) => { if (e.key === "Enter") showSettings = false; }}
  ></div>
  <div class="modal" role="dialog" aria-modal="true" aria-label="settings">
    <div class="mhead">
      <span>settings</span>
      <button class="x" aria-label="close" onclick={() => (showSettings = false)}>✕</button>
    </div>
    <div class="mbody">
      <div class="sgroup">
        <div class="sglabel">音源</div>
        <fieldset class="src-radios" disabled={running || starting}>
          <label><input type="radio" bind:group={sourceKind} value="lyria" /> Lyria（要APIキー）</label>
          <label><input type="radio" bind:group={sourceKind} value="mocklyria" /> MockLyria</label>
          <label><input type="radio" bind:group={sourceKind} value="test" /> Test</label>
          <label><input type="radio" bind:group={sourceKind} value="mic" /> Mic</label>
          <label><input type="radio" bind:group={sourceKind} value="dummy" /> Dummy</label>
        </fieldset>
        {#if sourceKind === "lyria"}
          <p class="key {apiKeyPresent ? 'ok' : 'ng'}">API key: {apiKeyPresent ? "検出" : "未設定"}</p>
        {/if}
      </div>

      <div class="sgroup">
        <div class="sglabel">MIDI ポート</div>
        <div class="row">
          <select bind:value={midiPortIndex}>
            {#each midiPorts as p, i (i)}
              <option value={i}>{i}: {p}</option>
            {/each}
          </select>
          <button class="tbtn" onclick={refreshPorts}>再取得</button>
          <button class="tbtn" onclick={openPort}>開く</button>
          <button class="tbtn" onclick={closePort} disabled={!midiOpenName}>閉じる</button>
        </div>
        <p class="hint">port: {midiOpenName || "—"} / last: {lastMidi || "—"}</p>
      </div>

      <div class="sgroup">
        <div class="sglabel">MIDI マッピング（Assign を押して MIDI を動かすと割当）</div>
        {#if learning}<p class="learn-hint">「{learning}」を学習中… MIDI を動かす（下の合成でも可）</p>{/if}
        <div class="maprows">
          <div class="maphd"><span>continuous (CC)</span></div>
          {#each CONTINUOUS_TARGETS as t (t)}
            <div class="maprow">
              <span class="mtarget">{t}</span>
              <span class="mbind" class:bound={bindingFor(t) !== "—"}>{bindingFor(t)}</span>
              <button class="assign" class:learning={learning === t} onclick={() => (learning = learning === t ? null : t)}>
                {learning === t ? "…" : "assign"}
              </button>
              <button class="clr" disabled={bindingFor(t) === "—"} onclick={() => clearBinding(t)}>clear</button>
            </div>
          {/each}
          <div class="maphd"><span>action (note / CC&gt;63)</span></div>
          {#each ACTION_TARGETS as t (t)}
            <div class="maprow">
              <span class="mtarget">{t}</span>
              <span class="mbind" class:bound={bindingFor(t) !== "—"}>{bindingFor(t)}</span>
              <button class="assign" class:learning={learning === t} onclick={() => (learning = learning === t ? null : t)}>
                {learning === t ? "…" : "assign"}
              </button>
              <button class="clr" disabled={bindingFor(t) === "—"} onclick={() => clearBinding(t)}>clear</button>
            </div>
          {/each}
        </div>
      </div>

      <div class="sgroup">
        <div class="sglabel">合成インジェクタ（MIDI 無しでも学習/動作確認）</div>
        <div class="synth">
          <label>CC# <input type="number" min="0" max="127" bind:value={synCc} class="num" /></label>
          <label>val <input type="range" min="0" max="127" bind:value={synVal} />{synVal}</label>
          <button class="tbtn" onclick={injectCc}>CC送信</button>
          <label>Note# <input type="number" min="0" max="127" bind:value={synNote} class="num" /></label>
          <button class="tbtn" onclick={() => injectNote(true)}>Note on</button>
          <button class="tbtn" onclick={() => injectNote(false)}>Note off</button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ダークモード（VJ と同系統: 黒〜濃紺グレー、シアン/グリーン accent）。Lyria 演奏に必要な UI のみ表示。 */
  :root { color-scheme: dark; }
  :global(html, body) { margin: 0; background: #0b0d10; }
  /* 1画面完結: viewport に固定してページ自体はスクロールさせない（ライブ中に探さないため）。
     position:fixed + inset:0 は VJ 窓の .vj と同じ方式（height:100vh でも動作は同等）。
     注: かつて「WKWebView で 100vh が 0 になる」仮説があったが計測で否定済み。
     真っ黒の実原因は keyed each の重複キー（each_key_duplicate）による mount 失敗だった。 */
  main {
    position: fixed;
    inset: 0;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    padding: 10px 12px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: hidden;
    color: #cdd3dd;
    background: #0b0d10;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex: 0 0 auto;
  }
  /* 作業領域: 左=prompt space（残り幅）、右=操作パネル群（固定幅）。高さは残り全部。 */
  .workspace {
    flex: 1 1 auto;
    min-height: 0; /* これが無いと子の高さで main が伸びてスクロールが出る */
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
    gap: 10px;
    overflow: hidden;
  }
  .rightcol {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    overflow: hidden;
  }
  .brand {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.14em;
    color: #9fb2c4;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #3a4250;
  }
  .dot.live {
    background: #5fe08a;
    box-shadow: 0 0 8px #5fe08a;
  }
  .topctl { display: flex; align-items: center; gap: 10px; }
  .fps { font-size: 11px; color: #6ff0e8; font-variant-numeric: tabular-nums; }
  /* セッション残り時間: 常時表示。1分を切ると警告色、ローテ中は強調 */
  .sess {
    font-size: 11px;
    color: #9fb2c4;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
    padding: 2px 8px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 999px;
  }
  .sess.warn { color: #f0c874; border-color: rgba(240, 200, 116, 0.45); }
  .sess.rot { color: #6ff0e8; border-color: rgba(79, 208, 216, 0.6); }
  /* VJ 告知メッセージの入力 */
  .mc-input {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    background: #0e1116;
    color: #cdd3dd;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    font: 14px ui-monospace, Menlo, monospace;
    line-height: 1.5;
    resize: vertical;
  }
  .mc-input:focus {
    outline: none;
    border-color: rgba(79, 208, 216, 0.6);
  }
  .mc-current { margin: 8px 0 0; font-size: 11px; color: #f0c874; }
  .mc-current.dim { color: #5c6675; }
  /* message ボタン: VJ に出している間は点灯させて出しっぱなしを防ぐ */
  .tbtn.on { border-color: rgba(240, 200, 116, 0.65); color: #f0c874; }

  /* 新着リクエストのトースト（右下・非操作） */
  .cue-toast {
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 60;
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 9px 15px;
    background: rgba(10, 20, 22, 0.94);
    border: 1px solid rgba(79, 208, 216, 0.55);
    border-radius: 999px;
    font: 12px ui-monospace, Menlo, monospace;
    color: #eafcff;
    pointer-events: none;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55);
    animation: ctpop 0.28s ease-out;
  }
  .ct-label { font-size: 9px; letter-spacing: 0.2em; color: #6ff0e8; }
  .ct-kw { font-weight: 700; }
  .ct-nick { font-size: 10.5px; color: #9fb2c4; }
  @keyframes ctpop {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .midi { font-size: 11px; color: #5c6675; letter-spacing: 0.04em; }
  .midi.on { color: #5fe08a; }
  /* 緊急回避モード発動中バッジ（点滅で目立たせる） */
  .conceal-badge {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: #12151b;
    background: #f0a648;
    border: 1px solid #f0c07a;
    border-radius: 6px;
    padding: 3px 9px;
    animation: concealpulse 0.9s ease-in-out infinite;
  }
  @keyframes concealpulse {
    0%,
    100% {
      opacity: 1;
      box-shadow: 0 0 0 rgba(240, 166, 72, 0);
    }
    50% {
      opacity: 0.72;
      box-shadow: 0 0 12px rgba(240, 166, 72, 0.7);
    }
  }
  .gear {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: #9fb2c4;
    width: 30px;
    height: 26px;
    border-radius: 6px;
    font-size: 15px;
    cursor: pointer;
  }
  .gear:hover { border-color: #4fd0d8; color: #eafcff; }

  /* パネル（極薄枠・落ち着いた濃色） */
  .panel {
    background: #14171d;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 8px;
    margin: 0; /* 縦の間隔は親の gap で制御 */
    padding: 8px 12px 10px;
    min-height: 0;
  }
  /* prompt space は残り高さいっぱいを使い、内側（pad＋サイド）で分割する */
  .panel.pad {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .ptitle {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #7f8b9c;
    margin-bottom: 10px;
  }
  /* 右列は幅が狭いのでノブの間隔を詰める（折り返しは許容） */
  .knobs { display: flex; gap: 11px; flex-wrap: wrap; align-items: flex-start; }
  .toggles { display: flex; flex-direction: column; gap: 6px; align-self: center; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  /* config / fx は右列で縦積み（旧 .cfgrow は撤去） */
  .col { flex: 0 0 auto; }
  .transport { display: flex; gap: 8px; flex-wrap: wrap; margin: 0; flex: 0 0 auto; }

  /* トランスポート/汎用ボタン */
  .tbtn {
    padding: 5px 12px;
    font: 11px ui-monospace, Menlo, monospace;
    background: #1b1f27;
    color: #cdd3dd;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    cursor: pointer;
  }
  .tbtn:hover { border-color: #4fd0d8; color: #eafcff; }
  .tbtn:disabled { opacity: 0.35; cursor: default; }
  .tbtn.go { border-color: #2f7d55; color: #7bf0a6; }
  .tbtn.stop { border-color: #7d3a3a; color: #f0a68e; }

  /* 四角トグル（Max 風） */
  .sq {
    padding: 4px 10px;
    font: 10px ui-monospace, Menlo, monospace;
    background: #1b1f27;
    color: #8a94a6;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
  }
  .sq.on {
    background: #14312e;
    border-color: #4fd0d8;
    color: #6ff0e8;
  }

  .err { color: #f0876a; font-size: 12px; margin: 8px 2px 0; }

  /* pad 描画エラー時のフォールバック（svelte:boundary の failed スニペット） */
  .pad-failed {
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: flex-start;
    padding: 12px 4px;
  }
  .pad-failed .err { margin: 0; }

  /* requests / audience cue
     右列の最下部に置き、残り高さを占める。こうすると件数が 0→5 と増減しても
     上の config / fx / transport の位置が一切動かない（ライブ中に狙う場所がズレない）。 */
  .cue-panel {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .cue-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; flex: 0 0 auto; }
  .cue-head .ptitle { margin-bottom: 0; }
  .cue-empty { font-size: 11px; color: #5c6675; margin: 0; }
  /* CUE_VISIBLE_MAX 件で打ち止めだが、狭い画面でも親からはみ出さないよう内部で収める */
  .cue-list { display: flex; flex-direction: column; gap: 4px; min-height: 0; overflow-y: auto; }
  .cue-more { margin: 6px 2px 0; font-size: 11px; color: #7f8b9c; font-variant-numeric: tabular-nums; }
  .cue-item {
    display: grid;
    grid-template-columns: 22px 1fr auto auto auto;
    gap: 10px;
    align-items: center;
    padding: 5px 8px;
    background: #0e1116;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 6px;
  }
  .cue-item.next { border-color: rgba(79, 208, 216, 0.4); }
  .cue-idx { font-size: 11px; color: #6ff0e8; text-align: center; font-variant-numeric: tabular-nums; }
  .cue-kw { font-size: 13px; color: #eef2f7; }
  .cue-nick { font-size: 10px; color: #7f8b9c; }
  .cue-add {
    padding: 3px 10px;
    font: 10px ui-monospace, Menlo, monospace;
    background: #14312e;
    color: #6ff0e8;
    border: 1px solid #4fd0d8;
    border-radius: 5px;
    cursor: pointer;
  }
  .cue-x {
    padding: 3px 8px;
    font: 10px ui-monospace, Menlo, monospace;
    background: #1b1f27;
    color: #8a94a6;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 5px;
    cursor: pointer;
  }
  .cue-x:hover { border-color: #7d3a3a; color: #f0a68e; }

  /* settings モーダル */
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 40;
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(680px, 92vw);
    max-height: 86vh;
    overflow: auto;
    background: #12151b;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    z-index: 41;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
    color: #cdd3dd;
    font: 12px ui-monospace, Menlo, monospace;
  }
  .mhead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #9fb2c4;
    position: sticky;
    top: 0;
    background: #12151b;
  }
  .x {
    background: transparent;
    border: none;
    color: #8a94a6;
    font-size: 14px;
    cursor: pointer;
  }
  .x:hover { color: #eafcff; }
  .mbody { padding: 12px 16px 18px; display: flex; flex-direction: column; gap: 18px; }
  .sgroup { display: flex; flex-direction: column; gap: 8px; }
  .sglabel {
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #7f8b9c;
  }
  .src-radios { border: none; margin: 0; padding: 0; display: flex; gap: 14px; flex-wrap: wrap; }
  .src-radios label { font-size: 12px; }
  .hint { font-size: 11px; color: #6b7688; margin: 2px 0 0; }
  .learn-hint { font-size: 11px; color: #6ff0e8; margin: 0; }

  /* マッピング表 */
  .maprows { display: flex; flex-direction: column; gap: 3px; }
  .maphd {
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #5c6675;
    margin-top: 6px;
    padding: 2px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }
  .maprow {
    display: grid;
    grid-template-columns: 1fr 120px 74px 60px;
    gap: 8px;
    align-items: center;
  }
  .mtarget { font-size: 12px; color: #cdd3dd; }
  .mbind {
    font-size: 11px;
    color: #5c6675;
    font-variant-numeric: tabular-nums;
    text-align: center;
    padding: 3px 6px;
    background: #0e1116;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 4px;
  }
  .mbind.bound { color: #6ff0e8; border-color: rgba(79, 208, 216, 0.35); }
  .assign,
  .clr {
    padding: 4px 8px;
    font: 10px ui-monospace, Menlo, monospace;
    background: #1b1f27;
    color: #9fb2c4;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 5px;
    cursor: pointer;
  }
  .assign:hover, .clr:hover { border-color: #4fd0d8; color: #eafcff; }
  .assign.learning { background: #4fd0d8; border-color: #4fd0d8; color: #06232a; font-weight: 700; }
  .clr:disabled { opacity: 0.3; cursor: default; }

  .synth { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 11px; }
  .num {
    width: 58px;
    padding: 3px 5px;
    background: #0e1116;
    color: #cdd3dd;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 4px;
    font-variant-numeric: tabular-nums;
  }
  select {
    padding: 4px 6px;
    background: #0e1116;
    color: #cdd3dd;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 4px;
  }
  input[type="range"] { accent-color: #4fd0d8; }
  input[type="radio"] {
    appearance: none;
    width: 13px;
    height: 13px;
    margin: 0 4px 0 0;
    border: 1px solid #4a5361;
    border-radius: 50%;
    background: #0e1116;
    cursor: pointer;
    vertical-align: -2px;
  }
  input[type="radio"]:checked { background: radial-gradient(circle, #4fd0d8 0 4px, #0e1116 4.5px); }
  .key { font-size: 11px; margin: 2px 0 0; }
  .key.ok { color: #5fe08a; }
  .key.ng { color: #f0a668; }
</style>
