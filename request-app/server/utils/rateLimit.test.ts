import { describe, expect, it } from "vitest";
import { createBucketLimiter, createTotalCounter } from "./rateLimit";

describe("createBucketLimiter", () => {
  it("容量ぶんは連続で許可する", () => {
    const lim = createBucketLimiter({ capacity: 3, refillMs: 1000 });
    expect(lim.take("a", 0).ok).toBe(true);
    expect(lim.take("a", 0).ok).toBe(true);
    expect(lim.take("a", 0).ok).toBe(true);
  });

  it("容量を超えたら拒否し、retryAfterMs を返す", () => {
    const lim = createBucketLimiter({ capacity: 2, refillMs: 1000 });
    lim.take("a", 0);
    lim.take("a", 0);
    const r = lim.take("a", 0);
    expect(r.ok).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(r.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it("時間経過でトークンが補充される", () => {
    const lim = createBucketLimiter({ capacity: 1, refillMs: 1000 });
    expect(lim.take("a", 0).ok).toBe(true);
    expect(lim.take("a", 500).ok).toBe(false);
    expect(lim.take("a", 1000).ok).toBe(true);
  });

  it("補充は容量を超えない", () => {
    const lim = createBucketLimiter({ capacity: 2, refillMs: 1000 });
    lim.take("a", 0);
    // 十分に時間が経っても容量ぶんだけ
    expect(lim.take("a", 100_000).ok).toBe(true);
    expect(lim.take("a", 100_000).ok).toBe(true);
    expect(lim.take("a", 100_000).ok).toBe(false);
  });

  it("キーごとに独立して数える", () => {
    const lim = createBucketLimiter({ capacity: 1, refillMs: 1000 });
    expect(lim.take("a", 0).ok).toBe(true);
    expect(lim.take("b", 0).ok).toBe(true);
    expect(lim.take("a", 0).ok).toBe(false);
  });

  it("古いキーを掃除してもメモリが無限に増えない", () => {
    const lim = createBucketLimiter({ capacity: 1, refillMs: 1000, idleMs: 5000 });
    lim.take("a", 0);
    lim.take("b", 0);
    expect(lim.size()).toBe(2);
    // idleMs を超えて放置されたキーは次回アクセス時に掃除される
    lim.take("c", 60_000);
    expect(lim.size()).toBe(1);
  });
});

describe("createTotalCounter", () => {
  it("上限まで許可し、超えたら拒否する", () => {
    const c = createTotalCounter(2);
    expect(c.take().ok).toBe(true);
    expect(c.take().ok).toBe(true);
    expect(c.take().ok).toBe(false);
  });

  it("現在値と上限を報告する", () => {
    const c = createTotalCounter(5);
    c.take();
    c.take();
    expect(c.used()).toBe(2);
    expect(c.limit()).toBe(5);
  });
});
