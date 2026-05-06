// Sistema de Atendimento Automático
// O bot pode ser usado em grupos OU como bot personalizado para qualquer propósito.

const KEYWORDS = [
    'preço', 'preco', 'valor', 'valores', 'quanto custa', 'custo', 'plano', 'planos',
    'contratar', 'contratação', 'contratacao', 'serviço', 'servico', 'serviços', 'servicos',
    'como funciona', 'funciona', 'informações', 'informacoes', 'info',
    'quero contratar', 'tenho interesse', 'interessado', 'orçamento', 'orcamento',
    'quero um bot', 'preciso de um bot', 'bot personalizado', 'bot para'
];

const ATTENDANCE_MESSAGE = `👋 Olá! Obrigado pelo contato!

Posso te ajudar com *dois tipos de solução*:

─────────────────────────
📦 *PLANOS PARA GRUPOS WHATSAPP*

• *1 Grupo* — R$ 100/mês
  Comandos, IA de moderação, anti-link, anti-flood, boas-vindas e suporte.

• *2 Grupos* — R$ 200/mês
  Tudo do plano anterior + moderação IA em até 2 grupos.

• *3 Grupos (MAIS VENDIDO)* ⭐ — R$ 250/mês
  Tudo do plano anterior + até 3 grupos. Melhor custo-benefício!

─────────────────────────
🤖 *BOT PERSONALIZADO*

Criamos bots sob medida para *qualquer finalidade*:
• Atendimento comercial automatizado
• Agendamentos e pedidos
• SAC e suporte ao cliente
• Notificações e alertas
• Integração com sistemas
• E muito mais...

💬 *Preço: a combinar conforme o projeto*
  _(orçamento gratuito, sem compromisso)_

─────────────────────────
📩 *Próximo passo:*
Responda aqui com o que você precisa e o desenvolvedor entrará em contato rapidamente!`;

import { sendSafeMessage } from './messageHandler.js';

// Número do desenvolvedor para notificações (via .env)
const RAW_DEV_PHONE = String(process.env.DEV_PHONE || '').trim().replace(/\D/g, '');
const DEVELOPER_JID = RAW_DEV_PHONE ? `${RAW_DEV_PHONE}@s.whatsapp.net` : null;

export function detectClientInterest(text) {
    const lowerText = String(text || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    return KEYWORDS.some(keyword => lowerText.includes(keyword));
}

export async function sendAttendanceMessage(sock, chatId) {
    try {
        await sendSafeMessage(sock, chatId, { text: ATTENDANCE_MESSAGE });
        console.log(`✅ Mensagem de atendimento enviada para: ${chatId}`);
        return true;
    } catch (error) {
        console.error('❌ Erro ao enviar mensagem de atendimento:', error);
        return false;
    }
}

// Rastrear usuários já atendidos (evitar spam por 24h)
const attendedUsers = new Set();

export function shouldSendAttendance(userId) {
    if (attendedUsers.has(userId)) {
        return false;
    }
    attendedUsers.add(userId);

    // Limpar após 24h
    setTimeout(() => {
        attendedUsers.delete(userId);
    }, 24 * 60 * 60 * 1000);

    return true;
}

// Notificar o desenvolvedor diretamente no PV
export async function notifyDeveloper(sock, clientId, clientNumber, messagePreview = '') {
    if (!DEVELOPER_JID) {
        console.warn('[AUTO-ATENDIMENTO] DEV_PHONE não configurado. Notificação ao desenvolvedor ignorada.');
        return;
    }

    const preview = String(messagePreview || '').slice(0, 280);
    const msg = [
        '🔔 *NOVO CONTATO COMERCIAL!*',
        '',
        `👤 Cliente: ${clientNumber}`,
        `🆔 JID: ${clientId}`,
        preview ? `💬 Mensagem: ${preview}` : '',
        '',
        `⏰ ${new Date().toLocaleString('pt-BR')}`,
        '',
        '⚡ O cliente recebeu a proposta e está aguardando seu contato!'
    ].filter(line => line !== undefined).join('\n');

    try {
        await sendSafeMessage(sock, DEVELOPER_JID, { text: msg });
        console.log(`✅ Desenvolvedor notificado: ${DEVELOPER_JID}`);
    } catch (e) {
        console.error('❌ Erro ao notificar desenvolvedor:', e);
    }
}

// Compatibilidade retroativa — notifica admins genéricos (mantido para não quebrar chamadas existentes)
export async function notifyAttendants(sock, clientId, clientNumber, getAdmins, messagePreview = '') {
    // Notifica o desenvolvedor diretamente
    await notifyDeveloper(sock, clientId, clientNumber, messagePreview);

    // Também notifica a lista de admins, excluindo o próprio dev para não duplicar
    try {
        const admins = await getAdmins();
        const excludedJids = new Set([DEVELOPER_JID].filter(Boolean));
        const excludedPhones = ['225919675449527'];

        for (const admin of admins) {
            try {
                const adminJidRaw = String(admin?.id || admin?.user_id || '').trim();
                if (!adminJidRaw) continue;
                const adminJid = adminJidRaw.includes('@') ? adminJidRaw : `${adminJidRaw}@s.whatsapp.net`;

                if (excludedJids.has(adminJid)) continue;
                if (excludedPhones.some(p => adminJid.includes(p))) continue;

                const notifMsg = [
                    '🔔 *NOVO CONTATO COMERCIAL!*',
                    '',
                    `👤 Cliente: ${clientNumber}`,
                    `🆔 JID: ${clientId}`,
                    '',
                    `⏰ ${new Date().toLocaleString('pt-BR')}`
                ].join('\n');

                await sendSafeMessage(sock, adminJid, { text: notifMsg });
            } catch (e) {
                console.error('Erro ao notificar admin:', e);
            }
        }
    } catch (e) {
        console.warn('[AUTO-ATENDIMENTO] Falha ao carregar admins para notificação:', e?.message || e);
    }
}

// Funções de verificação mantidas por compatibilidade
const verifiedUsers = new Set();

export async function sendVerificationMessage(sock, chatId) {
    try {
        await sendSafeMessage(sock, chatId, {
            text: `👋 Olá! Posso lhe ajudar?\n\n💡 Responda *SIM* se deseja conhecer nossos serviços de automação para WhatsApp ou bots personalizados.`
        });
        return true;
    } catch (error) {
        console.error('❌ Erro ao enviar verificação:', error);
        return false;
    }
}

export function markAsVerified(userId) {
    verifiedUsers.add(userId);
    setTimeout(() => verifiedUsers.delete(userId), 5 * 60 * 1000);
}

export function isVerified(userId) {
    return verifiedUsers.has(userId);
}
