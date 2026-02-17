import { listAliases } from './crypto/aliasStore.js';
import { renderIntelRadarImages } from './intelRadarImage.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CACHE_TTL_MS = 20 * 1000;

const COMMON_STOPWORDS = new Set([
    'MAS', 'TEM', 'AGORA', 'ISSO', 'AQUI', 'ALI', 'BORA', 'VAMOS', 'OBRIGADO', 'VALEU',
    'PARA', 'COM', 'SEM', 'PRA', 'POR', 'NOS', 'NAS', 'DE', 'DO', 'DA', 'DOS', 'DAS',
    'THE', 'AND', 'FOR', 'THIS', 'THAT', 'YOU', 'ARE', 'WILL', 'HTTP', 'HTTPS', 'WWW'
]);

const radarCache = new Map();

let aliasCache = { value: {}, updatedAt: 0 };

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function sanitizeToken(rawToken) {
    const token = String(rawToken || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (!token || token.length < 3 || token.length > 12) {
        return '';
    }
    return token;
}

function buildAliasLookup(aliasData = {}) {
    const lookup = new Map();
    const entries = Object.entries(aliasData || {});
    for (const [alias, data] of entries) {
        const aliasKey = sanitizeToken(alias);
        if (!aliasKey) {
            continue;
        }
        const labelSource = data?.label || aliasKey;
        const label = sanitizeToken(labelSource) || aliasKey;
        lookup.set(aliasKey, label);
    }
    return lookup;
}

async function getAliasLookup() {
    const now = Date.now();
    if ((now - aliasCache.updatedAt) < CACHE_TTL_MS && aliasCache.value) {
        return aliasCache.value;
    }

    try {
        const aliases = await listAliases();
        const mapObj = {};
        for (const item of aliases) {
            mapObj[item.alias] = { label: item.label || item.alias };
        }
        aliasCache = { value: mapObj, updatedAt: now };
    } catch (_) {
        aliasCache = { value: {}, updatedAt: now };
    }

    return aliasCache.value;
}

function extractMatchesFromText(text, aliasLookup) {
    const mentions = [];
    const safeText = String(text || '');

    const upperCaseMatches = safeText.match(/\b[A-Z]{3,6}\b/g) || [];
    upperCaseMatches.forEach((token) => mentions.push(token));

    const dollarMatches = safeText.match(/\$[A-Za-z]{2,12}\b/g) || [];
    dollarMatches.forEach((token) => mentions.push(token.slice(1)));

    const normalizedWords = normalizeText(safeText).split(/\s+/);
    normalizedWords.forEach((word) => {
        const key = sanitizeToken(word);
        if (!key) {
            return;
        }
        if (aliasLookup.has(key)) {
            mentions.push(aliasLookup.get(key));
        }
    });

    return mentions;
}

export function extractTokenMentions(messages, options = {}) {
    const now = Number(options.now || Date.now());
    const aliasLookup = options.aliasLookup instanceof Map ? options.aliasLookup : new Map();
    const stopwords = options.stopwords instanceof Set ? options.stopwords : COMMON_STOPWORDS;
    const limit = Number(options.limit || 10);

    const bucket = new Map();
    const safeMessages = Array.isArray(messages) ? messages : [];
    for (const item of safeMessages) {
        const timestamp = Number(item?.timestamp || 0);
        const text = String(item?.text || '');
        if (!text) {
            continue;
        }

        const matches = extractMatchesFromText(text, aliasLookup);
        for (const rawMatch of matches) {
            const token = sanitizeToken(rawMatch);
            if (!token || stopwords.has(token)) {
                continue;
            }

            if (!bucket.has(token)) {
                bucket.set(token, {
                    token,
                    totalMentions: 0,
                    lastHourMentions: 0,
                    previousHourMentions: 0
                });
            }

            const current = bucket.get(token);
            current.totalMentions += 1;

            if (timestamp >= (now - HOUR_MS)) {
                current.lastHourMentions += 1;
            } else if (timestamp >= (now - (2 * HOUR_MS))) {
                current.previousHourMentions += 1;
            }
        }
    }

    const sorted = Array.from(bucket.values())
        .sort((a, b) => b.totalMentions - a.totalMentions);

    return Number.isFinite(limit) && limit > 0 ? sorted.slice(0, limit) : sorted;
}

export function detectHype(tokensData) {
    const safeData = Array.isArray(tokensData) ? tokensData : [];
    const enriched = safeData.map((tokenData) => {
        const total = Number(tokenData.totalMentions || 0);
        const last = Number(tokenData.lastHourMentions || 0);
        const prev = Number(tokenData.previousHourMentions || 0);
        const growthRate = ((last - prev) / Math.max(prev, 1)) * 100;
        const engagementScore = (total * 0.6) + (growthRate * 0.4);

        let status = 'Estavel';
        if (growthRate >= 50) {
            status = 'HYPE FORTE 🔥';
        } else if (growthRate >= 20) {
            status = 'HYPE MODERADO 🚀';
        }

        return {
            ...tokenData,
            growthRate,
            engagementScore,
            status
        };
    }).sort((a, b) => b.engagementScore - a.engagementScore);

    return enriched.filter((item) => item.growthRate >= 20);
}

export function getTopActiveUsers(messages, limit = 10) {
    const safeMessages = Array.isArray(messages) ? messages : [];
    const usersMap = new Map();
    for (const item of safeMessages) {
        const userId = String(item?.userId || '').trim();
        if (!userId) {
            continue;
        }
        const displayName = String(item?.displayName || '').trim();
        const timestamp = Number(item?.timestamp || 0);

        if (!usersMap.has(userId)) {
            usersMap.set(userId, {
                name: displayName || userId,
                totalMessages: 0,
                lastMessageTime: timestamp
            });
        }

        const current = usersMap.get(userId);
        current.totalMessages += 1;
        if (displayName) {
            current.name = displayName;
        }
        if (timestamp > current.lastMessageTime) {
            current.lastMessageTime = timestamp;
        }
    }

    return Array.from(usersMap.values())
        .sort((a, b) => b.totalMessages - a.totalMessages)
        .slice(0, Math.max(1, Number(limit) || 10));
}

export function classifyGroupTemperature(stats) {
    const totalMessages = Number(stats?.totalMessages || 0);
    const activeUsers = Math.max(0, Number(stats?.activeUsers || 0));
    const avgMessagesPerUser = activeUsers > 0 ? totalMessages / activeUsers : 0;

    let level = 'FRIO';
    let label = 'FRIO ❄';
    if (totalMessages > 400) {
        level = 'QUENTE';
        label = 'QUENTE 🔥';
    } else if (totalMessages >= 150) {
        level = 'MORNO';
        label = 'MORNO 🌤';
    }

    return {
        level,
        label,
        totalMessages,
        activeUsers,
        avgMessagesPerUser
    };
}

function buildCacheKey(groupId, messages, now) {
    const safeMessages = Array.isArray(messages) ? messages : [];
    const len = safeMessages.length;
    const lastTimestamp = len > 0 ? Number(safeMessages[len - 1]?.timestamp || 0) : 0;
    const hourBucket = Math.floor(now / 10000);
    return `${groupId}::${len}::${lastTimestamp}::${hourBucket}`;
}

function summarizeText(report) {
    const highlight = report?.highlightToken;
    const topUser = report?.topActiveUsers?.[0];
    const groupStatus = report?.summary?.groupTemperature?.label || 'FRIO ❄';

    if (!highlight) {
        return [
            '📡 IMAVY RADAR DO GRUPO',
            '',
            '🔥 Token em destaque: sem variacao relevante',
            '📈 Crescimento: 0.0%',
            '',
            `🏆 Mais ativo: ${topUser ? `${topUser.name} (${topUser.totalMessages})` : 'sem dados'}`,
            '',
            `🌡 Grupo esta: ${groupStatus}`
        ].join('\n');
    }

    return [
        '📡 IMAVY RADAR DO GRUPO',
        '',
        `🔥 Token em destaque: ${highlight.token}`,
        `📈 Crescimento: ${highlight.growthRate.toFixed(1)}%`,
        '',
        `🏆 Mais ativo: ${topUser ? `${topUser.name} (${topUser.totalMessages})` : 'sem dados'}`,
        '',
        `🌡 Grupo esta: ${groupStatus}`
    ].join('\n');
}

export async function runIntelRadar({ messages, chatId, now = Date.now() }) {
    const safeMessages = Array.isArray(messages) ? messages : [];
    const groupMessages = String(chatId || '').endsWith('@g.us')
        ? safeMessages.filter((item) => item.groupId === chatId)
        : safeMessages;
    const last24h = groupMessages.filter((item) => Number(item.timestamp || 0) >= (now - DAY_MS));

    if (last24h.length === 0) {
        return {
            text: '📊 Nenhum dado recente para gerar o radar.',
            images: []
        };
    }

    const cacheKey = buildCacheKey(String(chatId || 'private'), last24h, now);
    const cached = radarCache.get(cacheKey);
    if (cached && (now - cached.createdAt) < CACHE_TTL_MS) {
        return cached.payload;
    }

    const aliasLookup = buildAliasLookup(await getAliasLookup());
    const tokenMentions = extractTokenMentions(last24h, { now, aliasLookup, limit: Number.POSITIVE_INFINITY });
    const hypeTokens = detectHype(tokenMentions);
    const enrichedTokens = tokenMentions.map((item) => {
        const prev = Math.max(1, Number(item.previousHourMentions || 0));
        const growthRate = ((Number(item.lastHourMentions || 0) - Number(item.previousHourMentions || 0)) / prev) * 100;
        let status = 'Estavel';
        if (growthRate >= 50) status = 'HYPE FORTE 🔥';
        else if (growthRate >= 20) status = 'HYPE MODERADO 🚀';
        return { ...item, growthRate, status };
    });

    const allUsers = getTopActiveUsers(last24h, Number.POSITIVE_INFINITY);
    const topUsers = allUsers.slice(0, 10);
    const summary = classifyGroupTemperature({
        totalMessages: last24h.length,
        activeUsers: allUsers.length
    });

    const report = {
        tokenAnalytics: enrichedTokens,
        hypeTokens,
        topActiveUsers: allUsers,
        summary: {
            totalMessages24h: summary.totalMessages,
            activeUsers: summary.activeUsers,
            avgMessagesPerUser: summary.avgMessagesPerUser,
            groupTemperature: summary
        },
        highlightToken: hypeTokens[0] || enrichedTokens[0] || null,
        generatedAt: now
    };

    const images = await renderIntelRadarImages(report);
    const text = summarizeText({ ...report, topActiveUsers: topUsers });

    const payload = { text, images, report };
    radarCache.set(cacheKey, { createdAt: now, payload });
    if (radarCache.size > 15) {
        const firstKey = radarCache.keys().next().value;
        radarCache.delete(firstKey);
    }

    return payload;
}
