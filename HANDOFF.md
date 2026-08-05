# Lyria RealTime VJ — セッション引き継ぎ（更新: 2026-07-24）

Claude 再起動後の再開用ドキュメント。**まずこの「現在地」ブロックを読む** → 詳細は各メモ参照。

## ▶ 現在地（2026-07-24 時点・ここから再開）

- **フェーズ: 実装完了。M2 / M2.5 / M3 / M4 / M5 / M5b / M6 / M7 / M8 すべて実装完了（M7/M8 は 2026-07-24）**。
- **M8（VJ 展開＋ポストエフェクト＋Max 風 control）実装完了**: トグル・オブジェクト5種（星雲/地平線ドーム/スキャン/中央パルス/星座線）＋ポストエフェクト5種（glitch/split/rgbShift/bloom/scanline、`three/webgpu` RenderPipeline）＋ control 窓の Max/MSP **Presentation モード**風リスタイル＋ PadEditor「VJ 展開」パネル（carry=prompt_space、Rust 変更なし）。詳細は下の「M8 実装完了メモ」。**次の一手 = user の live 確認・調整**。
- **control UI 刷新＋blob 持続化（2026-07-24, user FB）**: (1) **blob 追跡を持続化**（点滅解消）: 検出を `detField`（セル中心輝度>しきい値）→ `afterImage(detField, BLOB_HOLD_DAMP=0.972)` で**セル単位に信頼度を蓄積・緩やか減衰**（≈1.3s ロック保持）。HUD は瞬時検出でなく保持信頼度 `conf` で駆動、速い `blink` は撤去し緩いパルスに。(2) **control 画面をダークモード化**（`+page.svelte`、VJ 同系統の黒〜濃色＋シアン/緑 accent、`color-scheme: dark`）。(3) **Lyria 特化 UI**: メイン＝prompt space パッド／lyria config／master fx／トランスポート のみ。既定 source=lyria。(4) **Maxmsp 風ノブ**: 新規 `src/lib/ui/Knob.svelte`（SVG 270° ダイヤル、縦ドラッグ/ホイール/キー、`$bindable` value＋onInput(live)/onChange(release)）。config/FX/PadEditor の全スライダーをノブ化（bpm のみ onChange=setConfig+resetContext、他は onInput=live）。(5) **MIDI マッピング形式**: settings 内に「target｜binding｜assign(MIDI Learn)｜clear」のアサイン表。`store.ts` に **`unbind` 追加**（★store.test +4）。(6) **settings モーダル**: 音源選択・APIキー状態・MIDI ポート/アサイン表/合成インジェクタ等の非演奏 UI を歯車ボタンで開閉（Esc/背景クリックで閉）。緑: vitest 184・check 0/0warn・build 成功。Rust 変更なし。
- **TD 風ポストエフェクト追加（2026-07-24, user FB）**: `VJ_EFFECT_KEYS` に **`timemachine`／`blob`** を追加（全て `src/lib/vj/post.ts` に閉じる。シーン変更なし）。(1) **timemachine（GITS 風 時間ずらし）**: `three/addons/.../AfterImageNode` の `afterImage(baseTex, damp)` で履歴を蓄積し、`convertToTexture` でテクスチャ化 → **時間スクロールする per-pixel ワープ UV で再サンプル**（履歴が溶けて尾を引くスリットスキャン的表現）。`damp=amount×TIME_MACHINE_MAX_DAMP(0.94)`、ワープ量 `TIME_MACHINE_WARP(0.055)`。amount=0 で damp/ワープ/blend 全 0＝**恒等（透過）**。(2) **blob（blob tracking／スクリーンスペース検出）**: 最終画像の輝度で `BLOB_GRID_X×Y(22×13)` セルを検出（中心輝度>しきい値）、ヒットセルに**コーナーブラケット＋クロスヘア＋走査線**、明部の**輪郭線（隣接 texel 輝度差）** を重畳。`BLOB_THRESHOLD(0.34)` は `uLevel`（`post.setAudio(vp.level)`）で脈動。セル明滅は BPM 非依存。amount=0 で寄与ゼロ＝透過。統合は `VJ_EFFECT_KEYS` ジェネリックループで slider/carry/永続化が自動追従（scene.ts のエフェクトループも無変更で両者を post へ送信）。★test 更新: vjToggles/promptSpace/persistence の effect 期待値に 2 キー追加。緑: vitest 180・check 0・build 成功。live 調整ノブ=上記定数。
- **M8 調整（2026-07-24, user FB）**: (1) VJ オブジェクトは **horizon(地平線ドーム) のみ残し nebula/scan/corePulse を撤去**（`VJ_OBJECT_KEYS=["horizon"]`）。(2) **星座線を作り替え**: 背景に描画される星(anchors 90) 同士を**流れ星のように尾を引く輝線で結ぶ**。本数は **`constellationLines`(0..1) スライダー**で可変（0..`MAX_CONST_LINES`=60）。動きは **BPM 非依存**（`constClock` 実時間）。(3) **カメラをもっと下から**（基準高 1.9→0.8、下限 0.1、上下スイング拡大）。(4) **split をもっと分割＋非シームレス**（ミラー折返し→ハード反復 `fract`、`SPLIT_MAX_TILES=8`、BPM 非連動）。(5) ピン粒子は球殻分布・ストリームは 38ms 高速化・config スライダー live 反映(bpm は release で setConfig+resetContext) も反映済み。緑: vitest 180・check 0・build 成功。
- **M7（プロンプト空間）実装完了**: 2D パッド（ピン＋カーソル=音像モーフ、ガウシアン重みブレンド→`setPrompts`）＋ prompt_space 中継チャネル（Rust `push_prompt_space` 追加）＋ VJ 既定シーン PromptSpace（3D ピン/ラベル/粒子/影響線）＋右 30% 生データパネル（SENT/RECV/CTRL/ANLY ログ）＋ MIDI cursorX/cursorY/morph_next。詳細は下の「M7 実装完了メモ」。**次の一手 = user の live 確認・調整**。
- **M6（VJ 本番ビジュアル）実装完了**: 4 シーン（Vortex/RadialSpectrum/Terrain/Swarm）の TSL 粒子世界＋onset バースト＋spectrum 構造＋chaos 溶解→再結晶＋カット/フラッシュ切替＋読めるデータ層。詳細は下の「M6 実装完了メモ」。
- **M5b（マスターFXチェーン）実装完了（2026-07-24）**: master に **reverb量調整・ビートリピート(AudioWorklet)・フィルタースイープ・ディレイ** の4FX（※ crush/歪みは「酷すぎる」との user FB で 2026-07-24 除去）。カオスマクロ0..1で一括駆動（トランジションで自動 0→0.8→0）＋各FX個別 base（UI スライダー/MIDI）。詳細は下の「M5b 実装完了メモ」。
- **自動進行合意**: [[lyria-vj-autonomous-mode]]（spec→plan→実装→検証を自走、要所検証・ブロッカー/判断/破壊的操作/外部送信時のみ停止）。**git は初期化済み・`origin` = github.com/ray-zero3/lyria-performance（private）で管理中**（旧「コミットしない合意」は解消済み）。
- **VJ の見た目は M2〜M4 とも使い捨てプレースホルダ。本番デザインは M6**（user 合意）。M5 までは土台コードを積むだけ。
- **検証の制約（重要）**: 自動操作の Chrome は非フォーカスで `requestAnimationFrame` が停止＆`AudioContext` はユーザー操作起点でないと suspended。→ **live 音声/描画/実機MIDIは私の自動環境で検証不可**。純ロジックは Vitest/cargo test、UI配線は隔離ブラウザで、live/実機は user 確認。別ポートで vite 起動すると origin 別＝localStorage/BroadcastChannel 分離。
- **user 側の実機確認 待ち（任意・M5前でも後でも可）**: (1) `GEMINI_API_KEY=... npm run tauri dev` で 2窓＋第2ディスプレイ＋Lyria live＋MIDI実機、(2) prompt 追従（適用で対照的promptに変えて聴き比べ）。
- **起動/テスト**: リポジトリルートで実行。開発2窓 `GEMINI_API_KEY=... npm run tauri dev`（vite :1420）。フロントのみ `npm run dev`（Lyriaは `.env` の `VITE_GEMINI_API_KEY`、ブラウザで `/`＋`/vj`）。`npm test` / `npm run check` / `cargo test --manifest-path src-tauri/Cargo.toml --lib` / `cargo clippy --manifest-path src-tauri/Cargo.toml --lib`。
- **現状の緑**: vitest 180・cargo test 6・svelte-check 0・cargo build/clippy clean・`npm run build` 成功。
- **⚠️ user の dev サーバが :1420 で稼働している場合あり**（M4 live 検証で起動）。私が検証で vite を使う時は別ポート(:5199 等)で。実装詳細は下記「再開手順」の各完了メモに全部ある。

