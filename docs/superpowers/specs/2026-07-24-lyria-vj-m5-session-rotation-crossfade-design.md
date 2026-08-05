# Lyria VJ — M5: 2セッション・ローテーション + マスク付きクロスフェード（設計）

- 日付: 2026-07-24
- 対象マイルストーン: **M5**（M2/M2.5/M3/M4 完了済み。次は M6=本番ビジュアル）
- ステータス: 設計（brainstorming 合意済み）。git は未初期化のまま（コミットしない合意）。

## 1. ゴールと制約

**ゴール**: Lyria のセッション上限（10分）と、セッション間で音楽コンテキストを引き継げない制約を、
**2セッションのオーバーラップ＋エフェクトで隠したクロスフェード**で吸収し、実質シームレスに演奏を継続する。

**一次情報の制約（確定）**:
- セッション間の musical continuation は API 上不可能。`reset_context` は同一セッション内のみ。
- 位相ロック（拍/小節の完全同期）は不可能 → 隠し（マスク）を効かせた短い DJ ブレンドが上限。

**user 合意の方針（brainstorming 2026-07-24）**:
- ベースは「テンポ継続のみ」= 新セッションに現在の bpm/config/prompt を全投入し、equal-power で ~4s ブレンド。
- 加えて、**トランジション中はドラムを消し（Lyria `mute_drums`）、リバーブ等のマスターエフェクトでごまかす**。
  → WebAudio 側にマスターエフェクトバスを新設する。
- ローテーションのトリガは **自動(~8分) ＋ 手動オーバーライド（ボタン/MIDI）**。

## 2. アーキテクチャ概要（信号グラフ）

lyria / mocklyria 音源時のみ、単一 player を **2デッキ + マスターFXバス**に置き換える。
test/mic/dummy は現状の単純経路を維持（変更なし）。

```
deckA: LyriaLike → PcmPlayer → gainA ┐
deckB: LyriaLike → PcmPlayer → gainB ┘→ preMaster ──┬─────────────→ master → destination
                                                     └→ wetSend → Convolver(reverb IR) ─┘        └→ analyser(解析)
```

- 各デッキは「セッション本体 + そのセッション専用の PcmPlayer + 音量 gain」を持つ（同時に最大2）。
- preMaster = 両デッキの合流点。dry でそのまま master へ、並行して wetSend → reverb → master（送り）。
- **analyser は master 出力をタップ**（VJ は実際に聞こえる音＝リバーブ込みに反応する）。定常時 wet=0 なので従来と同じ音。

## 3. コンポーネント

### 3.1 `src/lib/audio/crossfade.ts`（新規・純粋関数・Vitest対象）

トランジションの「数学」だけを純粋関数として切り出し、単体テストする。ノード配線は持たない。

- `equalPowerGains(t: number): { out: number; in: number }`
  - t=0..1 を equal-power カーブへ。`out = cos(t·π/2)`, `in = sin(t·π/2)`。不変条件 `out² + in² ≈ 1`。
- `transitionEnvelope(elapsedMs: number, plan: TransitionPlan): TransitionState`
  - トランジション全体（LEAD→FADE→TAIL）を1つの純粋関数で表現。
  - `TransitionPlan = { leadMs; fadeMs; tailMs; wetPeak }`
  - 返り値 `TransitionState = { phase: "lead"|"fade"|"tail"|"done"; outGain; inGain; wet; muteDrumsOut; muteDrumsIn; progress }`
    - **LEAD** (0..leadMs): outGain=1, inGain=0, wet: 0→wetPeak, muteDrumsOut=true, muteDrumsIn=true, progress=0。
    - **FADE** (leadMs..leadMs+fadeMs): equal-power で out→in、wet=wetPeak を維持、muteDrums 両方 true、progress=0..1。
    - **TAIL** (…+tailMs): outGain=0, inGain=1, wet: wetPeak→0, muteDrumsOut=true(旧は間もなく破棄), muteDrumsIn=false（新セッションのドラム復帰）, progress=1。
    - **done** (total 超過): out=0, in=1, wet=0, muteDrumsIn=false。
  - すべて clamp。elapsed 負値は LEAD 開始として扱う。

### 3.2 `src/lib/audio/masterFx.ts`（新規）

マスターFXバスを構築（AudioContext 依存＝配線はここに閉じる）。

- `impulseResponseSamples(sampleRate, seconds, decay): Float32Array`（**純粋関数・Vitest対象**）
  - 手続き的リバーブ IR。ノイズ×指数減衰。長さ=`round(sampleRate·seconds)`、先頭≈±1、末尾≈0、全値∈[-1,1]。外部アセット不要。
