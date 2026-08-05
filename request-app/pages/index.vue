<script setup lang="ts">
// 観客用リクエストページ（スマホ想定・Apple ダークモード調）。
// nickname＋自由入力を送信 → 生成された英単語キーワードを表示。
interface CueItem {
  id: string;
  nickname: string;
  keywords: string[];
  text: string;
  tMs: number;
}

/** 端末 ID の保存キー（サーバのレート制限キーに使う）。 */
const CLIENT_ID_KEY = "lyria-request-client-id";

/**
 * 端末 ID 用のランダム16進文字列。
 *
 * crypto.randomUUID() を使ってはいけない: あれは secure context 専用で、LAN デモ
 * （http://192.168.x.x:3000 = 非 secure context）では undefined になり onMounted が
 * TypeError で落ちて clientId が空のままになる。getRandomValues は非 secure context
 * でも使えるのでこちらを使う。
 */
function randomClientId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

const nickname = ref("");
const text = ref("");
const submitting = ref(false);
const result = ref<CueItem | null>(null);
const error = ref("");
const clientId = ref("");

onMounted(() => {
  // 端末ごとの識別子（連打抑止用）。偽装可能なので防壁としては副次的。
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = randomClientId();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  clientId.value = id;
});

/** サーバのレスポンスから利用者向けの文言を決める（回避のヒントになる詳細は出さない）。 */
function messageForStatus(status: number): string {
  if (status === 429) return "送信が混み合っています。少し待ってからお試しください。";
  if (status === 400) return "この内容は送信できません。表現を変えてお試しください。";
  if (status === 413) return "メッセージが長すぎます。";
  return "送信できませんでした。しばらくして、もう一度お試しください。";
}

async function submit() {
  if (submitting.value) return; // 二重送信のみ防ぐ（連投のインターバルは設けない）
  error.value = "";
  const t = text.value.trim();
  if (!t) {
    error.value = "メッセージを入力してください。";
    return;
  }
  submitting.value = true;
  try {
    const res = await $fetch<{ ok: boolean; item: CueItem }>("/api/request", {
      method: "POST",
      headers: { "X-Client-Id": clientId.value },
      body: { nickname: nickname.value.trim(), text: t },
    });
    result.value = res.item;
    text.value = "";
  } catch (e: unknown) {
    const err = e as { statusCode?: number; response?: Response };
    error.value = messageForStatus(err?.statusCode ?? err?.response?.status ?? 0);
  } finally {
    submitting.value = false;
  }
}

function again() {
  result.value = null;
  error.value = "";
}
</script>

<template>
  <main class="page">
    <div class="content">
      <!-- 入力 -->
      <template v-if="!result">
        <header class="head">
          <h1 class="title">リクエスト</h1>
          <p class="subtitle">いまの気分を、ひとことで。<br />ステージの映像と音に届きます。</p>
        </header>

        <form class="form" @submit.prevent="submit">
          <div class="field">
            <label class="label" for="msg">メッセージ</label>
            <textarea
              id="msg"
              v-model="text"
              class="input area"
              maxlength="300"
              rows="3"
              placeholder="例：踊りたい / テクノ / 明るく"
            ></textarea>
          </div>

          <div class="field">
            <label class="label" for="nick">ニックネーム<span class="opt">任意</span></label>
            <input
              id="nick"
              v-model="nickname"
              class="input"
              type="text"
              maxlength="40"
              placeholder="お名前・ニックネーム"
            />
          </div>

          <button class="primary" type="submit" :disabled="submitting">
            {{ submitting ? "送信中…" : "リクエストを送信" }}
          </button>

          <p v-if="error" class="error">{{ error }}</p>
        </form>
      </template>

      <!-- 送信完了 -->
      <section v-else class="done">
        <div class="check" aria-hidden="true">
          <svg viewBox="0 0 44 44" width="44" height="44">
            <circle cx="22" cy="22" r="21" fill="none" stroke="var(--accent)" stroke-width="2" />
            <path
              d="M13 22.5 L19.5 29 L31 16"
              fill="none"
              stroke="var(--accent)"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </div>
        <h2 class="thanks">ありがとうございます</h2>
        <p class="done-sub">
          {{
            result.nickname && result.nickname !== "anon"
              ? result.nickname + " さんのリクエストを受け取りました。"
              : "リクエストを受け取りました。"
          }}
        </p>

        <p class="kw-label">ステージに届いたキーワード</p>
        <div class="keywords">
          <span v-for="k in result.keywords" :key="k" class="chip">{{ k }}</span>
        </div>

        <button class="ghost" type="button" @click="again">もう一度送る</button>
      </section>
    </div>
  </main>
