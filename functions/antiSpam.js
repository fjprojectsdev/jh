import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANNED_FILE = path.join(__dirname, '..', 'banned_words.json');

// Cache de mensagens recentes por usuário
const messageCache = new Map();
const SPAM_WINDOW = 10000; // 10 segundos
const MAX_REPEATED = 2; // Máximo de mensagens iguais

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

export function checkViolation(text, senderId, isAdmin = false) {
    const bannedWords = loadBannedWords();
    
    // 1. VERIFICAR LINKS (apenas para não-admins)
    if (!isAdmin) {
        const linkPatterns = [
            /https?:\/\/[^\s]+/gi,
            /www\.[^\s]+/gi,
            /[a-z0-9-]+\.(com|net|org|br|io|app|me|link|site|online|store|shop|xyz|top|click)[^\s]*/gi,
            /wa\.me\/[^\s]+/gi,
            /chat\.whatsapp\.com\/[^\s]+/gi,
            /t\.me\/[^\s]+/gi
        ];
        
        for (const pattern of linkPatterns) {
            if (pattern.test(text)) {
                return { violated: true, type: 'link não autorizado' };
            }
        }
    }
    
    // 2. VERIFICAR SPAM DE REPETIÇÃO (apenas para não-admins)
    if (!isAdmin && senderId) {
        const now = Date.now();
        
        if (!messageCache.has(senderId)) {
            messageCache.set(senderId, []);
        }
        
        const userMessages = messageCache.get(senderId);
        
        // Limpar mensagens antigas
        const recentMessages = userMessages.filter(msg => now - msg.timestamp < SPAM_WINDOW);
        
        // Contar mensagens idênticas
        const sameMessages = recentMessages.filter(msg => msg.text === text);
        
        if (sameMessages.length >= MAX_REPEATED) {
            return { violated: true, type: 'spam de repetição' };
        }
        
        // Adicionar mensagem atual
        recentMessages.push({ text, timestamp: now });
        messageCache.set(senderId, recentMessages);
        
        // Limpar cache periodicamente
        if (messageCache.size > 1000) {
            const oldestAllowed = now - SPAM_WINDOW;
            for (const [userId, messages] of messageCache.entries()) {
                const filtered = messages.filter(msg => msg.timestamp > oldestAllowed);
                if (filtered.length === 0) {
                    messageCache.delete(userId);
                } else {
                    messageCache.set(userId, filtered);
                }
            }
        }
    }
    
    // 3. VERIFICAR TERMOS PROIBIDOS (se houver)
    const lowerText = text.toLowerCase();
    for (const term of bannedWords) {
        if (lowerText.includes(term.toLowerCase())) {
            return { violated: true, type: `termo proibido: "${term}"` };
        }
    }
    
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