// Anti-spam minimalista - 2 regras simples
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANNED_FILE = path.join(__dirname, '..', 'banned_words.json');

// Cache simples: userId+chatId -> { textMap: { normalizedText: [timestamps] } }
const userCache = new Map();
const WINDOW = 10000; // 10 segundos
const MAX_REPEAT = 3; // 3 mensagens iguais

// Extrair texto de qualquer tipo de mensagem
export function getText(msg) {
    if (!msg?.message) return '';
    
    const content = msg.message;
    
    // Texto direto
    if (content.conversation) return content.conversation;
    if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
    
    // Caption de mídia
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
    const patterns = [
        /https?:\/\/\S+/i,
        /www\.\S+/i,
        /\b[a-z0-9-]+\.(com|com\.br|br|net|org|app|io|gg|me)\b/i
    ];
    return patterns.some(p => p.test(text));
}

// Limpar timestamps antigos
function cleanOld(timestamps, now) {
    return timestamps.filter(t => now - t < WINDOW);
}

// Verificar violação
export function checkViolation(messageText, chatId, userId, isAdmin) {
    // Admins são isentos
    if (isAdmin) return { violated: false };
    
    const now = Date.now();
    const normalized = normalize(messageText);
    
    // REGRA 2: Anti-link (apenas não-admins)
    if (!isAdmin && hasLink(messageText)) {
        console.log(`🚫 LINK bloqueado: ${userId} em ${chatId}`);
        return { violated: true, rule: 'LINK' };
    }
    
    // REGRA 1: Anti-repeat (apenas se tiver texto)
    if (!normalized) return { violated: false };
    
    const key = `${chatId}:${userId}`;
    if (!userCache.has(key)) {
        userCache.set(key, { textMap: {} });
    }
    
    const cache = userCache.get(key);
    if (!cache.textMap[normalized]) {
        cache.textMap[normalized] = [];
    }
    
    // Limpar antigos
    cache.textMap[normalized] = cleanOld(cache.textMap[normalized], now);
    
    // Contar repetições (incluindo a atual)
    const count = cache.textMap[normalized].length + 1;
    
    if (count >= MAX_REPEAT) {
        console.log(`🔁 REPEAT bloqueado: ${userId} (${count}x) em ${chatId}`);
        // Limpar cache desse texto para resetar contador
        delete cache.textMap[normalized];
        return { violated: true, rule: 'REPEAT' };
    }
    
    // Adicionar timestamp
    cache.textMap[normalized].push(now);
    
    return { violated: false };
}

// Funções de palavras banidas (manter compatibilidade)
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

export async function notifyAdmins(sock, groupId, userId, rule, strikeCount) {
    try {
        const groupMetadata = await sock.groupMetadata(groupId);
        const admins = groupMetadata.participants.filter(p => p.admin).map(p => p.id);
        
        const userNumber = userId.split('@')[0];
        const ruleText = rule === 'REPEAT' ? 'Repetição de mensagens' : 'Envio de link não autorizado';
        
        const adminMessage = `🚨 Alerta de Moderação

Usuário: ${userNumber}
Regra: ${ruleText}
Strikes: ${strikeCount}/3

${strikeCount === 3 ? '⚠️ Usuário será removido automaticamente.' : ''}`;
        
        for (const adminId of admins) {
            await sock.sendMessage(adminId, { text: adminMessage });
        }
    } catch (error) {
        console.error('Erro ao notificar admins:', error);
    }
}
