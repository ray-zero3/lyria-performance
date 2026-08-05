import { describe, it, expect } from "vitest";
import { createRotatingSource, type Deck, type DeckFactory } from "./rotation";
import type { TransitionPlan } from "$lib/audio/crossfade";
import { defaultLyriaConfig, type LyriaMusicConfig } from "./config";

const PLAN: TransitionPlan = { leadMs: 2000, fadeMs: 4000, tailMs: 2000, wetPeak: 0.5 };

interface MockDeck {
  deck: Deck;
  configs: LyriaMusicConfig[];
  gains: number[];
  readonly started: number;
  readonly stopped: number;
  setAudio(v: boolean): void;
}

function makeMockDeck(): MockDeck {
  const configs: LyriaMusicConfig[] = [];
  const gains: number[] = [];
  let audio = false;
  let started = 0;
  let stopped = 0;
  return {
    deck: {
      setPrompts: () => {},
      setConfig: (c) => configs.push(c),
      resetContext: () => {},
      setGain: (v) => gains.push(v),
      hasAudio: () => audio,
      start: async () => {
        started += 1;
      },
      stop: () => {
        stopped += 1;
      },
    },
    configs,
    gains,
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
    setAudio: (v) => {
      audio = v;
    },
  };
}

function makeFactory(decks: MockDeck[]): DeckFactory {
  let i = 0;
  return { create: () => decks[i++].deck };
}

const opts = (
  decks: MockDeck[],
  now: () => number,
  extra: Record<string, unknown> = {},
) => ({
  factory: makeFactory(decks),
  plan: PLAN,
  now,
  initialPrompts: [{ text: "pads", weight: 1 }],
  initialConfig: defaultLyriaConfig(),
  ...extra,
});

describe("createRotatingSource", () => {
  it("start で active を作りゲイン1", async () => {
    const d = [makeMockDeck()];
    let t = 0;
    const r = createRotatingSource(opts(d, () => t));
    await r.start();
    expect(d[0].started).toBe(1);
    expect(d[0].gains.at(-1)).toBe(1);
    expect(r.isTransitioning()).toBe(false);
  });

  it("rotate で incoming をドラムmute・ゲイン0で start、二重 rotate は無視", async () => {
    const d = [makeMockDeck(), makeMockDeck()];
    let t = 0;
    const r = createRotatingSource(opts(d, () => t));
    await r.start();
    r.rotate();
    expect(d[1].started).toBe(1);
    expect(d[1].configs.at(-1)?.muteDrums).toBe(true); // 新は drums mute で開始
    expect(d[1].gains.at(0)).toBe(0);
    expect(d[0].configs.at(-1)?.muteDrums).toBe(true); // 旧も drums 間引き
    expect(r.isTransitioning()).toBe(true);
    r.rotate(); // 進行中は無視
    expect(d[1].started).toBe(1);
  });

  it("first-chunk ゲート: 音が来るまで FADE を開始しない", async () => {
    const d = [makeMockDeck(), makeMockDeck()];
    let t = 0;
    const r = createRotatingSource(opts(d, () => t));
    await r.start();
    r.rotate();
    t = 5000; // lead(2000) 超過だが incoming に音なし
    r.tick(t);
    expect(d[0].gains.at(-1)).toBe(1); // 旧はまだ 1（無音へフェードしない）
    expect(d[1].gains.at(-1)).toBe(0);
    d[1].setAudio(true);
    t = 5001;
    r.tick(t); // ここで fade 開始
    t = 7001; // fadeStart(5001)+2000 = fade 半分
    r.tick(t);
    expect(d[0].gains.at(-1)!).toBeGreaterThan(0);
    expect(d[0].gains.at(-1)!).toBeLessThan(1);
    expect(d[1].gains.at(-1)!).toBeGreaterThan(0);
  });

  it("完了で active を昇格し、新 active のドラムを desired に戻す", async () => {
    const d = [makeMockDeck(), makeMockDeck()];
    let t = 0;
    const r = createRotatingSource(opts(d, () => t));
    await r.start();
    r.rotate();
    d[1].setAudio(true);
    t = 2001;
    r.tick(t); // fade 開始
    t = 2001 + PLAN.fadeMs + PLAN.tailMs + 10; // 総時間超過 → done
    r.tick(t);
    expect(d[0].stopped).toBe(1); // 旧を停止
    expect(r.isTransitioning()).toBe(false);
    expect(d[1].configs.at(-1)?.muteDrums).toBe(false); // 新 active はドラム復帰
    expect(d[1].gains.at(-1)).toBe(1);
  });

  it("incoming が時間内に音を出さなければ中止し active を維持", async () => {
    const d = [makeMockDeck(), makeMockDeck()];
    let t = 0;
    const r = createRotatingSource(opts(d, () => t, { incomingTimeoutMs: 8000 }));
    await r.start();
    r.rotate();
    t = 8001; // タイムアウト超過・音なし
    r.tick(t);
    expect(d[1].stopped).toBe(1); // incoming 破棄
    expect(r.isTransitioning()).toBe(false);
    expect(d[0].configs.at(-1)?.muteDrums).toBe(false); // active は desired に復帰
    expect(d[0].gains.at(-1)).toBe(1);
  });

  it("setConfig: トランジション中は両デッキ drums mute、平常時は desired そのまま", async () => {
    const d = [makeMockDeck(), makeMockDeck()];
    let t = 0;
    const r = createRotatingSource(opts(d, () => t));
    await r.start();
    r.setConfig({ ...defaultLyriaConfig(), muteDrums: false, bpm: 130 });
    expect(d[0].configs.at(-1)?.muteDrums).toBe(false);
    expect(d[0].configs.at(-1)?.bpm).toBe(130);
    r.rotate();
    r.setConfig({ ...defaultLyriaConfig(), muteDrums: false, bpm: 140 });
    expect(d[0].configs.at(-1)?.muteDrums).toBe(true); // 中は強制 mute
    expect(d[1].configs.at(-1)?.muteDrums).toBe(true);
    expect(d[1].configs.at(-1)?.bpm).toBe(140); // 他パラメータは反映
  });

  it("autoRotateMs 到達で tick が自動 rotate", async () => {
    const d = [makeMockDeck(), makeMockDeck()];
    let t = 0;
    const r = createRotatingSource(opts(d, () => t, { autoRotateMs: 10000 }));
    await r.start();
    t = 9000;
    r.tick(t);
    expect(r.isTransitioning()).toBe(false);
    t = 10001;
    r.tick(t);
    expect(r.isTransitioning()).toBe(true); // 自動ローテ発火
    expect(d[1].started).toBe(1);
  });
});
