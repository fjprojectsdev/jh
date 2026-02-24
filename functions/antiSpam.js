// Anti-spam minimalista - 2 regras + strikes (1/3)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendSafeMessage } from './messageHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STRIKES_FILE = path.join(__dirname, '..', 'strikes.json');
const GROUP_RULES_FILE = path.join(__dirname, '..', 'group_rules_cache.json');

// Cache: userId+chatId -> { textMap: { normalizedText: [timestamps] }, timeline: [timestamps] }
const messageCache = new Map();
const FLOOD_WINDOW_MS = Number(process.env.FLOOD_WINDOW_MS || 60000);
const MAX_REPEAT = Number(process.env.FLOOD_REPEAT_LIMIT || 3);
const MAX_MESSAGES_PER_WINDOW = Number(process.env.FLOOD_VOLUME_LIMIT || 10);
const STRIKE_EXPIRY = 24 * 60 * 60 * 1000; // 24 horas

const groupRulesCache = loadGroupRulesCache();

const ADULT_TERMS = [
    'porno', 'pornografia', 'onlyfans', 'nude', 'nudes', 'xvideos', 'redtube', 'acompanhante', 'gp', 'sexo'
];

const POLITICS_TERMS = [
    'eleicao', 'eleicoes', 'politica', 'politico', 'presidente', 'deputado', 'senador', 'governo', 'lula', 'bolsonaro'
];

const RELIGION_TERMS = [
    'igreja', 'religiao', 'evangelho', 'pastor', 'jesus', 'deus', 'oracao', 'culto'
];

const VIOLENCE_TERMS = [
    'matar', 'morte', 'arma', 'atirar', 'agredir', 'violencia', 'espancar'
];

function getFirstNonEmptyText(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }
    return '';
}

function extractTextFromContent(content, depth = 0) {
    if (!content || typeof content !== 'object' || depth > 6) return '';

    const directText = getFirstNonEmptyText(
        content.conversation,
        content.extendedTextMessage?.text,
        content.imageMessage?.caption,
        content.videoMessage?.caption,
        content.documentMessage?.caption,
        content.documentWithCaptionMessage?.message?.documentMessage?.caption,
        content.buttonsResponseMessage?.selectedDisplayText,
        content.buttonsResponseMessage?.selectedButtonId,
        content.templateButtonReplyMessage?.selectedDisplayText,
        content.templateButtonReplyMessage?.selectedId,
        content.listResponseMessage?.title,
        content.listResponseMessage?.singleSelectReply?.selectedRowId
    );

    if (directText) return directText;

    const wrappedNodes = [
        content.ephemeralMessage?.message,
        content.viewOnceMessage?.message,
        content.viewOnceMessageV2?.message,
        content.viewOnceMessageV2Extension?.message,
        content.editedMessage?.message,
        content.documentWithCaptionMessage?.message
    ];

    for (const nested of wrappedNodes) {
        const nestedText = extractTextFromContent(nested, depth + 1);
        if (nestedText) return nestedText;
    }

    return '';
}

// Extrair texto de qualquer tipo comum de mensagem
export function getText(msg) {
    if (!msg?.message) return '';
    return extractTextFromContent(msg.message, 0);
}

