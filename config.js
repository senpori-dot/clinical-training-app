// Supabaseプロジェクトの接続情報
// anon/publishable keyはクライアント側で公開しても問題ない設計のキーです(RLSで保護)
window.SUPABASE_URL = "https://nklgbelahdsjnxtwzdvl.supabase.co";
window.SUPABASE_ANON_KEY = "sb_publishable_ZKWt5eu0krfdANdS4GOKUA_QESn1mzE";
// ⚠️ 上記キーは会話で頂いたものをそのまま転記しています。
// Supabaseダッシュボード(Settings → API → Project API keys → anon/publishable)の値と
// 一文字違わず一致しているか、必ずご自身の目でも確認してください
// (このサンドボックス環境はネットワークアクセスできないため、接続確認はこちらではできません)。

window.COURSE_LABELS = ["①クール", "②クール", "③クール", "④クール", "⑤クール", "⑥クール"];
window.REQUIRED = {
  internal: 3,   // 院内3クール
  external: 3,   // 院外3クール
  internal_medicine: 3, // 内科系3クール
  surgery: 3,    // 外科系3クール
};
