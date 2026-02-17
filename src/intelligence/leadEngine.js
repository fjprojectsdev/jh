import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runIntelRadar } from '../../functions/intelRadar.js';

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
const IMAGE_PANEL_COLOR = 0x0a1f55ff;
const IMAGE_ROW_COLOR = 0x0c285fff;
const IMAGE_ROW_ALT_COLOR = 0x0a224fff;
const IMAGE_LEVEL_HIGH_COLOR = 0xd34f2cff;
const IMAGE_LEVEL_MEDIUM_COLOR = 0x1f9d59ff;
const IMAGE_LEVEL_LOW_COLOR = 0x6b7280ff;
const IMAGE_VALUE_COLOR = 0xc78b2cff;
const LEADS_STATE_FILE = path.join(__dirname, '..', '..', 'leads_state.json');
const SAVE_DEBOUNCE_MS = 5000;
const SAVE_INTERVAL_MS = 60000;

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

const leadEngineInstances = new Set();
let persistenceHooksBound = false;

function flushAllLeadEngines() {
    for (const engine of leadEngineInstances) {
        try {
            engine.saveStateNow();
        } catch (_) {
            // noop
        }
    }
}

function bindPersistenceHooks() {
    if (persistenceHooksBound) {
        return;
    }

    persistenceHooksBound = true;
    const events = ['beforeExit', 'exit', 'SIGINT', 'SIGTERM', 'uncaughtException'];
    for (const event of events) {
        process.on(event, () => {
            flushAllLeadEngines();
        });
    }
}

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

function fillRect(image, x, y, width, height, color) {
    const startX = Math.max(0, Math.floor(x));
    const startY = Math.max(0, Math.floor(y));
    const endX = Math.min(image.bitmap.width, Math.floor(x + width));
    const endY = Math.min(image.bitmap.height, Math.floor(y + height));

    for (let iy = startY; iy < endY; iy += 1) {
        for (let ix = startX; ix < endX; ix += 1) {
            image.setPixelColor(color, ix, iy);
        }
    }
}

