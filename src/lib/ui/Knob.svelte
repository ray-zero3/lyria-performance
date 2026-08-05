<script lang="ts">
  // Max/MSP 風ロータリーノブ。縦ドラッグ／ホイール／キーボードで値を変更。
  // - value は $bindable（親と双方向）。onInput=ドラッグ中の live 反映、onChange=リリース時（bpm の reset 等）。
  // - 270° スイープ（下部にギャップ）。SVG で track/value アーク＋インジケータを描画。
  interface Props {
    value: number;
    min: number;
    max: number;
    step?: number;
    label?: string;
    unit?: string;
    disabled?: boolean;
    size?: number;
    /** 表示整形（未指定は step の小数桁で自動）。 */
    format?: (v: number) => string;
    /** ドラッグ中/ホイール/キー操作のたびに呼ぶ（live 反映用）。 */
    onInput?: (v: number) => void;
    /** ポインタ解放時に呼ぶ（bpm の resetContext 等 1 回だけ実行したい処理用）。 */
    onChange?: (v: number) => void;
  }
  let {
    value = $bindable(),
    min,
    max,
    step = 0.01,
    label = "",
    unit = "",
    disabled = false,
    size = 46,
    format,
    onInput,
    onChange,
  }: Props = $props();

  const START_DEG = -135; // 7:30 方向
  const SWEEP_DEG = 270; // 下部にギャップ
  const PX_FULL_RANGE = 180; // このドラッグ量(px)で min→max

  const clamp = (v: number): number => Math.min(max, Math.max(min, v));
  const quantize = (v: number): number => {
    const q = Math.round((v - min) / step) * step + min;
    // step の浮動小数誤差を丸める
    const decimals = (String(step).split(".")[1] ?? "").length;
    return clamp(Number(q.toFixed(decimals)));
  };

  const decimals = $derived((String(step).split(".")[1] ?? "").length);
  const shown = $derived(format ? format(value) : value.toFixed(decimals));
  const t = $derived(max > min ? (clamp(value) - min) / (max - min) : 0);

  // 極座標（deg は 12 時方向=0、時計回り）
  function polar(r: number, deg: number): [number, number] {
    const a = ((deg - 90) * Math.PI) / 180;
    const c = size / 2;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  }
  function arcPath(rad: number, fromDeg: number, toDeg: number): string {
    const [x0, y0] = polar(rad, fromDeg);
    const [x1, y1] = polar(rad, toDeg);
    const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
    return `M ${x0} ${y0} A ${rad} ${rad} 0 ${large} 1 ${x1} ${y1}`;
  }

  const rad = $derived(size / 2 - 5);
  const valDeg = $derived(START_DEG + t * SWEEP_DEG);
  const trackD = $derived(arcPath(rad, START_DEG, START_DEG + SWEEP_DEG));
  const valueD = $derived(arcPath(rad, START_DEG, valDeg));
  const notch = $derived.by(() => {
    const [x0, y0] = polar(rad - 9, valDeg);
    const [x1, y1] = polar(rad - 1, valDeg);
    return { x0, y0, x1, y1 };
  });

  let dragging = $state(false);
  let startY = 0;
  let startVal = 0;

  function set(v: number, fireChange = false): void {
    const nv = quantize(v);
    if (nv !== value) {
      value = nv;
      onInput?.(nv);
    }
    if (fireChange) onChange?.(nv);
  }

  function onPointerDown(e: PointerEvent): void {
    if (disabled) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging = true;
    startY = e.clientY;
    startVal = value;
    e.preventDefault();
  }
  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    const fine = e.shiftKey ? 0.25 : 1;
    const dv = ((startY - e.clientY) / PX_FULL_RANGE) * (max - min) * fine;
    set(startVal + dv);
  }
  function onPointerUp(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    onChange?.(value);
  }
  function onWheel(e: WheelEvent): void {
    if (disabled) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    const s = e.shiftKey ? step : step * 5;
    set(value + dir * s, true);
  }
  function onKeyDown(e: KeyboardEvent): void {
    if (disabled) return;
    const big = (max - min) / 10;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") set(value + step, true);
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") set(value - step, true);
    else if (e.key === "PageUp") set(value + big, true);
    else if (e.key === "PageDown") set(value - big, true);
    else return;
    e.preventDefault();
  }
</script>

<div class="knob" class:disabled>
  <svg
    width={size}
    height={size}
    viewBox="0 0 {size} {size}"
    role="slider"
    tabindex={disabled ? -1 : 0}
    aria-label={label}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={value}
    class:dragging
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onwheel={onWheel}
    onkeydown={onKeyDown}
  >
    <circle class="body" cx={size / 2} cy={size / 2} r={rad - 6} />
    <path class="track" d={trackD} fill="none" />
    <path class="value" d={valueD} fill="none" />
    <line class="notch" x1={notch.x0} y1={notch.y0} x2={notch.x1} y2={notch.y1} />
  </svg>
  <div class="readout">
    {#if label}<span class="lbl">{label}</span>{/if}
    <span class="val">{shown}{unit}</span>
  </div>
</div>

<style>
  .knob {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    user-select: none;
  }
  svg {
    display: block;
    cursor: ns-resize;
    touch-action: none;
    outline: none;
    border-radius: 50%;
  }
  svg:focus-visible {
    box-shadow: 0 0 0 2px rgba(79, 208, 216, 0.55);
  }
  .body {
    fill: #1b1f27;
    stroke: #2a2f3a;
    stroke-width: 1;
  }
  .track {
    stroke: #333a47;
    stroke-width: 3.5;
    stroke-linecap: round;
  }
  .value {
    stroke: #4fd0d8;
    stroke-width: 3.5;
    stroke-linecap: round;
  }
  .notch {
    stroke: #eafcff;
    stroke-width: 2;
    stroke-linecap: round;
  }
  .dragging .value {
    stroke: #6ff0e8;
  }
  .readout {
    display: flex;
    flex-direction: column;
    align-items: center;
    line-height: 1.15;
  }
  .lbl {
    font-size: 9px;
    letter-spacing: 0.05em;
    color: #8a94a6;
    text-transform: lowercase;
  }
  .val {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: #d6dbe6;
  }
  .disabled {
    opacity: 0.4;
    pointer-events: none;
  }
</style>
