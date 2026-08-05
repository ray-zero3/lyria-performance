export interface StereoPcm {
  left: Float32Array;
  right: Float32Array;
}

/** base64 → バイト列（atob はブラウザ/Node 双方でグローバル）。 */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 16-bit LE インターリーブ stereo PCM → Float32 の L/R（-1..1）。 */
export function decodePcm16Stereo(bytes: Uint8Array): StereoPcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = Math.floor(bytes.byteLength / 4); // 2ch * 2byte
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = view.getInt16(i * 4, true) / 32768;
    right[i] = view.getInt16(i * 4 + 2, true) / 32768;
  }
  return { left, right };
}
