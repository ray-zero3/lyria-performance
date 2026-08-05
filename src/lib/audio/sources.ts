export interface AudioSource {
  node: AudioNode;
  dispose(): void;
}

/** 内蔵テスト信号: サウ波（LFO で周波数スイープ）＋トレモロ（onset が動くよう）。 */
export function createTestSource(ctx: AudioContext): AudioSource {
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = 220;

  // LFO で基音を上下スイープ（bands/spectrum が動く）
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.2;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 180;
  lfo.connect(lfoGain).connect(osc.frequency);

  // トレモロで振幅を揺らす（level/onset が動く）
  const amp = ctx.createGain();
  amp.gain.value = 0.6;
  const tremolo = ctx.createOscillator();
  tremolo.frequency.value = 2;
  const tremGain = ctx.createGain();
  tremGain.gain.value = 0.4;
  tremolo.connect(tremGain).connect(amp.gain);

  osc.connect(amp);
  osc.start();
  lfo.start();
  tremolo.start();

  return {
    node: amp,
    dispose() {
      try {
        osc.stop();
        lfo.stop();
        tremolo.stop();
      } catch {
        /* ignore */
      }
      try {
        amp.disconnect();
      } catch {
        /* ignore */
      }
    },
  };
}

/** マイク入力（destination へ繋がない＝ハウリング回避）。 */
export async function createMicSource(ctx: AudioContext): Promise<AudioSource> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const node = ctx.createMediaStreamSource(stream);
  return {
    node,
    dispose() {
      try {
        node.disconnect();
      } catch {
        /* ignore */
      }
      for (const t of stream.getTracks()) t.stop();
    },
  };
}
