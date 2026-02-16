const MINUTE_MS = 60_000;
const HISTORY_WINDOW_MS = 3 * MINUTE_MS;
const RATE_WINDOW_MS = 6 * MINUTE_MS;
const DOMINANCE_COOLDOWN_MS = 60_000;

function minuteBucket(timestamp) {
    return Math.floor(timestamp / MINUTE_MS) * MINUTE_MS;
}

function safeUpper(value) {
    return String(value || '').trim().toUpperCase();
}

function countEmoji(text, emojiList) {
    let total = 0;
    for (const emoji of emojiList) {
        if (!emoji) {
            continue;
        }
        const parts = text.split(emoji);
        total += Math.max(0, parts.length - 1);
    }
    return total;
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

function computeAverage(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return 0;
    }
    const sum = values.reduce((acc, value) => acc + Number(value || 0), 0);
    return sum / values.length;
}

export class SocialEngine {
    constructor(options = {}) {
        this.monitoredTokens = Array.isArray(options.monitoredTokens) && options.monitoredTokens.length > 0
            ? options.monitoredTokens.map(safeUpper).filter(Boolean)
            : ['NIX', 'SNAP'];
        this.trackedEmojis = Array.isArray(options.trackedEmojis) && options.trackedEmojis.length > 0
            ? options.trackedEmojis
            : ['🚀', '🔥', '💎'];
        this.groupState = new Map();
        this.tokenRegexes = new Map(
            this.monitoredTokens.map((token) => [token, new RegExp(`\\b${escapeRegex(token)}\\b`, 'gi')])
        );
    }

    processMessage(message, groupJid, now = Date.now()) {
        const groupId = String(groupJid || '').trim();
        if (!groupId) {
            return { socialSpike: null, tokenDominance: null };
        }

        const text = extractMessageText(message);
        if (!text) {
            this.cleanup(groupId, now);
            return { socialSpike: null, tokenDominance: null };
        }

        const state = this.ensureGroupState(groupId);

        const tokenMentions = {};
        let totalTokenMentions = 0;
        for (const token of this.monitoredTokens) {
            const regex = this.tokenRegexes.get(token);
            const matches = regex ? text.match(regex) : null;
            const count = Array.isArray(matches) ? matches.length : 0;
            if (count > 0) {
                tokenMentions[token] = count;
                totalTokenMentions += count;
            }
        }

        const emojiCount = countEmoji(text, this.trackedEmojis);
        state.messages.push({
            timestamp: now,
            tokenMentions,
            totalTokenMentions,
            emojiCount
        });
        if (!state.firstSeenAt) {
            state.firstSeenAt = now;
        }

        const bucket = minuteBucket(now);
        state.minuteBuckets.set(bucket, (state.minuteBuckets.get(bucket) || 0) + 1);
        this.cleanup(groupId, now);

        const currentRate = state.minuteBuckets.get(bucket) || 0;
        const historicalRates = [];
        for (let i = 1; i <= 5; i += 1) {
            historicalRates.push(state.minuteBuckets.get(bucket - (i * MINUTE_MS)) || 0);
        }
        const baselineRate = computeAverage(historicalRates);
        const socialIncrease = baselineRate > 0
            ? ((currentRate - baselineRate) / baselineRate) * 100
            : 0;

        const totals = this.aggregateWindow(state.messages);
        const topToken = this.findTopToken(totals.tokenTotals);

        let socialSpike = null;
        const hasBaselineWindow = now - state.firstSeenAt >= 5 * MINUTE_MS;
        if (hasBaselineWindow && baselineRate > 0 && currentRate > baselineRate * 2 && state.lastSpikeMinute !== bucket) {
            state.lastSpikeMinute = bucket;
            socialSpike = {
                groupJid: groupId,
                messageRate: currentRate,
                baselineRate,
                socialIncrease,
                topToken,
                emojiCount: totals.emojiCount,
                timestamp: now
            };
        }

        let tokenDominance = null;
        if (topToken) {
            const topCount = totals.tokenTotals[topToken] || 0;
            const allCount = Object.values(totals.tokenTotals).reduce((acc, value) => acc + value, 0);
            const others = Math.max(0, allCount - topCount);
            const ratio = others === 0 ? Number.POSITIVE_INFINITY : topCount / others;
            const canEmit = now - state.lastDominanceAt >= DOMINANCE_COOLDOWN_MS || state.lastDominanceToken !== topToken;

            if (canEmit && topCount >= 5 && ratio >= 5) {
                state.lastDominanceAt = now;
                state.lastDominanceToken = topToken;
                tokenDominance = {
                    groupJid: groupId,
                    token: topToken,
                    tokenCount: topCount,
                    othersCount: others,
                    ratio: Number.isFinite(ratio) ? ratio : 999,
                    windowMinutes: 3,
                    timestamp: now
                };
            }
        }

        return { socialSpike, tokenDominance };
    }

    ensureGroupState(groupId) {
        if (!this.groupState.has(groupId)) {
            this.groupState.set(groupId, {
                messages: [],
                minuteBuckets: new Map(),
                firstSeenAt: 0,
                lastSpikeMinute: 0,
                lastDominanceAt: 0,
                lastDominanceToken: ''
            });
        }
        return this.groupState.get(groupId);
    }

    aggregateWindow(messages) {
        const tokenTotals = {};
        let emojiCount = 0;

        for (const item of messages) {
            emojiCount += Number(item.emojiCount || 0);
            for (const [token, count] of Object.entries(item.tokenMentions || {})) {
                tokenTotals[token] = (tokenTotals[token] || 0) + Number(count || 0);
            }
        }

        return { tokenTotals, emojiCount };
    }

    findTopToken(tokenTotals) {
        let topToken = '';
        let topCount = 0;
        for (const token of this.monitoredTokens) {
            const count = Number(tokenTotals[token] || 0);
            if (count > topCount) {
                topCount = count;
                topToken = token;
            }
        }
        return topToken || null;
    }

    cleanup(groupId, now = Date.now()) {
        const state = this.groupState.get(groupId);
        if (!state) {
            return;
        }

        const messageCutoff = now - HISTORY_WINDOW_MS;
        const rateCutoff = now - RATE_WINDOW_MS;

        state.messages = state.messages.filter((entry) => entry.timestamp >= messageCutoff);

        for (const [bucket] of state.minuteBuckets.entries()) {
            if (bucket < rateCutoff) {
                state.minuteBuckets.delete(bucket);
            }
        }

        if (state.messages.length === 0 && state.minuteBuckets.size === 0) {
            this.groupState.delete(groupId);
        }
    }

    cleanupAll(now = Date.now()) {
        for (const groupId of this.groupState.keys()) {
            this.cleanup(groupId, now);
        }
    }
}

export default SocialEngine;
