/**
 * ビートリピート/スタッターの DSP コア（1ch分・純粋）。
 * static/worklets/beat-repeat.js が同一アルゴリズムを自己完結でミラーする（変更時は両方を合わせる）。
 *
 * 常に ring に input を書き込み履歴を保持。mix>0 の起動時に「直前 sliceFrames サンプル」を
 * frozen（独立バッファ）へコピーして凍結ループ。frozen は ring と別なので、ループ中に
 * input で上書きされない。mix<=0 で looping 解除（次回起動で再キャプチャ）。
 */
export interface BeatRepeatState {
  ring: Float32Array;
  w: number;
  looping: boolean;
  frozen: Float32Array;
  loopPos: number;
  sliceLen: number;
}

export function createBeatRepeatState(maxFrames: number): BeatRepeatState {
  return {
    ring: new Float32Array(Math.max(1, maxFrames)),
    w: 0,
    looping: false,
    frozen: new Float32Array(0),
    loopPos: 0,
    sliceLen: 0,
  };
}

export function beatRepeatBlock(
  st: BeatRepeatState,
  input: Float32Array,
  output: Float32Array,
  mix: number,
  sliceFrames: number,
): void {
  const len = st.ring.length;
  for (let i = 0; i < output.length; i++) {
    const x = input[i];
    if (mix > 0) {
      if (!st.looping) {
        const slice = Math.max(1, Math.min(Math.floor(sliceFrames), len));
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
      output[i] = mix * looped + (1 - mix) * x;
    } else {
      st.looping = false;
      output[i] = x;
    }
    st.ring[st.w] = x;
    st.w = (st.w + 1) % len;
  }
}
