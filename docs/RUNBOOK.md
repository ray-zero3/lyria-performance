# 当日の手順（RUNBOOK）

迷ったらこれだけ見る。すべてリポジトリルートで実行する。

## 1. 起動（この順番）

```bash
npm run show:preflight   # ① 事前チェック。全部 ✓ になるまで直す
npm run show:serve       # ② リクエストサーバ（ターミナル1・開いたまま）
npm run show:deploy      # ③ マシン名をランダム化して公開（.env の URL も自動更新）
npm run live             # ④ control / VJ 窓（ターミナル2・開いたまま）
```

**`show:deploy` は `live` より前に実行する。** QR は Tauri 起動時の `.env` を読むため、
公開でホスト名が変わったあとに Tauri を起動しないと QR が旧 URL のままになる。

マシン名を変えずに公開するだけなら従来の `npm run show:open`（この場合は順序自由）。

`show:deploy --build` は `show:serve` の**あとに**ビルドすることになるため、稼働中の
サーバは古いバンドルを配り続ける。ビルドが必要なら `show:build` を先に済ませること。

そのあと手で:

5. **VJ 窓を第2ディスプレイへ移して全画面**
6. control 窓の settings（⚙）で **APIキー状態が「あり」** を確認 → 音源 `lyria` → **start**

`show:build`（型チェック＋テスト＋両ビルド）は**事前に**済ませておく。当日やるなら Tauri を閉じてから。

## 1-B. LAN モード（デモ用・同じ Wi-Fi のスマホから）

外部公開せずに、**同じ Wi-Fi に繋いだスマホから**リクエストページを開くモード。
Tailscale / Funnel は一切触らない（QR の URL を `http://<この Mac の LAN IP>:3000/` に差し替えるだけ）。

```bash
npm run demo             # これ1つ（ターミナル1つ）。終了は Ctrl+C
```

`demo` がやること: 未ビルドなら request-app をビルド → リクエストサーバ起動 →
QR の URL を LAN アドレスに差し替え → control / VJ 窓を起動。
**Ctrl+C（または VJ 窓を閉じる）で自動的にサーバ停止と `.env` の復元まで戻す**ので、
「戻し忘れて次回の QR が LAN アドレスのまま」が起きない。

- リクエストサーバのログは `lan-demo.log`（`tail -f lan-demo.log` で見る）
- 既に `show:serve` が動いていればそれを使い、**終了時にも停止しない**（別ターミナルの担当分は触らない）
- IP を明示したいときは `npm run demo -- --ip 192.168.x.x`

サーバのログを別ターミナルで見たい・サーバは立てっぱなしにしたい場合は手動でも組める:

```bash
npm run show:serve       # ① リクエストサーバ（ターミナル1・開いたまま）
npm run show:lan         # ② QR の URL を LAN アドレスに差し替え（.env を書き換え）
npm run live             # ③ control / VJ 窓（ターミナル2・開いたまま）
npm run show:lan:off     # デモ後: .env の URL を元に戻す（手動時は忘れないこと）
```

`show:lan` も `live` より前に実行する（QR は Tauri 起動時の `.env` を読む）。
`show:preflight` は LAN モードを自動判別して LAN 側の疎通を確認する。

- IP は Wi-Fi → デフォルトルートの順で自動検出。複数 NIC があると候補も表示するので、
  繋がらなければ `npm run show:lan -- --ip 192.168.x.x` で明示する
- Funnel 版と違い `NUXT_ACCESS_KEY` 未設定でも止めないが、**同じ Wi-Fi の全員が課金 API を叩ける**ので鍵は入れておく
- `.funnel-state` が残っている（Funnel 公開中）ときは実行を拒否する。どちらも `VITE_REQUEST_URL` を
  書き換えるため、混ぜると復元できなくなる。先に `npm run show:revert` すること

**繋がらないときの原因はほぼネットワーク側**:

| 症状 | 原因 | 対処 |
|---|---|---|
| QR を読んでも開かない | 別 SSID（ゲスト用・2.4/5GHz 別 SSID）にいる | スマホを Mac と同じ SSID に繋ぐ |
| 同じ SSID なのに開かない | AP の端末間通信ブロック（ゲスト Wi-Fi・社内 AP では既定で有効なことが多い） | Mac のインターネット共有かスマホのテザリングで同じ網にする |
| Mac 自身からも届かない | macOS ファイアウォールが node の受信を拒否 | システム設定 → ネットワーク → ファイアウォール → オプションで許可 |

HTTPS ではないため公演本番には使わない（外部公開は `show:deploy`）。

## 2. 公演中の操作

| やりたいこと | 操作 |
|---|---|
| セッション残り時間 | control 窓の右上 `session 4:32`。**1分を切ると琥珀色**、ローテ中は `rotating…` |
| 観客リクエストを音に入れる | 右下 requests の `→ pin` → **パッドの置きたい位置をクリック**（`cancel` で取り消せる） |
| リクエストを捨てる | `×` |
| VJ に告知を出す | `message` → 入力 → `VJ に表示`。消すのは `message off`（出している間はボタンが点灯） |
| シーン切替 | `scene next`（promptSpace ⇄ latentField、900ms クロスフェード） |
| セッションを手動で切り替え | `rotate`（完了時にシーンも自動で切り替わる） |

音が破綻したら `reset ctx`。Lyria が瞬断すると **conceal が自動発動**して `⚠ CONCEAL` バッジが出る（復帰まで音を繋ぐ）。

## 3. 公演後（忘れずに）

```bash
npm run show:revert   # 公開停止 → マシン名を復元 → .env の URL を復元（3つまとめて）
```