---

（以下は経緯・決定事項・各マイルストーン完了メモ）

## 会話の流れ（要約・初期）

1. **mrt2~（Magenta RT ローカル外部, Max/MSP）調査**
   - help を開くと Max がクラッシュ → 原因は **mrt2~ 0.0.1 のスレッド安全性バグ**（構築時に複数スレッドが同じ MLX/Metal デバイスへ並行アクセス → Metal assert → abort）。Max 本体や設定のせいではない。
   - 音は出るがノイズ → **base M4 が GPU律速でリアルタイム生成が間に合わずドロップアウト**。buffersize では治らない（ジッタ吸収しかできないため）。
   - 「NPU の限界か？」→ MLX は GPU(Metal) 使用で **ANE 不使用**。ボトルネックは GPU＋メモリ帯域。
2. **mrt2_base int8 量子化 R&D**（rnd スキル。詳細: `../rnd/notes/001_int8_quant/index.md`）
   - 結論: **出荷版 `mrt2_base.mlxfn` は既に int8 量子化済み**（実測: 出荷版2.77GB=int8 ≠ 真bf16 5.03GB）。当初の「bf16→int8で2x」前提は誤りだった。
   - 量子化(int4まで) × CFG削減(num_cfgs 0まで) の全構成で **RTF 最大 0.53**、base M4 で mrt2_base の realtime 化は不可。realtime は mrt2_small か M4 Pro/Max。
   - **mrt2_small(230M) インストール済み**。int4 variant 3種（`mrt2_base_int4` 等）は温存（user が Max で実機確認予定 = 未完了の Q3）。
3. **Lyria RealTime へ方針転換（＝この新プロジェクト）**

## Lyria RealTime の要点（一次情報確認済み）

- Gemini API のホスト型ストリーミング音楽生成。`@google/genai`、model `models/lyria-realtime-exp`、WebSocket、`apiVersion: "v1alpha"`。
- 出力: **48kHz / 16-bit PCM / stereo**、`response.audioChunk.data`（base64）。
- 操作: `session.setWeightedPrompts({weightedPrompts:[{text,weight}]})` / `session.setMusicGenerationConfig({musicGenerationConfig:{bpm(60-200), scale, guidance(0-6), density(0-1), brightness(0-1), temperature, top_k, seed, mute_bass, mute_drums, ...}}})` / `session.play()` / `session.close()`。bpm/scale 変更時は `resetContext()`（同一セッション内のハード遷移）。
- **セッション上限 10分。セッション間で音楽的コンテキストを引き継ぐ手段は無い**（`reset_context` はセッション内のみ、audio continuation も resume も無い）。完全シームレスな継続は API 上不可能。

## 決定事項（技術）

- **スタック: Tauri v2 + SvelteKit + Vite + three.js/WebGPU**。
  - Nuxt は**非採用**（ローカル Tauri SPA では SSR/サーバー/SEO が無関係で旨味なし。Vue が欲しければ Vue3+Vite で十分）。
  - Electron **不要**（下記 WebGPU 確認済みのため）。
- **WebGPU プローブ PASS**（macOS 26 Tahoe + M4, WKWebView）: `navigator.gpu=true`, adapter=apple(Metal直), **three_backend=WebGPU**（WebGLフォールバックではない）。実装は `src/routes/+page.svelte`、Rust側 `report_probe` コマンドは `src-tauri/src/lib.rs`。
- **アーキテクチャ**: 2 窓（control=`/` / VJ=`/vj`、SvelteKit route 分割）＋ **Rust hub**（状態の単一の真実 + イベント中継 `emit`/`emit_to`/`listen` + 窓/第2ディスプレイ管理 + APIキー保管）。
  - Lyria 接続と **Web Audio 再生・解析（AnalyserNode）は control 窓**。VJ 窓は解析データ（level / 低中高帯域 / ~32-64ビンスペクトル / onset を ~30-60fps でコンパクトに）で反応。
- **10分対策**: 2 セッション・オーバーラップ（~8分でローテーション起動）＋ **GainNode 等パワークロスフェード**（~4s）＋ 共有 state を新セッションへ全投入。位相ロック不可 → 短いクロスフェードで DJ ブレンド的に繋ぐ。
- **MIDI**: **Rust backend の `midir`（CoreMIDI）→ Tauri events → UI マッピング**（Web MIDI は WKWebView 対応が不確実なので非推奨）。MIDI out で LED フィードバックも可。CC→bpm/guidance/density/brightness/prompt weight、pad→prompt トグル/mute/reset_context、MIDIラーン層。
- **APIキー**: Rust が env `GEMINI_API_KEY` から読み control 窓へ供給（コード/ログに出さない）。

## 成果物（現状）

- `lyria-vj/`: Tauri v2 + SvelteKit + Vite scaffold。three インストール済み。**WebGPU プローブ実装済み・確認済み**。
- ツールチェーン完備: node 24.2 / rust 1.88 / **cargo-tauri 2.11.4** / Xcode。
- （mrt2 側）隔離 venv `../.venv_mrtquant`、rnd 記録 `../rnd/`。

## 段階ビルドプラン

