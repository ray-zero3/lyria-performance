# Lyria VJ — M2 テレメトリ基盤スケルトン 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2窓（control/VJ）＋Rust hub＋テレメトリ契約をダミーデータで端から端まで通し、VJ窓が最小ハイブリッド描画（波形/タイムライン/操作フラッシュ/背景パルス/読み出し）を第2ディスプレイ全画面で表示する。

**Architecture:** control窓が *measured-telemetry*（frame/event）を生成し Rust hub 経由で VJ窓へ中継。hub は *commanded-state*（HubState）の権威で、変化時に `state` をブロードキャスト。VJ窓は純消費者。トランスポートを `TelemetryTransport` で抽象化し、本番=`tauriTransport`、素のブラウザ検証=`browserTransport`（BroadcastChannel）を環境で自動切替。

**Tech Stack:** Tauri v2 (Rust) / SvelteKit + Svelte 5 (runes) / TypeScript / three.js `three/webgpu` (WebGPU) / Vitest / `cargo test`。

## Global Constraints

- Node 24.2 / Rust 1.88 / cargo-tauri 2.11.4（既存ツールチェーン）。
- Vite dev ポートは **1420 固定**（`strictPort`）。ブラウザ検証は `http://localhost:1420/` と `/vj`。
- SvelteKit は **adapter-static + `ssr=false`（SPA）**。すべてクライアント実行。
- Svelte は **5系 runes**（`$state` 等）。`<script lang="ts">` を使うため `vitePreprocess` を有効化する。
- 契約の**形の単一定義は TS 側**（`src/lib/telemetry/contract.ts`）。Rust は HubState のみ型付けし、frame/event は不透明JSON(`serde_json::Value`)で中継。
- 契約フィールドは **camelCase**（Rust serde は `rename_all = "camelCase"`）。
- 固定長: `SPECTRUM_BINS = 48`、`WAVEFORM_SAMPLES = 256`。session上限 `DURATION_CAP_MS = 600_000`、ローテ目標 `ROTATE_AT_MS = 480_000`。
- 検証: 純ロジック=Vitest／Rust=cargo test、描画・窓配置=`svelte-check` ＋ Chrome/WKWebView 目視。
- VJ窓は例外を投げない（clamp・last-known・防御的ラップ）。
- APIキー等の秘匿情報をログ/コンソールに出さない（M2では未使用だが方針として）。
- git は未初期化のまま（コミット手順は本計画では実行しない。各タスク末尾の「Commit」ステップは *スキップ* し、代わりに検証コマンドの緑を完了条件とする）。

---

## ファイル構成（新規/変更）

```
src-tauri/
  src/lib.rs                      … 変更: commands登録・state管理・setup配線
  src/hub/mod.rs                  … 新規: hubモジュール宣言
  src/hub/state.rs                … 新規: HubState型＋reducer＋commands
  src/hub/relay.rs                … 新規: push_frame/push_event（不透明中継）
  src/windows.rs                  … 新規: 第2ディスプレイ配置＋全画面
  tauri.conf.json                 … 変更: 2窓定義（main=/, vj=/vj）
  capabilities/default.json       … 変更: windows=[main,vj]＋core:event:default
src/
  lib/telemetry/constants.ts      … 新規: 定数
  lib/telemetry/contract.ts       … 新規: 型＋default＋clamp＋validate
  lib/telemetry/dummy.ts          … 新規: ダミー生成器（決定的）
  lib/telemetry/bus.ts            … 新規: TelemetryTransport i/f＋factory
  lib/telemetry/tauriTransport.ts … 新規: 本番トランスポート
  lib/telemetry/browserTransport.ts … 新規: 検証トランスポート（BroadcastChannel）
  lib/vj/store.ts                 … 新規: 消費側ストア（last-known/eventリング）
  lib/vj/renderer.ts              … 新規: three/webgpu 初期化
  lib/vj/scene.ts                 … 新規: rAFループ＋レイヤ合成
  lib/vj/layers/backgroundPulse.ts … 新規
  lib/vj/layers/waveformRibbon.ts  … 新規
  lib/vj/layers/timeline.ts        … 新規
  lib/vj/layers/controlFlashes.ts  … 新規
  lib/vj/layers/readouts.ts        … 新規（DOMオーバーレイ更新）
  routes/+page.svelte             … 変更: control窓シェル＋ダミードライバ
  routes/vj/+page.svelte          … 新規: VJ窓シェル
svelte.config.js                  … 変更: vitePreprocess有効化
vitest.config.js                  … 新規: Vitest設定（$libエイリアス）
package.json                      … 変更: vitest追加＋scripts
```

---

## Task 1: TypeScript + Vitest 基盤

**Files:**
- Modify: `svelte.config.js`
- Modify: `package.json`
- Create: `vitest.config.js`
- Test: `src/lib/sanity.test.ts`

**Interfaces:**
- Produces: `npm test`（vitest run）、`npm run check`（svelte-check）が動く土台。

- [ ] **Step 1: vitePreprocess を有効化**

`svelte.config.js` を次に置換:
```js
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      fallback: "index.html",
    }),
  },
};

export default config;
```

- [ ] **Step 2: vitest を追加**

Run: `cd src-tauri/.. && npm i -D vitest@^2`
（作業ディレクトリは `lyria-vj/`。`npm i -D vitest@^2` を実行）
Expected: devDependencies に vitest が入る。

- [ ] **Step 3: `vitest.config.js` を作成**

```js
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
    },
  },
});
```

- [ ] **Step 4: `package.json` の scripts にテストを追加**

`"scripts"` に以下を追記（既存キーは残す）:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 5: サニティテストを書く（失敗させる）**

`src/lib/sanity.test.ts`:
```ts
import { describe, it, expect } from "vitest";

describe("sanity", () => {
  it("runs vitest", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: テスト実行**

Run: `npm test`
Expected: PASS（1 passed）。

- [ ] **Step 7: 型チェックが通ることを確認**

Run: `npm run check`
Expected: エラー0（warning は可）。

---

## Task 2: テレメトリ契約 + 定数（TS）

**Files:**
- Create: `src/lib/telemetry/constants.ts`
- Create: `src/lib/telemetry/contract.ts`
- Test: `src/lib/telemetry/contract.test.ts`

**Interfaces:**
- Produces:
  - 定数 `SPECTRUM_BINS=48`, `WAVEFORM_SAMPLES=256`, `DURATION_CAP_MS=600000`, `ROTATE_AT_MS=480000`
  - 型 `HubState`, `TelemetryFrame`, `TelemetryEvent`, `WeightedPrompt`, `MusicConfig`
  - `defaultHubState(): HubState`
  - `clampFrame(input: unknown): TelemetryFrame`（不正値を安全化。範囲外 clamp、配列長を固定長に整形）
  - `clamp01(n: number): number`, `clampRange(n, lo, hi): number`

- [ ] **Step 1: 定数ファイルを作成**

`src/lib/telemetry/constants.ts`:
```ts
export const SPECTRUM_BINS = 48;
export const WAVEFORM_SAMPLES = 256;
export const DURATION_CAP_MS = 600_000; // 10分
export const ROTATE_AT_MS = 480_000; // ~8分でローテ目標（M5）
```

- [ ] **Step 2: 失敗するテストを書く**

`src/lib/telemetry/contract.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  defaultHubState,
  clampFrame,
  clamp01,
  clampRange,
} from "./contract";
import { SPECTRUM_BINS, WAVEFORM_SAMPLES, DURATION_CAP_MS } from "./constants";

describe("clamp helpers", () => {
  it("clamp01 clamps to [0,1]", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
  });
  it("clamp01 maps NaN to 0", () => {
    expect(clamp01(NaN)).toBe(0);
  });
  it("clampRange clamps to [lo,hi]", () => {
    expect(clampRange(5, 0, 3)).toBe(3);
    expect(clampRange(-5, 0, 3)).toBe(0);
  });
});

describe("defaultHubState", () => {
  it("has idle session and cap", () => {
    const s = defaultHubState();
    expect(s.session.state).toBe("idle");
    expect(s.session.durationCapMs).toBe(DURATION_CAP_MS);
    expect(s.session.startedAtMs).toBeNull();
    expect(Array.isArray(s.prompts)).toBe(true);
  });
});

