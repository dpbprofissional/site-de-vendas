// Backend Node.js — webhook PixGo, criação de PIX e consulta de status.
// Segredos vêm do .env. NUNCA commit do .env.
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SUPABASE_ANON_KEY,
  WEBHOOK_SECRET,
  PIXGO_API_KEY,
  PIXGO_BASE_URL = 'https://pixgo.org/api/v1',
  GMAIL_USER,
  GMAIL_PASS,
  PRODUCT_URL = 'https://creditodecelular.com/recargas',
  PRODUCT_NAME = 'Painel de Recargas',
  PRODUCT_AMOUNT = '47.00',
  CORS_ORIGIN = '*',
  PORT = 3000,
} = process.env;

// Sanity check
const required = { SUPABASE_URL, SUPABASE_SERVICE_KEY, WEBHOOK_SECRET, PIXGO_API_KEY };
for (const [k, v] of Object.entries(required)) {
  if (!v) { console.error(`ENV faltando: ${k}`); process.exit(1); }
}

const app = express();

// CORS simples
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Body raw para webhook + JSON para o resto
app.use('/webhook/pixgo', express.raw({ type: '*/*', limit: '100kb' }));
app.use(express.json({ limit: '100kb' }));

const adminDb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const transporter = (GMAIL_USER && GMAIL_PASS)
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_PASS } })
  : null;

// ===== Auth helper: valida JWT do Supabase no header Authorization =====
async function requireUser(req, res) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) { res.status(401).json({ success: false, message: 'Não autenticado' }); return null; }
  const { data, error } = await adminDb.auth.getUser(token);
  if (error || !data?.user) { res.status(401).json({ success: false, message: 'Token inválido' }); return null; }
  return data.user;
}

// ===== Criar PIX =====
app.post('/api/pix/create', async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    if (phone.length < 10 || phone.length > 11) {
      return res.status(400).json({ success: false, message: 'Telefone inválido' });
    }

    const externalId = `PEDIDO_${user.id.slice(0, 8)}_${Date.now()}`;
    const amount = Number(PRODUCT_AMOUNT);

    const pgRes = await fetch(`${PIXGO_BASE_URL}/payment/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': PIXGO_API_KEY },
      body: JSON.stringify({
        amount,
        description: PRODUCT_NAME,
        customer_name: user.user_metadata?.full_name || user.email,
        customer_email: user.email,
        customer_phone: phone,
        external_id: externalId,
      }),
    });
    const result = await pgRes.json().catch(() => ({}));
    if (!pgRes.ok || !result.success) {
      console.error('PixGo error', pgRes.status, result);
      return res.status(502).json({ success: false, message: result.message || 'Falha no gateway' });
    }

    const { error: dbErr } = await adminDb.from('orders').insert({
      user_id: user.id,
      payment_id: result.data.payment_id,
      external_id: externalId,
      amount,
      status: 'pending',
      product_name: PRODUCT_NAME,
      product_url: PRODUCT_URL,
      payment_method: 'pix',
    });
    if (dbErr) console.error('DB insert order', dbErr);

    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error('create pix', err);
    res.status(500).json({ success: false, message: 'Erro interno' });
  }
});

// ===== Status do PIX (consulta segura via backend) =====
app.get('/api/pix/status/:paymentId', async (req, res) => {
  try {
    const user = await requireUser(req, res); if (!user) return;
    const paymentId = req.params.paymentId;

    // Garante que o pedido pertence ao usuário
    const { data: order } = await adminDb
      .from('orders').select('id,user_id,status')
      .eq('payment_id', paymentId).single();
    if (!order || order.user_id !== user.id) {
      return res.status(404).json({ success: false, message: 'Pedido não encontrado' });
    }

    // Se já completed/expired no DB, devolve sem chamar gateway
    if (['completed', 'expired', 'refunded'].includes(order.status)) {
      return res.json({ success: true, data: { status: order.status } });
    }

    const pgRes = await fetch(`${PIXGO_BASE_URL}/payment/${encodeURIComponent(paymentId)}/status`, {
      headers: { 'X-API-Key': PIXGO_API_KEY },
    });
    const result = await pgRes.json().catch(() => ({}));
    res.json(result);
  } catch (err) {
    console.error('status', err);
    res.status(500).json({ success: false, message: 'Erro interno' });
  }
});

// ===== Webhook PixGo =====
app.post('/webhook/pixgo', async (req, res) => {
  try {
    const timestamp = req.headers['x-webhook-timestamp'];
    const signature = req.headers['x-webhook-signature'];
    const payload = req.body?.toString('utf8') || '';
    if (!timestamp || !signature || !payload) {
      return res.status(400).json({ error: 'Headers ausentes' });
    }

    const expected = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(`${timestamp}.${payload}`)
      .digest('hex');

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(signature), 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Assinatura inválida' });
    }

    // Replay protection 5 min
    const skew = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
    if (!Number.isFinite(skew) || skew > 300) {
      return res.status(401).json({ error: 'Timestamp inválido' });
    }

    const event = JSON.parse(payload);
    // Idempotência: ignorar se já processado
    if (event?.id) {
      const { data: dup } = await adminDb.from('webhook_events').select('id').eq('id', event.id).maybeSingle();
      if (dup) return res.json({ success: true, duplicated: true });
      await adminDb.from('webhook_events').insert({ id: event.id, type: event.event });
    }

    switch (event.event) {
      case 'payment.completed': await handleCompleted(event.data); break;
      case 'payment.expired':   await updateStatus(event.data.payment_id, 'expired'); break;
      case 'payment.refunded':  await updateStatus(event.data.payment_id, 'refunded'); break;
      default: console.log('Evento ignorado:', event.event);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('webhook', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

async function updateStatus(paymentId, status) {
  await adminDb.from('orders').update({ status, updated_at: new Date().toISOString() }).eq('payment_id', paymentId);
}

async function handleCompleted(paymentData) {
  const { payment_id } = paymentData;
  const { data: order, error } = await adminDb
    .from('orders').select('*, profiles:user_id(email, full_name)')
    .eq('payment_id', payment_id).single();
  if (error || !order) { console.error('order not found', error); return; }
  if (order.status === 'completed') return; // idempotente

  await adminDb.from('orders').update({
    status: 'completed', completed_at: new Date().toISOString(),
  }).eq('id', order.id);

  await adminDb.from('messages').insert({
    user_id: order.user_id,
    order_id: order.id,
    message_type: 'product_delivery',
    content: `Seu acesso ao ${order.product_name} foi liberado! Acesse: ${order.product_url}`,
  });

  if (transporter) {
    try {
      await transporter.sendMail({
        from: GMAIL_USER,
        to: order.profiles?.email,
        subject: 'Seu acesso foi liberado!',
        html: `
          <h2>Bem-vindo ao ${order.product_name}!</h2>
          <p>Olá ${order.profiles?.full_name || ''},</p>
          <p>Seu pagamento foi confirmado. Clique para acessar:</p>
          <p><a href="${order.product_url}" style="background:#32bcad;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;">ACESSAR</a></p>
        `,
      });
    } catch (e) { console.error('mail', e); }
  }
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));