| # | 内容 | Lyriaキー |
|---|------|-----------|
| ~~probe~~ | WebGPU 実機確認 → **PASS済み** | 不要 |
| ~~M2~~ | 2窓 skeleton + Rust hub + テレメトリ契約（ダミー流）+ 第2ディスプレイ + 最小ハイブリッド描画 → **実装完了（2026-07-23）** | 不要 |
| ~~M2.5~~ | MIDI 入力層（midir → events → UIマッピング + MIDIラーン） → **実装完了（2026-07-23、実機MIDIは要確認）** | 不要 |
| ~~M3~~ | Web Audio 再生 + AnalyserNode 実解析 → VJ が実音に反応 → **実装完了（2026-07-23）** | 不要 |
| ~~M4~~ | Lyria 接続（prompts/config, PCM→Web Audio）+ 操作UI → **live 成立（2026-07-23: 実キー+allowlistで音が鳴った）** | **要** |
| ~~M5~~ | 2セッション・8分ローテーション + マスク付きクロスフェード → **実装完了（2026-07-24、live は要確認）** | **要** |
| ~~M6~~ | VJ ビジュアル作り込み（4シーン TSL 粒子 + データ層） → **実装完了（2026-07-24、live は要確認）** | 一部要 |
| ~~M7~~ | プロンプト空間（2Dパッド音像モーフ + 3D既定シーン + 右生データパネル + MIDIカーソル） → **実装完了（2026-07-24、live は要確認）** | 一部要 |

## 未決（brainstorming で詰める候補）

- **VJ ビジュアルのコンセプト/演出**（音のどの特徴を何に? TSL シェーダの方向性、複数シーン、遷移）。
- **control UI レイアウト**と **MIDI 初期マッピング**（使用コントローラ未定 → 決まれば固定マップ、未定なら汎用ラーン）。
- **クロスフェードの UX**（拍合わせをどこまで作り込むか）。
- **ブロッカー: Lyria API キー + allowlist アクセス**（AI Studio で `lyria-realtime-exp` が叩けるか要確認。M4 で必要）。

## M8 実装完了メモ（2026-07-24・VJ 展開＋ポストエフェクト＋Max 風 control）

- **設計/計画**: `docs/superpowers/specs/2026-07-24-lyria-vj-m8-vj-development-toggles-posteffects-design.md` / `docs/superpowers/plans/2026-07-24-lyria-vj-m8-vj-development-toggles-posteffects.md`。**Rust 変更ゼロ**（carry は既存 prompt_space チャネル）。
- **carry 拡張**（`src/lib/prompts/promptSpace.ts`）: `PromptSpaceState` に `vjObjects?`（nebula/horizon/scan/corePulse/constellation の bool）＋ `vjEffects?`（glitch/split/rgbShift/bloom/scanline の 0..1）。キーは `VJ_OBJECT_KEYS`/`VJ_EFFECT_KEYS`（as const、単一定義）。`clampPromptSpaceState` は**常に全キー埋め**で出力（厳密 bool 化・clamp01・未知キー破棄・未指定デフォルト＝旧保存データ後方互換）。immutable ヘルパ `setVjObject`/`setVjEffect` ★test +4。persistence round-trip テストに新フィールド反映。
- **純粋マッピング**（`src/lib/vj/vjToggles.ts` 新規）: `objectTargets`（bool→0|1）/`effectTargets`（clamp01・不正→0）★test 2。VJ 側の carry→目標値変換の単一入口。
- **トグル・オブジェクト**（`scenes/promptSpace.ts`）: 5 種を init で常時構築し、`uObjNebula/uObjHorizon/uObjScan/uObjCore`（TSL uniform 0..1）と constellation（LineSegments、`material.opacity` を JS 更新）に `easeAlpha(OBJ_TAU=420ms)` で目標へ補間（突然出/消し無し。OFF→0 で不可視）。目標は `applyTargets` の `objectTargets(space.vjObjects)`。
  - **nebula**: 大サイズ加算スプライト 36 個の霧（level 明滅・ノイズゆらぎ）。**horizon**: 半径 7.5 の緯線 5 リング粒子ドーム 3200（mid 反応・緩回転）。**scan**: 円盤 2600 粒子の水平スキャン面が y=0..2.4 を三角波で往復（burst 増光/加速）。**corePulse**: 中央 (0,0.6,0) の同心 3 リング（burst/level で拡大・発光）。**constellation**: 黄金角配置の決定的擬似星 14＋星チェーン＋アクティブピン→最寄り星＋カーソル→最寄り星の輝線（animate で毎フレーム張り替え）。カウント定数は全て export（live 調整ポイント）。★scenes smoke +1（全 ON→一部 OFF→dispose）。
- **ポストエフェクト**（`src/lib/vj/post.ts` 新規）: `createPostFx(renderer, scene, camera)` → `{ setEffect(name, amount), renderAsync(), setSize(w,h), dispose() }`。
  - **確認済み export（three 0.185.1 実物）**: `three/webgpu` の **`RenderPipeline`**（旧 `PostProcessing` は **r183 で改名**され deprecated wrapper（warnOnce）→ RenderPipeline を採用）。`RenderPipeline.renderAsync()` も **r181 deprecated** → `renderer.init()` 済み前提で **`render()`** を使用（post の API 名は契約どおり `renderAsync()` のまま、内部で `pipeline.render()`）。`three/tsl` の `pass()`（RenderTarget は毎フレーム drawing buffer へ自動追従）。`three/addons/tsl/display/BloomNode.js` の `bloom(node, strength, radius, threshold)`（strength に uniform ノード直結可・@types あり）。
  - glitch（行ブロックずらし ~8Hz）/split（ミラー折返しタイル 1..4）/rgbShift（回転色収差＋glitch 行で追加分離）/scanline（走査線減光＋微歪み）は **1 パスの自作 TSL Fn** に統合（追加 RT なし）。bloom は既製 BloomNode を合成結果に加算。**各 uniform 0..1、全て 0 で完全透過**（数式上オフセット/ゲート/減光が 0）。強度は `setEffect` 目標 → renderAsync 内で `easeAlpha(FX_TAU=260ms)` 平滑。
  - ★test +1: スタブ renderer（toneMapping/outputColorSpace のみ）での**グラフ構築 smoke**（構築/setEffect/setSize/dispose が throw しない）。**実描画（render()）は GPU 依存で vitest 不可 → build 緑＋live 確認に委ねる**。
