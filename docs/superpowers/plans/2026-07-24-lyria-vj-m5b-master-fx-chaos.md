# Lyria VJ M5b: マスターFXチェーン（カオス演出）実装計画

> 実装は TDD（純粋関数はテスト先行）。git はコミットしない合意 → 締めは該当テスト実行。詳細な型/アルゴリズムは spec `2026-07-24-lyria-vj-m5b-master-fx-chaos-design.md` を参照。

**Goal:** マスターに reverb量調整 / ビートリピート(AudioWorklet) / フィルタースイープ / 歪み+ディレイ を実装し、カオスマクロ0..1で一括駆動＋個別調整。トランジションで「ぐちゃぐちゃ」に。

## Global Constraints
- 作業ディレクトリ `lyria-vj`。immutability・日本語コメント。全 base=0・chaos=0 で従来音（回帰不変）。
- ベースライン緑: vitest 64・cargo test 6・svelte-check 0・build/clippy clean。割らない。

### Task 1: 定数（constants.ts）
- 追加 `CHAOS_PEAK=0.8` / `STUTTER_DIVISION=0.5` / `DELAY_TIME_S=0.18`。`REVERB_WET_PEAK` 撤去（driver は CHAOS_PEAK 使用）。
- [ ] 追記 → `npm run check`（0 errors）。

### Task 2: beatRepeat.ts（純粋・TDD）
- [ ] test 先行（mix=0 パススルー / mix=1 凍結スライスループ / mix=0.5 ブレンド / 再起動で再キャプチャ）→ RED
- [ ] 実装（ring 常時書込・frozen 独立バッファ）→ `npm test -- beatRepeat` GREEN

### Task 3: fxParams.ts（純粋・TDD）
- [ ] test 先行（透過(0,0) / chaos=1 全上昇+filterFreq≈300 / base floor / 単調 / filterFreq 単調減）→ RED
- [ ] `computeFxParams` 実装 → `npm test -- fxParams` GREEN

### Task 4: worklet（static/worklets/beat-repeat.js）
- [ ] `registerProcessor('beat-repeat')` を beatRepeat.ts と同一ロジックで自己完結実装（params mix/sliceFrames、ch毎 ring/frozen）。
- [ ] `npm run build` が static を含めて成功。

### Task 5: masterFx.ts（改修）
- [ ] MasterFx I/F 拡張（setChaos/setReverbBase/setStutterBase/setFilterBase/setCrushBase/setDelayBase/setBpm）、`createMasterFx` を async 化しチェーン構築。worklet addModule は try/catch フォールバック。impulseResponseSamples/test は維持。
- [ ] `npm run check` 0 errors、`npm test -- masterFx` GREEN。

### Task 6: rotation.ts（onWet→onChaos リネーム）
- [ ] `onWet`→`onChaos`（emit は envelope wet を chaos として渡す）→ `npm test -- rotation` GREEN（不変）。

### Task 7: driver.ts（配線）
- [ ] `masterFx = await createMasterFx(ctx)`、初期 setBpm、onChaos→setChaos、setConfig で setBpm、`AudioDriver.setChaos/setFx` 追加、transition.wet→chaos＋controlParams.chaos 公開。plan.wetPeak=CHAOS_PEAK。
- [ ] `npm run check` 0、`npm test` 全緑。

### Task 8: MIDI/UI（types/mapping/+page）
- [ ] ContinuousTarget に fxReverb/fxStutter/fxFilter/fxCrush/fxDelay/chaos 追加＋RANGES[0,1]。
- [ ] +page に FX スライダー＋applyContinuous 分岐（fx/chaos→driver.setFx/setChaos）。
- [ ] `npm run check` 0、`npm test -- mapping` GREEN。

### Task 9: 全体検証・HANDOFF更新
- [ ] `npm test` / `npm run check` / cargo test / clippy / build を緑確認。HANDOFF に M5b 追記。

## Self-Review
- spec §3.1→T2, §3.2→T4, §3.3→T3, §3.4→T5, §3.5→T6, §3.6→T7, §3.7→T8, §4→T1。全カバー。
- 型整合: `computeFxParams`/`FxBases`/`FxParams`(T3) を masterFx(T5) が使用。`MasterFxName`(T7) と UI/MIDI(T8) の fx 名一致（reverb/stutter/filter/crush/delay）。`onChaos`(T6) を driver(T7) が使用。