function getRadarLevel(score) {
    const safeScore = Number(score || 0);
    if (safeScore >= 100) return { label: 'ALTO', icon: '🔥', color: IMAGE_LEVEL_HIGH_COLOR };
    if (safeScore >= 50) return { label: 'MÉDIO', icon: '🟢', color: IMAGE_LEVEL_MEDIUM_COLOR };
    return { label: 'BAIXO', icon: '⚪', color: IMAGE_LEVEL_LOW_COLOR };
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function estimateLeadValue(score) {
    const raw = Number(score || 0) * 6;
    return clamp(Math.round(raw), 50, 1500);
}

function formatUsd(value) {
    const safe = Math.max(0, Number(value || 0));
    return `$${safe.toLocaleString('en-US')}`;
}

function getRankBadge(index) {
    if (index === 0) return '🥇';
    if (index === 1) return '🥈';
    if (index === 2) return '🥉';
    return `#${index + 1}`;
}

function simplifyLeadIdentity(lead) {
    const byName = String(lead?.displayName || '').trim();
    if (byName) {
        return truncateLine(byName, 24);
    }

    const digits = jidToDigits(lead?.userId);
    if (digits) {
        if (digits.length > 11) {
            return `...${digits.slice(-11)}`;
        }
        return formatPhoneWithDdd(digits);
    }

    const localId = String(lead?.userId || '').split('@')[0];
    return truncateLine(localId, 18);
}

function formatRadarDate(now = Date.now()) {
    try {
        return new Date(now).toLocaleString('pt-BR', { hour12: false });
    } catch (_) {
        return new Date(now).toISOString();
    }
}

function buildRadarReport(allLeads, now = Date.now()) {
    const ordered = Array.isArray(allLeads)
        ? [...allLeads].sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
        : [];
    const topLeads = ordered.slice(0, 10);

    const summary = {
        high: 0,
        medium: 0,
        low: 0,
        totalAnalyzed: ordered.length,
        totalPotential: 0
    };

    for (const lead of ordered) {
        const level = getRadarLevel(lead.score);
        if (level.label === 'ALTO') summary.high += 1;
        else if (level.label === 'MÉDIO') summary.medium += 1;
        else summary.low += 1;

        summary.totalPotential += estimateLeadValue(lead.score);
    }

    return {
        now,
        topLeads: topLeads.map((lead, index) => ({
            rankBadge: getRankBadge(index),
            identity: simplifyLeadIdentity(lead),
            level: getRadarLevel(lead.score),
            estimatedValue: estimateLeadValue(lead.score),
            groupName: truncateLine(String(lead.groupName || '-'), 30)
        })),
        summary
    };
}

async function renderCommercialRadarImage(report) {
    const [titleFont, bodyFont] = await Promise.all([
        loadFont(SANS_32_WHITE),
        loadFont(SANS_16_WHITE)
    ]);

    const topCount = Array.isArray(report?.topLeads) ? report.topLeads.length : 0;
    const headerH = 140;
    const summaryH = 170;
    const rowH = 58;
    const tableTop = 340;
    const tableHeaderH = 40;
    const rowsH = Math.max(1, topCount) * rowH;
    const height = tableTop + tableHeaderH + rowsH + 30;
    const image = new Jimp({ width: IMAGE_WIDTH, height, color: IMAGE_BG_COLOR });

    for (let y = 0; y < height; y += 80) {
        for (let x = 0; x < IMAGE_WIDTH; x += 80) {
            if (((x + y) / 80) % 2 === 0) {
                fillRect(image, x, y, 80, 80, IMAGE_ACCENT_COLOR);
            }
        }
    }

    fillRect(image, 24, 20, IMAGE_WIDTH - 48, headerH, IMAGE_PANEL_COLOR);
    fillRect(image, 24, 180, IMAGE_WIDTH - 48, summaryH, IMAGE_PANEL_COLOR);

    const summary = report?.summary || {};
    const summaryCards = [
        { title: '🔥 Interessados Altos', value: summary.high || 0, color: IMAGE_LEVEL_HIGH_COLOR },
        { title: '🟢 Interessados Médios', value: summary.medium || 0, color: IMAGE_LEVEL_MEDIUM_COLOR },
        { title: '⚪ Interessados Baixos', value: summary.low || 0, color: IMAGE_LEVEL_LOW_COLOR },
        { title: '👥 Total analisado', value: summary.totalAnalyzed || 0, color: IMAGE_ACCENT_COLOR },
        { title: '💰 Potencial estimado total', value: formatUsd(summary.totalPotential || 0), color: IMAGE_VALUE_COLOR }
    ];

    const cardGap = 12;
    const cardWidth = Math.floor((IMAGE_WIDTH - 48 - 20 - (cardGap * 4)) / 5);
    const cardY = 214;
    const cardH = 110;

    for (let i = 0; i < summaryCards.length; i += 1) {
        const card = summaryCards[i];
        const cardX = 34 + (i * (cardWidth + cardGap));
        fillRect(image, cardX, cardY, cardWidth, cardH, card.color);
        image.print({
            font: bodyFont,
            x: cardX + 12,
            y: cardY + 14,
            text: card.title,
            maxWidth: cardWidth - 24
        });
        image.print({
            font: titleFont,
            x: cardX + 12,
            y: cardY + 46,
            text: String(card.value),
            maxWidth: cardWidth - 24
        });
    }

    image.print({
        font: titleFont,
        x: 40,
        y: 42,
        text: 'IMAVY RADAR COMERCIAL',
        maxWidth: 700
    });

    image.print({
        font: bodyFont,
        x: 40,
        y: 92,
        text: 'Ranking de Interesse da Comunidade',
        maxWidth: 600
    });

    image.print({
        font: bodyFont,
        x: IMAGE_WIDTH - 300,
        y: 34,
        text: formatRadarDate(report?.now),
        maxWidth: 250
    });

    fillRect(image, 24, tableTop, IMAGE_WIDTH - 48, tableHeaderH, IMAGE_PANEL_COLOR);
    image.print({ font: bodyFont, x: 40, y: tableTop + 10, text: 'Posição', maxWidth: 120 });
    image.print({ font: bodyFont, x: 160, y: tableTop + 10, text: 'Lead', maxWidth: 220 });
    image.print({ font: bodyFont, x: 420, y: tableTop + 10, text: 'Nível', maxWidth: 120 });
    image.print({ font: bodyFont, x: 580, y: tableTop + 10, text: 'Potencial', maxWidth: 180 });
    image.print({ font: bodyFont, x: 800, y: tableTop + 10, text: 'Grupo', maxWidth: 360 });

    const topLeads = Array.isArray(report?.topLeads) ? report.topLeads : [];
    if (topLeads.length === 0) {
        image.print({
            font: bodyFont,
            x: 40,
            y: tableTop + tableHeaderH + 16,
            text: 'Nenhum lead detectado ainda.',
            maxWidth: 500
        });
    } else {
        topLeads.forEach((lead, index) => {
            const rowY = tableTop + tableHeaderH + (index * rowH);
            fillRect(image, 24, rowY, IMAGE_WIDTH - 48, rowH, index % 2 === 0 ? IMAGE_ROW_COLOR : IMAGE_ROW_ALT_COLOR);
            image.print({ font: bodyFont, x: 40, y: rowY + 18, text: lead.rankBadge, maxWidth: 100 });
            image.print({ font: bodyFont, x: 160, y: rowY + 18, text: lead.identity, maxWidth: 240 });
            image.print({ font: bodyFont, x: 420, y: rowY + 18, text: `${lead.level.icon} ${lead.level.label}`, maxWidth: 140 });
            fillRect(image, 580, rowY + 10, 180, 38, IMAGE_VALUE_COLOR);
            image.print({ font: bodyFont, x: 595, y: rowY + 20, text: formatUsd(lead.estimatedValue), maxWidth: 150 });
            image.print({ font: bodyFont, x: 800, y: rowY + 18, text: lead.groupName, maxWidth: 360 });
        });
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
        this.periodicSaveTimer = null;
        this.lastSavedAt = 0;
        this.loadState();
        this.startPeriodicSave();
        leadEngineInstances.add(this);
        bindPersistenceHooks();
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

    startPeriodicSave() {
        if (this.periodicSaveTimer) {
            return;
        }

        this.periodicSaveTimer = setInterval(() => {
            this.saveStateNow();
        }, SAVE_INTERVAL_MS);
        if (typeof this.periodicSaveTimer.unref === 'function') {
            this.periodicSaveTimer.unref();
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
            userId,
            displayName: String(message?.pushName || '').trim(),
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
        const radar = await runIntelRadar({
            messages: this.messageLog,
            chatId,
            now: Date.now()
        });

        if (!radar || (!radar.text && (!radar.images || radar.images.length === 0))) {
            await sock.sendMessage(chatId, { text: '📊 Nenhum dado para gerar o radar.' });
            return;
        }

        if (radar.text) {
            await sock.sendMessage(chatId, { text: radar.text });
        }

        const safeImages = Array.isArray(radar.images) ? radar.images : [];
        for (const imageBuffer of safeImages) {
            await sock.sendMessage(chatId, {
                image: imageBuffer,
                mimetype: 'image/png',
                caption: 'IMAVY RADAR COMERCIAL'
            });
        }
    }
}

export function createLeadEngine(options = {}) {
    return new LeadEngine(options);
}
