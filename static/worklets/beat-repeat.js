// ビートリピート/スタッター AudioWorkletProcessor（自己完結・古典スクリプト）。
// アルゴリズムは src/lib/audio/beatRepeat.ts と同一（変更時は両方を合わせる）。
// ch ごとに ring（履歴）と frozen（凍結スライス）を持つ。mix>0 起動時に直前 sliceFrames を
// frozen へコピーしてループ。frozen は独立バッファなので input で上書きされない。
const MAX_FRAMES = 96000; // 2s @48k（最遅 bpm の 1/8 音符でも十分）

class BeatRepeatProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "mix", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      {
        name: "sliceFrames",
        defaultValue: 12000,
        minValue: 1,
        maxValue: MAX_FRAMES,
        automationRate: "k-rate",
      },
    ];
  }

  constructor() {
    super();
    this.states = []; // ch 毎の { ring, w, looping, frozen, loopPos, sliceLen }
  }

  ensure(ch) {
    if (!this.states[ch]) {
      this.states[ch] = {
        ring: new Float32Array(MAX_FRAMES),
        w: 0,
        looping: false,
        frozen: new Float32Array(0),
        loopPos: 0,
        sliceLen: 0,
      };
    }
    return this.states[ch];
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const mix = params.mix.length > 0 ? params.mix[0] : 0;
    const rawSlice = params.sliceFrames.length > 0 ? params.sliceFrames[0] : 12000;
    const len = MAX_FRAMES;

    for (let ch = 0; ch < output.length; ch++) {
      const st = this.ensure(ch);
      const inCh = input && input.length > 0 ? input[ch] || input[0] : null;
      const outCh = output[ch];
      for (let i = 0; i < outCh.length; i++) {
        const x = inCh ? inCh[i] : 0;
        if (mix > 0) {
          if (!st.looping) {
            const slice = Math.max(1, Math.min(Math.floor(rawSlice), len));
            st.sliceLen = slice;
            if (st.frozen.length !== slice) st.frozen = new Float32Array(slice);
            for (let k = 0; k < slice; k++) {
              const idx = (((st.w - slice + k) % len) + len) % len;
              st.frozen[k] = st.ring[idx];
            }
            st.loopPos = 0;
            st.looping = true;
          }
          const looped = st.frozen[st.loopPos % st.sliceLen];
          st.loopPos = (st.loopPos + 1) % st.sliceLen;
          outCh[i] = mix * looped + (1 - mix) * x;
        } else {
          st.looping = false;
          outCh[i] = x;
        }
        st.ring[st.w] = x;
        st.w = (st.w + 1) % len;
      }
    }
    return true;
  }
}

registerProcessor("beat-repeat", BeatRepeatProcessor);
