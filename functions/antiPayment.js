// antiPayment.js - Sistema anti-flood de pagamentos
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAYMENT_BANS_FILE = path.join(__dirname, '..', 'payment_bans.json');

// Whitelist de usuários autorizados a enviar pagamentos
const PAYMENT_WHITELIST = new Set([
    '225919675449527@lid',
    '556993613476@s.whatsapp.net',
    '227349882745008@lid',
    '556493344024@s.whatsapp.net'
]);

// Cache de flood (usuário -> {count, firstTs})
const floodCache = new Map();

function loadBans() {
    try {
        if (fs.existsSync(PAYMENT_BANS_FILE)) {
            return JSON.parse(fs.readFileSync(PAYMENT_BANS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Erro ao carregar bans de pagamento:', e);
    }
    return [];
}

function saveBan(chatId, senderId, reason) {
    try {
        const bans = loadBans();
        bans.push({
            chatId,
            senderId,
            reason,
            timestamp: Date.now(),
            date: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
        });
        fs.writeFileSync(PAYMENT_BANS_FILE, JSON.stringify(bans, null, 2));
    } catch (e) {
        console.error('Erro ao salvar ban:', e);
    }
}

async function isGroupAdmin(sock, chatId, senderId) {
    try {
        const metadata = await sock.groupMetadata(chatId);
        const participant = metadata.participants.find(p => p.id === senderId);
        return participant?.admin === 'admin' || participant?.admin === 'superadmin';
    } catch (e) {
        return false;
    }
}

function isPaymentMessage(message) {
    if (!message) return false;
    
    return !!(
        message.requestPaymentMessage ||
        message.paymentInviteMessage ||
        message.sendPaymentMessage
    );
}

async function banUser(sock, chatId, senderId) {
    try {
        await sock.groupParticipantsUpdate(chatId, [senderId], 'remove');
        saveBan(chatId, senderId, 'PAYMENT_SPAM');
        
        const userNumber = senderId.split('@')[0];
        await sock.sendMessage(chatId, {
            text: `🚫 *USUÁRIO BANIDO*\n\n⚠️ @${userNumber} foi removido por enviar pedido de pagamento não autorizado.\n\n🔒 Essa prática é proibida para evitar golpes.`,
            mentions: [senderId]
        });
        
        console.log(`🚫 Usuário ${senderId} banido por PAYMENT_SPAM no grupo ${chatId}`);
        return true;
    } catch (e) {
        console.error('Erro ao banir usuário:', e);
        return false;
    }
}

export async function handleAntiPayment(sock, message) {
    try {
        const chatId = message.key.remoteJid;
        const senderId = message.key.participant || message.key.remoteJid;
        
        // Só em grupos
        if (!chatId.endsWith('@g.us')) return false;
        
        // Verificar se é mensagem de pagamento
        if (!isPaymentMessage(message.message)) return false;
        
        console.log('💳 PAGAMENTO DETECTADO:', senderId);
        
        // Whitelist
        if (PAYMENT_WHITELIST.has(senderId)) {
            console.log('✅ Usuário na whitelist, permitido');
            return false;
        }
        
        // Verificar se é admin
        const isAdmin = await isGroupAdmin(sock, chatId, senderId);
        if (isAdmin) {
            console.log('✅ Admin, permitido');
            return false;
        }
        
        // BAN IMEDIATO
        console.log('🚨 BANINDO usuário por pagamento não autorizado');
        await banUser(sock, chatId, senderId);
        
        return true;
    } catch (e) {
        console.error('Erro no anti-payment:', e);
        return false;
    }
}

export function addToPaymentWhitelist(userId) {
    PAYMENT_WHITELIST.add(userId);
    return { success: true, message: `✅ ${userId} adicionado à whitelist de pagamentos` };
}

export function removeFromPaymentWhitelist(userId) {
    PAYMENT_WHITELIST.delete(userId);
    return { success: true, message: `✅ ${userId} removido da whitelist de pagamentos` };
}

export function getPaymentBans() {
    return loadBans();
}
