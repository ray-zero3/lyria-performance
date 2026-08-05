# Lyria VJ — M6: VJ 本番ビジュアル（WebGPU/TSL・有機的粒子世界）設計

- 日付: 2026-07-24
- 位置づけ: 最終マイルストーン。M2〜M5b の使い捨てプレースホルダ描画を本番ビジュアルに差し替える。
- ステータス: 設計（brainstorming 合意済み）。git 未初期化のまま（コミットしない合意）。

## 1. 合意済みの方向性（brainstorming 2026-07-24）

- **世界観**: 有機的な流体/粒子世界（GPU パーティクル＋flow field）。上に薄い「読めるデータ層」。＝M2 確定のオーガニック＋幾何学ハイブリッドの本番化。
- **シーン構成**: **複数シーン＋切替**（MIDI/ボタンで切替、任意で自動切替）。
- **トランジション演出**: **崩壊/溶解→再結晶 と カット/フラッシュ切替の両方**。
  - session ローテーション（`state="rotating"`）中は `chaos`(0..1) 連動の**溶解→再結晶**。
  - 手動シーン切替は**カット/フラッシュ**。どちらのスタイルも選べる。
- **音の主役**: **onset**（拍/アタック＝粒子バースト・衝撃波・フラッシュ）＋ **spectrum[48]**（空間構造＝リング/地形/放射）。補助で bands→色/密度、level/peak→全体強度、bpm→動きのテンポ。

## 2. シーンセット（確定・4種）

各シーンは粒子世界の「見え」。共通で onset バースト・chaos 溶解に反応。

1. **Vortex（渦）**: curl-noise flow field に沿って GPU 粒子が流れる。spectrum の帯域で流れのスケール/乱流を変調。onset で放射状の衝撃（バースト押し出し）。
2. **Radial Spectrum（放射リング）**: spectrum[48] を 48 セクタの同心リング/リップルにマッピング。粒子が各リング上に配置され、bin 値で半径が脈動。onset で拡大する衝撃波リング。
3. **Terrain（地形）**: spectrum で変位する高さ場（グリッド）。粒子が地形上を流れる。onset で地形にリップル。カメラがゆっくりドリフト。
4. **Swarm（群れ）**: boids 風の群れ挙動（結合/整列/分離を簡略化）。onset で散らばり、spectrum の帯域で群れの塊/速度を変調。

（user 確認済み: 初版は 4 種）

## 3. アーキテクチャ

現 `src/lib/vj/`（renderer.ts / scene.ts / layers/ の 5 プレースホルダ）を **シーンベース**に再編。WebGPURenderer（`three/webgpu`）と store は流用。

- `src/lib/vj/visualMapping.ts`（**純粋・Vitest**）: frame + HubState → 視覚パラメータ。
  - `onsetEnvelope(prev, onset, dt)`: onset を attack/decay のバースト値(0..1)へ（アタックで跳ね、減衰）。
  - `smoothSpectrum(prev, spectrum, alpha)`: spectrum[48] の時間平滑（0..1）。
  - `bandsToColor(bands)`: low/mid/high → 色相/彩度など（HSL 係数）。
  - `chaosToDissolve(chaos)`: chaos(0..1) → 溶解量（粒子飛散・歪みの強度）。
  - `motionSpeed(bpm)`: bpm → 動きのテンポ係数。
- `src/lib/vj/sceneManager.ts`（**状態機械・Vitest 可**、three 非依存の判断部）:
  - シーン一覧・現在シーン・`next()/setScene(id)`。
  - 手動切替＝カット/フラッシュ（フラッシュ時間の状態）。
  - `state="rotating"`＋chaos 連動＝溶解。rotate 完了で再結晶（任意で次シーンへ自動切替 or 同シーン再構築）。
  - `autoSwitchOnRotate`（任意）: ローテーション完了時にシーンを進める。
  - three オブジェクト操作は注入（`SceneImpl` インターフェース）で分離しテスト可能に。
