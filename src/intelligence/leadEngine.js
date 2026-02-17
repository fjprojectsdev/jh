import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { Jimp, loadFont } = require('jimp');
const { SANS_16_WHITE, SANS_32_WHITE } = require('@jimp/plugin-print/fonts');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LEAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LEADS_LIMIT = 5000;
const ACTIVITY_WINDOW_MS = 3 * 60 * 1000;
const WORDS_LIMIT = 10;
const MESSAGE_LOG_LIMIT = 12000;
const IMAGE_WIDTH = 1200;
const IMAGE_BG_COLOR = 0x06143bff;
const IMAGE_ACCENT_COLOR = 0x0f2d7bff;
const LEADS_STATE_FILE = path.join(__dirname, '..', '..', 'leads_state.json');
const SAVE_DEBOUNCE_MS = 5000;

const STOP_WORDS = new Set([
    'de', 'do', 'da', 'dos', 'das', 'e', 'em', 'no', 'na', 'nos', 'nas', 'o', 'a', 'os', 'as',
    'um', 'uma', 'uns', 'umas', 'pra', 'pro', 'por', 'para', 'que', 'com', 'sem', 'se', 'eu',
    'voce', 'voces', 'ele', 'ela', 'eles', 'elas', 'me', 'te', 'lhe', 'nossa', 'nosso', 'minha',
    'meu', 'sua', 'seu', 'ta', 'to', 'tava', 'vai', 'vou', 'ja', 'so', 'mais', 'menos', 'muito',
    'pouco', 'isso', 'isto', 'aquele', 'aquela', 'aqui', 'ali', 'la', 'nao', 'sim', 'bom', 'boa',
    'blz', 'ok', 'beleza', 'mano', 'cara'
]);
const CRYPTO_RELEVANT_WORDS = new Set([
    'btc', 'bitcoin', 'eth', 'ethereum', 'sol', 'solana', 'bnb', 'nix', 'snap', 'snappy',
    'token', 'tokens', 'projeto', 'projetos', 'cripto', 'crypto', 'altcoin', 'altcoins',
    'compra', 'comprar', 'vendendo', 'venda', 'buy', 'sell', 'entrada', 'saida',
    'long', 'short', 'pump', 'dump', 'moon', 'hype', 'fomo', 'holder', 'holders',
    'wallet', 'carteira', 'contrato', 'endereco', 'ca', 'liquidez', 'liquidity',
    'dex', 'chart', 'grafico', 'pool', 'staking', 'marketcap', 'volume', 'listagem',
    'preco', 'alvo', 'resistencia', 'suporte', 'pix', 'exchange', 'binance', 'mexc'
]);

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractContentFromMessage(messageContent) {
    if (!messageContent || typeof messageContent !== 'object') {
        return null;
    }

    const wrappers = [
        messageContent.ephemeralMessage,
        messageContent.viewOnceMessage,
        messageContent.viewOnceMessageV2,
        messageContent.viewOnceMessageV2Extension,
        messageContent.documentWithCaptionMessage
    ];

    for (const wrapped of wrappers) {
        if (wrapped && wrapped.message) {
            return extractContentFromMessage(wrapped.message);
        }
    }

    return messageContent;
}

function extractMessageText(message) {
    const content = extractContentFromMessage(message && message.message);
    if (!content) {
        return '';
    }

    const candidates = [
        content.conversation,
        content.extendedTextMessage && content.extendedTextMessage.text,
        content.imageMessage && content.imageMessage.caption,
        content.videoMessage && content.videoMessage.caption,
        content.documentMessage && content.documentMessage.caption,
        content.buttonsResponseMessage && content.buttonsResponseMessage.selectedDisplayText,
        content.listResponseMessage && content.listResponseMessage.title,
        content.templateButtonReplyMessage && content.templateButtonReplyMessage.selectedDisplayText
    ];

    for (const value of candidates) {
        const text = String(value || '').trim();
        if (text) {
            return text;
        }
    }

    return '';
}

function countOccurrencesByRegex(text, regex) {
    const matches = text.match(regex);
    return Array.isArray(matches) ? matches.length : 0;
}