- **scene.ts 配線**: `createPostFx` を try/catch で構築（失敗時 console.error＋素の `renderer.renderAsync` にフォールバック）。ループは post 経由レンダ、carry の vjEffects は同一参照キャッシュで `effectTargets`→`setEffect`。resize は `post.setSize` にも伝播。dispose 連鎖。
- **control UI**（`PadEditor.svelte`）: 「VJ 展開」パネル＝オブジェクト 5 チェックボックス＋エフェクト 5 スライダー。既存 `commit()` 単一入口 → localStorage＋onSpace（prompt_space）送信＋ハートビート同期。ラベルは日本語（星雲/地平線ドーム/スキャン/中央パルス/星座線）。
- **§7 Max/MSP 風リスタイル（Presentation モード）**: `+page.svelte`/`PadEditor.svelte` の `<style>` を全面差し替え（構造/bind/handler 不変）。**user 訂正（2026-07-24）でパッチャー風→Presentation モード風**: パッチコード・インレット/アウトレット端子・格子/ドット・オブジェクトボックスは**出さない**。フラットグレー背景（#d4d4d4）＋機能ごとの bgcolor パネル（#e3e3e3・極薄枠・角丸 5px・UPPERCASE 小見出し）＋ウィジェット統一（スライダー=accent-color ティール #3a7d8c、トグル=appearance:none 四角＋X 印 SVG、bang=円ボタン（ターゲット×）、number box=コンパクト白、ボタン=フラット #f6f6f6・active でティール反転）。SVG パッドは黒枠ディスプレイとして温存。`:root { color-scheme: light }`。VJ 窓（黒）は無変更。
- **検証**: vitest **180**（+8: promptSpace +4・vjToggles 2・post 1・scenes +1）・svelte-check 0 errors 0 warnings・`npm run build` 成功（three/addons bundle 込み）・cargo test 6・clippy clean。
- **未確認（要 live）**: 各オブジェクトの見た目/明るさ/密度、ポストエフェクトの効き（特に **WebGPU RenderPipeline の実描画**と bloom 品質、全 0 時のオーバーヘッド）、トグル/スライダー→VJ 反映の体感遅延（OBJ_TAU/FX_TAU）、Presentation 風 UI の操作感（WKWebView での accent-color トラック塗り含む）、M4 実機での fps（追加 ~5.8k 粒子＋post パス）。
- **調整ポイント（live で詰める）**: NEBULA/HORIZON/SCAN/CORE/CONST 各 COUNT・OBJ_TAU（scenes/promptSpace.ts）、FX_TAU・BLOOM_MAX_STRENGTH・bloom の radius 0.4/threshold 0.55・glitch 8Hz/行数 10..36・split タイル数 1..4・rgbShift 0.012・scanline 640 本/減光 0.4（post.ts）、Max 配色（#3a7d8c 系）。重い場合は post を全 0 時に素レンダへ自動フォールバックする最適化余地あり（現状は常時 post 経由＝spec 許容）。

## M7 実装完了メモ（2026-07-24・プロンプト空間）

- **設計/計画**: `docs/superpowers/specs/2026-07-24-lyria-vj-m7-prompt-space-design.md` / `docs/superpowers/plans/2026-07-24-lyria-vj-m7-prompt-space.md`。
- **構成**: 純粋層 `src/lib/prompts/promptSpace.ts`（Vitest 25）→ 永続 `persistence.ts`（5）→ コントローラ `PadEditor.svelte` → 中継チャネル prompt_space（bus/browser/tauri＋Rust）→ VJ store last-known → 既定シーン `scenes/promptSpace.ts` ＋ 右生データパネル `dataPanel.ts`（整形は `dataPanelFormat.ts` 純粋・Vitest 14）。
- **純粋ロジック**（promptSpace.ts）: `computeWeights(pins,cursor)` = 空テキスト除外→ガウシアン raw=exp(-d²/(2r²))→Σ正規化→閾値 0.02 未満除外→上位 K=6→再正規化（最終Σ=1）。全滅時は最近傍 weight=1 フォールバック（無音化防止）。`normalizedPinWeights`（VJ 可視化用・ピン index 対応）/ `morphStep`（線形+クランプ）/ `easeInOutCubic` / immutable CRUD（add/move/remove/updateText/updateRadius/moveCursor/addTarget/removeTarget）/ `clampPromptSpaceState`（境界の防御的整形）/ `defaultPromptSpaceState`（スターター4ピン・決定的ID）。**型 Pin/Cursor/Target/PromptSpaceState はここが単一定義**（contract.ts は非変更。transport は `$lib/prompts/promptSpace` から type import）。
- **コントローラ**（PadEditor.svelte、`/` の単一 prompt 入力を置換・常時表示）: SVG パッド（ピン●＋1σ円＋ラベル、カーソル◇、影響線=重み不透明度）。ピン/カーソルのドラッグ（pointer capture）、+ピン=テキスト＋クリック配置、選択ピンの編集/削除、ターゲット保存＋クリックで自動モーフ（duration 0.5–20s、easeInOutCubic、rAF）＋「次へモーフ」。変更は `commit()` 単一入口 → localStorage 保存（500ms スロットル、key `lyria-vj-prompt-space`）＋送信（120ms スロットル: `computeWeights`→`onWeights`→`driver.setPrompts`、`onSpace`→`pushPromptSpace`）。ハートビート 500ms（~2Hz）で `onSpace` のみ再送（後発 VJ 窓同期）。境界は `$state.snapshot()`。weights が空のときは setPrompts しない。
- **中継チャネル**: `TelemetryTransport.pushPromptSpace/onPromptSpace`。browser=BroadcastChannel Msg `{t:"promptSpace"}`、tauri=`invoke("push_prompt_space")`＋`listen("prompt_space")`。**Rust: `relay.rs` に `push_prompt_space`（push_event と同形の不透明中継 `emit_to("vj","prompt_space",..)`）＋ `lib.rs` invoke_handler 登録**（M7 で想定内の Rust 変更はこれのみ）。VJ 側は `store.applyPromptSpace`（clamp して last-known 保持、snapshot に `promptSpace: state|null`）。
- **VJ 既定シーン**（scenes/promptSpace.ts、`scenes/index.ts` の `createSceneBundle()` 先頭=既定。既存4シーンは切替で残存）: パッド x,y→3D x,z、ピン y=重みで浮上（PIN_LIFT=1.1）。ピン=グロー核＋周回粒子 ORBIT_COUNT=3600（軌道半径/輝度∝重み、spectrum bin＋onset で「解析」脈動）＋スキャンリング（拡大→減衰、onset 増光）＋CanvasTexture ラベル（document ガードで node 安全）。カーソル=ダイヤ Sprite、カーソル→ピンの LineSegments 影響線（輝度=重み。WebGPU は線幅不可のため輝度＋流れ粒子 FLOW_COUNT=900 で太さ感）。GridHelper 床・シアン/緑/白・低速オービットカメラ。dissolve/flash 対応。`setPromptSpace(space|null)` は同一参照キャッシュで毎フレーム安価。
- **レイアウト調整（2026-07-24, user 指示）**: **ビジュアルは画面全体**（`.stage` を inset:0 のフルスクリーン化）。右生データパネルはビジュアル上のオーバーレイ（`.panel` position:absolute 右寄せ・`pointer-events:none`）。flex 分割は撤去。→ **さらに調整（user FB）: 背景レイヤー撤去**（bg/blur/border 無し、代わりに `text-shadow` で可読性確保）、**幅を狭く**（22%・min200/max380・font 10px）、`src/routes/vj/+page.svelte`。
- **生データパネルの高速化（2026-07-24, user 指示）**: 「高速に多種データを送受信している感」を出すため、ストリームを **facet ローテーション**化（`dataPanelFormat.formatStreamTick`: ANLY/BAND/SPEC/CURS/WGHT の5種を tick 毎に切替）＋ティック間隔を短縮（`STREAM_TICK_MS=80`・RENDER 70ms・`LOG_RING=260`）。旧 `formatAnalysisLine` は撤去。★test: formatStreamTick 6。緑: vitest 172。
- **カメラ/ピン演出調整（2026-07-24, user 指示）**: (1) **カメラの激しさをパラメータ化** `cameraEnergy`(0..1) を `PromptSpaceState` に追加（default 0＝控えめオービット、1=半径ゆらぎ+上下+横揺れで縦横無尽）。PadEditor に「カメラの激しさ」スライダー、prompt_space チャネルで VJ へ、localStorage 永続。(2) **注視点は中央固定**（0,0.35,0）。※当初 cursor/pin 追従＋巡回を実装したが「注視点が変わり続けると変」との user FB で撤回（`pickMostMoved` も削除）。カメラ位置のオービットのみ激しさで可変。(3) **ピンの移動/出現/消失・カーソル・激しさ・床反応を全て指数平滑で滑らかに**（scene 内に id 安定スロット＋目標値、毎フレーム `animate()` で補間。出現=フェードイン、消失=フェードアウト後にスロット解放、カクつき/突然消滅なし）。純粋ヘルパ `src/lib/vj/cameraRig.ts`（`easeAlpha` のみ）★test 5。調整定数は `scenes/promptSpace.ts` の POS_TAU/AMT_TAU/ENERGY_TAU。
- **シーン刷新（2026-07-24, user 指示）**: (1) **単一シーン運用**＝バンドルは promptSpace のみ（`scenes/index.ts`）。抽象4シーン(vortex/radialSpectrum/terrain/swarm)はファイル温存(scenes.test で smoke)だがアプリ非搭載。control の「シーン切替」ボタン撤去。(2) **星空 `buildStarfield`**（`STAR_COUNT=26000` の球殻・twinkle・level/onset 微反応）を背景に敷き、**ピンはその中から生まれ収束**（buildOrbitSprite に `BORN_SPREAD` = active↑で星状の広がり→収束）。(3) **描画密度アップ**（ORBIT_COUNT 3600→9000 / FLOW_COUNT 900→2400 / 星26000 / 床グリッド）。M4 実機で重ければ各 COUNT を削減。(4) **床**: 平衡感覚用 GridHelper は常時。加えて **オーディオ反応フロア** `buildReactiveFloor`（`FLOOR_GRID²`=80²=6400、列=周波数のスペクトログラム床＋onset 同心円リップル＋level 脈動）を追加し、`floorReactive`(bool、`PromptSpaceState`) の ON/OFF で `uFloorReactive` を滑らかに 0↔1。PadEditor にチェックボックス。緑: vitest 167・check 0・build 成功。
- **右生データパネル**（dataPanel.ts、vj ページ右 幅 32%・半透明オーバーレイ・min 280px）: 上=スナップショット（SESSION/PROMPTS+重みバー█░/CONFIG/CHAOS+cursor+pins/ROTATE 進捗）、下=リング 200 行ストリームログ（SENT=prompt_set/config_set、RECV=chunk/session/rotate、CTRL=操作、ANLY=500ms ティック解析）。DOM 反映 100ms（~10Hz）スロットル＋auto-scroll。行整形は `dataPanelFormat.ts` 純粋関数（fmtClock/truncateJson 160 字/weightBar/formatLogLine/formatAnalysisLine/snapshotLines）。秘密は流れない（prompts/config/解析値のみ）。
- **MIDI**: ContinuousTarget に `cursorX`/`cursorY`（RANGES [0,1]）、ActionTarget に `morph_next`。`applyContinuous`→`pad.setCursorNorm`（片軸更新）、`applyAction`→`pad.morphNextTarget()`。**`promptWeight` はパッド置換に伴い削除**（stale 保存マッピングは isContinuous 判定から漏れて no-op になり安全）。
- **検証**: vitest **162**（+52: promptSpace 25・persistence 5・dataPanelFormat 14・midi +2・store +1・transport +1・scenes +2/index 2）・svelte-check 0・cargo test 6・clippy clean・`npm run build` 成功。
- **未確認（要 live）**: パッド操作→音像モーフの体感（120ms スロットルの粒度）、3D シーンの構図/明るさ/ラベル可読性、右パネルの情報密度、MIDI カーソルの滑らかさ、後発 VJ 窓のハートビート同期、第2ディスプレイ。
- **調整ポイント（live で詰める）**: SEND_THROTTLE_MS=120/HEARTBEAT_MS=500（PadEditor）、WEIGHT_THRESHOLD=0.02/MAX_ACTIVE_PROMPTS=6/DEFAULT_PIN_RADIUS=0.28（promptSpace.ts）、ORBIT_COUNT/FLOW_COUNT/PAD_SCALE/PIN_LIFT（scenes/promptSpace.ts）、LOG_RING=200/RENDER_INTERVAL_MS=100/ANALYSIS_TICK_MS=500（dataPanel.ts）、パネル幅 30%（vj/+page.svelte）。

