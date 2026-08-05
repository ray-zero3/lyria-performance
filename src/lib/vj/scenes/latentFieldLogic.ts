// latentField シーンの純粋ロジック。
// 「あり得るプロンプト空間全体」を表すノードカタログの構築、カメラ飛行の状態機械と経路計算、
// ロックオン対象の選択、解析 HUD テキストの組み立て、演奏履歴の蓄積を提供する。
// このファイルは three / DOM / Svelte に依存しない（Vitest で完全にテスト可能）。
import { clamp01, type WeightedPrompt } from "$lib/telemetry/contract";
import { easeInOutCubic, type PromptSpaceState } from "$lib/prompts/promptSpace";

/** 3D ベクトル（three 非依存の純データ）。 */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** ノード種別: 演奏履歴 / パッド上ピン / 観客リクエスト / 保存ターゲット / 潜在（未演奏の仮説）。 */
export type NodeKind = "history" | "pin" | "request" | "target" | "latent";

/** 潜在空間の 1 ノード（ロックオン・解析の対象）。 */
export interface LatentNode {
  id: string;
  kind: NodeKind;
  text: string;
  /** 副次情報（投入者・時刻・由来など）。無ければ空文字。 */
  sub: string;
  pos: Vec3Like;
}

/** 演奏履歴の 1 エントリ（実際に Lyria へ送られたプロンプト）。 */
export interface HistoryEntry {
  text: string;
  tMs: number;
}

// ---- 決定的ハッシュ（配置・解析値の擬似乱数源） ----

/** FNV-1a 32bit 文字列ハッシュ（決定的）。 */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 32bit 整数 → 0..1 の決定的擬似乱数（xorshift 撹拌）。 */
export function hash01(seed: number): number {
  let x = seed >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  return x / 0xffffffff;
}

/** epoch ms → HH:MM（ローカル時刻）。 */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---- 履歴の蓄積 ----

/** 履歴の保持上限（live 調整ポイント）。 */
export const HISTORY_MAX = 24;

/**
 * 現在の weighted prompts を履歴へ蓄積。既出テキストは追加しない（重複防止）。
 * 変化が無ければ同一参照を返す（呼び出し側の変更検知用）。純粋。
 */
export function accumulateHistory(
  history: readonly HistoryEntry[],
  prompts: readonly WeightedPrompt[],
  tMs: number,
  max: number = HISTORY_MAX,
): readonly HistoryEntry[] {
  const seen = new Set(history.map((h) => h.text));
  const fresh: HistoryEntry[] = [];
  for (const p of prompts) {
    const text = typeof p?.text === "string" ? p.text.trim() : "";
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    fresh.push({ text, tMs });
  }
  if (fresh.length === 0) return history;
  const merged = [...history, ...fresh];
  const cap = Math.max(1, max);
  return merged.slice(Math.max(0, merged.length - cap));
}

// ---- ノード配置（決定的） ----

/** 種別ごとの配置半径殻。中心=確定した現実、外縁=推測（live 調整ポイント）。 */
export const KIND_RADIUS: Record<NodeKind, number> = {
  request: 2.6,
  pin: 3.4,
  target: 4.3,
  history: 5.2,
  latent: 6.4,
};
/** 半径ジッタ（KIND_RADIUS に対する比率 0..1）。 */
export const RADIUS_JITTER = 0.35;
/** 縦方向のつぶし率（銀河風の扁平分布）。 */
export const FIELD_Y_SQUASH = 0.55;

/** ノード id から決定的に 3D 配置を計算。種別で半径殻が変わる。純粋。 */
export function nodePosition(id: string, kind: NodeKind): Vec3Like {
  const h = hashString(id);
  const az = hash01(h) * Math.PI * 2;
  const elev = hash01(h ^ 0x9e3779b9) * 2 - 1; // -1..1
  const jit = hash01(h ^ 0x85ebca6b);
  const radius = KIND_RADIUS[kind] * (1 - RADIUS_JITTER / 2 + jit * RADIUS_JITTER);
  const rr = Math.sqrt(Math.max(0, 1 - elev * elev));
  return {
    x: Math.cos(az) * rr * radius,
    y: elev * radius * FIELD_Y_SQUASH,
    z: Math.sin(az) * rr * radius,
  };
}

// ---- ノードカタログの構築 ----

/** カタログの上限ノード数（シーン側 uniformArray の固定長と揃える）。 */
export const MAX_NODES = 28;
/** カタログが空でも飛行が成立する最低ノード数（UNCHARTED で充填）。 */
export const MIN_NODES = 6;
/** 潜在ブレンド（ピン×ピンの補間仮説）の生成上限（live 調整ポイント）。 */
export const MAX_BLEND_NODES = 8;