function countEmoji(text, emojiList) {
    let total = 0;
    for (const emoji of emojiList) {
        if (!emoji) {
            continue;
        }
        total += text.split(emoji).length - 1;
    }
    return total;
}

function hasBuyIntent(normalizedText) {
    if (!normalizedText) {
        return false;
    }

    return normalizedText.includes('quero comprar')
        || normalizedText.includes('como comprar')
        || normalizedText.includes('manda contrato');
}

function hasAnyKeyword(normalizedText, keywords) {
    for (const keyword of keywords) {
        if (normalizedText.includes(keyword)) {
            return true;
        }
    }
    return false;
}

function tokenizeWords(text) {
    const normalized = normalizeText(text)
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ');

    return normalized
        .split(/\s+/)
        .map((word) => word.trim())
        .filter((word) => word.length >= 3)
        .filter((word) => !STOP_WORDS.has(word))
        .filter((word) => !/^\d+$/.test(word));
}

export function classifyLead(score) {
    const safeScore = Number(score || 0);
    if (safeScore >= 120) return { icon: '🔥', label: 'QUENTE' };
    if (safeScore >= 60) return { icon: '🟢', label: 'MORNO' };
    return { icon: '⚪', label: 'FRIO' };
}

function classifyInterestType(lead) {
    if (Number(lead.buyIntentHits || 0) > 0) {
        return '🎯 Quer comprar';
    }
    if (Number(lead.speculationHits || 0) > 0) {
        return '📊 Especulando';
    }
    if (Number(lead.hypeEmojis || 0) > 5) {
        return '🐳 Forte comprador';
    }
    return '👀 Curioso';
}

function classifyActivityLevel(messageCountLast3Min) {
    const count = Number(messageCountLast3Min || 0);
    if (count >= 20) return '🚀 Muito ativo';
    if (count >= 10) return '🔥 Ativo';
    if (count >= 5) return '🙂 Normal';
    return '💤 Parado';
}

function formatLastActivity(lastActivity, now = Date.now()) {
    const diffMs = Math.max(0, now - Number(lastActivity || 0));
    const minutes = Math.floor(diffMs / 60000);

    if (minutes < 5) {
        return 'agora mesmo';
    }
    if (minutes < 30) {
        return `${minutes} minutos atrás`;
    }

    const hours = Math.floor(diffMs / 3600000);
    if (hours < 2) {
        return `${Math.max(1, hours)} horas atrás`;
    }

    return 'mais de 2 horas atrás';
}

function truncateLine(value, maxLen = 110) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxLen) {
        return text;
    }
    return `${text.slice(0, maxLen - 1)}…`;
}

async function renderLeadsReportImage(lines) {
    const safeLines = (Array.isArray(lines) ? lines : []).map((line) => truncateLine(line));
    const [titleFont, bodyFont] = await Promise.all([
        loadFont(SANS_32_WHITE),
        loadFont(SANS_16_WHITE)
    ]);

    const padX = 34;
    const padY = 28;
    const bodyLineHeight = Math.max(20, Number(bodyFont?.common?.lineHeight || 18) + 4);
    const titleLineHeight = Math.max(38, Number(titleFont?.common?.lineHeight || 32) + 6);
    const title = safeLines[0] || 'RANKING DE INTERESSADOS';
    const bodyLines = safeLines.slice(1);
    const estimatedHeight = padY * 2 + titleLineHeight + 14 + (bodyLines.length * bodyLineHeight) + 24;
    const height = Math.min(4200, Math.max(420, estimatedHeight));

    const image = new Jimp({ width: IMAGE_WIDTH, height, color: IMAGE_BG_COLOR });

    for (let y = 0; y < height; y += 64) {
        for (let x = 0; x < IMAGE_WIDTH; x += 64) {
            if (((x + y) / 64) % 2 === 0) {
                image.setPixelColor(IMAGE_ACCENT_COLOR, x, y);
            }
        }
    }

    image.print({
        font: titleFont,
        x: padX,
        y: padY,
        text: title,
        maxWidth: IMAGE_WIDTH - (padX * 2)
    });

    let currentY = padY + titleLineHeight + 14;
    for (const line of bodyLines) {
        image.print({
            font: bodyFont,
            x: padX,
            y: currentY,
            text: line,
            maxWidth: IMAGE_WIDTH - (padX * 2)
        });
        currentY += bodyLineHeight;
    }

    return await image.getBuffer('image/png');
}

