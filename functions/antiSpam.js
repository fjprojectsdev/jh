import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANNED_FILE = path.join(__dirname, '..', 'banned_words.json');

// Cache de mensagens por usuário
const userMessageCache = new Map(); // chatId+userId -> { times: [], repeatMap: {} }
const SPAM_WINDOW = 10000; // 10 segundos
const MAX_FLOOD = 8; // Máximo de mensagens em 10s
const MAX_REPEAT = 4; // Máximo de mensagens iguais em 10s

function loadBannedWords() {
    try {
        return JSON.parse(fs.readFileSync(BANNED_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function saveBannedWords(words) {
    fs.writeFileSync(BANNED_FILE, JSON.stringify(words, null, 2));
}

// Normalizar texto para comparação
function normalizeText(text) {
    if (!text || typeof text !== 'string') return '';
    return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Limpar timestamps antigos
function cleanOldTimestamps(timestamps, now) {
    return timestamps.filter(t => now - t < SPAM_WINDOW);
}

// Obter cache do usuário
function getUserCache(chatId, userId) {
    const key = `${chatId}:${userId}`;
    if (!userMessageCache.has(key)) {
        userMessageCache.set(key, { times: [], repeatMap: {} });
    }
    return userMessageCache.get(key);
}

// Limpar cache periodicamente
setInterval(() => {
    const now = Date.now();
    for (const [key, cache] of userMessageCache.entries()) {
        cache.times = cleanOldTimestamps(cache.times, now);
        for (const text in cache.repeatMap) {
            cache.repeatMap[text] = cleanOldTimestamps(cache.repeatMap[text], now);
            if (cache.repeatMap[text].length === 0) {
                delete cache.repeatMap[text];
            }
        }
        if (cache.times.length === 0 && Object.keys(cache.repeatMap).length === 0) {
            userMessageCache.delete(key);
        }
    }
}, 30000); // Limpar a cada 30s

export function checkViolation(messageText, chatId, senderId, isAdmin = false) {
    const now = Date.now();
    const normalizedText = normalizeText(messageText);
    const cache = getUserCache(chatId, senderId);
    
    // Limpar timestamps antigos
    cache.times = cleanOldTimestamps(cache.times, now);
    
    const auditLog = {
        chatId,
        userId: senderId,
        isAdmin,
        text: messageText.substring(0, 100),
        timestamp: new Date().toISOString(),
        ruleTriggered: null,
        counts: {},
        actionTaken: 'IGNORE'
    };
    
    // 1. VERIFICAR LINKS (apenas para não-admins)
    if (!isAdmin) {
        const linkPatterns = [
            /https?:\/\/[^\s]+/gi,
            /www\.[^\s]+/gi,
            /[a-z0-9-]+\.(com|net|org|br|io|app|me|link|site|online|store|shop|xyz|top|click|info|co)[^\s]*/gi,
            /wa\.me\/[^\s]+/gi,
            /chat\.whatsapp\.com\/[^\s]+/gi,
            /t\.me\/[^\s]+/gi,
            /instagram\.com\/[^\s]*/gi,
            /facebook\.com\/[^\s]*/gi,
            /twitter\.com\/[^\s]*/gi,
            /tiktok\.com\/[^\s]*/gi
        ];
        
        for (const pattern of linkPatterns) {
            if (pattern.test(messageText)) {
                auditLog.ruleTriggered = 'LINK';
                auditLog.actionTaken = 'DELETE+STRIKE';
                console.log('🚨 AUDIT:', JSON.stringify(auditLog));
                return { violated: true, type: 'link não autorizado', rule: 'LINK' };
            }
        }
    } else {
        // Admin enviou link - permitir mas logar
        const hasLink = /https?:\/\/|www\.|\.(com|net|org|br|io)/i.test(messageText);
        if (hasLink) {
            console.log(`✅ ADMIN link allowed: ${senderId} in ${chatId}`);
        }
    }
    
    // 2. VERIFICAR FLOOD (volume de mensagens)
    if (!isAdmin) {
        const floodCount = cache.times.length + 1; // +1 para a mensagem atual
        auditLog.counts.flood = floodCount;
        
        if (floodCount >= MAX_FLOOD) {
            auditLog.ruleTriggered = 'FLOOD';
            auditLog.actionTaken = 'DELETE+STRIKE';
            console.log('🚨 AUDIT:', JSON.stringify(auditLog));
            return { violated: true, type: 'flood de mensagens', rule: 'FLOOD' };
        }
    }
    
    // 3. VERIFICAR REPEAT (mensagens iguais)
    if (!isAdmin && normalizedText.length > 0) {
        if (!cache.repeatMap[normalizedText]) {
            cache.repeatMap[normalizedText] = [];
        }
        cache.repeatMap[normalizedText] = cleanOldTimestamps(cache.repeatMap[normalizedText], now);
        
        const repeatCount = cache.repeatMap[normalizedText].length + 1; // +1 para a mensagem atual
        auditLog.counts.repeat = repeatCount;
        
        if (repeatCount >= MAX_REPEAT) {
            auditLog.ruleTriggered = 'REPEAT';
            auditLog.actionTaken = 'DELETE+STRIKE';
            console.log('🚨 AUDIT:', JSON.stringify(auditLog));
            return { violated: true, type: 'spam de repetição', rule: 'REPEAT' };
        }
        
        // Adicionar timestamp para repeat
        cache.repeatMap[normalizedText].push(now);
    }
    
    // 4. VERIFICAR TERMOS PROIBIDOS (se houver)
    const bannedWords = loadBannedWords();
    const lowerText = messageText.toLowerCase();
    for (const term of bannedWords) {
        if (lowerText.includes(term.toLowerCase())) {
            auditLog.ruleTriggered = 'BANNED_WORD';
            auditLog.actionTaken = 'DELETE+STRIKE';
            console.log('🚨 AUDIT:', JSON.stringify(auditLog));
            return { violated: true, type: `termo proibido: "${term}"`, rule: 'BANNED_WORD' };
        }
    }
    
    // Adicionar timestamp para flood
    cache.times.push(now);
    
    // Nenhuma violação
    console.log('✅ AUDIT:', JSON.stringify(auditLog));
    return { violated: false };
}

export async function notifyAdmins(sock, groupId, violationData) {
    try {
        const groupMetadata = await sock.groupMetadata(groupId);
        const admins = groupMetadata.participants.filter(p => p.admin).map(p => p.id);
        
        const userNumber = violationData.userId.split('@')[0];
        const dateTime = new Date().toLocaleString('pt-BR');
        
        const adminMessage = `Alerta de Moderação

Usuário: ${userNumber}
Data/Hora: ${dateTime}
Tipo: ${violationData.type || 'Violação detectada'}

Mensagem bloqueada:
${violationData.message}`;
        
        for (const adminId of admins) {
            await sock.sendMessage(adminId, { text: adminMessage });
        }
    } catch (error) {
        console.error('Erro ao notificar admins:', error);
    }
}

export function addBannedWord(word) {
    const words = loadBannedWords();
    const term = word.trim();
    
    if (words.includes(term)) {
        return { success: false, message: `Termo "${term}" já existe na lista.` };
    }
    
    words.push(term);
    saveBannedWords(words);
    return { success: true, message: `Termo "${term}" adicionado com sucesso.` };
}

export function removeBannedWord(word) {
    const words = loadBannedWords();
    const term = word.trim();
    const index = words.indexOf(term);
    
    if (index === -1) {
        return { success: false, message: `Termo "${term}" não encontrado.` };
    }
    
    words.splice(index, 1);
    saveBannedWords(words);
    return { success: true, message: `Termo "${term}" removido com sucesso.` };
}

export function listBannedWords() {
    return loadBannedWords();
}