export interface CatalogInput {
  space: PromptSpaceState | null;
  history: readonly HistoryEntry[];
  maxNodes?: number;
}

/**
 * プロンプト空間の状態＋演奏履歴から「あり得るプロンプト空間」のノードカタログを構築。純粋。
 * 優先順: 観客リクエスト → パッド上ピン → 保存ターゲット → 履歴（新しい順）→
 * 潜在ブレンド（ピン×ピン）→ UNCHARTED 充填（最低 MIN_NODES を保証）。
 */
export function buildNodeCatalog(input: CatalogInput): LatentNode[] {
  const max = Math.max(MIN_NODES, input.maxNodes ?? MAX_NODES);
  const nodes: LatentNode[] = [];
  const seen = new Set<string>();
  const push = (id: string, kind: NodeKind, text: string, sub: string): void => {
    if (nodes.length >= max || seen.has(id)) return;
    seen.add(id);
    nodes.push({ id, kind, text, sub, pos: nodePosition(id, kind) });
  };

  const pins = input.space?.pins ?? [];
  const usable = pins.filter((p) => p.text.trim().length > 0);
  // 1) 観客リクエスト由来のピン（nickname 付き）
  for (const p of usable) {
    if (!p.nickname) continue;
    const when = typeof p.tMs === "number" ? ` · ${hhmm(p.tMs)}` : "";
    push(`req:${p.id}`, "request", p.text.trim(), `by ${p.nickname}${when}`);
  }
  // 2) 通常ピン（現在パッドに置かれている＝これから使われうる）
  for (const p of usable) {
    if (p.nickname) continue;
    push(`pin:${p.id}`, "pin", p.text.trim(), `pad (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
  }
  // 3) 保存ターゲット（モーフ先＝これから訪れうる座標）
  for (const t of input.space?.targets ?? []) {
    push(`tgt:${t.id}`, "target", t.name, `saved vector (${t.x.toFixed(2)}, ${t.y.toFixed(2)})`);
  }
  // 4) 履歴（新しい順）
  for (let i = input.history.length - 1; i >= 0; i--) {
    const h = input.history[i];
    push(`hist:${hashString(h.text).toString(16)}`, "history", h.text, `played ${hhmm(h.tMs)}`);
  }
  // 5) 潜在ブレンド: ピンのペア補間で生じうる組み合わせ（仮説ノード）
  let blends = 0;
  outer: for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      if (blends >= MAX_BLEND_NODES || nodes.length >= max) break outer;
      const a = usable[i];
      const b = usable[j];
      push(`mix:${a.id}+${b.id}`, "latent", `${a.text.trim()} × ${b.text.trim()}`, "interpolation field");
      blends++;
    }
  }
  // 6) 最低ノード数の保証（空状態でも飛行が成立する）
  let k = 0;
  while (nodes.length < MIN_NODES && k < MIN_NODES * 2) {
    const id = `void:${k}`;
    push(id, "latent", `UNCHARTED-${(hashString(id) & 0xffff).toString(16).toUpperCase()}`, "unresolved region");
    k++;
  }
  return nodes;
}

// ---- カメラ飛行の状態機械 ----

export type FlightPhase = "cruise" | "lock" | "analyze" | "release";

/** 各位相の継続時間 ms（live 調整ポイント）。 */
export const CRUISE_MS = 4800;
export const LOCK_MS = 1300;
export const ANALYZE_MS = 6400;
export const RELEASE_MS = 1200;

export const PHASE_DURATION: Record<FlightPhase, number> = {
  cruise: CRUISE_MS,
  lock: LOCK_MS,
  analyze: ANALYZE_MS,
  release: RELEASE_MS,
};

export interface FlightState {
  phase: FlightPhase;
  /** 現位相の経過 ms。 */
  phaseMs: number;
  /** 直前にロックオンしていたノード index（cruise の出発点）。 */
  fromIndex: number;
  /** 現在向かっている/ロックオン中のノード index。 */
  targetIndex: number;
  /** ロックオン通算回数（HUD の LOCK 番号。cruise→lock 遷移で +1）。 */
  lockSeq: number;
}

/** 初期状態（cruise から開始）。 */
export function createFlightState(): FlightState {
  return { phase: "cruise", phaseMs: 0, fromIndex: 0, targetIndex: 0, lockSeq: 0 };
}

/** 次ターゲット選択の候補サンプル数（多いほど遠いノードが選ばれやすい）。 */
export const TARGET_CANDIDATES = 4;

const dist2 = (a: Vec3Like, b: Vec3Like): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};

/**
 * 次のロックオン対象を選択。rand で候補を数個サンプルし、現在地から最も遠いものを採る
 * （飛行が長く伸びて「空間を飛び回る」感じになる）。純粋（rand は注入）。
 */
export function selectNextTarget(
  current: number,
  positions: readonly Vec3Like[],
  rand: () => number,
): number {
  const n = positions.length;
  if (n <= 1) return 0;
  const cur = positions[((current % n) + n) % n];
  let best = -1;
  let bestD = -1;
  for (let i = 0; i < TARGET_CANDIDATES; i++) {
    const r = rand();
    const r01 = Number.isFinite(r) ? clamp01(r) : 0;
    const cand = Math.min(n - 1, Math.floor(r01 * n));
    if (cand === current) continue;
    const d = dist2(positions[cand], cur);
    if (d > bestD) {
      bestD = d;
      best = cand;
    }
  }
  if (best < 0) best = (current + 1) % n; // 全候補が current だった場合のフォールバック
  return best;
}

/**
 * 飛行状態を dt だけ進める。位相満了で cruise→lock→analyze→release→cruise を巡回し、
 * 余剰 dt は次位相へ持ち越す。純粋（rand は注入。immutable に新 state を返す）。
 */
export function stepFlight(
  s: FlightState,
  dtMs: number,
  positions: readonly Vec3Like[],
  rand: () => number,
): FlightState {
  const n = positions.length;
  if (n === 0) return s;
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
  let st: FlightState = {
    ...s,
    phaseMs: s.phaseMs + dt,
    fromIndex: ((s.fromIndex % n) + n) % n,
    targetIndex: ((s.targetIndex % n) + n) % n,
  };
  // 1 フレームで複数位相をまたいでも安全なようにループ（guard で無限ループ防止）
  for (let guard = 0; guard < 8; guard++) {
    const dur = PHASE_DURATION[st.phase];
    if (st.phaseMs < dur) break;
    const carry = st.phaseMs - dur;
    if (st.phase === "cruise") {
      st = { ...st, phase: "lock", phaseMs: carry, lockSeq: st.lockSeq + 1 };
    } else if (st.phase === "lock") {
      st = { ...st, phase: "analyze", phaseMs: carry };
    } else if (st.phase === "analyze") {
      st = { ...st, phase: "release", phaseMs: carry };
    } else {
      st = {
        phase: "cruise",
        phaseMs: carry,
        fromIndex: st.targetIndex,
        targetIndex: selectNextTarget(st.targetIndex, positions, rand),
        lockSeq: st.lockSeq,
      };
    }
  }
  return st;
}

// ---- カメラ経路（位相境界で連続なパラメトリック経路） ----

/** 巡航時の視点距離（ノードからの距離）。 */
export const VIEW_DIST_FAR = 3.1;
/** ロックオン/解析時の接近距離。 */
export const VIEW_DIST_NEAR = 1.25;
/** 視点の基準高さ（ノードから上方向）。 */
export const VIEW_HEIGHT = 0.45;
/** 巡航中の弧の持ち上げ量（飛行感。energy で増える）。 */
export const CRUISE_ARC_LIFT = 1.7;
/** 視点方位のドリフト速度 rad/s（基本値＋energy 係数）。 */
export const ORBIT_DRIFT_BASE = 0.05;
export const ORBIT_DRIFT_ENERGY = 0.22;
/** 解析中の呼吸（距離の脈動比率。sin(πu) で両端 0 = 位相境界と連続）。 */
export const ANALYZE_BREATH = 0.08;

const GOLDEN_ANGLE = 2.399963229728653;

export interface CameraPose {
  pos: Vec3Like;
  look: Vec3Like;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** ノード index ごとの視点位置（方位角は index 由来＋時間ドリフト）。 */
function viewpoint(index: number, node: Vec3Like, tSec: number, energy: number, dist: number): Vec3Like {
  const ang = index * GOLDEN_ANGLE + tSec * (ORBIT_DRIFT_BASE + energy * ORBIT_DRIFT_ENERGY);
  return {
    x: node.x + Math.cos(ang) * dist,
    y: node.y + VIEW_HEIGHT,
    z: node.z + Math.sin(ang) * dist,
  };
}

/**
 * 飛行状態 → カメラ位置と注視点。各位相の端点が一致するよう設計してあり、
 * 位相遷移でカメラが飛ばない（連続）。純粋。
 */
export function cameraPose(
  s: FlightState,
  positions: readonly Vec3Like[],
  tSec: number,
  energy: number,
): CameraPose {
  const n = positions.length;
  if (n === 0) {
    // ノード未構築時のフォールバック（原点をゆっくり周回）
    const a = tSec * 0.1;
    return { pos: { x: Math.cos(a) * 6, y: 1.2, z: Math.sin(a) * 6 }, look: { x: 0, y: 0, z: 0 } };
  }
  const e01 = clamp01(energy);
  const fi = ((s.fromIndex % n) + n) % n;
  const ti = ((s.targetIndex % n) + n) % n;
  const from = positions[fi];
  const tgt = positions[ti];

  if (s.phase === "cruise") {
    const u = clamp01(s.phaseMs / CRUISE_MS);
    const eu = easeInOutCubic(u);
    const a = viewpoint(fi, from, tSec, e01, VIEW_DIST_FAR);
    const b = viewpoint(ti, tgt, tSec, e01, VIEW_DIST_FAR);
    const lift = Math.sin(Math.PI * u) * CRUISE_ARC_LIFT * (0.5 + e01); // 両端 0 → 境界連続
    const lookU = clamp01(u * 1.6); // 注視は先行して目標ノードへ移す
    return {
      pos: { x: lerp(a.x, b.x, eu), y: lerp(a.y, b.y, eu) + lift, z: lerp(a.z, b.z, eu) },
      look: {
        x: lerp(from.x, tgt.x, lookU),
        y: lerp(from.y, tgt.y, lookU),
        z: lerp(from.z, tgt.z, lookU),
      },
    };
  }
  if (s.phase === "lock") {
    const u = clamp01(s.phaseMs / LOCK_MS);
    const dist = lerp(VIEW_DIST_FAR, VIEW_DIST_NEAR, easeInOutCubic(u));
    return { pos: viewpoint(ti, tgt, tSec, e01, dist), look: { ...tgt } };
  }
  if (s.phase === "analyze") {
    const u = clamp01(s.phaseMs / ANALYZE_MS);
    const breath = Math.sin(Math.PI * u) * ANALYZE_BREATH;
    return { pos: viewpoint(ti, tgt, tSec, e01, VIEW_DIST_NEAR * (1 + breath)), look: { ...tgt } };
  }
  // release: 近距離 → 巡航距離へ戻す（次の cruise 始点と一致）
  const u = clamp01(s.phaseMs / RELEASE_MS);
  const dist = lerp(VIEW_DIST_NEAR, VIEW_DIST_FAR, easeInOutCubic(u));
  return { pos: viewpoint(ti, tgt, tSec, e01, dist), look: { ...tgt } };
}

// ---- 解析 HUD テキスト ----

/** HUD の 1 行に表示するプロンプト文字数の上限。 */
export const HUD_TEXT_MAX = 32;
/** HUD タイプライタ表示の速度（文字/秒、live 調整ポイント）。 */
export const HUD_CHARS_PER_SEC = 90;

const KIND_CLASS: Record<NodeKind, string> = {
  history: "ARCHIVE",
  pin: "ACTIVE",
  request: "REQUEST",
  target: "VECTOR",
  latent: "LATENT",
};

/**
 * ロックオンしたノードの解析結果テキスト（ミニマル 2 行）。
 * 1 行目: 種別＋ロック番号＋由来、2 行目: プロンプト本文。純粋。
 */
export function buildAnalysisLines(node: LatentNode, lockSeq: number, totalNodes: number): string[] {
  const text =
    node.text.length > HUD_TEXT_MAX ? `${node.text.slice(0, HUD_TEXT_MAX - 1)}…` : node.text;
  const seq = String(((Math.max(1, lockSeq) - 1) % 99) + 1).padStart(2, "0");
  const head = `${KIND_CLASS[node.kind]} ${seq}/${String(Math.max(1, totalNodes)).padStart(2, "0")}`;
  return [node.sub ? `${head} · ${node.sub}` : head, `"${text}"`];
}

/** タイプライタ表示: 経過時間ぶんの文字数まで行を段階的に開示。純粋。 */
export function revealLines(
  lines: readonly string[],
  elapsedMs: number,
  charsPerSec: number = HUD_CHARS_PER_SEC,
): string[] {
  const total = Math.max(0, Math.floor((Math.max(0, elapsedMs) / 1000) * charsPerSec));
  const out: string[] = [];
  let left = total;
  for (const line of lines) {
    if (left <= 0) break;
    out.push(line.length <= left ? line : line.slice(0, left));
    left -= line.length;
  }
  return out;
}

// ---- 関係線（ロックノード → 近傍ノード） ----

/** center から近い順に最大 k 個のノード index（center 自身は除く）。純粋。 */
export function nearestIndices(
  positions: readonly Vec3Like[],
  center: number,
  k: number,
): number[] {
  const n = positions.length;
  if (n === 0 || center < 0 || center >= n) return [];
  const c = positions[center];
  return positions
    .map((p, i) => ({ i, d: dist2(p, c) }))
    .filter((e) => e.i !== center)
    .sort((a, b) => a.d - b.d)
    .slice(0, Math.max(0, k))
    .map((e) => e.i);
}