function jidToDigits(userId) {
    const local = String(userId || '').split('@')[0].split(':')[0];
    return local.replace(/\D/g, '');
}

function formatPhoneWithDdd(userId) {
    const digits = jidToDigits(userId);
    if (!digits) {
        return String(userId || '');
    }

    let national = digits;
    if (national.startsWith('55') && national.length >= 12) {
        national = national.slice(2);
    }

    if (national.length === 11) {
        return `(${national.slice(0, 2)}) ${national.slice(2, 7)}-${national.slice(7)}`;
    }

    if (national.length === 10) {
        return `(${national.slice(0, 2)}) ${national.slice(2, 6)}-${national.slice(6)}`;
    }

    if (digits.startsWith('55') && digits.length >= 12) {
        return `+${digits}`;
    }

    return digits;
}

function resolveLeadDisplayName(message, userId, existingDisplayName = '') {
    const pushName = String(message?.pushName || '').trim();
    if (pushName) {
        return pushName;
    }

    if (existingDisplayName) {
        return existingDisplayName;
    }

    return formatPhoneWithDdd(userId);
}

export class LeadEngine {
    constructor(options = {}) {
        this.monitoredTokens = Array.isArray(options.monitoredTokens) && options.monitoredTokens.length > 0
            ? options.monitoredTokens.map((token) => String(token || '').trim().toUpperCase()).filter(Boolean)
            : ['NIX', 'SNAP'];
        this.trackedEmojis = Array.isArray(options.trackedEmojis) && options.trackedEmojis.length > 0
            ? options.trackedEmojis
            : ['🚀', '🔥', '💎'];
        this.leads = new Map();
        this.messageLog = [];
        this.relevantWords = new Set(CRYPTO_RELEVANT_WORDS);
        for (const token of this.monitoredTokens) {
            this.relevantWords.add(normalizeText(token));
        }
        this.tokenRegexes = new Map(
            this.monitoredTokens.map((token) => [token, new RegExp(`\\b${escapeRegex(token)}\\b`, 'gi')])
        );
        this.pendingSaveTimer = null;
        this.lastSavedAt = 0;
        this.loadState();
    }

    makeLeadKey(userId, groupId) {
        return `${String(userId || '').trim()}::${String(groupId || '').trim()}`;
    }

    cleanupMessageLog(now = Date.now()) {
        const cutoff = now - LEAD_TTL_MS;
        this.messageLog = this.messageLog.filter((item) => Number(item.timestamp || 0) >= cutoff);

        if (this.messageLog.length <= MESSAGE_LOG_LIMIT) {
            return;
        }

        this.messageLog = this.messageLog.slice(this.messageLog.length - MESSAGE_LOG_LIMIT);
    }

    cleanup(now = Date.now()) {
        const cutoff = now - LEAD_TTL_MS;
        for (const [key, lead] of this.leads.entries()) {
            if (!lead || Number(lead.lastActivity || 0) < cutoff) {
                this.leads.delete(key);
            }
        }

        if (this.leads.size > LEADS_LIMIT) {
            const sorted = Array.from(this.leads.entries())
                .sort((a, b) => Number(a[1].lastActivity || 0) - Number(b[1].lastActivity || 0));
            const overflow = this.leads.size - LEADS_LIMIT;
            for (let i = 0; i < overflow; i += 1) {
                this.leads.delete(sorted[i][0]);
            }
        }

        this.cleanupMessageLog(now);
    }