`show:deploy` が保存した `.funnel-state` から元のマシン名を読んで戻す。状態ファイルを
失った場合は名前を明示する:

```bash
npm run show:revert -- --hostname <元のマシン名>
```

元の名前が分からなくなった場合は Tailscale の管理画面（<https://login.tailscale.com/admin/machines>）で確認する。

マシン名を戻さないと、他のデバイスからこの Mac を参照する名前がランダム文字列
（例 `lp521592b5f6`）のままになる。`show:open` で公開した場合は `npm run show:close`。

### ランダムなマシン名を「秘密」として当てにしない

Funnel は Let's Encrypt の証明書を取得するため、**ホスト名は数分で Certificate
Transparency ログに公開され、誰でも列挙できる**。ランダム化はマシンの本名を公開
アドレスに出さないための措置であって、アクセス制御ではない。実際に観客ページを
守っているのは `NUXT_ACCESS_KEY`（URL の `?k=`）だけ。
そのため `show:deploy` は `NUXT_ACCESS_KEY` 未設定なら公開せずに停止する。

## 4. 公開 URL と鍵

- URL は `.env` の `VITE_REQUEST_URL`（`?k=…` 付き）。**QR は VJ 画面の左下**に出る
- **鍵なしのアクセスは 403**。QR から入れば Cookie に入り、以降18時間は鍵不要
- 鍵を変えたいときは `request-app/.env` の `NUXT_ACCESS_KEY` と `.env` の `VITE_REQUEST_URL` の `?k=` を**同じ値に**して、サーバと Tauri を再起動

## 5. やってはいけないこと

- **Tauri / vite dev が動いている間に `npm run build` を実行する**
  → `.svelte-kit` を壊して control 窓が真っ黒になる。`npm run show:build` はガードで止まる
- **新しい `{#each}` のキーにユーザー入力由来の値を使う**
  → 重複すると Svelte がクラッシュして窓ごと落ちる（`{#each x as v (v.id)}` のように一意な id を使う）
- **dev サーバ（`nuxi dev`）を Funnel で公開する**
  → `/@vite/client` などが外部に出る。公開は必ず `show:serve`（本番ビルド）で
- **観客ページのクライアント側で `crypto.randomUUID()` を使う**
  → secure context 専用。LAN モード（`http://192.168.x.x:3000`）では undefined になり
  `onMounted` が TypeError で落ちる。`crypto.getRandomValues()` を使う（`pages/index.vue`）
- **シェルスクリプトで `"$VAR（"` のように変数の直後に全角文字を置く**
  → macOS の `/bin/sh`（bash 3.2）が全角文字の先頭バイトを変数名に含めてしまい、
  `set -u` で `unbound variable` になる。`"${VAR}（"` と波括弧で閉じる

## 6. トラブル

| 症状 | 原因の候補 | 対処 |
|---|---|---|
| リクエストが control 窓に出ない | cue トークン不一致 / CORS | `show:preflight` の「cue トークンが両 .env で一致」を確認 |
| 観客が 403 になる | QR の `?k=` と `NUXT_ACCESS_KEY` の不一致 | preflight の「QR の `?k=` とアクセスキーが一致」を確認 |
| 観客ページが `Blocked request` | Vite の `allowedHosts`（dev サーバを公開している） | `show:serve` で起動しているか確認 |
| 観客に「送信できませんでした」 | OpenCode の一時障害（502） | 少し待って再送。頻発するならクレジット残高を確認 |
| control 窓が真っ黒 | pad 内のエラー | 通常は boundary がエラー表示に置き換わる。出ないときは Cmd+R |
| 音が出ない | Lyria の APIキー / allowlist | settings でキー状態を確認。最悪 `MockLyria` に切替（VJ は動く） |
| 公開したのに 502 | サーバが落ちている | `show:serve` を再実行 |

**ログの見方**: リクエストサーバのターミナルに `[access] 鍵なしアクセスを N 件拒否` が1分間隔で出る。桁が急に増えたら攻撃を受けている（ただし 403 で弾かれているので実害はない）。

## 7. 見た目を調整したくなったら

| 対象 | 定数 | 現在値 |
|---|---|---|
| blob 枠の線の太さ | `BLOB_FRAME_LINE_PX`（`src/lib/vj/post.ts`） | 1.5 |
| ロックオン枠の線 | `RETICLE_LINE`（`scenes/latentField.ts`） | 0.006 |
| 解析 HUD の大きさ | `HUD_HEIGHT`（同上） | 0.12 |
| 点群の量（重いとき最初にここ） | `DUST_COUNT`（同上） | 14000 |
| シーンのフェード時間 | `DEFAULT_SCENE_FADE_MS`（`sceneManager.ts`） | 900 |
| control の cue 表示件数 | `CUE_VISIBLE_MAX`（`routes/+page.svelte`） | 5 |
| VJ の cue 表示件数 | `VJ_CUE_VISIBLE`（`routes/vj/+page.svelte`） | 9 |

投影環境で細線が飛ぶ場合は `BLOB_FRAME_LINE_PX` と `RETICLE_LINE` を上げる。

## 8. 流量の上限（変えたいとき）

`request-app/server/api/request.post.ts`:

- 全体 **10件/分**（バースト5）… `TOTAL_PER_MIN` / `TOTAL_BURST`
- 同一端末 **1.5秒**間隔 … `CLIENT_INTERVAL_MS`
- 公演累計 **300件** … `SHOW_TOTAL_LIMIT`（プロセス起動からの通算。**公演直前にサーバを再起動すればリセットされる**）
