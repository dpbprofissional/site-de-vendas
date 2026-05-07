// Backend para gerenciar webhooks do PixGo e enviar e-mails
// Este arquivo deve ser executado em um servidor Node.js

const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// Configurações
const SUPABASE_URL = 'https://geyrjgmjthefoueguhod.supabase.co';
const SUPABASE_SERVICE_KEY = 'sua_service_role_key_aqui'; // Obter do Supabase
const WEBHOOK_SECRET = 'sua_webhook_secret_aqui'; // Obter do painel do PixGo
const PRODUCT_URL = 'https://creditodecelular.com/recargas';

// Inicializar Supabase com Service Role (para operações do servidor)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Configurar Nodemailer (exemplo com Gmail)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'seu_email@gmail.com',
        pass: 'sua_senha_de_app' // Usar senha de app do Gmail
    }
});

// Webhook do PixGo
app.post('/webhook/pixgo', async (req, res) => {
    try {
        // Verificar assinatura do webhook
        const timestamp = req.headers['x-webhook-timestamp'];
        const signature = req.headers['x-webhook-signature'];
        const payload = req.rawBody.toString();

        const signaturePayload = timestamp + '.' + payload;
        const expected = crypto
            .createHmac('sha256', WEBHOOK_SECRET)
            .update(signaturePayload)
            .digest('hex');

        // Comparação timing-safe
        if (!crypto.timingSafeEqual(
            Buffer.from(expected),
            Buffer.from(signature)
        )) {
            console.log('Assinatura inválida');
            return res.status(401).json({ error: 'Assinatura inválida' });
        }

        // Protecção contra replay attack (5 min)
        if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) {
            console.log('Timestamp expirado');
            return res.status(401).json({ error: 'Timestamp expirado' });
        }

        const data = JSON.parse(payload);
        console.log('Webhook recebido:', data.event);

        if (data.event === 'payment.completed') {
            await handlePaymentCompleted(data.data);
        } else if (data.event === 'payment.expired') {
            await handlePaymentExpired(data.data);
        } else if (data.event === 'payment.refunded') {
            await handlePaymentRefunded(data.data);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Erro ao processar webhook:', error);
        res.status(500).json({ error: error.message });
    }
});

// Processar pagamento confirmado
async function handlePaymentCompleted(paymentData) {
    try {
        const { payment_id, external_id, customer } = paymentData;

        // Buscar o pedido no banco de dados
        const { data: order, error: orderError } = await supabase
            .from('orders')
            .select('*, users(email, full_name)')
            .eq('payment_id', payment_id)
            .single();

        if (orderError || !order) {
            console.error('Pedido não encontrado:', orderError);
            return;
        }

        // Atualizar status do pedido
        await supabase
            .from('orders')
            .update({
                status: 'completed',
                completed_at: new Date()
            })
            .eq('id', order.id);

        // Criar mensagem interna
        await supabase
            .from('messages')
            .insert([{
                user_id: order.user_id,
                order_id: order.id,
                message_type: 'product_delivery',
                content: `🎉 Seu acesso ao Painel de Recargas foi liberado!\n\nAcesse agora: ${PRODUCT_URL}\n\nObrigado pela compra!`
            }]);

        // Enviar e-mail
        const mailOptions = {
            from: 'seu_email@gmail.com',
            to: order.users.email,
            subject: '✅ Seu acesso foi liberado!',
            html: `
                <h2>Bem-vindo ao Painel de Recargas!</h2>
                <p>Olá ${order.users.full_name},</p>
                <p>Seu pagamento foi confirmado com sucesso! 🎉</p>
                <p>Seu acesso ao painel de recargas já está ativo.</p>
                <p>
                    <a href="${PRODUCT_URL}" style="background-color: #32bcad; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
                        ACESSAR PAINEL
                    </a>
                </p>
                <p>Qualquer dúvida, entre em contato conosco.</p>
                <p>Obrigado!</p>
            `
        };

        await transporter.sendMail(mailOptions);
        console.log('E-mail enviado para:', order.users.email);

    } catch (error) {
        console.error('Erro ao processar pagamento:', error);
    }
}

// Processar pagamento expirado
async function handlePaymentExpired(paymentData) {
    try {
        const { payment_id } = paymentData;

        await supabase
            .from('orders')
            .update({ status: 'expired' })
            .eq('payment_id', payment_id);

        console.log('Pagamento expirado:', payment_id);
    } catch (error) {
        console.error('Erro ao processar expiração:', error);
    }
}

// Processar reembolso
async function handlePaymentRefunded(paymentData) {
    try {
        const { payment_id } = paymentData;

        await supabase
            .from('orders')
            .update({ status: 'refunded' })
            .eq('payment_id', payment_id);

        console.log('Pagamento reembolsado:', payment_id);
    } catch (error) {
        console.error('Erro ao processar reembolso:', error);
    }
}

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
