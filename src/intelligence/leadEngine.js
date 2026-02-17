const LEAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LEADS_LIMIT = 5000;

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

export function classifyLead(score) {
    const safeScore = Number(score || 0);
    if (safeScore >= 120) return '💎 WHALE';
    if (safeScore >= 80) return '🔥 HOT';
    if (safeScore >= 40) return '🟢 WARM';
    return '⚪ COLD';
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
        this.tokenRegexes = new Map(
            this.monitoredTokens.map((token) => [token, new RegExp(`\\b${escapeRegex(token)}\\b`, 'gi')])
        );
    }

    makeLeadKey(userId, groupId) {
        return `${String(userId || '').trim()}::${String(groupId || '').trim()}`;
    }

    cleanup(now = Date.now()) {
        const cutoff = now - LEAD_TTL_MS;
        for (const [key, lead] of this.leads.entries()) {
            if (!lead || Number(lead.lastActivity || 0) < cutoff) {
                this.leads.delete(key);
            }
        }

        if (this.leads.size <= LEADS_LIMIT) {
            return;
        }

        const sorted = Array.from(this.leads.entries())
            .sort((a, b) => Number(a[1].lastActivity || 0) - Number(b[1].lastActivity || 0));
        const overflow = this.leads.size - LEADS_LIMIT;
        for (let i = 0; i < overflow; i += 1) {
            this.leads.delete(sorted[i][0]);
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
            groupId: safeGroupId,
            groupName: String(groupName || safeGroupId),
            score: 0,
            level: '⚪ COLD',
            messages: 0,
            tokenMentions: 0,
            hypeEmojis: 0,
            firstSeen: now,
            lastActivity: now
        };

        current.groupName = String(groupName || current.groupName || safeGroupId);
        current.score += scoreDelta;
        current.messages += 1;
        current.tokenMentions += tokenMentionsCount;
        current.hypeEmojis += emojiCount;
        current.lastActivity = now;
        current.level = classifyLead(current.score);

        this.leads.set(leadKey, current);
        this.cleanup(now);
        return current;
    }

    getTopLeads(limit = 15, now = Date.now()) {
        this.cleanup(now);
        return Array.from(this.leads.values())
            .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
            .slice(0, Math.max(1, Number(limit) || 15));
    }

    async handleLeadsCommand(sock, chatId) {
        const topLeads = this.getTopLeads(15);
        if (topLeads.length === 0) {
            await sock.sendMessage(chatId, { text: '📊 Nenhum lead detectado ainda.' });
            return;
        }

        const lines = ['📊 *RANKING DE LEADS (IMAVY INTEL)*', ''];
        topLeads.forEach((lead, index) => {
            lines.push(`#${index + 1} ${lead.level}`);
            lines.push(`👤 ${lead.userId}`);
            lines.push(`📈 Score: ${lead.score}`);
            lines.push(`💬 Msgs: ${lead.messages}`);
            lines.push(`🏷 Tokens: ${lead.tokenMentions}`);
            lines.push(`🚀 Emojis: ${lead.hypeEmojis}`);
            lines.push(`📍 Grupo: ${lead.groupName}`);
            lines.push('──────────────');
        });

        await sock.sendMessage(chatId, { text: lines.join('\n') });
    }
}

export function createLeadEngine(options = {}) {
    return new LeadEngine(options);
}