</template>

<style scoped>
  .page {
    min-height: 100vh;
    min-height: 100dvh;
    display: flex;
    justify-content: center;
    padding: 0 22px;
  }
  .content {
    width: 100%;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 100vh;
    min-height: 100dvh;
    padding: 48px 0;
  }

  /* ヘッダー */
  .head {
    margin-bottom: 36px;
  }
  .title {
    margin: 0;
    font-size: 40px;
    line-height: 1.05;
    font-weight: 600;
    letter-spacing: -0.022em;
    color: var(--text);
  }
  .subtitle {
    margin: 14px 0 0;
    font-size: 17px;
    line-height: 1.5;
    font-weight: 400;
    color: var(--text-secondary);
    letter-spacing: -0.01em;
  }

  /* フォーム */
  .form {
    display: flex;
    flex-direction: column;
    gap: 22px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .label {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary);
    letter-spacing: -0.005em;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .opt {
    font-size: 12px;
    font-weight: 400;
    color: var(--text-tertiary);
  }
  .input {
    width: 100%;
    padding: 14px 16px;
    background: var(--surface);
    color: var(--text);
    border: 1px solid transparent;
    border-radius: 14px;
    font-size: 17px;
    line-height: 1.4;
    font-family: inherit;
    transition:
      border-color 0.15s ease,
      background 0.15s ease;
    -webkit-appearance: none;
    appearance: none;
  }
  .input::placeholder {
    color: var(--text-tertiary);
  }
  .input:focus {
    outline: none;
    border-color: var(--accent);
    background: var(--surface-2);
  }
  .area {
    resize: none;
    min-height: 92px;
  }

  /* プライマリボタン（Apple ブルー塗り） */
  .primary {
    margin-top: 4px;
    width: 100%;
    padding: 15px 20px;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 14px;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.01em;
    font-family: inherit;
    cursor: pointer;
    transition:
      background 0.15s ease,
      transform 0.06s ease;
  }
  .primary:hover {
    background: var(--accent-hover);
  }
  .primary:active {
    transform: scale(0.985);
  }
  .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .error {
    margin: 2px 2px 0;
    font-size: 14px;
    color: #ff453a; /* Apple system red (dark) */
    letter-spacing: -0.005em;
  }

  /* 送信完了 */
  .done {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .check {
    margin-bottom: 20px;
    line-height: 0;
  }
  .thanks {
    margin: 0;
    font-size: 28px;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--text);
  }
  .done-sub {
    margin: 10px 0 0;
    font-size: 16px;
    line-height: 1.5;
    color: var(--text-secondary);
    letter-spacing: -0.01em;
  }
  .kw-label {
    margin: 36px 0 14px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-tertiary);
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .keywords {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .chip {
    padding: 10px 20px;
    background: var(--surface);
    border-radius: 980px;
    font-size: 19px;
    font-weight: 500;
    letter-spacing: -0.01em;
    color: var(--text);
  }
  .ghost {
    margin-top: 40px;
    background: none;
    border: none;
    color: var(--accent);
    font-size: 17px;
    font-weight: 400;
    font-family: inherit;
    letter-spacing: -0.01em;
    cursor: pointer;
    padding: 8px;
  }
  .ghost:hover {
    color: var(--accent-hover);
  }
  .ghost:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