    loadState() {
        try {
            if (!fs.existsSync(LEADS_STATE_FILE)) {
                return;
            }
            const raw = fs.readFileSync(LEADS_STATE_FILE, 'utf8');
            const parsed = raw ? JSON.parse(raw) : {};
            const leadsEntries = Array.isArray(parsed.leadsEntries) ? parsed.leadsEntries : [];
            const messageLog = Array.isArray(parsed.messageLog) ? parsed.messageLog : [];

            this.leads = new Map(leadsEntries.map((entry) => [String(entry[0] || ''), entry[1]]).filter((entry) => entry[0]));
            this.messageLog = messageLog;
            this.cleanup(Date.now());
        } catch (_) {
            this.leads = new Map();
            this.messageLog = [];
        }
    }

    saveStateNow() {
        try {
            this.cleanup(Date.now());
            const payload = {
                updatedAt: new Date().toISOString(),
                leadsEntries: Array.from(this.leads.entries()),
                messageLog: this.messageLog
            };
            fs.writeFileSync(LEADS_STATE_FILE, JSON.stringify(payload), 'utf8');
            this.lastSavedAt = Date.now();
        } catch (_) {
            // noop
        }
    }

    scheduleSave() {
        const now = Date.now();
        if (now - this.lastSavedAt > 30000) {
            this.saveStateNow();
            return;
        }

        if (this.pendingSaveTimer) {
            return;
        }

        this.pendingSaveTimer = setTimeout(() => {
            this.pendingSaveTimer = null;
            this.saveStateNow();
        }, SAVE_DEBOUNCE_MS);
        if (typeof this.pendingSaveTimer.unref === 'function') {
            this.pendingSaveTimer.unref();
        }
    }

    processMessage(message, groupId, groupName, now = Date.now()) {
        const safeGroupId = String(groupId || '').trim();
        if (!safeGroupId) {
            return null;
        }

        const userId = String(message?.key?.participant || message?.key?.remoteJid || '').trim();
        if (!userId || userId.includes('@g.us')) {
            return null;
        }

        const text = extractMessageText(message);
        if (!text) {
            this.cleanup(now);
            return null;
        }

        this.messageLog.push({
            timestamp: now,
            groupId: safeGroupId,
            groupName: String(groupName || safeGroupId),
            text
        });

        const normalized = normalizeText(text);
        const leadKey = this.makeLeadKey(userId, safeGroupId);

        let tokenMentionsCount = 0;
        for (const token of this.monitoredTokens) {
            const regex = this.tokenRegexes.get(token);
            tokenMentionsCount += countOccurrencesByRegex(text, regex);
        }

        const emojiCount = countEmoji(text, this.trackedEmojis);
        const intentBonus = hasBuyIntent(normalized) ? 15 : 0;
        const scoreDelta = 1 + (tokenMentionsCount * 5) + (emojiCount * 3) + intentBonus;

        const current = this.leads.get(leadKey) || {
            userId,
            displayName: resolveLeadDisplayName(message, userId),
            groupId: safeGroupId,
            groupName: String(groupName || safeGroupId),
            score: 0,
            level: classifyLead(0),
            messages: 0,
            tokenMentions: 0,
            hypeEmojis: 0,
            firstSeen: now,
            lastActivity: now,
            buyIntentHits: 0,
            speculationHits: 0,
            recentMessageTimestamps: []
        };

        const buyInterestKeywords = ['comprar', 'como compra', 'como faz', 'pix'];
        const speculationKeywords = ['contrato', 'endereco', 'dex', 'liquidez'];

        const hasBuyInterestKeyword = hasAnyKeyword(normalized, buyInterestKeywords);
        const hasSpeculationKeyword = hasAnyKeyword(normalized, speculationKeywords);

        current.displayName = resolveLeadDisplayName(message, userId, current.displayName);
        current.groupName = String(groupName || current.groupName || safeGroupId);
        current.score += scoreDelta;
        current.messages += 1;
        current.tokenMentions += tokenMentionsCount;
        current.hypeEmojis += emojiCount;
        current.lastActivity = now;
        current.buyIntentHits += hasBuyInterestKeyword ? 1 : 0;
        current.speculationHits += hasSpeculationKeyword ? 1 : 0;

        current.recentMessageTimestamps.push(now);
        current.recentMessageTimestamps = current.recentMessageTimestamps.filter((ts) => now - ts <= ACTIVITY_WINDOW_MS);
        current.level = classifyLead(current.score);

        this.leads.set(leadKey, current);
        this.cleanup(now);
        this.scheduleSave();
        return current;
    }