## M6 実装完了メモ（2026-07-24・VJ 本番ビジュアル）

- **設計/計画**: `docs/superpowers/specs/2026-07-24-lyria-vj-m6-vj-visuals-design.md` / `docs/superpowers/plans/2026-07-24-lyria-vj-m6-vj-visuals.md`。
- **構成**: 純粋層 `visualMapping`（Vitest）→ three 非依存の状態機械 `sceneManager`（Vitest）→ `scenes/` 4 種（TSL uniform 駆動）→ `scene.ts` 配線。`dataLayer` が読めるデータ層。M2〜M5b のプレースホルダ `layers/` 5 ファイルは削除。
- **技術要点（three 0.185.1 実物確認済み）**: WebGPU では `THREE.Points` が **1px 固定** → 粒子は **`THREE.Sprite` + `sprite.count`（WebGPU インスタンシング）+ `SpriteNodeMaterial`**（`PointsNodeMaterial` の JSDoc が指示する公式手法）。`uniformArray` は updateType=RENDER で毎フレーム `.array` 書き換えが GPU 反映。`element()` の戻りは chainable でないため `float()`/`vec3()` でラップ＋`uniformArray<"float">` literal generic（@types/three 0.185.1 の型都合）。import は `three/webgpu`（クラス）と `three/tsl`（ノード）。
- **実装**:
  - `src/lib/vj/visualMapping.ts`（純粋）= `onsetEnvelope`（アタック即時・指数減衰 ONSET_DECAY_MS=180）/ `smoothSpectrum`（IIR、SPECTRUM_SMOOTH_MS=120）/ `bandsToColor`（low=青紫↔high=ピンクの HSL）/ `hslToRgb`・`secondaryColor`（+0.42 回し）/ `chaosToDissolve`（^1.4）/ `motionSpeed`（bpm/120、0.25..2.5）/ `VisualParams` 型 ★test 22。
  - `src/lib/vj/sceneManager.ts`（three 非依存）= シーン一覧/current/`next()`/`setScene(id)`（手動=カット+flash、flashMs=250）、rotating 中は dissolveTarget へ指数追従（ease 600ms）・非 rotating は 0 へ（再結晶）、rotating→非 rotating エッジで `autoSwitchOnRotate`（scene.ts は true で使用）ならフラッシュ無しで次シーンへ ★test 11。
  - `src/lib/vj/scenes/`: `types.ts`（SceneContext/SceneImpl= init/update/setDissolve/flash/dispose）、`sceneUtils.ts`（共通 uniforms 束: time/burst/level/low/mid/high/dissolve/flash/colorA/colorB/spectrum[48]、applyVisualParams、加算 Sprite ヘルパ、FLASH_DECAY_MS=220）。
  - 4 シーン（全て加算合成・丸ソフト粒子・dissolve で飛散+減光・flash で白飛び）: `vortex.ts`（6000 粒子、内側ほど速い渦+noise flow、bin 担当粒子が spectrum で半径脈動、onset で放射押し出し）/ `radialSpectrum.ts`（48bin×130、セクタ角=bin、半径=bin 値で脈動、onset 立ち上がり(>0.55)で拡大衝撃波リング uRing/uRingAmp）/ `terrain.ts`（88×88 グリッド、中心=低域〜外周=高域の bin 割当てで高さ場+noise、onset で同心円リップル、カメラ低速オービット）/ `swarm.ts`（5200 粒子、uniformArray[8] アトラクタを JS リサージュ駆動、粒子は mx_noise_vec3 軌道で塊、low=塊の大きさ・high=速度、onset で散開）★smoke test 4（TSL グラフ構築が throw しない・GPU 不要）。
  - `src/lib/vj/dataLayer.ts` = DOM オーバーレイ（top: state/scene/経過/rotate 残り/transition%、進捗バー 2px、bottom: prompt・bpm/dens/bright・seq/drops、波形リボンは canvas 2d 毎フレーム）。テキストは 250ms スロットル。
  - `src/lib/vj/scene.ts` = store→純粋マッピング→manager.frame→visible 切替→dataLayer→renderAsync。`scene_next` は control 窓からの `TelemetryEvent{ctrl:"param", id:"scene_next"}` をイベントリングで受けて `manager.next()`（開始時 Date.now() 透かしで過去イベント無視）。`renderer.ts` は PerspectiveCamera(60°) 化+aspect resize+背景 0x030309（カメラはアクティブシーンが毎フレーム所有）。
  - MIDI: `ActionTarget`+`ACTION_TARGETS` に `scene_next`（Learn UI 自動追加）。`+page.svelte` に `sceneNext()`（pushEvent 発行）+`applyAction` 分岐+常時表示「シーン切替」ボタン（音源/稼働不問で効く）。
