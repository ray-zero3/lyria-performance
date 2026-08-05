<template>
  <NuxtPage />
</template>

<style>
  :root {
    color-scheme: dark;
    /* Apple ダーク基調のトークン */
    --bg: #000000;
    --surface: #1c1c1e;
    --surface-2: #2c2c2e;
    --text: #f5f5f7;
    --text-secondary: #a1a1a6;
    --text-tertiary: #6e6e73;
    --separator: rgba(255, 255, 255, 0.1);
    --accent: #0a84ff;
    --accent-hover: #409cff;
  }
  html,
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family:
      -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue",
      "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
  }
  * {
    box-sizing: border-box;
  }
</style>