    getTopLeads(limit = 10, now = Date.now()) {
        this.cleanup(now);
        return Array.from(this.leads.values())
            .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
            .slice(0, Math.max(1, Number(limit) || 10));
    }

    getTopWords(chatId, now = Date.now(), limit = WORDS_LIMIT) {
        this.cleanup(now);
        const isGroupContext = String(chatId || '').endsWith('@g.us');

        const wordCount = new Map();
        for (const item of this.messageLog) {
            if (isGroupContext && item.groupId !== chatId) {
                continue;
            }

            const words = tokenizeWords(item.text);
            for (const word of words) {
                if (!this.relevantWords.has(word)) {
                    continue;
                }
                wordCount.set(word, (wordCount.get(word) || 0) + 1);
            }
        }

        return Array.from(wordCount.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, Math.max(1, Number(limit) || WORDS_LIMIT));
    }

    async handleLeadsCommand(sock, chatId) {
        const now = Date.now();
        const allLeads = this.getTopLeads(LEADS_LIMIT, now);
        const topLeads = allLeads.slice(0, 10);

        if (topLeads.length === 0) {
            await sock.sendMessage(chatId, { text: '📊 Nenhum lead detectado ainda.' });
            return;
        }

        const summary = {
            quentes: 0,
            mornos: 0,
            frios: 0
        };

        for (const lead of allLeads) {
            const level = lead.level && lead.level.label ? lead.level : classifyLead(lead.score);
            if (level.label === 'QUENTE') summary.quentes += 1;
            else if (level.label === 'MORNO') summary.mornos += 1;
            else summary.frios += 1;
        }

        const topWords = this.getTopWords(chatId, now, WORDS_LIMIT);

        const lines = [
            '📊 RANKING DE INTERESSADOS (IMAVY)',
            '',
            '📈 Resumo Geral:',
            `🔥 Quentes: ${summary.quentes}`,
            `🟢 Mornos: ${summary.mornos}`,
            `⚪ Frios: ${summary.frios}`,
            ''
        ];

        if (topWords.length > 0) {
            lines.push('📝 Palavras mais faladas:');
            topWords.forEach(([word, count], idx) => {
                lines.push(`${idx + 1}. ${word} (${count}x)`);
            });
            lines.push('');
        }

        for (let i = 0; i < topLeads.length; i += 1) {
            const lead = topLeads[i];
            const level = lead.level && lead.level.label ? lead.level : classifyLead(lead.score);
            const recentCount = Array.isArray(lead.recentMessageTimestamps)
                ? lead.recentMessageTimestamps.filter((ts) => now - ts <= ACTIVITY_WINDOW_MS).length
                : 0;
            const displayName = String(lead.displayName || '').trim() || formatPhoneWithDdd(lead.userId);

            lines.push(`${level.icon} ${i + 1} – ${level.label}`);
            lines.push(`👤 ${displayName}`);
            lines.push(`${classifyInterestType(lead)}`);
            lines.push(`📈 Pontuação: ${lead.score}`);
            lines.push(`⚡ ${classifyActivityLevel(recentCount)}`);
            lines.push(`💬 Mensagens: ${lead.messages}`);
            lines.push(`🏷 Tokens citados: ${lead.tokenMentions}`);
            lines.push(`🚀 Emojis de hype: ${lead.hypeEmojis}`);
            lines.push(`⏱ Falou: ${formatLastActivity(lead.lastActivity, now)}`);
            lines.push(`📍 Grupo: ${lead.groupName}`);
            lines.push('────────────────────');
        }

        try {
            const imageBuffer = await renderLeadsReportImage(lines);
            await sock.sendMessage(chatId, {
                image: imageBuffer,
                mimetype: 'image/png',
                caption: '📊 Ranking de interessados (IMAVY)'
            });
        } catch (error) {
            await sock.sendMessage(chatId, { text: lines.join('\n') });
        }
    }
}

export function createLeadEngine(options = {}) {
    return new LeadEngine(options);
}