- **検証**: vitest **110**（+37: visualMapping 22・sceneManager 11・scenes smoke 4）・svelte-check 0・cargo test 6・clippy clean・`npm run build` 成功。
- **未確認（要 live: フォーカス窓 or 実機）**: 各シーンの実際の見た目/明るさ/構図、M4 実機での 60fps（粒子数）、onset バースト・衝撃波・リップルの体感、chaos 溶解→再結晶（ローテーションと繋いだ流れ）、scene_next（ボタン/MIDI）とカット+フラッシュ、autoSwitch でのシーン入れ替わり、dataLayer の視認性、第2ディスプレイ全画面。
- **調整ポイント（live で詰める）**: 粒子数（VORTEX_COUNT=6000 / RADIAL_PER_BIN=130 / TERRAIN_GRID=88 / SWARM_COUNT=5200）、ONSET_DECAY_MS/SPECTRUM_SMOOTH_MS（visualMapping.ts）、DEFAULT_FLASH_MS/DEFAULT_DISSOLVE_EASE_MS（sceneManager.ts）、FLASH_DECAY_MS（sceneUtils.ts）、burst エッジしきい値 0.55（radial/terrain）、色マッピング係数（bandsToColor）、各シーンの scale/glow 係数、`autoSwitchOnRotate`（scene.ts で true）。

## M5b 実装完了メモ（2026-07-24・マスターFXチェーン/カオス演出）

- **背景（user 指示）**: 「リバーブの効き調整やビートリピートなどのエフェクトをマスターに実装。もっとぐちゃぐちゃにしながらトランジションさせたい」→ M5 の単純リバーブ wash を複数FXのマスターチェーンに拡張。
- **brainstorming 合意**: FX 全採用（reverb量調整/ビートリピート/フィルタースイープ/歪み+ディレイ）、ビートリピートは **AudioWorklet 本物のスライスループ**、制御は **カオスマクロ＋個別調整**。
- **設計/計画**: `docs/superpowers/specs/2026-07-24-lyria-vj-m5b-master-fx-chaos-design.md` / `docs/superpowers/plans/2026-07-24-lyria-vj-m5b-master-fx-chaos.md`。
- **信号グラフ**（crush 除去後）: preMaster → beatRepeat(worklet) → filter(BiquadLPF) →〔dry〕＋〔delaySend→Delay⇄feedback〕＋〔reverbSend→Convolver〕→ master → destination/analyser。定常時（chaos=0・全base=0）は dry のみ＝従来音。
- **⚠ crush(歪み/WaveShaper) は 2026-07-24 に除去**（user FB「酷すぎる」）。fxParams/masterFx/midi/UI から crush 系を削除し、FX は reverb/stutter/filter/delay の4つ。再追加は WaveShaper を戻すか worklet でビットクラッシュ化する形で可能（spec §7 参照）。
- **実装**:
  - `src/lib/audio/beatRepeat.ts`（純粋）= ring 常時書込＋mix>0 起動で直前スライスを frozen へ凍結ループ（独立バッファで上書き回避）。mix ブレンド／再起動で再キャプチャ ★test 4。`static/worklets/beat-repeat.js` が同一ロジックを自己完結ミラー（params: mix / sliceFrames、ch毎 ring/frozen）。**変更時は両方合わせる**。
  - `src/lib/audio/fxParams.ts`（純粋）= `computeFxParams(bases, chaos)`。各FX実効量=clamp01(base + chaos*weight)、weight reverb.7/stutter1/filter1/crush.8/delay.8。filterFreq は対数スイープ(20k→300)、Q=0.7+amt*8、delayFeedback=amt*.82 ★test 5。
  - `src/lib/audio/masterFx.ts`= `createMasterFx` を **async 化**（worklet addModule）。`MasterFx`: setChaos / setBase(name) / setBpm / dispose。worklet 失敗時は stutter 無しでパススルー（try/catch）。連続値は setTargetAtTime(0.02) で平滑化、WaveShaper curve は crush 変化時のみ再生成。`impulseResponseSamples`（既存純粋）維持 ★test 5。worklet URL は driver から `${base}/worklets/beat-repeat.js` を opts で注入（masterFx は `$app/paths` を import しない＝vitest 汚染回避）。
  - `src/lib/lyria/rotation.ts`= `onWet`→`onChaos` リネーム（envelope の wet=0→peak→0 をカオス量として供給）。テスト不変。
  - `src/lib/audio/driver.ts`= `masterFx = await createMasterFx(ctx, {workletUrl})`、初期 setBpm、`onChaos→setChaos`、`setConfig` で setBpm 追従、`AudioDriver.setChaos/setFx` 追加。トランジション露出は `controlParams.chaos`（旧 reverbWet を改名）＋`transitionProgress`＋`session.state="rotating"`。plan.wetPeak=`CHAOS_PEAK(0.8)`。analyser は FX 込みの master 出力タップ（M5 から）。
  - `src/lib/midi/types.ts`+`mapping.ts`= ContinuousTarget に `chaos/fxReverb/fxStutter/fxFilter/fxCrush/fxDelay`（範囲 [0,1]）追加。`+page.svelte` に「マスターFX」パネル（chaos＋5スライダー、oninput で live 反映）、`applyContinuous` に fx/chaos 分岐（`driver.setChaos/setFx`）。
