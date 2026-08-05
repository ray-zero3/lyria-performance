/// env `GEMINI_API_KEY` を返す（未設定なら空文字）。
/// キーはコード/ログに出さない（値をそのまま返すのは control 窓へ供給するため）。
#[tauri::command]
pub fn get_api_key() -> String {
    std::env::var("GEMINI_API_KEY").unwrap_or_default()
}
