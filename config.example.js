// Copie este arquivo para `config.js` e preencha com as suas chaves PÚBLICAS.
// NUNCA coloque a Service Role Key do Supabase nem o Webhook Secret aqui —
// esses segredos são EXCLUSIVAMENTE do backend (.env).
window.APP_CONFIG = {
  SUPABASE_URL: 'https://SEU-PROJETO.supabase.co',
  SUPABASE_ANON_KEY: 'sua_anon_key_publica',
  // A chamada à API do PixGo deve ser feita pelo BACKEND (ver /api/pix/create).
  // O frontend NÃO deve mais conter a API Key do PixGo.
  API_BASE: '', // ex.: 'https://seu-backend.com' — vazio = mesma origem
  PRODUCT: {
    name: 'Painel de Recargas',
    amount: 47.0,
    url: 'https://creditodecelular.com/recargas',
  },
};