- **定数**（constants.ts）: `CHAOS_PEAK=0.8`（トランジションのカオスピーク）/ `STUTTER_DIVISION=0.5`（1/8音符）/ `DELAY_TIME_S=0.18`。`REVERB_WET_PEAK` は撤去し `CHAOS_PEAK` に置換。
- **検証**: vitest 73（beatRepeat 4・fxParams 5 追加）・svelte-check 0・cargo test 6・clippy clean・`npm run build` 成功（`build/worklets/beat-repeat.js` 出力確認）。
- **未確認（要 live: フォーカス窓 or 実機）**: 実FXの聞こえ（特に本物ビートリピートの質感）、**WKWebView の AudioWorklet 動作**（失敗時はパススルーにフォールバック）、カオス連動トランジションの「ぐちゃぐちゃ」度、個別スライダー/MIDI の効き。純ロジック(beatRepeat/fxParams)は Vitest 済み。
- **調整ポイント（live で詰める）**: CHAOS_WEIGHT（fxParams.ts）、CHAOS_PEAK、STUTTER_DIVISION、DELAY_TIME_S、filter の open/closed Hz。真のビットクラッシュ（サンプルレート/ビット削減）は現状 WaveShaper 歪みで近似（本物は将来 worklet 化可）。

## M5 実装完了メモ（2026-07-24）

- **設計/計画**: `docs/superpowers/specs/2026-07-24-lyria-vj-m5-session-rotation-crossfade-design.md` / `docs/superpowers/plans/2026-07-24-lyria-vj-m5-session-rotation-crossfade.md`。
- **brainstorming 合意（クロスフェード UX）**: ベースは「テンポ継続のみ」（新セッションに現 bpm/config/prompt を全投入し equal-power で ~4s ブレンド、位相合わせなし＝位相ロックは API 上不可）。**加えてトランジション中はドラムを消し（Lyria `mute_drums`）、リバーブ等のマスターエフェクトでごまかす**（user 指示）。ローテーションは **自動(~8分)＋手動オーバーライド（ボタン/MIDI）**。
- **実装（フロントのみ・Rust 変更ゼロ）**:
  - `src/lib/audio/crossfade.ts`（純粋）= `equalPowerGains`（定パワー）/ `transitionEnvelope`（LEAD 2s→FADE 4s→TAIL 2s の gain/wet/drumMute/progress を返す）★test 9。
  - `src/lib/audio/masterFx.ts` = `impulseResponseSamples`（手続き的リバーブ IR・決定的 xorshift・アセット不要）★test 5、`createMasterFx`（preMaster→dry/master ＋ wetSend→Convolver→master、`setWet`）。
  - `src/lib/lyria/rotation.ts` = `createRotatingSource`（2デッキ・オーバーラップ。DeckFactory と `now()` 注入でテスト可）。rotate() で incoming を drums mute・gain0 で start＋旧も drums 間引き、**first-chunk ゲート**（音が来るまで FADE 開始せず無音移行を防止）、`autoRotateMs` 到達で tick が自動 rotate、incoming タイムアウト(8s)で中止して active 維持、done で active 昇格＋新のドラム復帰。drum mute の setConfig は rotate/完了/中止の**離散点のみ**（毎フレーム API を叩かない）★test 7。
  - `src/lib/audio/driver.ts` = lyria/mocklyria 分岐を「2デッキ + masterFx」に置換。各デッキ = session+player+gain、gain→preMaster。**analyser は master 出力をタップ**（リバーブ込みの実出力に VJ が反応）。loop から `rotation.tick(now)`（rAF 駆動＝非フォーカスで自然停止）。`AudioDriver.rotate()` 追加。pushState でトランジション中 `session.state="rotating"`＋`controlParams.transitionProgress/reverbWet` を公開。
  - `src/lib/midi/types.ts` = `ActionTarget` に `"rotate"` 追加（Learn UI は配列反復で自動追加）。`+page.svelte` に「ローテーション」ボタン＋`applyAction` の `case "rotate"`。
- **定数**（`src/lib/telemetry/constants.ts`）: `CROSSFADE_LEAD_MS=2000` / `CROSSFADE_FADE_MS=4000` / `CROSSFADE_TAIL_MS=2000` / `INCOMING_AUDIO_TIMEOUT_MS=8000` / `REVERB_SECONDS=2.5` / `REVERB_DECAY=2.0` / `REVERB_WET_PEAK=0.5`。既存 `ROTATE_AT_MS=480_000` を自動ローテに使用。
- **検証**: vitest 64（crossfade 9・masterFx 5・rotation 7 を追加）・svelte-check 0・cargo test 6・clippy clean・`npm run build` 成功。
- **未確認（要 live: Lyria キー＋allowlist＋フォーカス窓 or 実機）**: 実クロスフェードの自然さ、リバーブ wash の聞こえ、Lyria `mute_drums` の反映遅延の体感、8分自動ローテの長時間挙動、手動ローテ（ボタン/MIDI の `rotate`）。純ロジックは Vitest で確認済み、live 反応はブラウザ非フォーカスで rAF 停止のため私の自動環境では不可。
- **user が spec レビューで修正可能な解釈**: ドラム消しは Lyria `mute_drums`（生成側・反映に遅延）を LEAD 2s の助走で先送りしリバーブ wash と併用。「音声ドメインでの完全なドラム除去」はミックス済みステレオから不可能なため不採用。wetPeak=0.5 / FADE=4s / LEAD=TAIL=2s は初期値で live 調整前提。

## M2 実装完了メモ（2026-07-23）

- **設計/計画**: `docs/superpowers/specs/2026-07-23-lyria-vj-m2-telemetry-skeleton-design.md` / `docs/superpowers/plans/2026-07-23-lyria-vj-m2-telemetry-skeleton.md`。
- **確定コンセプト**: データビジュアライズ型VJ（DJに見せない）。操作の動き・API受信・時刻/タイムライン・波形を"主役データ"として、オーガニック＋幾何学の視覚言語で見せる。見せ方はハイブリッド（世界＋読めるデータ層）。操作は汎用MIDIラーン。
- **実装済み**: テレメトリ契約（TS `src/lib/telemetry/contract.ts` が形の単一定義／Rust は HubState のみ型付け・frame/event は不透明中継）、トランスポート抽象化（`bus.ts`＋`tauriTransport`／`browserTransport`=BroadcastChannel、`window.__TAURI__` で自動切替）、VJ消費ストア（last-known/seq-drop/eventリング）、ダミー生成器、Rust hub（`hub/state.rs`＋`hub/relay.rs` get_state/set_state/push_frame/push_event）、2窓conf（main=/, vj=/vj）＋capabilities、`windows.rs`（第2ディスプレイ全画面・1枚時フォールバック）、VJ最小描画5レイヤ（backgroundPulse/waveformRibbon/timeline/controlFlashes=InstancedMesh/readouts）。
- **追加依存**: devDeps に `vitest` `@types/three` `@webgpu/types`。svelte.config に `vitePreprocess`（TS有効化）。
- **検証**: vitest 21件緑／svelte-check 0エラー／cargo test 3件緑。ブラウザ（vite :1420、`/`＋`/vj`）でハイブリッド描画5要素の反応を目視確認済み。実 `cargo tauri dev` は起動確認済み（バイナリ稼働・panic無し）。**未確認（要ユーザー環境）**: 実2窓の見た目・第2ディスプレイ全画面・2窓のlive連動。
- **⚠️ 重要**: 現在のVJ描画は *データ配管検証用の使い捨てプレースホルダ*。**美観は未着手**。VJビジュアルの本番デザイン（シーン・シェーダ・トーン）は **M6** で専用に設計・実装する（user 合意 2026-07-23）。積み上げるのは土台コードのみ、描画は M6 で差し替え。
- **検証の注意**: ブラウザ2タブでは非アクティブタブの rAF が停止するため cross-tab の live 実演は不可（実アプリは別ウィンドウで両方可視なので問題化しない）。VJ消費→描画は BroadcastChannel 直接注入で検証した。
- **自動進行合意**: [[lyria-vj-autonomous-mode]]（spec→plan→実装→検証を自走、要所検証・ブロッカー時のみ停止）。git は未初期化のまま。