function normalizeForMatch(text) {
    return String(text || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function loadGroupRulesCache() {
    try {
        if (!fs.existsSync(GROUP_RULES_FILE)) return {};
        const raw = fs.readFileSync(GROUP_RULES_FILE, 'utf8');
        const parsed = raw ? JSON.parse(raw) : {};
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch {
        return {};
    }
}

function saveGroupRulesCache() {
    try {
        fs.writeFileSync(GROUP_RULES_FILE, JSON.stringify(groupRulesCache, null, 2));
    } catch (e) {
        console.warn('Falha ao salvar regras por grupo:', e.message);
    }
}

function extractCustomBlockedTerms(description) {
    const text = String(description || '');
    const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const out = new Set();
    const patterns = [
        /palavras?\s+proibid[^\:]*:\s*(.+)$/i,
        /termos?\s+proibid[^\:]*:\s*(.+)$/i,
        /banid[^\:]*:\s*(.+)$/i
    ];

    for (const line of lines) {
        for (const p of patterns) {
            const m = line.match(p);
            if (!m) continue;
            const tail = String(m[1] || '');
            const parts = tail.split(/[;,|/]/g).map((x) => x.trim()).filter(Boolean);
            for (const part of parts) {
                const cleaned = normalizeForMatch(part).replace(/[^\p{L}\p{N}\s_-]/gu, '').trim();
                if (cleaned.length >= 3 && cleaned.length <= 40) {
                    out.add(cleaned);
                }
            }
        }
    }
    return Array.from(out).slice(0, 50);
}

function deriveGroupPolicy(description) {
    const normalized = normalizeForMatch(description);
    return {
        blockAdult: /(adult|\+18|porn|nude|conteudo adulto|conteudo inadequado)/i.test(normalized),
        blockPolitics: /(politic|eleic|partid|governo|presidente|deputad|senador)/i.test(normalized),
        blockReligion: /(relig|igreja|pastor|evangelho|culto|oracao|deus|jesus)/i.test(normalized),
        blockViolence: /(violen|arma|agress|matar|morte|crime)/i.test(normalized),
        customBlockedTerms: extractCustomBlockedTerms(description)
    };
}

function containsAnyTerm(normalizedMessage, terms) {
    for (const term of terms) {
        const t = normalizeForMatch(term).trim();
        if (!t) continue;
        if (normalizedMessage.includes(t)) {
            return t;
        }
    }
    return null;
}

function checkDescriptionRules(messageText, chatId) {
    const rules = groupRulesCache[String(chatId || '')];
    if (!rules || !rules.policy) return { violated: false };

    const normalized = normalizeForMatch(messageText);
    const policy = rules.policy;

    if (policy.blockAdult) {
        const hit = containsAnyTerm(normalized, ADULT_TERMS);
        if (hit) return { violated: true, rule: 'DESC_ADULT', detail: hit };
    }
    if (policy.blockPolitics) {
        const hit = containsAnyTerm(normalized, POLITICS_TERMS);
        if (hit) return { violated: true, rule: 'DESC_POLITICS', detail: hit };
    }
    if (policy.blockReligion) {
        const hit = containsAnyTerm(normalized, RELIGION_TERMS);
        if (hit) return { violated: true, rule: 'DESC_RELIGION', detail: hit };
    }
    if (policy.blockViolence) {
        const hit = containsAnyTerm(normalized, VIOLENCE_TERMS);
        if (hit) return { violated: true, rule: 'DESC_VIOLENCE', detail: hit };
    }
    if (Array.isArray(policy.customBlockedTerms) && policy.customBlockedTerms.length > 0) {
        const hit = containsAnyTerm(normalized, policy.customBlockedTerms);
        if (hit) return { violated: true, rule: 'DESC_TERM', detail: hit };
    }

    return { violated: false };
}

export function syncGroupRules(chatId, groupName, description) {
    const safeChatId = String(chatId || '').trim();
    if (!safeChatId) return;

    const safeName = String(groupName || '').trim();
    const safeDescription = String(description || '').trim();
    const existing = groupRulesCache[safeChatId];
    const currentHash = `${safeName}::${safeDescription}`;

    if (existing && existing.hash === currentHash) {
        return;
    }

    const policy = deriveGroupPolicy(safeDescription);
    groupRulesCache[safeChatId] = {
        groupId: safeChatId,
        groupName: safeName,
        description: safeDescription,
        policy,
        hash: currentHash,
        updatedAt: new Date().toISOString()
    };
    saveGroupRulesCache();
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
    return timestamps.filter((t) => now - t < FLOOD_WINDOW_MS);
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
    // Admins sao isentos
    if (isAdmin) return { violated: false };

    const now = Date.now();
    const normalized = normalize(messageText);

    // REGRA 1: Anti-link
    if (hasLink(messageText)) {
        console.log(`LINK bloqueado: ${userId}`);
        return { violated: true, rule: 'LINK' };
    }

    if (!normalized) return { violated: false };

    const key = `${chatId}:${userId}`;
    if (!messageCache.has(key)) {
        messageCache.set(key, { textMap: {}, timeline: [] });
    }

    const cache = messageCache.get(key);
    cache.timeline = cleanOld(cache.timeline || [], now);
    cache.timeline.push(now);

    if (cache.timeline.length >= MAX_MESSAGES_PER_WINDOW) {
        console.log(`FLOOD VOLUME bloqueado: ${userId} (${cache.timeline.length} msgs/${Math.round(FLOOD_WINDOW_MS / 1000)}s)`);
        cache.timeline = [];
        cache.textMap = {};
        return { violated: true, rule: 'FLOOD_VOLUME' };
    }

    if (!cache.textMap[normalized]) {
        cache.textMap[normalized] = [];
    }

    cache.textMap[normalized] = cleanOld(cache.textMap[normalized], now);
    const count = cache.textMap[normalized].length + 1;

    if (count >= MAX_REPEAT) {
        console.log(`FLOOD REPEAT bloqueado: ${userId} (${count}x/${Math.round(FLOOD_WINDOW_MS / 1000)}s)`);
        delete cache.textMap[normalized];
        return { violated: true, rule: 'FLOOD_REPEAT' };
    }

    cache.textMap[normalized].push(now);

    // REGRA 3: regras da descricao por grupo
    const descViolation = checkDescriptionRules(messageText, chatId);
    if (descViolation.violated) {
        console.log(`DESC RULE bloqueado: ${userId} (${descViolation.rule}${descViolation.detail ? `:${descViolation.detail}` : ''})`);
        return descViolation;
    }

    return { violated: false };
}
// Notificar admins
export async function notifyAdmins(sock, chatId, userId, rule, strikeCount, messageText, error = null) {
    try {
        const userNumber = userId.split('@')[0];
        const ruleMap = {
            LINK: 'Envio de link nao autorizado',
            FLOOD_REPEAT: 'Flood de mensagens repetidas (3 iguais em 1 minuto)',
            FLOOD_VOLUME: 'Flood por volume (10 mensagens em 1 minuto)',
            DESC_ADULT: 'Conteudo adulto bloqueado pelas regras da descricao',
            DESC_POLITICS: 'Conteudo politico bloqueado pelas regras da descricao',
            DESC_RELIGION: 'Conteudo religioso bloqueado pelas regras da descricao',
            DESC_VIOLENCE: 'Conteudo violento bloqueado pelas regras da descricao',
            DESC_TERM: 'Termo bloqueado pelas regras da descricao'
        };
        const ruleText = ruleMap[rule] || `Regra: ${rule}`;

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
            await sendSafeMessage(sock, chatId, {
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