- `createMasterFx(ctx): MasterFx`
  - ノード: `preMaster`(Gain), `master`(Gain), `wetSend`(Gain, 初期0), `Convolver`(buffer=IR)。
  - 配線: preMaster→master(dry), preMaster→wetSend→Convolver→master。
  - I/F: `input: GainNode`(=preMaster, デッキ接続先), `output: AudioNode`(=master, destination/analyser 接続先), `setWet(0..1)`（wetSend.gain へ ramp）, `dispose()`。
- スコープ限定: M5 コアは**リバーブ送りのみ**。マスターLPF等のスイープは将来拡張（バスは拡張しやすく作る）。

### 3.3 `src/lib/lyria/rotation.ts`（新規・オーケストレーション）

2デッキ + FXバスを束ねてローテーションを司る。driver から使う。テスト容易化のため
**デッキ生成を注入（DeckFactory）**し、時刻を注入（`now()`）できるようにして、実 AudioContext 無しでも
ローテーション手順のロジックを検証できるようにする。

- `interface Deck { session: LyriaLike; setGain(v: number): void; stop(): void; hasAudio(): boolean }`
- `interface DeckFactory { create(cbForChunk, onEvent): Deck }`（実装は player+gain+session を組む。テストは mock deck）
- `createRotatingSource(opts): RotatingSource`
  - `RotatingSource`: `setPrompts`, `setConfig`, `resetContext`（= アクティブデッキへ委譲＋「現在の共有 state」を保持）, `rotate()`, `stop()`, `onTransition(cb)`（progress/wet/state 通知）。
  - 内部状態: `active: Deck`, `incoming: Deck | null`, `desiredConfig`（user 意図）, `effectiveConfig`（送信値。トランジション中は `{...desired, muteDrums:true}`）, `transitionStartMs`。
  - **rotate() の手順**:
    1. トランジション進行中なら無視（二重起動ガード）。
    2. `incoming = factory.create(...)`。`setPrompts(current)`, `setConfig({...desired, muteDrums:true})`, `await start()`。
    3. `active` へも `setConfig({...desired, muteDrums:true})`（旧のドラムを間引く）。
    4. `transitionStartMs = now()`。以後、tick ごとに時刻からフェーズを決め、gainA/B・wet・muteDrums を適用。
       - **LEAD** は rotate() 直後から wall-clock で進める（wet を 0→peak、両デッキ muteDrums=true。outGain=1/inGain=0 のまま音量は動かさない）。
       - **FADE の開始自体を first-chunk まで保留**する（`fadeStartMs = max(transitionStartMs+leadMs, firstChunkMs)`）。それまで outGain=1 を維持＝**無音へフェードしない**。`incoming.hasAudio()` が true になって初めて FADE クロックを起動し、equal-power で out→in。
       - `transitionEnvelope` は「理想の数学」を返し、rotation はゲート（FADE 開始保留）を被せて適用する。
    5. `done` で: 旧 `active.stop()` → `incoming` を `active` に昇格 → `effectiveConfig=desired` に戻し新アクティブへ `setConfig(desired)`（ドラム復帰）→ `incoming=null`。
  - tick 駆動は driver 側の rAF ループから `rotation.tick(now)` を呼ぶ（別タイマー不要、rAF 停止時は自然に止まる）。

### 3.4 `src/lib/audio/driver.ts`（変更）

- `isLyria` 分岐を、`createMasterFx` + `createRotatingSource`（デッキは実 player+gain+session を組む DeckFactory）に置換。
  - analyser は `masterFx.output` をタップ。
- `AudioDriver` I/F に `rotate(): void` を追加（非 lyria は no-op）。
- **自動ローテ**: セッション開始時に `startedAtMs + ROTATE_AT_MS` を目標に、rAF ループ内で「到達したら1回だけ rotate()」。setTimeout ではなく rAF 判定にして、非フォーカスで rAF が止まればローテも止まる（検証環境の挙動と一致）。
- `pushState`: トランジション中は `session.state="rotating"`、`controlParams` に `transitionProgress`(0..1) と `reverbWet`(0..1) を付与。定常時は `"playing"`・付与なし。
  - **契約変更なし**（`controlParams` は自由形式 Record、Rust も BTreeMap で受ける）。**Rust 変更ゼロ**。

### 3.5 UI / MIDI（変更）

- `ActionTarget` に `"rotate"` を追加（`src/lib/midi/types.ts` の型と `ACTION_TARGETS`）。UI の Learn 一覧は配列反復なので自動で増える。
- `+page.svelte`:
  - 「ローテーション」ボタン（`running && isLyriaLike` で活性）→ `driver?.rotate()`。
  - `applyAction` の switch に `case "rotate": driver?.rotate()`。
  - config 変更は現状どおり `driver.setConfig` 経由（rotation が desired として保持し、必要時 muteDrums を上書き）。