## 再開手順

- 作業ディレクトリ: `/Users/rei.matsuda/workspace/private/lyria-performance`（＝リポジトリルート。2026-07-25 に開発機を移動。旧環境の `.../MRT2_LiveCoding_Extensions/lyria-vj/` から git リポジトリ化して移設済み）
- アクティブプロジェクト: リポジトリルート直下（`src/`＝SvelteKit、`src-tauri/`＝Rust、`request-app/`＝観客リクエスト Nuxt）
- 次の一手: **user の live 確認・調整**。M2〜M8 すべて実装完了（M4 は 2026-07-23 に実 Lyria で発音確認、M5/M5b/M6/M7/M8 は 2026-07-24 実装・live 未確認）。詳細は上の「M8 実装完了メモ」「M7 実装完了メモ」「M6 実装完了メモ」「M5b 実装完了メモ」「M5 実装完了メモ」。
- **M2.5 完了メモ（2026-07-23）**: `src/lib/midi/`（`types.ts`, `mapping.ts`=midiKey/scaleCc/applyMidi★test, `store.ts`=localStorage永続+bind★test, `midiBus.ts`=Tauri購読+合成inject）。Rust `midi.rs`=midir/CoreMIDI、`list_midi_ports`/`open_midi_port`/`close_midi_port`、`midi` イベント（camelCase）、`parse_midi`★test、`MidiState` を lib.rs で manage+登録、Cargo に `midir="0.10"`。control UI に MIDIポート選択・Learn（連続6＋アクション4）・合成インジェクタ。連続CC→driver.setConfig/setPrompts、アクション→resetContext/play_toggle/mute。全MIDIを `TelemetryEvent{control,source:'midi'}` で pushEvent→VJフラッシュ。config に muteBass/muteDrums 追加（payload は mute_bass/mute_drums）。検証: vitest 43・cargo test 6・build/clippy 緑。合成MIDIで Learn→bind→localStorage永続＋control event を確認（:5199 隔離）。**未確認**: 実機 MIDI（コントローラ接続→ポート選択→Learn→操作）。**注意**: 別ポートで vite 起動すると origin 別＝localStorage/BroadcastChannel 分離。
- **M4 live 確認メモ（2026-07-23）**: 実キー(env `VITE_GEMINI_API_KEY`)＋allowlist で `npm run dev`→ブラウザ Lyria で発音 OK。修正2件: (1) **Svelte `$state` プロキシは BroadcastChannel/structuredClone 不可** → UI 境界で `$state.snapshot(cfg)` してから driver/transport へ渡す（`+page.svelte` の start/applyLive）。(2) Lyria/MockLyria 時は driver が **実 prompt/config を HubState に反映**（`lyriaHubState`）して VJ の読めるデータ層に実値を出す（従来 dummyStateAt で偽値だった）。未確認: prompt への musical 追従度合い（適用ボタンで対照的な prompt に変えて聴き比べると分かる）、VJ の live 反応はブラウザ2タブだと非アクティブ側 rAF 停止で制限（実2窓 Taur iが本番）。
- **M4 完了メモ（2026-07-23, コア実装）**: `src/lib/lyria/`（`pcm.ts`=PCM16 stereo デコード, `config.ts`=定数/payload, `player.ts`=ストリーミング再生+nextStart, `mock.ts`=モックLyria, `session.ts`=実Lyria（`@google/genai` を start() 内で動的import・最小型cast）, `types.ts`, `apiKey.ts`）。`driver.ts` に音源 `mocklyria`/`lyria` 追加（player→analyser入口→解析）。control UI に prompts/config・live適用・reset context・APIキー状態。Rust `keystore.rs`=`get_api_key`（env `GEMINI_API_KEY`）を lib.rs 登録。API イベント（session/prompt_set/config_set/chunk/rotate）を pushEvent。設計/計画は `docs/superpowers/{specs,plans}/2026-07-23-lyria-vj-m4-*`（specのみ。planはspecに集約）。一次情報: model `models/lyria-realtime-exp` / apiVersion `v1alpha` / 48kHz-16bit-stereo / `client.live.music.connect({model,callbacks:{onmessage,onerror,onclose}})` / 受信 `serverContent.audioChunks[].data`(base64) / bpm・scale変更は `reset_context()`。
- **M4 検証**: vitest 35（pcm/config/player.nextStart 含む）・svelte-check 0・cargo test 3・clippy clean・cargo build 緑。MockLyria 単体で PCM チャンク(19200B=48k/100ms)＋API イベント全種を確認。**未確認（要キー+allowlist / フォーカスブラウザ or 実機）**: 実 Lyria 接続と live 再生→VJ 反応（AudioContext はユーザー操作起点、rAF はフォーカス要）。
- **APIキー作成手順（ブロッカー）**: https://aistudio.google.com/apikey でキー作成 → プロジェクトで **billing 有効化** → `lyria-realtime-exp` は **allowlist が必要な模様（2026-05〜07時点）**、実接続で権限エラーが出たら Project ID・model・apiVersion `v1alpha`・希望リージョン・課金状況 を添えて申請 → env `GEMINI_API_KEY=... npm run tauri dev` で起動。
- **M3 完了メモ（2026-07-23）**: 実解析は `src/lib/audio/`（`compute.ts`=純粋関数・帯域/spectrum/waveform/level-peak/spectral-flux onset＝Vitest 7件、`analyser.ts`/`sources.ts`/`driver.ts`）。control 窓に音源セレクタ [Dummy|Test|Mic]。Mic の macOS 権限は `src-tauri/Info.plist`（NSMicrophoneUsageDescription）。設計/計画は `docs/superpowers/{specs,plans}/2026-07-23-lyria-vj-m3-*`。検証: vitest 28件・svelte-check 0・cargo test 3・cargo build 緑。**未確認（要フォーカスされたブラウザ/実機）**: 自動Chrome は非フォーカスで rAF が止まり AudioContext も suspended のため live の Test/Mic 解析→VJ 反応は目視不可（コードは配線・構築を確認済み。`http://localhost:1420/` を*自分の*ブラウザで開き Test→開始、別タブ `/vj` で確認できる）。
- 開発起動: `npm run tauri dev`（リポジトリルートで実行。vite :1420 + 2窓）。フロントのみ検証は `npm run dev` → ブラウザで `/` と `/vj`。テスト: `npm test`（vitest）/ `npm run check`（型）/ `cargo test --manifest-path src-tauri/Cargo.toml --lib`。
