// 緊急回避（コンシール）ワークレット。
// 全入力を ring（直近数秒）に常時記録。conceal パラメータ(0..1)が立ち上がると
// その瞬間の ring を凍結し、「逆再生グラニュラー飛ばし＋フィルタスイープ＋長時間減衰」を生成、
// equal-power で live↔conceal をクロスフェードする。conceal=0 では完全パススルー（無害）。
//
// 検知/フェードのタイミングは main thread（driver）が conceal パラメータの自動化で駆動する。
// このワークレットは DSP のみを担当（判定は持たない）。

const RING_SEC = 4.0; // 緊急回避バッファ長（秒）
const GUARD_SEC = 0.14; // 凍結直前（瞬断で 0 が書かれた領域）をスキップ
const SPAN_SEC = 2.6; // グラニュラーの飛ばし範囲（凍結点からの後方窓）
const GRAIN_MIN_SEC = 0.04; // グレイン長 40〜160ms
const GRAIN_MAX_SEC = 0.16;
const SWEEP_SEC = 1.5; // フィルタスイープ周期
const DECAY_START_SEC = 6.0; // これを超える長い瞬断で緩やかに減衰
const DECAY_TAU_SEC = 3.0;
const MAKEUP = 1.3; // グラニュラー＋LPF で下がる分の補正
const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;

class ConcealProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "conceal", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "a-rate" }];
  }

  constructor() {
    super();
    const sr = sampleRate;
    this.len = Math.floor(RING_SEC * sr);
    this.guard = Math.floor(GUARD_SEC * sr);
    this.span = Math.min(Math.floor(SPAN_SEC * sr), this.len - this.guard - 1);
    this.grainMin = Math.floor(GRAIN_MIN_SEC * sr);
    this.grainMax = Math.floor(GRAIN_MAX_SEC * sr);
    this.sweepRate = TWO_PI / (SWEEP_SEC * sr);
    this.states = []; // ch 毎の状態
    this.prevC = 0; // 直前ブロックの conceal（立ち上がり検出）
  }

  ensure(ch) {
    while (this.states.length < ch + 1) {
      this.states.push({
        ring: new Float32Array(this.len),
        w: 0,
        freezeW: 0,
        phase: 0, // conceal 開始からのサンプル数
        grainRemain: 0,
        grainLen: 1,
        readPos: 0, // 逆再生の読み出し位置（後方へ進む）
        lp: 0, // 一極 LPF 状態
      });
    }
    return this.states[ch];
  }

  startGrain(st) {
    const glen = this.grainMin + Math.floor(Math.random() * (this.grainMax - this.grainMin + 1));
    st.grainLen = Math.max(1, glen);
    st.grainRemain = st.grainLen;
    // 凍結点から guard〜guard+span 後方の位置を無作為に選ぶ（＝飛ばし）
    const off = this.guard + Math.floor(Math.random() * this.span);
    st.readPos = st.freezeW - off;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const cArr = params.conceal;
    const c0 = cArr.length > 0 ? cArr[0] : 0;
    const rising = c0 > 0.001 && this.prevC <= 0.001;
    this.prevC = c0;
    const len = this.len;

    for (let ch = 0; ch < output.length; ch++) {
      const outCh = output[ch];
      const inCh = input && input.length > 0 ? input[ch] || input[0] : null;
      const st = this.ensure(ch);

      if (rising) {
        // 凍結: 直前（瞬断で 0 が書かれた分）を避けて凍結点を少し戻す
        st.freezeW = st.w - this.guard;
        st.phase = 0;
        st.grainRemain = 0;
        st.lp = 0;
      }

      for (let i = 0; i < outCh.length; i++) {
        const x = inCh ? inCh[i] : 0;
        // 常時 ring に記録
        st.ring[st.w] = x;
        st.w = st.w + 1 >= len ? 0 : st.w + 1;

        const c = cArr.length > 1 ? cArr[i] : c0;
        let cn = 0;
        if (c > 0.001) {
          if (st.grainRemain <= 0) this.startGrain(st);
          const idx = (((st.readPos | 0) % len) + len) % len;
          let g = st.ring[idx];
          // グレイン内 Hann 窓（クリック回避）
          const p = (st.grainLen - st.grainRemain) / st.grainLen;
          const env = 0.5 - 0.5 * Math.cos(TWO_PI * p);
          g *= env;
          st.readPos -= 1; // 逆再生
          st.grainRemain -= 1;
          // フィルタスイープ（一極 LPF の係数を時間で揺らす）
          const sweep = 0.5 + 0.45 * Math.sin(st.phase * this.sweepRate);
          const coeff = sweep * sweep * 0.6 + 0.02; // 0.02〜0.62
          st.lp += coeff * (g - st.lp);
          // 長い瞬断は緩やかに減衰（アンビエント化）
          const tSec = st.phase / sampleRate;
          const amp = tSec < DECAY_START_SEC ? 1 : Math.exp(-(tSec - DECAY_START_SEC) / DECAY_TAU_SEC);
          cn = st.lp * amp * MAKEUP;
          st.phase += 1;
          if (!(cn === cn)) cn = 0; // NaN ガード
        }
        // equal-power クロスフェード（c=0→live、c=1→conceal）
        outCh[i] = x * Math.cos(c * HALF_PI) + cn * Math.sin(c * HALF_PI);
      }
    }
    return true;
  }
}

registerProcessor("conceal", ConcealProcessor);