describe("clampFrame", () => {
  it("normalizes array lengths to fixed sizes", () => {
    const f = clampFrame({
      tMs: 123,
      seq: 1,
      audio: { level: 2, peak: -1, bands: { low: 5, mid: 0.2, high: 0.3 }, spectrum: [1, 2], waveform: [3], onset: 9 },
    });
    expect(f.audio.spectrum.length).toBe(SPECTRUM_BINS);
    expect(f.audio.waveform.length).toBe(WAVEFORM_SAMPLES);
    expect(f.audio.level).toBe(1); // clamped
    expect(f.audio.peak).toBe(0); // clamped
    expect(f.audio.bands.low).toBe(1);
    expect(f.audio.onset).toBe(1);
  });
  it("survives garbage input without throwing", () => {
    const f = clampFrame(null);
    expect(f.audio.spectrum.length).toBe(SPECTRUM_BINS);
    expect(f.audio.waveform.length).toBe(WAVEFORM_SAMPLES);
    expect(f.seq).toBe(0);
  });
  it("clamps waveform to [-1,1] and spectrum to [0,1]", () => {
    const f = clampFrame({
      tMs: 0, seq: 0,
      audio: { level: 0, peak: 0, bands: { low: 0, mid: 0, high: 0 },
        spectrum: new Array(SPECTRUM_BINS).fill(9),
        waveform: new Array(WAVEFORM_SAMPLES).fill(-9), onset: 0 },
    });
    expect(f.audio.spectrum.every((v) => v === 1)).toBe(true);
    expect(f.audio.waveform.every((v) => v === -1)).toBe(true);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `npm test`
Expected: FAIL（`./contract` が未実装）。

- [ ] **Step 4: 契約を実装**

`src/lib/telemetry/contract.ts`:
```ts
import {
  SPECTRUM_BINS,
  WAVEFORM_SAMPLES,
  DURATION_CAP_MS,
} from "./constants";

export type SessionState =
  | "idle"
  | "connecting"
  | "playing"
  | "rotating"
  | "closed";

export interface MusicConfig {
  bpm: number;
  scale: string;
  guidance: number;
  density: number;
  brightness: number;
}

export interface WeightedPrompt {
  text: string;
  weight: number;
}

export interface HubState {
  session: {
    id: string;
    state: SessionState;
    startedAtMs: number | null;
    durationCapMs: number;
    rotateAtMs: number | null;
  };
  music: MusicConfig;
  prompts: WeightedPrompt[];
  controlParams: Record<string, number>;
}

export interface TelemetryFrame {
  tMs: number;
  seq: number;
  audio: {
    level: number;
    peak: number;
    bands: { low: number; mid: number; high: number };
    spectrum: number[]; // 長さ SPECTRUM_BINS, 0..1
    waveform: number[]; // 長さ WAVEFORM_SAMPLES, -1..1
    onset: number; // 0..1
  };
}

export type TelemetryEvent =
  | {
      kind: "control";
      tMs: number;
      source: "midi" | "ui";
      ctrl: "cc" | "note" | "param";
      id: string | number;
      value: number;
      label?: string;
    }
  | {
      kind: "api";
      tMs: number;
      api: "prompt_set" | "config_set" | "chunk" | "session" | "rotate";
      payload: unknown;
    };

export function clamp01(n: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function clampRange(n: number, lo: number, hi: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

export function defaultMusicConfig(): MusicConfig {
  return { bpm: 120, scale: "C_MAJOR", guidance: 3, density: 0.5, brightness: 0.5 };
}

export function defaultHubState(): HubState {
  return {
    session: {
      id: "none",
      state: "idle",
      startedAtMs: null,
      durationCapMs: DURATION_CAP_MS,
      rotateAtMs: null,
    },
    music: defaultMusicConfig(),
    prompts: [],
    controlParams: {},
  };
}

function fixedArray(
  src: unknown,
  len: number,
  map: (v: number) => number,
): number[] {
  const out = new Array<number>(len).fill(map(0));
  if (Array.isArray(src)) {
    for (let i = 0; i < len && i < src.length; i++) {
      out[i] = map(typeof src[i] === "number" ? src[i] : 0);
    }
  }
  return out;
}

/** 任意入力を安全な TelemetryFrame に整形（不正値は clamp、配列は固定長）。決して throw しない。 */
export function clampFrame(input: unknown): TelemetryFrame {
  const o = (input ?? {}) as Record<string, unknown>;
  const audio = (o.audio ?? {}) as Record<string, unknown>;
  const bands = (audio.bands ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && !Number.isNaN(v) ? v : 0);
  return {
    tMs: num(o.tMs),
    seq: num(o.seq),
    audio: {
      level: clamp01(num(audio.level)),
      peak: clamp01(num(audio.peak)),
      bands: {
        low: clamp01(num(bands.low)),
        mid: clamp01(num(bands.mid)),
        high: clamp01(num(bands.high)),
      },
      spectrum: fixedArray(audio.spectrum, SPECTRUM_BINS, clamp01),
      waveform: fixedArray(audio.waveform, WAVEFORM_SAMPLES, (v) => clampRange(v, -1, 1)),
      onset: clamp01(num(audio.onset)),
    },
  };
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npm test`
Expected: PASS。

- [ ] **Step 6: 型チェック**

Run: `npm run check`
Expected: エラー0。

---

## Task 3: VJ 消費側ストア（TS）

**Files:**
- Create: `src/lib/vj/store.ts`
- Test: `src/lib/vj/store.test.ts`

**Interfaces:**
- Consumes: `contract.ts`（`HubState`, `TelemetryFrame`, `TelemetryEvent`, `clampFrame`, `defaultHubState`）
- Produces: `createVjStore()` を返す。メソッド:
  - `applyState(s: HubState): void`
  - `applyFrame(input: unknown): void`（clampFrame経由、seq後退は無視、欠落は last-known 保持）
  - `pushEvent(e: TelemetryEvent): void`（最大 `EVENT_RING = 64` 件のリング）
  - `snapshot(): { state: HubState; frame: TelemetryFrame; events: TelemetryEvent[]; lastSeq: number; drops: number }`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/vj/store.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createVjStore } from "./store";
import { defaultHubState } from "$lib/telemetry/contract";

function frame(seq: number, level = 0.5) {
  return { tMs: seq * 16, seq, audio: { level, peak: level, bands: { low: 0, mid: 0, high: 0 }, spectrum: [], waveform: [], onset: 0 } };
}

describe("vj store", () => {
  it("starts with default state and zero frame", () => {
    const s = createVjStore();
    const snap = s.snapshot();
    expect(snap.state.session.state).toBe("idle");
    expect(snap.frame.seq).toBe(0);
    expect(snap.events.length).toBe(0);
  });

  it("applies newer frames and ignores stale seq", () => {
    const s = createVjStore();
    s.applyFrame(frame(1, 0.3));
    s.applyFrame(frame(2, 0.7));
    s.applyFrame(frame(1, 0.9)); // stale → 無視
    expect(s.snapshot().frame.seq).toBe(2);
    expect(s.snapshot().frame.audio.level).toBe(0.7);
  });

  it("counts dropped frames via seq gaps", () => {
    const s = createVjStore();
    s.applyFrame(frame(1));
    s.applyFrame(frame(4)); // 2,3 が欠落 → drops += 2
    expect(s.snapshot().drops).toBe(2);
  });

  it("holds last-known frame when given garbage", () => {
    const s = createVjStore();
    s.applyFrame(frame(5, 0.6));
    s.applyFrame(null); // 破損 → seq=0 は stale 扱いで last-known 維持
    expect(s.snapshot().frame.seq).toBe(5);
    expect(s.snapshot().frame.audio.level).toBe(0.6);
  });

  it("keeps event ring bounded", () => {
    const s = createVjStore();
    for (let i = 0; i < 100; i++) {
      s.pushEvent({ kind: "control", tMs: i, source: "ui", ctrl: "cc", id: i, value: 0.1 });
    }
    expect(s.snapshot().events.length).toBe(64);
    // 最新が末尾
    const last = s.snapshot().events[63];
    expect(last.kind === "control" && last.id).toBe(99);
  });

  it("applies hub state", () => {
    const s = createVjStore();
    const st = defaultHubState();
    st.session.state = "playing";
    st.prompts = [{ text: "warm pads", weight: 0.8 }];
    s.applyState(st);
    expect(s.snapshot().state.session.state).toBe("playing");
    expect(s.snapshot().state.prompts[0].text).toBe("warm pads");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test`
Expected: FAIL（`./store` 未実装）。

- [ ] **Step 3: ストアを実装**

`src/lib/vj/store.ts`:
```ts
import {
  clampFrame,
  defaultHubState,
  type HubState,
  type TelemetryEvent,
  type TelemetryFrame,
} from "$lib/telemetry/contract";

const EVENT_RING = 64;

export interface VjSnapshot {
  state: HubState;
  frame: TelemetryFrame;
  events: TelemetryEvent[];
  lastSeq: number;
  drops: number;
}

export interface VjStore {
  applyState(s: HubState): void;
  applyFrame(input: unknown): void;
  pushEvent(e: TelemetryEvent): void;
  snapshot(): VjSnapshot;
}

export function createVjStore(): VjStore {
  let state: HubState = defaultHubState();
  let frame: TelemetryFrame = clampFrame(null); // seq=0 のゼロフレーム
  let lastSeq = 0;
  let drops = 0;
  const events: TelemetryEvent[] = [];

  return {
    applyState(s: HubState) {
      state = s;
    },
    applyFrame(input: unknown) {
      const next = clampFrame(input);
      // seq が後退/同一なら stale として無視（last-known 維持）
      if (next.seq <= lastSeq) return;
      if (lastSeq > 0 && next.seq > lastSeq + 1) {
        drops += next.seq - lastSeq - 1;
      }
      lastSeq = next.seq;
      frame = next;
    },
    pushEvent(e: TelemetryEvent) {
      events.push(e);
      if (events.length > EVENT_RING) events.splice(0, events.length - EVENT_RING);
    },
    snapshot(): VjSnapshot {
      return { state, frame, events: events.slice(), lastSeq, drops };
    },
  };
}
```

- [ ] **Step 4: テスト通過を確認**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5: 型チェック**

Run: `npm run check`
Expected: エラー0。

---

## Task 4: ダミー生成器（TS）

**Files:**
- Create: `src/lib/telemetry/dummy.ts`
- Test: `src/lib/telemetry/dummy.test.ts`

**Interfaces:**
- Consumes: `contract.ts`, `constants.ts`
- Produces:
  - `makeDummyFrame(seq: number, tMs: number): TelemetryFrame`（tMs から決定的に生成。sine波形＋擬似スペクトル）
  - `maybeDummyEvent(seq: number, tMs: number): TelemetryEvent | null`（一定周期で control/api イベント）
  - `dummyStateAt(startedAtMs: number, nowMs: number): HubState`（playing、経過に応じ prompts/config を軽く変化）

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/telemetry/dummy.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { makeDummyFrame, maybeDummyEvent, dummyStateAt } from "./dummy";
import { SPECTRUM_BINS, WAVEFORM_SAMPLES } from "./constants";

describe("makeDummyFrame", () => {
  it("is deterministic for the same inputs", () => {
    const a = makeDummyFrame(10, 1000);
    const b = makeDummyFrame(10, 1000);
    expect(a).toEqual(b);
  });
  it("produces in-range fixed-length arrays", () => {
    const f = makeDummyFrame(3, 500);
    expect(f.audio.spectrum.length).toBe(SPECTRUM_BINS);
    expect(f.audio.waveform.length).toBe(WAVEFORM_SAMPLES);
    expect(f.audio.level).toBeGreaterThanOrEqual(0);
    expect(f.audio.level).toBeLessThanOrEqual(1);
    expect(Math.min(...f.audio.waveform)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...f.audio.waveform)).toBeLessThanOrEqual(1);
    expect(f.seq).toBe(3);
  });
});

describe("maybeDummyEvent", () => {
  it("returns an event on the emit cadence and null otherwise", () => {
    // 30フレームに1回 control を出す設計（下記実装参照）
    expect(maybeDummyEvent(30, 480)).not.toBeNull();
    expect(maybeDummyEvent(1, 16)).toBeNull();
  });
});

describe("dummyStateAt", () => {
  it("reports playing with a started session", () => {
    const s = dummyStateAt(0, 1000);
    expect(s.session.state).toBe("playing");
    expect(s.session.startedAtMs).toBe(0);
    expect(s.prompts.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test`
Expected: FAIL。

- [ ] **Step 3: 実装**

`src/lib/telemetry/dummy.ts`:
```ts
import {
  clamp01,
  defaultMusicConfig,
  type HubState,
  type TelemetryEvent,
  type TelemetryFrame,
} from "./contract";
import {
  SPECTRUM_BINS,
  WAVEFORM_SAMPLES,
  DURATION_CAP_MS,
  ROTATE_AT_MS,
} from "./constants";

const TAU = Math.PI * 2;
const EVENT_EVERY = 30; // フレーム毎に control イベント
const API_EVERY = 90; // フレーム毎に api イベント

/** tMs から決定的にフレームを生成（実 AnalyserNode の代役）。 */
export function makeDummyFrame(seq: number, tMs: number): TelemetryFrame {
  const t = tMs / 1000;
  const level = clamp01(0.4 + 0.35 * Math.sin(t * 1.3) + 0.15 * Math.sin(t * 5.1));
  const low = clamp01(0.5 + 0.5 * Math.sin(t * 0.9));
  const mid = clamp01(0.5 + 0.5 * Math.sin(t * 2.3 + 1));
  const high = clamp01(0.5 + 0.5 * Math.sin(t * 4.7 + 2));

  const spectrum = new Array<number>(SPECTRUM_BINS);
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    const f = i / SPECTRUM_BINS;
    const env = Math.exp(-f * 2.5); // 低域が強い
    spectrum[i] = clamp01(env * (0.6 + 0.4 * Math.sin(t * (2 + f * 8) + i)));
  }

  const waveform = new Array<number>(WAVEFORM_SAMPLES);
  for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
    const p = i / WAVEFORM_SAMPLES;
    waveform[i] =
      0.6 * Math.sin(p * TAU * 3 + t * 4) * level +
      0.25 * Math.sin(p * TAU * 11 + t * 7);
  }

  const onset = seq % EVENT_EVERY === 0 ? 1 : clamp01(0.2 * Math.abs(Math.sin(t * 9)));

  return { tMs, seq, audio: { level, peak: clamp01(level + 0.1), bands: { low, mid, high }, spectrum, waveform, onset } };
}

export function maybeDummyEvent(seq: number, tMs: number): TelemetryEvent | null {
  if (seq > 0 && seq % EVENT_EVERY === 0) {
    const id = (seq / EVENT_EVERY) % 8;
    return { kind: "control", tMs, source: "ui", ctrl: "cc", id, value: clamp01(0.5 + 0.5 * Math.sin(tMs / 700)), label: `cc${id}` };
  }
  if (seq > 0 && seq % API_EVERY === 0) {
    return { kind: "api", tMs, api: "chunk", payload: { chunkIndex: seq / API_EVERY, bytes: 48000 } };
  }
  return null;
}

/** ダミーの HubState（playing）。経過で prompt/config を軽く変化。 */
export function dummyStateAt(startedAtMs: number, nowMs: number): HubState {
  const elapsed = nowMs - startedAtMs;
  const music = defaultMusicConfig();
  music.bpm = 120 + Math.round(8 * Math.sin(elapsed / 4000));
  music.brightness = clamp01(0.5 + 0.3 * Math.sin(elapsed / 3000));
  music.density = clamp01(0.5 + 0.3 * Math.cos(elapsed / 5000));
  const prompts =
    elapsed % 16000 < 8000
      ? [{ text: "warm analog pads", weight: 0.8 }, { text: "sub bass", weight: 0.4 }]
      : [{ text: "glassy arps", weight: 0.7 }, { text: "airy noise", weight: 0.3 }];
  return {
    session: {
      id: "dummy-1",
      state: "playing",
      startedAtMs,
      durationCapMs: DURATION_CAP_MS,
      rotateAtMs: startedAtMs + ROTATE_AT_MS,
    },
    music,
    prompts,
    controlParams: { bpm: music.bpm, brightness: music.brightness, density: music.density },
  };
}
```

- [ ] **Step 4: テスト通過を確認**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5: 型チェック**

Run: `npm run check`
Expected: エラー0。

---

## Task 5: トランスポート抽象化（TS）

**Files:**
- Create: `src/lib/telemetry/bus.ts`
- Create: `src/lib/telemetry/browserTransport.ts`
- Create: `src/lib/telemetry/tauriTransport.ts`
- Test: `src/lib/telemetry/browserTransport.test.ts`

**Interfaces:**
- Consumes: `contract.ts`
- Produces:
  - `interface TelemetryTransport`（下記）
  - `createTransport(role: "control" | "vj"): TelemetryTransport`（`window.__TAURI__` 判定で自動切替。SSRなし前提でクライアントのみ）
  - `createBrowserTransport(role, channelFactory?)`（channelFactory 注入でテスト可能）

```ts
interface TelemetryTransport {
  // control→(hub)→vj
  pushFrame(frame: TelemetryFrame): void;
  pushEvent(event: TelemetryEvent): void;
  onFrame(cb: (f: TelemetryFrame) => void): void;
  onEvent(cb: (e: TelemetryEvent) => void): void;
  // hub state
  onState(cb: (s: HubState) => void): void;
  getState(): Promise<HubState>;
  setState(patch: Partial<HubState>): void; // browser: controlがhub代行 / tauri: set_* commandへ
  dispose(): void;
}
```

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/telemetry/browserTransport.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { createBrowserTransport, type ChannelLike } from "./browserTransport";
import { defaultHubState } from "./contract";

/** BroadcastChannel を模す最小の共有バス（同一プロセス内の複数チャネルを繋ぐ）。 */
function makeFakeBus() {
  const peers: FakeChannel[] = [];
  class FakeChannel implements ChannelLike {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    constructor() {
      peers.push(this);
    }
    postMessage(data: unknown) {
      for (const p of peers) {
        if (p !== this) p.onmessage?.({ data: structuredClone(data) });
      }
    }
    close() {
      const i = peers.indexOf(this);
      if (i >= 0) peers.splice(i, 1);
    }
  }
  return () => new FakeChannel();
}

describe("browserTransport", () => {
  it("relays frames from control to vj", () => {
    const factory = makeFakeBus();
    const control = createBrowserTransport("control", factory);
    const vj = createBrowserTransport("vj", factory);
    const got = vi.fn();
    vj.onFrame(got);
    control.pushFrame({ tMs: 1, seq: 1, audio: { level: 0.5, peak: 0.5, bands: { low: 0, mid: 0, high: 0 }, spectrum: [], waveform: [], onset: 0 } });
    expect(got).toHaveBeenCalledTimes(1);
    expect(got.mock.calls[0][0].seq).toBe(1);
    control.dispose();
    vj.dispose();
  });

  it("control answers getState for vj", async () => {
    const factory = makeFakeBus();
    const control = createBrowserTransport("control", factory);
    const vj = createBrowserTransport("vj", factory);
    const st = defaultHubState();
    st.session.state = "playing";
    control.setState(st);
    const fetched = await vj.getState();
    expect(fetched.session.state).toBe("playing");
    control.dispose();
    vj.dispose();
  });

  it("broadcasts state changes to vj onState", () => {
    const factory = makeFakeBus();
    const control = createBrowserTransport("control", factory);
    const vj = createBrowserTransport("vj", factory);
    const onState = vi.fn();
    vj.onState(onState);
    const st = defaultHubState();
    st.prompts = [{ text: "x", weight: 1 }];
    control.setState(st);
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState.mock.calls[0][0].prompts[0].text).toBe("x");
    control.dispose();
    vj.dispose();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npm test`
Expected: FAIL。

- [ ] **Step 3: browserTransport を実装**

`src/lib/telemetry/browserTransport.ts`:
```ts
import {
  defaultHubState,
  type HubState,
  type TelemetryEvent,
  type TelemetryFrame,
} from "./contract";
import type { TelemetryTransport } from "./bus";

export interface ChannelLike {
  postMessage(data: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close(): void;
}

type Msg =
  | { t: "frame"; frame: TelemetryFrame }
  | { t: "event"; event: TelemetryEvent }
  | { t: "state"; state: HubState }
  | { t: "getState" }; // vj → control 要求。control は "state" で応答。

const CHANNEL_NAME = "lyria-vj-telemetry";

function defaultFactory(): ChannelLike {
  return new BroadcastChannel(CHANNEL_NAME) as unknown as ChannelLike;
}

/**
 * ブラウザ検証用トランスポート。
 * control ロールが hub を代行（HubState を保持し getState/state を応答）。
 */
export function createBrowserTransport(
  role: "control" | "vj",
  channelFactory: () => ChannelLike = defaultFactory,
): TelemetryTransport {
  const ch = channelFactory();
  const frameCbs: Array<(f: TelemetryFrame) => void> = [];
  const eventCbs: Array<(e: TelemetryEvent) => void> = [];
  const stateCbs: Array<(s: HubState) => void> = [];
  let localState: HubState = defaultHubState(); // control が権威

  ch.onmessage = (ev) => {
    const m = ev.data as Msg;
    if (!m || typeof m !== "object") return;
    switch (m.t) {
      case "frame":
        for (const cb of frameCbs) cb(m.frame);
        break;
      case "event":
        for (const cb of eventCbs) cb(m.event);
        break;
      case "state":
        localState = m.state;
        for (const cb of stateCbs) cb(m.state);
        break;
      case "getState":
        if (role === "control") ch.postMessage({ t: "state", state: localState } satisfies Msg);
        break;
    }
  };

  return {
    pushFrame(frame) {
      ch.postMessage({ t: "frame", frame } satisfies Msg);
    },
    pushEvent(event) {
      ch.postMessage({ t: "event", event } satisfies Msg);
    },
    onFrame(cb) {
      frameCbs.push(cb);
    },
    onEvent(cb) {
      eventCbs.push(cb);
    },
    onState(cb) {
      stateCbs.push(cb);
    },
    getState() {
      if (role === "control") return Promise.resolve(localState);
      return new Promise<HubState>((resolve) => {
        const onMsg = (ev: { data: unknown }) => {
          const m = ev.data as Msg;
          if (m && m.t === "state") {
            resolve(m.state);
          }
        };
        // 一時リスナ: 既存 onmessage を包む
        const prev = ch.onmessage;
        ch.onmessage = (ev) => {
          prev?.(ev);
          onMsg(ev);
        };
        ch.postMessage({ t: "getState" } satisfies Msg);
        // フォールバック: 応答が無ければデフォルト
        setTimeout(() => resolve(defaultHubState()), 300);
      });
    },
    setState(patch) {
      localState = { ...localState, ...patch } as HubState;
      ch.postMessage({ t: "state", state: localState } satisfies Msg);
      for (const cb of stateCbs) cb(localState);
    },
    dispose() {
      ch.close();
    },
  };
}
```

> 注: `setState` は本計画では全 HubState を渡す（`Partial` だが実質フルステート）。テストの `control.setState(st)` は完全な state を渡している。

- [ ] **Step 4: bus.ts（i/f＋factory）と tauriTransport を実装**

`src/lib/telemetry/bus.ts`:
```ts
import type { HubState, TelemetryEvent, TelemetryFrame } from "./contract";
import { createBrowserTransport } from "./browserTransport";
import { createTauriTransport } from "./tauriTransport";

export interface TelemetryTransport {
  pushFrame(frame: TelemetryFrame): void;
  pushEvent(event: TelemetryEvent): void;
  onFrame(cb: (f: TelemetryFrame) => void): void;
  onEvent(cb: (e: TelemetryEvent) => void): void;
  onState(cb: (s: HubState) => void): void;
  getState(): Promise<HubState>;
  setState(patch: Partial<HubState>): void;
  dispose(): void;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

export function createTransport(role: "control" | "vj"): TelemetryTransport {
  return isTauri() ? createTauriTransport(role) : createBrowserTransport(role);
}
```

`src/lib/telemetry/tauriTransport.ts`:
```ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { HubState, TelemetryEvent, TelemetryFrame } from "./contract";
import type { TelemetryTransport } from "./bus";

/**
 * 本番トランスポート。
 * control: pushFrame/pushEvent → invoke("push_frame"/"push_event")（Rust hub が vj へ emit_to）。
 * vj: listen("frame"/"event"/"state")。getState → invoke("get_state")。
 * setState → invoke("set_state")（hub が state をブロードキャスト）。
 */
export function createTauriTransport(_role: "control" | "vj"): TelemetryTransport {
  const unlisteners: Array<Promise<() => void>> = [];

  return {
    pushFrame(frame) {
      void invoke("push_frame", { frame });
    },
    pushEvent(event) {
      void invoke("push_event", { event });
    },
    onFrame(cb) {
      unlisteners.push(listen<TelemetryFrame>("frame", (e) => cb(e.payload)));
    },
    onEvent(cb) {
      unlisteners.push(listen<TelemetryEvent>("event", (e) => cb(e.payload)));
    },
    onState(cb) {
      unlisteners.push(listen<HubState>("state", (e) => cb(e.payload)));
    },
    getState() {
      return invoke<HubState>("get_state");
    },
    setState(patch) {
      void invoke("set_state", { patch });
    },
    dispose() {
      for (const u of unlisteners) void u.then((fn) => fn());
    },
  };
}
```

- [ ] **Step 5: テスト通過を確認**

Run: `npm test`
Expected: PASS（browserTransport の3テスト）。

- [ ] **Step 6: 型チェック**

Run: `npm run check`
Expected: エラー0。

---

## Task 6: Rust hub（HubState＋commands＋不透明中継）

**Files:**
- Create: `src-tauri/src/hub/mod.rs`
- Create: `src-tauri/src/hub/state.rs`
- Create: `src-tauri/src/hub/relay.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces（TS 契約と camelCase 一致）:
  - `HubState`（serde, `rename_all="camelCase"`）: session{id,state,startedAtMs,durationCapMs,rotateAtMs}, music{bpm,scale,guidance,density,brightness}, prompts[], controlParams
  - commands: `get_state() -> HubState`, `set_state(patch: HubState)`（全置換）, `push_frame(frame: serde_json::Value)`, `push_event(event: serde_json::Value)`
  - `set_state` は `state` を全ウィンドウへ emit。`push_frame`/`push_event` は `emit_to("vj", ...)`。

- [ ] **Step 1: hub/state.rs を実装（reducer 単体テスト付き）**

`src-tauri/src/hub/state.rs`:
```rust
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub state: String, // "idle"|"connecting"|"playing"|"rotating"|"closed"
    pub started_at_ms: Option<f64>,
    pub duration_cap_ms: f64,
    pub rotate_at_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MusicConfig {
    pub bpm: f64,
    pub scale: String,
    pub guidance: f64,
    pub density: f64,
    pub brightness: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WeightedPrompt {
    pub text: String,
    pub weight: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubState {
    pub session: Session,
    pub music: MusicConfig,
    pub prompts: Vec<WeightedPrompt>,
    pub control_params: BTreeMap<String, f64>,
}

impl Default for HubState {
    fn default() -> Self {
        HubState {
            session: Session {
                id: "none".into(),
                state: "idle".into(),
                started_at_ms: None,
                duration_cap_ms: 600_000.0,
                rotate_at_ms: None,
            },
            music: MusicConfig {
                bpm: 120.0,
                scale: "C_MAJOR".into(),
                guidance: 3.0,
                density: 0.5,
                brightness: 0.5,
            },
            prompts: Vec::new(),
            control_params: BTreeMap::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_idle_with_cap() {
        let s = HubState::default();
        assert_eq!(s.session.state, "idle");
        assert_eq!(s.session.duration_cap_ms, 600_000.0);
        assert!(s.session.started_at_ms.is_none());
    }

    #[test]
    fn serializes_to_camelcase() {
        let s = HubState::default();
        let v = serde_json::to_value(&s).unwrap();
        // camelCase キーが存在
        assert!(v["session"]["durationCapMs"].is_number());
        assert!(v["session"]["startedAtMs"].is_null());
        assert!(v["music"]["brightness"].is_number());
        assert!(v["controlParams"].is_object());
    }

    #[test]
    fn roundtrips_through_json() {
        let mut s = HubState::default();
        s.session.state = "playing".into();
        s.prompts.push(WeightedPrompt { text: "warm pads".into(), weight: 0.8 });
        let json = serde_json::to_string(&s).unwrap();
        let back: HubState = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }
}
```

- [ ] **Step 2: reducer/シリアライズのテストが通ることを確認**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS（3 tests）。※ `hub` モジュールは Step 4 で `lib.rs` に宣言するまでコンパイル対象外。この Step ではまず Step 4 まで進めてから実行してよい（下記 Step 6 で一括確認）。

- [ ] **Step 3: relay.rs（不透明中継＋commands）を実装**

`src-tauri/src/hub/relay.rs`:
```rust
use crate::hub::state::HubState;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// vj ウィンドウへ frame を中継（不透明JSON）。
#[tauri::command]
pub fn push_frame(app: AppHandle, frame: serde_json::Value) {
    let _ = app.emit_to("vj", "frame", frame);
}

/// vj ウィンドウへ event を中継（不透明JSON）。
#[tauri::command]
pub fn push_event(app: AppHandle, event: serde_json::Value) {
    let _ = app.emit_to("vj", "event", event);
}

/// 現在の HubState スナップショットを返す。
#[tauri::command]
pub fn get_state(state: State<'_, Mutex<HubState>>) -> HubState {
    state.lock().map(|s| s.clone()).unwrap_or_default()
}

/// HubState を全置換し、全ウィンドウへ "state" をブロードキャスト。
#[tauri::command]
pub fn set_state(app: AppHandle, state: State<'_, Mutex<HubState>>, patch: HubState) {
    if let Ok(mut s) = state.lock() {
        *s = patch.clone();
    }
    let _ = app.emit("state", patch);
}
```

- [ ] **Step 4: hub/mod.rs と lib.rs を配線**

`src-tauri/src/hub/mod.rs`:
```rust
pub mod relay;
pub mod state;
```

`src-tauri/src/lib.rs` を次に置換:
```rust
// Lyria VJ M2: 2窓＋hub＋テレメトリ中継のバックエンド。
mod hub;
mod windows;

use hub::state::HubState;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(HubState::default()))
        .invoke_handler(tauri::generate_handler![
            hub::relay::get_state,
            hub::relay::set_state,
            hub::relay::push_frame,
            hub::relay::push_event,
        ])
        .setup(|app| {
            windows::place_vj_on_second_display(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

> 注: `windows.rs` は Task 12 で実装。**このタスクだけ先に cargo test したい場合**は `mod windows;` と `.setup(...)` を一時的にコメントアウトして `cargo test --lib` を実行し、確認後に戻す。順番に実装するなら Task 12 まで進めてから `cargo test`/`cargo tauri dev` する。

- [ ] **Step 5: report_probe の扱い**

`report_probe` は M2 では不要。`src/routes/+page.svelte` は Task 10 で置換されるため `report_probe` 呼び出しは消える。`lib.rs` からも削除済み（上記 Step 4 の置換で消えている）。

- [ ] **Step 6: Rust 単体テストを実行**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS（state.rs の3テスト）。`windows` 未実装なら Step 4 の注記どおり一時コメントアウトで確認。

---

## Task 7: VJ レンダラ＋シーン骨格（描画・目視）

**Files:**
- Create: `src/lib/vj/renderer.ts`
- Create: `src/lib/vj/scene.ts`

**Interfaces:**
- Consumes: `three/webgpu`, `store.ts`
- Produces:
  - `createRenderer(canvasHolder: HTMLElement): Promise<{ renderer, scene, camera, dispose }>`（WebGPU初期化、失敗時は例外を投げず `null` 返却の安全版）
  - `startScene(holder: HTMLElement, store: VjStore): Promise<() => void>`（rAFループ開始、dispose関数を返す。M2はまず clear color ＋ 背景パルスの土台）

- [ ] **Step 1: renderer.ts を実装**

`src/lib/vj/renderer.ts`:
```ts
import * as THREE from "three/webgpu";

export interface RendererBundle {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  resize: (w: number, h: number) => void;
  dispose: () => void;
}

/** WebGPU レンダラを初期化。失敗しても throw せず null を返す（VJ窓の堅牢性）。 */
export async function createRenderer(holder: HTMLElement): Promise<RendererBundle | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.gpu) return null;
    const renderer = new THREE.WebGPURenderer({ antialias: true });
    const w = holder.clientWidth || window.innerWidth;
    const h = holder.clientHeight || window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    await renderer.init();
    if (!renderer.backend?.isWebGPUBackend) {
      // WebGL フォールバックでも描画は継続可。ログのみ。
      console.warn("[vj] WebGPU backend 未使用（fallback）");
    }
    holder.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    // 画面いっぱいに 2D 平面を張るための正射影カメラ（-1..1）
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
    camera.position.z = 1;

    const resize = (nw: number, nh: number) => {
      renderer.setSize(nw, nh);
    };
    const dispose = () => {
      renderer.dispose();
      renderer.domElement.remove();
    };
    return { renderer, scene, camera, resize, dispose };
  } catch (e) {
    console.error("[vj] createRenderer 失敗:", e);
    return null;
  }
}
```

- [ ] **Step 2: scene.ts（rAFループ土台）を実装**

`src/lib/vj/scene.ts`:
```ts
import * as THREE from "three/webgpu";
import { createRenderer } from "./renderer";
import type { VjStore } from "./store";
import { createBackgroundPulse } from "./layers/backgroundPulse";
import { createWaveformRibbon } from "./layers/waveformRibbon";
import { createControlFlashes } from "./layers/controlFlashes";
import { updateTimeline } from "./layers/timeline";
import { updateReadouts } from "./layers/readouts";

export interface Layer {
  object?: THREE.Object3D;
  update: (store: VjStore, nowMs: number) => void;
  dispose?: () => void;
}

/** VJ シーンを開始。dispose 関数を返す。描画不可時も throw しない。 */
export async function startScene(
  holder: HTMLElement,
  overlay: HTMLElement,
  store: VjStore,
): Promise<() => void> {
  const bundle = await createRenderer(holder);
  if (!bundle) {
    overlay.textContent = "WebGPU 初期化に失敗しました（描画停止）";
    return () => {};
  }
  const { renderer, scene, camera, resize, dispose } = bundle;

  const bg = createBackgroundPulse();
  const ribbon = createWaveformRibbon();
  const flashes = createControlFlashes();
  const layers: Layer[] = [bg, ribbon, flashes];
  for (const l of layers) if (l.object) scene.add(l.object);

  let raf = 0;
  let running = true;
  const onResize = () => resize(holder.clientWidth, holder.clientHeight);
  window.addEventListener("resize", onResize);

  const loop = () => {
    if (!running) return;
    const nowMs = performance.now();
    try {
      for (const l of layers) l.update(store, nowMs);
      updateTimeline(overlay, store, nowMs);
      updateReadouts(overlay, store);
      void renderer.renderAsync(scene, camera);
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
    for (const l of layers) l.dispose?.();
    dispose();
  };
}
```

> このタスクは Task 8/9 のレイヤ実装に依存する。順序としては Task 8→9 のレイヤを先に用意してから `scene.ts` をコンパイル可能にする。**実装順:** Task 7 の renderer.ts → Task 8/9 のレイヤ → Task 7 の scene.ts の順でファイルを揃え、最後に Task 11 で `/vj` から呼ぶ。

- [ ] **Step 3: 型チェック（レイヤ実装後）**

Run: `npm run check`
Expected: エラー0（Task 8/9 完了後）。

---

## Task 8: レイヤ backgroundPulse ＋ waveformRibbon（描画・目視）

**Files:**
- Create: `src/lib/vj/layers/backgroundPulse.ts`
- Create: `src/lib/vj/layers/waveformRibbon.ts`

**Interfaces:**
- Produces: `createBackgroundPulse(): Layer`, `createWaveformRibbon(): Layer`（`Layer` 型は `scene.ts`）

- [ ] **Step 1: backgroundPulse を実装**

`src/lib/vj/layers/backgroundPulse.ts`:
```ts
import * as THREE from "three/webgpu";
import type { Layer } from "../scene";

/** 全画面クアッド。level/bands で色と明度が呼吸する（オーガニックの媒体プレースホルダ）。 */
export function createBackgroundPulse(): Layer {
  const geo = new THREE.PlaneGeometry(2, 2);
  const mat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0x0a0a12) });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.z = -1;

  return {
    object: mesh,
    update: (store) => {
      const { frame } = store.snapshot();
      const { level, bands } = frame.audio;
      // 低域=青紫、中域=シアン、高域=マゼンタ寄りに、level で明度
      const r = 0.05 + 0.25 * bands.high + 0.15 * level;
      const g = 0.05 + 0.20 * bands.mid + 0.10 * level;
      const b = 0.08 + 0.35 * bands.low + 0.20 * level;
      (mat.color as THREE.Color).setRGB(r, g, b);
    },
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}
```

- [ ] **Step 2: waveformRibbon を実装**

`src/lib/vj/layers/waveformRibbon.ts`:
```ts
import * as THREE from "three/webgpu";
import { WAVEFORM_SAMPLES } from "$lib/telemetry/constants";
import type { Layer } from "../scene";

/** 波形を横断するラインとして描く（読めるデータの看板要素）。 */
export function createWaveformRibbon(): Layer {
  const positions = new Float32Array(WAVEFORM_SAMPLES * 3);
  for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
    positions[i * 3] = (i / (WAVEFORM_SAMPLES - 1)) * 2 - 1; // x: -1..1
    positions[i * 3 + 1] = 0; // y
    positions[i * 3 + 2] = 0.1; // z（背景より手前）
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicNodeMaterial({ color: 0x8fe9ff });
  const line = new THREE.Line(geo, mat);

  return {
    object: line,
    update: (store) => {
      const { frame } = store.snapshot();
      const wf = frame.audio.waveform;
      const attr = geo.getAttribute("position") as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const n = Math.min(WAVEFORM_SAMPLES, wf.length);
      for (let i = 0; i < n; i++) {
        arr[i * 3 + 1] = wf[i] * 0.7; // y に波形
      }
      attr.needsUpdate = true;
    },
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}
```

- [ ] **Step 3: 型チェック**

Run: `npm run check`
Expected: エラー0（`scene.ts` の import が解決）。

- [ ] **Step 4: 目視（Task 11 完了後にまとめて）**

このタスク単体の目視は Task 11（/vj 配線）完了後に実施。期待: 背景色が呼吸し、中央に波形ラインが揺れる。

---

## Task 9: レイヤ timeline ＋ controlFlashes ＋ readouts（描画・目視）

**Files:**
- Create: `src/lib/vj/layers/timeline.ts`
- Create: `src/lib/vj/layers/controlFlashes.ts`
- Create: `src/lib/vj/layers/readouts.ts`

**Interfaces:**
- Produces:
  - `createControlFlashes(): Layer`（`TelemetryEvent{control}` を store.events から拾い、点を明滅）
  - `updateTimeline(overlay: HTMLElement, store, nowMs): void`（DOMオーバーレイにタイムライン文字列）
  - `updateReadouts(overlay: HTMLElement, store): void`（prompt/config/session をDOMに）

> timeline/readouts は DOM オーバーレイ更新関数（`Layer` ではない）。`scene.ts` から直接呼ぶ。

- [ ] **Step 1: controlFlashes を実装**

`src/lib/vj/layers/controlFlashes.ts`:
```ts
import * as THREE from "three/webgpu";
import type { Layer } from "../scene";

const MAX_FLASHES = 32;

/** control イベントごとに点を出し、減衰させる。 */
export function createControlFlashes(): Layer {
  const positions = new Float32Array(MAX_FLASHES * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsNodeMaterial({ color: 0xffe08a, size: 14, transparent: true });
  const points = new THREE.Points(geo, mat);

  let lastSeen = 0;
  const active: Array<{ x: number; y: number; born: number }> = [];

  return {
    object: points,
    update: (store, nowMs) => {
      const snap = store.snapshot();
      // 新規 control イベントを拾う（events は最大64件）
      for (const e of snap.events) {
        if (e.kind === "control" && e.tMs > lastSeen) {
          const x = (Number(typeof e.id === "number" ? e.id : 0) / 8) * 1.6 - 0.8;
          const y = (e.value - 0.5) * 1.4;
          active.push({ x, y, born: nowMs });
          lastSeen = e.tMs;
        }
      }
      // 減衰（0.8秒）＆バッファ更新
      while (active.length > MAX_FLASHES) active.shift();
      const attr = geo.getAttribute("position") as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let i = 0; i < MAX_FLASHES; i++) {
        const f = active[i];
        if (f && nowMs - f.born < 800) {
          arr[i * 3] = f.x;
          arr[i * 3 + 1] = f.y;
          arr[i * 3 + 2] = 0.2;
        } else {
          arr[i * 3] = 999; // 画面外へ退避
          arr[i * 3 + 1] = 999;
          arr[i * 3 + 2] = 0.2;
        }
      }
      attr.needsUpdate = true;
    },
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}
```

- [ ] **Step 2: timeline を実装**

`src/lib/vj/layers/timeline.ts`:
```ts
import type { VjStore } from "../store";

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

/** セッション経過/残り/ローテを DOM オーバーレイの #tl に書く。 */
export function updateTimeline(overlay: HTMLElement, store: VjStore, _nowMs: number): void {
  const el = overlay.querySelector<HTMLElement>("#tl");
  if (!el) return;
  const { state } = store.snapshot();
  const { startedAtMs, durationCapMs, rotateAtMs, state: ss } = state.session;
  if (startedAtMs == null) {
    el.textContent = `session: ${ss}`;
    return;
  }
  const elapsed = Date.now() - startedAtMs;
  const remaining = durationCapMs - elapsed;
  const toRotate = rotateAtMs != null ? rotateAtMs - Date.now() : null;
  el.textContent =
    `${ss}  ${fmt(elapsed)} / ${fmt(durationCapMs)}  ·  残り ${fmt(remaining)}` +
    (toRotate != null ? `  ·  rotate in ${fmt(toRotate)}` : "");
}
```

- [ ] **Step 3: readouts を実装**

`src/lib/vj/layers/readouts.ts`:
```ts
import type { VjStore } from "../store";

/** prompt/config/drops を DOM オーバーレイの #ro に書く（読めるデータ層）。 */
export function updateReadouts(overlay: HTMLElement, store: VjStore): void {
  const el = overlay.querySelector<HTMLElement>("#ro");
  if (!el) return;
  const snap = store.snapshot();
  const { music, prompts } = snap.state;
  const promptLine = prompts.length
    ? prompts.map((p) => `${p.text}·w${p.weight.toFixed(1)}`).join("   ")
    : "(no prompts)";
  el.textContent =
    `${promptLine}\n` +
    `bpm ${music.bpm.toFixed(0)} | guid ${music.guidance.toFixed(1)} | ` +
    `dens ${music.density.toFixed(2)} | bright ${music.brightness.toFixed(2)}\n` +
    `seq ${snap.lastSeq} | drops ${snap.drops} | lvl ${snap.frame.audio.level.toFixed(2)}`;
}
```

- [ ] **Step 4: 型チェック**

Run: `npm run check`
Expected: エラー0。

---

## Task 10: control 窓シェル＋ダミードライバ（Svelte・目視）

**Files:**
- Modify: `src/routes/+page.svelte`（probe を置換）

**Interfaces:**
- Consumes: `createTransport`, `makeDummyFrame`, `maybeDummyEvent`, `dummyStateAt`
- 動作: control 窓としてダミー生成器を回し、frame(60fps)/event を transport で push。開始時に session を張り、`setState` で state をブロードキャスト。stub ボタンで prompts/bpm を変更。

- [ ] **Step 1: +page.svelte を置換**

`src/routes/+page.svelte`:
```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { createTransport, type TelemetryTransport } from "$lib/telemetry/bus";
  import { makeDummyFrame, maybeDummyEvent, dummyStateAt } from "$lib/telemetry/dummy";

  let transport: TelemetryTransport | null = null;
  let raf = 0;
  let seq = 0;
  let startedAtMs = 0;
  let running = $state(false);
  let fps = $state(0);
  let lastFpsT = 0;
  let frames = 0;

  function start() {
    if (running) return;
    running = true;
    startedAtMs = Date.now();
    seq = 0;
    transport?.setState(dummyStateAt(startedAtMs, Date.now()));
    lastFpsT = performance.now();
    const loop = () => {
      if (!running) return;
      const now = Date.now();
      seq += 1;
      const f = makeDummyFrame(seq, now - startedAtMs);
      transport?.pushFrame(f);
      const ev = maybeDummyEvent(seq, now - startedAtMs);
      if (ev) transport?.pushEvent(ev);
      // 状態は 500ms 毎に更新
      if (seq % 30 === 0) transport?.setState(dummyStateAt(startedAtMs, now));
      // FPS 計測
      frames++;
      const pt = performance.now();
      if (pt - lastFpsT >= 1000) {
        fps = frames;
        frames = 0;
        lastFpsT = pt;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  function bumpBpm() {
    transport?.setState({ ...dummyStateAt(startedAtMs || Date.now(), Date.now()) });
  }

  onMount(() => {
    transport = createTransport("control");
  });
  onDestroy(() => {
    stop();
    transport?.dispose();
  });
</script>

<main>
  <h1>lyria-vj — control（M2 ダミードライバ）</h1>
  <div class="row">
    {#if running}
      <button onclick={stop}>停止</button>
    {:else}
      <button onclick={start}>ダミー開始</button>
    {/if}
    <button onclick={bumpBpm} disabled={!running}>state 更新</button>
    <span class="fps">push {fps} fps</span>
  </div>
  <p class="hint">
    ブラウザ検証: このタブ（<code>/</code>）で「ダミー開始」後、別タブで <code>/vj</code> を開くと反応します。
  </p>
</main>

<style>
  :root { color-scheme: dark; }
  main { font-family: -apple-system, system-ui, sans-serif; padding: 20px; background: #101018; color: #e8e8f0; min-height: 100vh; box-sizing: border-box; }
  h1 { font-size: 18px; }
  .row { display: flex; gap: 12px; align-items: center; margin: 12px 0; }
  button { padding: 8px 16px; font-size: 14px; background: #2a2a3a; color: #e8e8f0; border: 1px solid #444; border-radius: 6px; cursor: pointer; }
  button:disabled { opacity: 0.4; cursor: default; }
  .fps { font-variant-numeric: tabular-nums; color: #8fe9ff; }
  .hint { font-size: 12px; color: #99a; }
  code { background: #000; padding: 1px 5px; border-radius: 3px; }
</style>
```

- [ ] **Step 2: 型チェック**

Run: `npm run check`
Expected: エラー0。

- [ ] **Step 3: 目視（control単体）**

Run: `npm run dev`（別ターミナルで起動）
ブラウザで `http://localhost:1420/` を開き「ダミー開始」→ `push 60 fps` 付近が表示されればOK。

---

## Task 11: VJ ルート配線（Svelte・目視）

**Files:**
- Create: `src/routes/vj/+page.svelte`

**Interfaces:**
- Consumes: `createTransport`, `createVjStore`, `startScene`
- 動作: マウント時に store 作成 → transport 購読（onFrame/onEvent/onState）→ `getState()` で初期同期 → `startScene(canvasHolder, overlay, store)`。

- [ ] **Step 1: vj/+page.svelte を作成**

`src/routes/vj/+page.svelte`:
```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { createTransport, type TelemetryTransport } from "$lib/telemetry/bus";
  import { createVjStore } from "$lib/vj/store";
  import { startScene } from "$lib/vj/scene";

  let holder: HTMLElement;
  let overlay: HTMLElement;
  let transport: TelemetryTransport | null = null;
  let stopScene: (() => void) | null = null;

  onMount(async () => {
    const store = createVjStore();
    transport = createTransport("vj");
    transport.onFrame((f) => store.applyFrame(f));
    transport.onEvent((e) => store.pushEvent(e));
    transport.onState((s) => store.applyState(s));
    // 遅れて起動しても現在状態に同期
    try {
      const s = await transport.getState();
      store.applyState(s);
    } catch (_) {
      // ignore
    }
    stopScene = await startScene(holder, overlay, store);
  });

  onDestroy(() => {
    stopScene?.();
    transport?.dispose();
  });
</script>

<div class="vj">
  <div bind:this={holder} class="canvas"></div>
  <div bind:this={overlay} class="overlay">
    <div id="tl" class="tl"></div>
    <div id="ro" class="ro"></div>
  </div>
</div>

<style>
  :global(html, body) { margin: 0; background: #000; overflow: hidden; }
  .vj { position: fixed; inset: 0; }
  .canvas { position: absolute; inset: 0; }
  .canvas :global(canvas) { display: block; width: 100%; height: 100%; }
  .overlay { position: absolute; inset: 0; pointer-events: none; font-family: ui-monospace, monospace; color: #cfe8ff; }
  .tl { position: absolute; top: 16px; left: 20px; font-size: 14px; letter-spacing: 0.02em; text-shadow: 0 1px 4px #000; }
  .ro { position: absolute; bottom: 16px; left: 20px; font-size: 13px; white-space: pre; line-height: 1.5; text-shadow: 0 1px 4px #000; }
</style>
```

- [ ] **Step 2: 型チェック**

Run: `npm run check`
Expected: エラー0。

- [ ] **Step 3: 目視（ブラウザ2タブ = browserTransport 経路の確認）**

`npm run dev` 起動中に:
1. `http://localhost:1420/` を開き「ダミー開始」。
2. 別タブで `http://localhost:1420/vj` を開く。
Expected: VJ側で 背景色が呼吸／中央に波形ライン／左下に prompt・bpm 等／左上にタイムライン（session表示）／control由来のフラッシュ点が明滅。コンソールエラー0。
※ browserTransport は同一プロセスの別タブ間を BroadcastChannel で繋ぐ。control タブで「開始」していること。

---

## Task 12: 2窓 Tauri 設定＋第2ディスプレイ配置（Rust/conf・目視）

**Files:**
- Create: `src-tauri/src/windows.rs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**
- Produces: `place_vj_on_second_display(app: &AppHandle)`（モニタ2枚以上で vj 窓を第2ディスプレイへ移動＋全画面。1枚ならウィンドウのまま=フォールバック。失敗しても panic しない）

- [ ] **Step 1: tauri.conf.json の windows を2窓に**

`src-tauri/tauri.conf.json` の `app.windows` を置換:
```json
"windows": [
  {
    "label": "main",
    "title": "lyria-vj control",
    "url": "/",
    "width": 900,
    "height": 640
  },
  {
    "label": "vj",
    "title": "lyria-vj VJ",
    "url": "/vj",
    "width": 1280,
    "height": 720
  }
]
```

- [ ] **Step 2: capabilities を2窓＋eventに**

`src-tauri/capabilities/default.json` を置換:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for control and vj windows",
  "windows": ["main", "vj"],
  "permissions": [
    "core:default",
    "core:event:default",
    "opener:default"
  ]
}
```

- [ ] **Step 3: windows.rs を実装**

`src-tauri/src/windows.rs`:
```rust
use tauri::{AppHandle, Manager, PhysicalPosition};

/// vj ウィンドウを第2ディスプレイへ移動し全画面化する。
/// モニタが1枚、または各種取得に失敗した場合は何もしない（フォールバック）。panic しない。
pub fn place_vj_on_second_display(app: &AppHandle) {
    let Some(vj) = app.get_webview_window("vj") else {
        eprintln!("[windows] vj ウィンドウが見つからない");
        return;
    };
    let monitors = match vj.available_monitors() {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[windows] available_monitors 失敗: {e}");
            return;
        }
    };
    if monitors.len() < 2 {
        // 1枚: フォールバック（ウィンドウのまま）
        return;
    }
    let second = &monitors[1];
    let pos: &PhysicalPosition<i32> = second.position();
    if let Err(e) = vj.set_position(tauri::Position::Physical(*pos)) {
        eprintln!("[windows] set_position 失敗: {e}");
        return;
    }
    if let Err(e) = vj.set_fullscreen(true) {
        eprintln!("[windows] set_fullscreen 失敗: {e}");
    }
}
```

- [ ] **Step 4: Rust ビルド＆テスト**

Run: `cd src-tauri && cargo build && cargo test --lib`
Expected: ビルド成功、state.rs テスト PASS。

- [ ] **Step 5: 実 Tauri 目視**

Run: `npm run tauri dev`（= `cargo tauri dev`）
Expected:
- control 窓（main, `/`）と VJ 窓（vj, `/vj`）が起動。
- モニタ2枚時: VJ 窓が第2ディスプレイで全画面。1枚時: ウィンドウ表示（フォールバック）。
- control 窓で「ダミー開始」→ VJ 窓が反応（tauriTransport 経路：push_frame→emit_to("vj")）。
- コンソール/Rust ログにエラー0（APIキー等の秘匿情報出力なし）。

---

## Task 13: 統合検証（成功基準チェック）

**Files:** なし（検証のみ）

- [ ] **Step 1: 全ユニット/型/Rustテスト**

Run:
```bash
npm test && npm run check && (cd src-tauri && cargo test --lib && cargo build)
```
Expected: すべて緑。

- [ ] **Step 2: browserTransport 経路の目視**

`npm run dev` → `/` で開始 → `/vj` で描画確認（Task 11 の期待どおり）。

- [ ] **Step 3: 実 Tauri 経路の目視**

`npm run tauri dev` → 2窓・第2ディスプレイ全画面・VJ反応（Task 12 の期待どおり）。

- [ ] **Step 4: 堅牢性チェック**

- VJ を先に開き、後から control を開始しても `get_state` で同期し破綻しない。
- control を一度停止→再開しても VJ が黒画面化せず last-known 保持後に追従する。

- [ ] **Step 5: 成功基準（設計 §9）を確認**

設計ドキュメント §9 の6項目をすべて満たすことを確認し、満たさない項目があれば該当タスクに戻る。

---

## 自己レビュー結果（この計画）

- **Spec coverage:** 設計 §3(アーキ)→Task6/12、§4(契約)→Task2、§5(VJ描画)→Task7-9,11、§6(第2ディスプレイ)→Task12、§7(堅牢性)→Task2/3/7/12＋Task13-4、§8(トランスポート/検証)→Task1/5/13。全節に対応タスクあり。
- **Placeholder scan:** TBD/TODO なし。各コードステップは実コードを記載。
- **Type consistency:** TS `TelemetryFrame/HubState` と Rust `HubState`(camelCase) のフィールド名一致（startedAtMs/durationCapMs/rotateAtMs/controlParams）。`createVjStore`/`snapshot`/`applyFrame` 等の名称は Task3 定義と Task7-11 の使用箇所で一致。`createTransport`/`TelemetryTransport` は Task5 定義と Task10/11 使用で一致。
- **既知の実装順の注意:** `scene.ts`(Task7) は Task8/9 のレイヤに依存。ファイル作成順を Task7(renderer)→Task8→Task9→Task7(scene)→Task10→Task11 とする（本文に明記済み）。Rust の `mod windows;`(Task6 lib.rs) は Task12 実装まで未定義のため、Task6 単体で cargo test する場合は一時コメントアウト（本文に明記済み）。
