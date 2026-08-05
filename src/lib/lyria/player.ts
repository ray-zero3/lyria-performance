import { LYRIA_SAMPLE_RATE } from "./config";
import { decodePcm16Stereo } from "./pcm";

/** チャンクの再生開始時刻を決める純粋関数（アンダーラン時は now+minLead へ）。 */
export function nextStart(nextTime: number, now: number, minLead = 0.05): number {
  return nextTime < now ? now + minLead : nextTime;
}

export interface PcmPlayer {
  /** 16-bit LE stereo PCM のバイト列を投入（デコード→スケジュール再生）。 */
  pushChunkBytes(bytes: Uint8Array): void;
  /** 出力先ノード（M3 の analyser 入口など）へ接続。 */
  connect(dest: AudioNode): void;
  stop(): void;
}

export function createPcmPlayer(ctx: AudioContext): PcmPlayer {
  const out = ctx.createGain();
  out.gain.value = 1;
  let nextTime = 0;
  const sources = new Set<AudioBufferSourceNode>();

  return {
    connect(dest: AudioNode) {
      out.connect(dest);
    },
    pushChunkBytes(bytes: Uint8Array) {
      const { left, right } = decodePcm16Stereo(bytes);
      const frames = left.length;
      if (!frames) return;
      const buf = ctx.createBuffer(2, frames, LYRIA_SAMPLE_RATE);
      buf.copyToChannel(left, 0);
      buf.copyToChannel(right, 1);
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(out);
      nextTime = nextStart(nextTime, ctx.currentTime);
      node.start(nextTime);
      nextTime += buf.duration;
      sources.add(node);
      node.onended = () => sources.delete(node);
    },
    stop() {
      for (const n of sources) {
        try {
          n.stop();
        } catch {
          /* ignore */
        }
      }
      sources.clear();
      try {
        out.disconnect();
      } catch {
        /* ignore */
      }
      nextTime = 0;
    },
  };
}
