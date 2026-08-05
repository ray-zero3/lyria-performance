// レート制限（純粋ロジック。時刻は引数で受け取るのでテスト可能）。
//
// 設計の前提: Tailscale Funnel 経由だと送信元が tailscaled になり、クライアント IP 単位の制限は
// 効かない可能性が高い。よって「全体トークンバケット」と「公演累計上限」を主防壁、端末 ID / IP 単位は
// 一般客の連打抑止（偽装可能なので副次的）と位置づける。

export interface TakeResult {
  ok: boolean;
  /** 拒否時、次に1トークン溜まるまでの目安 ms。 */
  retryAfterMs: number;
}

export interface BucketLimiter {
  take(key: string, nowMs: number): TakeResult;
  /** 保持しているキー数（メモリ肥大の監視用）。 */
  size(): number;
}

export interface BucketOptions {
  /** バーストで許可する数。 */
  capacity: number;
  /** 1トークン補充にかかる ms。 */
  refillMs: number;
  /** この時間アクセスが無いキーは掃除する（既定 10 分）。 */
  idleMs?: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

/** トークンバケット。キー単位に capacity/refillMs で流量を絞る。 */
export function createBucketLimiter(opts: BucketOptions): BucketLimiter {
  const { capacity, refillMs } = opts;
  const idleMs = opts.idleMs ?? 10 * 60 * 1000;
  const buckets = new Map<string, Bucket>();

  return {
    take(key: string, nowMs: number): TakeResult {
      // 放置されたキーを掃除（観客数規模ではキー数が小さいので毎回走査で十分）。
      for (const [k, b] of buckets) {
        if (nowMs - b.last > idleMs) buckets.delete(k);
      }

      const b = buckets.get(key) ?? { tokens: capacity, last: nowMs };
      const refilled = Math.min(capacity, b.tokens + (nowMs - b.last) / refillMs);
      b.last = nowMs;

      if (refilled >= 1) {
        b.tokens = refilled - 1;
        buckets.set(key, b);
        return { ok: true, retryAfterMs: 0 };
      }
      b.tokens = refilled;
      buckets.set(key, b);
      return { ok: false, retryAfterMs: Math.ceil((1 - refilled) * refillMs) };
    },
    size(): number {
      return buckets.size;
    },
  };
}

export interface TotalCounter {
  take(): { ok: boolean };
  used(): number;
  limit(): number;
}

/** 公演全体の累計上限（クレジットの暴走消費に対する最後の栓）。プロセス起動からの通算。 */
export function createTotalCounter(limit: number): TotalCounter {
  let used = 0;
  return {
    take() {
      if (used >= limit) return { ok: false };
      used += 1;
      return { ok: true };
    },
    used: () => used,
    limit: () => limit,
  };
}