## 4. トランジション・タイムライン（既定値）

| フェーズ | 長さ | outGain | inGain | wet | drums(out) | drums(in) |
|---|---|---|---|---|---|---|
| LEAD | 2000ms | 1 | 0(ゲート) | 0→peak | mute | mute |
| FADE | 4000ms | cos | sin | peak | mute | mute |
| TAIL | 2000ms | 0 | 1 | peak→0 | mute | **unmute** |

- 合計 ~8s。自動ローテは 8分(=`ROTATE_AT_MS`)、10分上限まで十分な余裕。
- 「~4s クロスフェード」は FADE 区間を指す。LEAD/TAIL はドラム消し＋リバーブ washの助走/余韻。

## 5. データフロー / VJ への露出（M5は最小・本番は M6）

- `session.state`: 定常 `"playing"`、トランジション中 `"rotating"`。
- `controlParams.transitionProgress`(0..1), `controlParams.reverbWet`(0..1) を pushState で公開。VJ は last-known state から読める。
- `api` イベント: rotate 開始/完了で既存の `api:"rotate"` を emit（payload に `{phase, progress}`）。VJ の event リング/フラッシュ用。
- M5 の VJ 描画は既存の使い捨てプレースホルダのまま。washの本演出は M6。

## 6. エラーハンドリング

- incoming セッションの start 失敗（接続エラー/キー無効）: トランジションを中止し incoming を破棄、active を継続（`effectiveConfig=desired` に戻す）。エラーは `errorMsg`/イベントで可視化、演奏は途切れさせない。
- first-chunk が一定時間（例 8s）来ない: フェードを進めず、タイムアウトで incoming 破棄＋active 継続（無音移行を防止）。
- 二重 rotate（自動と手動の競合）: 進行中は無視。
- stop(): active/incoming 両セッション・両 player・FX バス・AudioContext を確実に解放。

## 7. テスト計画

**純粋・単体（Vitest / キー不要 / ブラウザ不要）**:
- `crossfade.equalPowerGains`: t=0/0.5/1 の値、out²+in²≈1、単調性。
- `crossfade.transitionEnvelope`: 各フェーズ境界での phase 遷移、gain 単調、wet 0→peak→0、muteDrums フラグ、progress clamp、done 状態。
- `masterFx.impulseResponseSamples`: 長さ・先頭≈1・末尾≈0・範囲[-1,1]・decay 大で末尾が小。
- `rotation`（mock DeckFactory + 注入 clock + MockLyria 相当）: rotate で incoming が muteDrums=true で start、first-chunk ゲート、done で active 昇格＋ドラム復帰＋旧 stop、二重 rotate 無視、start 失敗時の中止復帰。

**live のみ（user 確認・キー＋allowlist＋フォーカスされた窓/実機）**:
- 実リバーブの聞こえ、実クロスフェードの自然さ、Lyria `mute_drums` の反映遅延の体感、VJ の反応。
- 8分自動ローテの実挙動（長時間）と手動ローテ（ボタン/MIDI）。

## 8. 定数（`src/lib/telemetry/constants.ts` に追記）

- `ROTATE_AT_MS = 480_000`（既存）。
- `CROSSFADE_LEAD_MS = 2000`, `CROSSFADE_FADE_MS = 4000`, `CROSSFADE_TAIL_MS = 2000`。
- リバーブ: `REVERB_SECONDS = 2.5`, `REVERB_DECAY = 2.0`, `REVERB_WET_PEAK = 0.5`。
- first-chunk タイムアウト: `INCOMING_AUDIO_TIMEOUT_MS = 8000`。

## 9. 前提・解釈（user が spec レビューで修正可能な点）

- **ドラム消しは Lyria `mute_drums`（生成側）で行う**。生成ストリームへの反映には遅延があるため、
  LEAD(2s) の助走で先に mute を送り、リバーブ wash と併せて拍の衝突を隠す方針。
  「音声ドメインでの完全なドラム除去」はミックス済みステレオからは不可能なため採らない。
- リバーブは手続き的 IR（アセット無し）。wetPeak=0.5 は初期値で、live 調整前提。
- FADE=4s / LEAD=TAIL=2s は初期値。live で詰める。

## 10. スコープ外（M5 では作らない）

- VJ 本番ビジュアル（wash の演出含む）＝ **M6**。
- マスターLPF スイープ等の追加 FX（バスは拡張可能に作るが M5 はリバーブ送りのみ）。
- 3セッション以上のオーバーラップ、拍/小節のオンセット同期スタート（費用対効果で不採用）。
