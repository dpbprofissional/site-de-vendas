/* eslint-disable no-undef */
// Frontend — sem chaves privadas. A criação do PIX é feita via backend.
(() => {
  const cfg = window.APP_CONFIG;
  if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    alert('Configuração ausente. Copie config.example.js para config.js e preencha as chaves públicas.');
    return;
  }

  const { createClient } = window.supabase;
  const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  const API = (cfg.API_BASE || '').replace(/\/$/, '');

  let currentUser = null;
  let paymentId = null;
  let checkInterval = null;
  let checkAttempts = 0;
  const MAX_CHECK_ATTEMPTS = 180; // ~15 min com 5s

  // ===== Utils =====
  const $ = (id) => document.getElementById(id);

  function toast(msg, type = 'info') {
    const el = $('toast');
    const colors = { info: 'bg-gray-800', success: 'bg-emerald-600', error: 'bg-red-600' };
    el.className = `toast text-white px-4 py-3 rounded-lg shadow-lg ${colors[type] || colors.info}`;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 4000);
  }

  function isValidEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
  function isValidCPF(cpf) {
    cpf = (cpf || '').replace(/\D/g, '');
    if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
    let s = 0;
    for (let i = 0; i < 9; i++) s += parseInt(cpf[i]) * (10 - i);
    let d1 = (s * 10) % 11; if (d1 === 10) d1 = 0;
    if (d1 !== parseInt(cpf[9])) return false;
    s = 0;
    for (let i = 0; i < 10; i++) s += parseInt(cpf[i]) * (11 - i);
    let d2 = (s * 10) % 11; if (d2 === 10) d2 = 0;
    return d2 === parseInt(cpf[10]);
  }
  function maskCPF(v) {
    return v.replace(/\D/g, '').slice(0, 11)
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  }
  function maskPhone(v) {
    const d = v.replace(/\D/g, '').slice(0, 11);
    if (d.length <= 10) return d.replace(/(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3').trim();
    return d.replace(/(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3').trim();
  }

  // ===== Auth =====
  async function init() {
    $('total-display').textContent = `R$ ${cfg.PRODUCT.amount.toFixed(2).replace('.', ',')}`;
    const { data: { session } } = await supabase.auth.getSession();
    if (session) { currentUser = session.user; showProductSection(); }
    supabase.auth.onAuthStateChange((_e, s) => {
      currentUser = s?.user || null;
      if (currentUser) showProductSection(); else showAuthSection();
    });
  }

  async function handleRegister(e) {
    e.preventDefault();
    const name = $('register_name').value.trim();
    const email = $('register_email').value.trim();
    const cpf = $('register_cpf').value.replace(/\D/g, '');
    const password = $('register_password').value;
    if (!name || name.length < 2) return toast('Informe seu nome completo.', 'error');
    if (!isValidEmail(email)) return toast('E-mail inválido.', 'error');
    if (!isValidCPF(cpf)) return toast('CPF inválido.', 'error');
    if (password.length < 8) return toast('Senha deve ter pelo menos 8 caracteres.', 'error');

    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      const { data, error } = await supabase.auth.signUp({
        email, password,
        options: { data: { full_name: name, cpf } },
      });
      if (error) return toast(error.message, 'error');
      // perfil é criado por trigger no DB (recomendado) — fallback opcional:
      if (data.user) {
        await supabase.from('profiles').upsert({
          id: data.user.id, email, full_name: name, cpf,
        }, { onConflict: 'id' });
      }
      toast('Conta criada! Verifique seu e-mail.', 'success');
      e.target.reset();
    } catch (err) {
      console.error(err); toast('Erro ao criar conta.', 'error');
    } finally { if (btn) btn.disabled = false; }
  }

  async function handleLogin(e) {
    e.preventDefault();
    const email = $('login_email').value.trim();
    const password = $('login_password').value;
    if (!isValidEmail(email) || !password) return toast('Preencha e-mail e senha.', 'error');
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return toast(error.message, 'error');
      currentUser = data.user; showProductSection();
    } catch (err) { console.error(err); toast('Erro ao entrar.', 'error'); }
    finally { if (btn) btn.disabled = false; }
  }

  async function handleLogout() {
    stopPaymentCheck();
    await supabase.auth.signOut();
    currentUser = null;
    showAuthSection();
  }

  function showAuthSection() {
    $('auth-section').classList.remove('hidden');
    $('product-section').classList.add('hidden');
    $('user-info').classList.add('hidden');
    $('user-info').classList.remove('flex');
  }
  function showProductSection() {
    $('auth-section').classList.add('hidden');
    $('product-section').classList.remove('hidden');
    $('user-info').classList.remove('hidden');
    $('user-info').classList.add('flex');
    $('user-email').textContent = currentUser.email;
    // Resetar estado do checkout
    $('checkout-form').classList.remove('hidden');
    $('pix-display').classList.add('hidden');
    $('payment-success').classList.add('hidden');
  }

  // ===== Pagamento =====
  async function handleCheckout(e) {
    e.preventDefault();
    if (!currentUser) return toast('Faça login para continuar.', 'error');
    const phone = $('customer_phone').value.replace(/\D/g, '');
    if (phone.length < 10) return toast('Telefone inválido.', 'error');

    setPayLoading(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch(`${API}/api/pix/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ phone }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result.success) {
        return toast(result.message || 'Erro ao gerar PIX.', 'error');
      }
      paymentId = result.data.payment_id;
      displayPix(result.data);
      startPaymentCheck();
    } catch (err) {
      console.error(err); toast('Erro de conexão.', 'error');
    } finally { setPayLoading(false); }
  }

  function setPayLoading(loading) {
    $('btn-pay').disabled = loading;
    $('btn-text').textContent = loading ? 'GERANDO...' : 'PAGAR COM PIX';
    $('btn-loader').classList.toggle('hidden', !loading);
  }

  function displayPix(data) {
    $('checkout-form').classList.add('hidden');
    $('pix-display').classList.remove('hidden');
    const qr = data.qr_image_url
      ? `<img src="${data.qr_image_url}" alt="QR Code PIX">`
      : '';
    $('qr-code-container').innerHTML = qr;
    $('pix-code').value = data.qr_code || '';
    if (data.expires_at) {
      const exp = new Date(data.expires_at);
      $('pix-expires').textContent = `Expira em ${exp.toLocaleTimeString('pt-BR')}`;
    }
  }

  async function copyPix() {
    const v = $('pix-code').value;
    try {
      await navigator.clipboard.writeText(v);
      toast('Código PIX copiado!', 'success');
    } catch {
      $('pix-code').select(); document.execCommand('copy');
      toast('Código PIX copiado!', 'success');
    }
  }

  function startPaymentCheck() {
    stopPaymentCheck();
    checkAttempts = 0;
    checkInterval = setInterval(checkPaymentStatus, 5000);
  }
  function stopPaymentCheck() {
    if (checkInterval) clearInterval(checkInterval);
    checkInterval = null;
  }

  async function checkPaymentStatus() {
    if (!paymentId) return stopPaymentCheck();
    checkAttempts++;
    if (checkAttempts > MAX_CHECK_ATTEMPTS) {
      stopPaymentCheck();
      toast('Tempo esgotado. Recarregue para tentar novamente.', 'error');
      return;
    }
    try {
      // Consulta segura via backend (não expõe API key do PixGo)
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch(`${API}/api/pix/status/${encodeURIComponent(paymentId)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return;
      const result = await res.json();
      const status = result?.data?.status;
      if (status === 'completed') {
        stopPaymentCheck();
        showSuccess();
      } else if (status === 'expired' || status === 'refunded') {
        stopPaymentCheck();
        toast('Pagamento ' + status, 'error');
      }
    } catch (err) {
      console.error('status check', err);
    }
  }

  function showSuccess() {
    $('pix-display').classList.add('hidden');
    $('payment-success').classList.remove('hidden');
    $('link-product').href = cfg.PRODUCT.url;
  }

  // ===== Eventos =====
  document.addEventListener('DOMContentLoaded', () => {
    $('login-form').addEventListener('submit', handleLogin);
    $('register-form').addEventListener('submit', handleRegister);
    $('checkout-form').addEventListener('submit', handleCheckout);
    $('btn-logout').addEventListener('click', handleLogout);
    $('btn-copy').addEventListener('click', copyPix);
    $('btn-cancel-pix').addEventListener('click', () => {
      stopPaymentCheck(); paymentId = null; showProductSection();
    });
    $('register_cpf').addEventListener('input', (e) => { e.target.value = maskCPF(e.target.value); });
    $('customer_phone').addEventListener('input', (e) => { e.target.value = maskPhone(e.target.value); });

    // Tabs Entrar / Criar conta
    const tabLogin = $('tab-login'), tabReg = $('tab-register');
    const loginForm = $('login-form'), regForm = $('register-form');
    function activate(which) {
      const isLogin = which === 'login';
      loginForm.classList.toggle('hidden', !isLogin);
      regForm.classList.toggle('hidden', isLogin);
      tabLogin.className = (isLogin ? 'tab-active' : 'tab-inactive') + ' flex-1 py-2 rounded-lg text-sm font-semibold transition';
      tabReg.className = (!isLogin ? 'tab-active' : 'tab-inactive') + ' flex-1 py-2 rounded-lg text-sm font-semibold transition';
    }
    tabLogin.addEventListener('click', () => activate('login'));
    tabReg.addEventListener('click', () => activate('register'));

    init();
  });
})();
