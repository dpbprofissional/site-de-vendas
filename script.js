// Configurações
const SUPABASE_URL = 'https://geyrjgmjthefoueguhod.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_jCq-TLBHXJJsvhY5GnJryQ_1PwOfjhT';
const API_KEY = 'pk_9ebc2433e6c3dee8cc738ba349958e869382b167d9e7d56fab72a5fdb4cf4d51';
const BASE_URL = 'https://pixgo.org/api/v1';
const PRODUCT_URL = 'https://creditodecelular.com/recargas';

// Inicializar Supabase
const { createClient } = window.supabase;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let paymentId = null;
let checkInterval = null;

// Verificar autenticação ao carregar
window.addEventListener('load', async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
        currentUser = session.user;
        showProductSection();
    }
});

// ============ AUTENTICAÇÃO ============

async function handleRegister() {
    const name = document.getElementById('register_name').value;
    const email = document.getElementById('register_email').value;
    const cpf = document.getElementById('register_cpf').value.replace(/\D/g, '');
    const password = document.getElementById('register_password').value;

    if (!name || !email || !cpf || !password) {
        alert('Por favor, preencha todos os campos.');
        return;
    }

    try {
        // Registrar no Supabase Auth
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email,
            password
        });

        if (authError) {
            alert('Erro ao criar conta: ' + authError.message);
            return;
        }

        // Salvar dados do usuário na tabela users
        const { error: dbError } = await supabase
            .from('users')
            .insert([{
                id: authData.user.id,
                email,
                full_name: name,
                cpf,
                password_hash: 'managed_by_supabase'
            }]);

        if (dbError) {
            alert('Erro ao salvar dados: ' + dbError.message);
            return;
        }

        alert('Conta criada com sucesso! Verifique seu e-mail para confirmar.');
        // Limpar formulário
        document.getElementById('register_name').value = '';
        document.getElementById('register_email').value = '';
        document.getElementById('register_cpf').value = '';
        document.getElementById('register_password').value = '';
    } catch (error) {
        console.error('Erro:', error);
        alert('Erro ao criar conta.');
    }
}

async function handleLogin() {
    const email = document.getElementById('login_email').value;
    const password = document.getElementById('login_password').value;

    if (!email || !password) {
        alert('Por favor, preencha e-mail e senha.');
        return;
    }

    try {
        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        if (error) {
            alert('Erro ao fazer login: ' + error.message);
            return;
        }

        currentUser = data.user;
        showProductSection();
    } catch (error) {
        console.error('Erro:', error);
        alert('Erro ao fazer login.');
    }
}

async function logout() {
    await supabase.auth.signOut();
    currentUser = null;
    document.getElementById('auth-section').classList.remove('hidden');
    document.getElementById('product-section').classList.add('hidden');
    document.getElementById('user-info').classList.add('hidden');
}

function showProductSection() {
    document.getElementById('auth-section').classList.add('hidden');
    document.getElementById('product-section').classList.remove('hidden');
    document.getElementById('user-info').classList.remove('hidden');
    document.getElementById('user-email').textContent = currentUser.email;
}

// ============ PAGAMENTO PIX ============

async function generatePix() {
    if (!currentUser) {
        alert('Você precisa estar logado para fazer uma compra.');
        return;
    }

    const phone = document.getElementById('customer_phone').value;

    if (!phone) {
        alert('Por favor, preencha o telefone.');
        return;
    }

    // UI Feedback
    const btn = document.getElementById('btn-pay');
    const btnText = document.getElementById('btn-text');
    const btnLoader = document.getElementById('btn-loader');
    
    btn.disabled = true;
    btnText.innerText = 'GERANDO...';
    btnLoader.classList.remove('hidden');

    try {
        const externalId = 'PEDIDO_' + Date.now();

        // Criar cobrança no PixGo
        const response = await fetch(`${BASE_URL}/payment/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': API_KEY
            },
            body: JSON.stringify({
                amount: 47.00,
                description: 'Painel de Recargas',
                customer_name: currentUser.user_metadata?.full_name || currentUser.email,
                customer_email: currentUser.email,
                customer_phone: phone,
                external_id: externalId
            })
        });

        const result = await response.json();

        if (result.success) {
            paymentId = result.data.payment_id;

            // Salvar pedido no banco de dados
            const { error: dbError } = await supabase
                .from('orders')
                .insert([{
                    user_id: currentUser.id,
                    payment_id: paymentId,
                    external_id: externalId,
                    amount: 47.00,
                    status: 'pending',
                    product_name: 'Painel de Recargas',
                    product_url: PRODUCT_URL,
                    payment_method: 'pix'
                }]);

            if (dbError) {
                console.error('Erro ao salvar pedido:', dbError);
            }

            displayPix(result.data);
            startPaymentCheck();
        } else {
            alert('Erro ao gerar PIX: ' + (result.message || result.error));
            resetButton();
        }
    } catch (error) {
        console.error('Erro:', error);
        alert('Erro de conexão com o servidor.');
        resetButton();
    }
}

function displayPix(data) {
    document.getElementById('checkout-form').classList.add('hidden');
    document.getElementById('pix-display').classList.remove('hidden');
    
    const qrContainer = document.getElementById('qr-code-container');
    qrContainer.innerHTML = `<img src="${data.qr_image_url}" alt="QR Code PIX">`;
    
    document.getElementById('pix-code').value = data.qr_code;
}

function copyPixCode() {
    const pixCode = document.getElementById('pix-code');
    pixCode.select();
    document.execCommand('copy');
    alert('Código PIX copiado!');
}

function startPaymentCheck() {
    // Verifica o status a cada 5 segundos
    checkInterval = setInterval(async () => {
        try {
            const response = await fetch(`${BASE_URL}/payment/${paymentId}/status`, {
                method: 'GET',
                headers: {
                    'X-API-Key': API_KEY
                }
            });

            const result = await response.json();

            if (result.success && result.data.status === 'completed') {
                clearInterval(checkInterval);
                
                // Atualizar status do pedido no banco de dados
                await supabase
                    .from('orders')
                    .update({ status: 'completed', completed_at: new Date() })
                    .eq('payment_id', paymentId);

                // Criar mensagem interna
                const { data: orderData } = await supabase
                    .from('orders')
                    .select('id')
                    .eq('payment_id', paymentId)
                    .single();

                if (orderData) {
                    await supabase
                        .from('messages')
                        .insert([{
                            user_id: currentUser.id,
                            order_id: orderData.id,
                            message_type: 'product_delivery',
                            content: `Seu acesso ao Painel de Recargas foi liberado! Clique no botão abaixo para acessar: ${PRODUCT_URL}`
                        }]);
                }

                // Enviar e-mail (simulado - em produção usar um serviço de e-mail)
                console.log('E-mail enviado para:', currentUser.email);
                console.log('Conteúdo: Seu acesso foi liberado! Acesse:', PRODUCT_URL);

                showSuccess();
            }
        } catch (error) {
            console.error('Erro ao verificar status:', error);
        }
    }, 5000);
}

function showSuccess() {
    document.getElementById('pix-display').classList.add('hidden');
    document.getElementById('payment-success').classList.remove('hidden');
}

function resetButton() {
    const btn = document.getElementById('btn-pay');
    const btnText = document.getElementById('btn-text');
    const btnLoader = document.getElementById('btn-loader');
    
    btn.disabled = false;
    btnText.innerText = 'PAGAR COM PIX';
    btnLoader.classList.add('hidden');
}
