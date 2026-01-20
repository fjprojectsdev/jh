// Anti-spam minimalista - 2 regras + strikes (1/3)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STRIKES_FILE = path.join(__dirname, '..', 'strikes.json');

// Cache: userId+chatId -> { textMap: { normalizedText: [timestamps] } }
const messageCache = new Map();
const WINDOW = 10000; // 10 segundos
const MAX_REPEAT = 3;
const STRIKE_EXPIRY = 24 * 60 * 60 * 1000; // 24 horas

// Extrair texto de qualquer tipo de mensagem
export function getText(msg) {
    if (!msg?.message) return '';
    const content = msg.message;
    if (content.conversation) return content.conversation;
    if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
    if (content.imageMessage?.caption) return content.imageMessage.caption;
    if (content.videoMessage?.caption) return content.videoMessage.caption;
    return '';
}

// Normalizar texto
function normalize(text) {
    if (!text || typeof text !== 'string') return '';
    return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Detectar link
function hasLink(text) {
    const pattern = /(https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+\.(com|com\.br|br|net|org|app|io|gg|me)\b)/i;
    return pattern.test(text);
}

// Limpar timestamps antigos
function cleanOld(timestamps, now) {
    return timestamps.filter(t => now - t < WINDOW);
}

// Carregar strikes
function loadStrikes() {
    try {
        return JSON.parse(fs.readFileSync(STRIKES_FILE, 'utf8'));
    } catch {
        return {};
    }
}

// Salvar strikes
function saveStrikes(strikes) {
    fs.writeFileSync(STRIKES_FILE, JSON.stringify(strikes, null, 2));
}

// Obter strikes do usuário
export function getStrikes(chatId, userId) {
    const strikes = loadStrikes();
    const key = `${chatId}:${userId}`;
    const data = strikes[key];

    if (!data) return 0;

    // Verificar expiração (24h)
    const now = Date.now();
    if (now - data.lastViolation > STRIKE_EXPIRY) {
        delete strikes[key];
        saveStrikes(strikes);
        return 0;
    }

    return data.count || 0;
}

// Adicionar strike
export function addStrike(chatId, userId, rule, message) {
    const strikes = loadStrikes();
    const key = `${chatId}:${userId}`;

    if (!strikes[key]) {
        strikes[key] = { count: 0, violations: [] };
    }

    strikes[key].count++;
    strikes[key].lastViolation = Date.now();
    strikes[key].violations.push({
        rule,
        message: message.substring(0, 100),
        timestamp: new Date().toISOString()
    });

    saveStrikes(strikes);
    return strikes[key].count;
}

// Resetar strikes
export function resetStrikes(chatId, userId) {
    const strikes = loadStrikes();
    const key = `${chatId}:${userId}`;
    delete strikes[key];
    saveStrikes(strikes);
}

// Verificar violação
export function checkViolation(messageText, chatId, userId, isAdmin) {
    // Admins são isentos
    if (isAdmin) return { violated: false };

    const now = Date.now();
    const normalized = normalize(messageText);

    // REGRA 2: Anti-link
    if (hasLink(messageText)) {
        console.log(`🚫 LINK bloqueado: ${userId}`);
        return { violated: true, rule: 'LINK' };
    }

    // REGRA 1: Anti-repeat
    if (!normalized) return { violated: false };

    const key = `${chatId}:${userId}`;
    if (!messageCache.has(key)) {
        messageCache.set(key, { textMap: {} });
    }

    const cache = messageCache.get(key);
    if (!cache.textMap[normalized]) {
        cache.textMap[normalized] = [];
    }

    cache.textMap[normalized] = cleanOld(cache.textMap[normalized], now);
    const count = cache.textMap[normalized].length + 1;

    if (count >= MAX_REPEAT) {
        console.log(`🔁 REPEAT bloqueado: ${userId} (${count}x)`);
        delete cache.textMap[normalized];
        return { violated: true, rule: 'REPEAT' };
    }

    cache.textMap[normalized].push(now);
    return { violated: false };
}

// Notificar admins
export async function notifyAdmins(sock, chatId, userId, rule, strikeCount, messageText, error = null) {
    try {
        const userNumber = userId.split('@')[0];
        const ruleText = rule === 'REPEAT' ? 'Repetição de mensagens' : 'Envio de link não autorizado';

        console.log(`🚨 Anti-Spam Notification (SILENCED)
User: ${userNumber}
Regra: ${ruleText}
Strikes: ${strikeCount}/3
Error: ${error || 'None'}`);

        // Notificação via DM desativada para evitar spam aos admins
        /* 
        const groupMetadata = await sock.groupMetadata(chatId);
        const admins = groupMetadata.participants.filter(p => p.admin).map(p => p.id);

        let adminMessage = `🚨 Anti-Spam\n\nUsuário: ${userNumber}\nRegra: ${ruleText}\nMensagem: "${messageText.substring(0, 50)}..."\nStrikes: ${strikeCount}/3`;

        if (error) adminMessage += `\n\n⚠️ ${error}`;
        
        for (const adminId of admins) {
            await sock.sendMessage(adminId, { text: adminMessage });
        }
        */
    } catch (error) {
        console.error('Erro ao registrar notificação de spam:', error);
    }
}

// Aplicar punição
export async function applyPunishment(sock, chatId, userId, strikeCount) {
    const userNumber = userId.split('@')[0];

    if (strikeCount === 3) {
        // Tentar banir
        try {
            await sock.groupParticipantsUpdate(chatId, [userId], 'remove');
            await sock.sendMessage(chatId, {
                text: `🚫 @${userNumber} foi removido após atingir 3/3 strikes.`,
                mentions: [userId]
            });
            resetStrikes(chatId, userId);
            console.log(`✅ Usuário ${userNumber} banido (3/3 strikes)`);
        } catch (error) {
            console.error(`❌ Erro ao banir ${userNumber}:`, error.message);
            await notifyAdmins(sock, chatId, userId, 'BAN_FAILED', strikeCount, '',
                `Usuário atingiu 3/3 strikes, mas não tenho permissão para remover.`);
        }
    }
}

// Manter compatibilidade com comandos antigos
export function addBannedWord(word) {
    return { success: false, message: 'Sistema de palavras banidas desabilitado.' };
}

export function removeBannedWord(word) {
    return { success: false, message: 'Sistema de palavras banidas desabilitado.' };
}

export function listBannedWords() {
    return [];
}
