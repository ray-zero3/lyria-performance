// 右生データパネルの行整形（純粋関数のみ・DOM 非依存）。
// SENT = control 窓が Lyria へ送ったもの / RECV = Lyria から受けたもの / CTRL = 操作 / ANLY = 解析。
// 秘密（API キー等）はここを通らない: prompts/config/解析値のみを扱う。
import { clamp01, type HubState, type TelemetryEvent, type TelemetryFrame } from "$lib/telemetry/contract";
import type { PromptSpaceState } from "$lib/prompts/promptSpace";

/** ログ 1 行に含める payload JSON の最大文字数。 */
export const LOG_PAYLOAD_MAX = 160;

/** tMs → "HH:MM:SS.mmm"（ローカル時刻）。不正値は 00:00:00.000。 */
export function fmtClock(tMs: number): string {
  if (typeof tMs !== "number" || !Number.isFinite(tMs)) return "00:00:00.000";
  const d = new Date(tMs);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const p3 = (n: number): string => String(n).padStart(3, "0");
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
}

/** 値を JSON 文字列化し max 超は「…」で切る。循環参照等でも throw しない。 */
export function truncateJson(v: unknown, max: number = LOG_PAYLOAD_MAX): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? "null";
  } catch {
    s = "[unserializable]";
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 重み 0..1 → 固定幅バー（█ / ░）。 */
export function weightBar(w: number, width = 10): string {
  const filled = Math.round(clamp01(w) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

const SENT_APIS = new Set(["prompt_set", "config_set"]);

/** TelemetryEvent → タイムスタンプ付き生ログ 1 行。 */
export function formatLogLine(e: TelemetryEvent): string {
  const clock = fmtClock(e.tMs);
  if (e.kind === "api") {
    const dir = SENT_APIS.has(e.api) ? "SENT" : "RECV";
    return `${clock} ${dir} ${e.api} ${truncateJson(e.payload)}`;
  }
  const label = e.label ?? `${e.ctrl}${e.id}`;
  return `${clock} CTRL ${e.source} ${label} = ${e.value.toFixed(2)}`;
}

/** ストリームティックの facet 数（tick 毎に別種のデータを出して「高速に多種のデータが流れる」感を出す）。 */
export const STREAM_FACETS = 5;

/**
 * TelemetryFrame + 現在状態 → 高速ストリーム 1 行。tick で facet をローテーション:
 * 0=ANLY(lvl/pk/on) 1=BAND(lo/mid/hi) 2=SPEC(ピークbin+ミニバー) 3=CURS(カーソル) 4=WGHT(最大重み)。
 */
export function formatStreamTick(
  f: TelemetryFrame,
  state: HubState,
  space: PromptSpaceState | null,
  tick: number,
): string {
  const clock = fmtClock(Date.now());
  const a = f.audio;
  const facet = ((Math.trunc(tick) % STREAM_FACETS) + STREAM_FACETS) % STREAM_FACETS;
  if (facet === 0) {
    return `${clock} ANLY seq=${f.seq} lvl=${a.level.toFixed(2)} pk=${a.peak.toFixed(2)} on=${a.onset.toFixed(2)}`;
  }
  if (facet === 1) {
    return `${clock} BAND lo=${a.bands.low.toFixed(2)} mid=${a.bands.mid.toFixed(2)} hi=${a.bands.high.toFixed(2)}`;
  }
  if (facet === 2) {
    let pk = 0;
    let pv = 0;
    for (let i = 0; i < a.spectrum.length; i++) {
      if (a.spectrum[i] > pv) {
        pv = a.spectrum[i];
        pk = i;
      }
    }
    const mini = a.spectrum
      .slice(0, 12)
      .map((v) => Math.round(clamp01(v) * 9))
      .join("");
    return `${clock} SPEC pk=b${String(pk).padStart(2, "0")} v=${pv.toFixed(2)} [${mini}]`;
  }
  if (facet === 3) {
    const cx = space?.cursor.x ?? 0.5;
    const cy = space?.cursor.y ?? 0.5;
    return `${clock} CURS x=${cx.toFixed(3)} y=${cy.toFixed(3)} act=${state.prompts.length}`;
  }
  const top = state.prompts.reduce<{ text: string; weight: number } | null>(
    (b, p) => (p.weight > (b?.weight ?? -1) ? p : b),
    null,
  );
  const t = top ? `${top.text.slice(0, 18)}=${top.weight.toFixed(2)}` : "(none)";
  return `${clock} WGHT ${t}`;
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

/** 上部スナップショット（現在状態）の行列。space は last-known（未受信 null 可）。 */
export function snapshotLines(state: HubState, space: PromptSpaceState | null): string[] {
  const lines: string[] = [];
  const { session, music, prompts, controlParams } = state;
  const elapsed = session.startedAtMs != null ? Date.now() - session.startedAtMs : null;
  lines.push(
    `SESSION ${session.state}` +
      (elapsed != null ? `  ${fmtDur(elapsed)} / ${fmtDur(session.durationCapMs)}` : ""),
  );
  lines.push("PROMPTS");
  if (prompts.length === 0) lines.push("  (none)");
  for (const p of prompts) {
    const text = p.text.length > 24 ? `${p.text.slice(0, 23)}…` : p.text;
    lines.push(`  ${text.padEnd(24)} ${weightBar(p.weight)} ${p.weight.toFixed(2)}`);
  }
  lines.push(
    `CONFIG bpm ${music.bpm.toFixed(0)}  guid ${music.guidance.toFixed(1)}  ` +
      `dens ${music.density.toFixed(2)}  brig ${music.brightness.toFixed(2)}`,
  );
  const chaos = controlParams.chaos ?? 0;
  const cursor = space ? `cursor (${space.cursor.x.toFixed(2)}, ${space.cursor.y.toFixed(2)})` : "cursor (—)";
  const pins = space ? `pins ${space.pins.length}` : "pins —";
  lines.push(`CHAOS chaos ${chaos.toFixed(2)}  ${cursor}  ${pins}`);
  const prog = controlParams.transitionProgress;
  if (session.state === "rotating" && typeof prog === "number") {
    lines.push(`ROTATE ${weightBar(prog, 20)} ${(prog * 100).toFixed(0)}%`);
  }
  return lines;
}