- `src/lib/vj/scenes/`: 各シーン = `{ init(ctx), update(vp, dt), setDissolve(amount), flash(), dispose() }`。TSL node material（`three/webgpu` の `SpriteNodeMaterial`/`PointsNodeMaterial` + TSL 位置/色ノード、uniform 駆動）。
  - `vortex.ts` / `radialSpectrum.ts` / `terrain.ts`。
  - 粒子は初版では **instanced points + TSL uniform/noise 駆動**（フル compute バッファは将来最適化）。
- `src/lib/vj/dataLayer.ts`: 読めるデータ層（prompt テキスト・bpm・session state・rotation progress・波形の細いリボン）を**控えめなオーバーレイ**として。M2 概念の「世界＋読めるデータ層」を踏襲するが主役は粒子。
- `src/lib/vj/scene.ts`（改修）: レンダループで store から frame/state を読み、`visualMapping` を通し、`sceneManager` 経由で現シーンを `update`。dissolve/flash を適用。

## 4. データフロー

```
store(last frame / last state / events)
  → visualMapping（純粋: onset envelope / spectrum smooth / bands色 / chaos→dissolve / bpm→speed）
  → sceneManager（現シーン選択・切替/溶解/フラッシュの状態）
  → 現 scene.update(visualParams, dt)  → TSL uniform 更新 → WebGPU 描画
dataLayer が prompt/bpm/state/progress を薄く重ねる
```

- `chaos`/`transitionProgress`/`session.state` は M5/M5b で公開済みの `controlParams`/`session` から読む。
- MIDI/API イベント（既存の event リング）で onset 以外の「操作の動き」フラッシュも拾える（M2 の controlFlashes を継承・改良）。

## 5. 操作（control 窓 or VJ 窓）

- シーン切替: MIDI アクション `scene_next`（＋ボタン）。トランジションスタイル切替も用意（dissolve/cut）。
- これらは M2.5 の MIDI アクション層に `scene_next` を足す形（`ActionTarget` 追加）。VJ 窓へは既存の event/transport 経路で通知。

## 6. テスト計画

**純粋・単体（Vitest）**:
- `visualMapping`: onsetEnvelope（アタックで上昇・時間で減衰・clamp）、smoothSpectrum（長さ48・0..1・平滑）、chaosToDissolve（単調・0→0,1→max）、bandsToColor（範囲）、motionSpeed（bpm 単調）。
- `sceneManager`: next() の巡回、setScene、フラッシュ状態のタイムアウト、rotating 中の dissolve 反映、rotate 完了での再結晶＋autoSwitch、注入 SceneImpl で update/dissolve/flash 呼び出し順を検証。

**live のみ（user 確認・フォーカス窓 or 実機／WebGPU 必須）**: 各シーンの見た目、TSL シェーダ、粒子数/パフォーマンス、onset バースト・spectrum 構造・chaos 溶解・フラッシュの体感、第2ディスプレイ全画面。

## 7. スコープ / 段階

- **初版（M6.0）**: 4 シーン（Vortex/RadialSpectrum/Terrain/Swarm）＋ onset バースト＋spectrum 構造＋chaos 溶解＋カット/フラッシュ切替＋薄いデータ層。純ロジックは Vitest、見た目は live 調整。
- **将来**: フル GPU compute 粒子、シーン別プリセット、ポストプロセス（bloom 等）。

## 8. 前提・リスク

- **WebGPU/TSL の実挙動は live 必須**（私の自動環境は非フォーカスで rAF 停止＝目視不可）。renderer は失敗時 null で描画停止する堅牢化済み。
- TSL API はバージョン依存が大きい → 初めて使うノードは three のバージョンに合わせて確認しながら実装（推測で書かない）。
- 粒子数は M4 実機（M4 チップ）で 60fps を狙い、live で調整。

## 9. 確定事項

- シーンセット: **4 種（Vortex / RadialSpectrum / Terrain / Swarm）**（user 確認済み 2026-07-24）。
- **計画・実装は Fable モデルで実施**（user 指示 2026-07-24）。
