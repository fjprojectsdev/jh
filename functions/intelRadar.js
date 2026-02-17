import { listAliases } from './crypto/aliasStore.js';
import { renderIntelRadarImages } from './intelRadarImage.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CACHE_TTL_MS = 20 * 1000;

const COMMON_STOPWORDS = new Set([
    'MAS', 'TEM', 'AGORA', 'ISSO', 'AQUI', 'ALI', 'BORA', 'VAMOS', 'OBRIGADO', 'VALEU',
    'PARA', 'COM', 'SEM', 'PRA', 'POR', 'NOS', 'NAS', 'DE', 'DO', 'DA', 'DOS', 'DAS',
    'QUE', 'QUEM', 'COMO', 'QUANDO', 'ONDE', 'ESTA', 'ESTAO', 'FOI', 'SER', 'TER',
    'THE', 'AND', 'FOR', 'THIS', 'THAT', 'YOU', 'ARE', 'WILL', 'HTTP', 'HTTPS', 'WWW'
]);

const TOKEN_BLACKLIST = new Set([
    'COME', 'QUEIMA', 'PIX', 'BORA', 'VAMO', 'HOJE', 'AMANHA', 'ONTEM', 'GALERA', 'POVO'
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

function formatUserFromJid(userId) {
    const digits = String(userId || '').split('@')[0].replace(/\D/g, '');
    if (!digits) return String(userId || '-');

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
    if (digits.startsWith('55')) {
        return `+${digits}`;
    }
    return digits;
}

function sanitizeDisplayName(name, userId) {
    const raw = String(name || '').trim();
    if (!raw) {
        return formatUserFromJid(userId);
    }

    const cleaned = raw.replace(/[^\p{L}\p{N}\s._\-]/gu, '').replace(/\s+/g, ' ').trim();
    const safe = cleaned || raw;
    const questionRatio = (safe.match(/\?/g) || []).length / Math.max(1, safe.length);
    if (questionRatio > 0.2 || safe.length < 2) {
        return formatUserFromJid(userId);
    }

    return safe.slice(0, 28);
}

function buildAliasLookup(aliasData = {}) {
    const lookup = new Map();
    for (const [alias, data] of Object.entries(aliasData || {})) {
        const aliasKey = sanitizeToken(alias);
        if (!aliasKey) continue;
        const label = sanitizeToken(data?.label || aliasKey) || aliasKey;
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
    const matches = [];
    const safeText = String(text || '');

    const uppercase = safeText.match(/\b[A-Z]{3,6}\b/g) || [];
    uppercase.forEach((t) => matches.push(t));

    const dollar = safeText.match(/\$[A-Za-z]{2,12}\b/g) || [];
    dollar.forEach((t) => matches.push(t.slice(1)));

    const normalizedWords = normalizeText(safeText).split(/\s+/);
    normalizedWords.forEach((word) => {
        const key = sanitizeToken(word);
        if (!key) return;
        if (aliasLookup.has(key)) {
            matches.push(aliasLookup.get(key));
        }
    });

    return matches;
}

export function extractTokenMentions(messages, options = {}) {
    const now = Number(options.now || Date.now());
    const aliasLookup = options.aliasLookup instanceof Map ? options.aliasLookup : new Map();
    const stopwords = options.stopwords instanceof Set ? options.stopwords : COMMON_STOPWORDS;
    const limit = Number.isFinite(options.limit) ? Number(options.limit) : 10;

    const bucket = new Map();
    const safeMessages = Array.isArray(messages) ? messages : [];
    for (const item of safeMessages) {
        const timestamp = Number(item?.timestamp || 0);
        const text = String(item?.text || '');
        if (!text) continue;

        const localCount = new Map();
        const matches = extractMatchesFromText(text, aliasLookup);
        for (const rawMatch of matches) {
            const token = sanitizeToken(rawMatch);
            if (!token || stopwords.has(token) || TOKEN_BLACKLIST.has(token)) continue;
            localCount.set(token, (localCount.get(token) || 0) + 1);
        }

        for (const [token, count] of localCount.entries()) {
            if (!bucket.has(token)) {
                bucket.set(token, {
                    token,
                    totalMentions: 0,
                    lastHourMentions: 0,
                    previousHourMentions: 0
                });
            }
            const current = bucket.get(token);
            current.totalMentions += count;

            if (timestamp >= (now - HOUR_MS)) {
                current.lastHourMentions += count;
            } else if (timestamp >= (now - (2 * HOUR_MS))) {
                current.previousHourMentions += count;
            }
        }
    }

    const sorted = Array.from(bucket.values())
        .filter((row) => row.totalMentions >= 2)
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

        let status = 'ESTAVEL';
        if (growthRate >= 50) status = 'HYPE FORTE';
        else if (growthRate >= 20) status = 'HYPE MODERADO';

        return { ...tokenData, growthRate, engagementScore, status };
    }).sort((a, b) => b.engagementScore - a.engagementScore);

    return enriched.filter((item) => item.growthRate >= 20);
}

export function getTopActiveUsers(messages, limit = 10) {
    const usersMap = new Map();
    const safeMessages = Array.isArray(messages) ? messages : [];

    for (const item of safeMessages) {
        const userId = String(item?.userId || '').trim();
        if (!userId) continue;
        const timestamp = Number(item?.timestamp || 0);

        if (!usersMap.has(userId)) {
            usersMap.set(userId, {
                userId,
                name: sanitizeDisplayName(item?.displayName, userId),
                totalMessages: 0,
                lastMessageTime: timestamp
            });
        }

        const current = usersMap.get(userId);
        current.totalMessages += 1;
        current.name = sanitizeDisplayName(item?.displayName, userId);
        if (timestamp > current.lastMessageTime) {
            current.lastMessageTime = timestamp;
        }
    }

    return Array.from(usersMap.values())
        .sort((a, b) => b.totalMessages - a.totalMessages)
        .slice(0, Math.max(1, Number(limit) || 10));
}

export function getTopGroups(messages, limit = 10) {
    const groups = new Map();
    const safeMessages = Array.isArray(messages) ? messages : [];

    for (const item of safeMessages) {
        const groupId = String(item?.groupId || '').trim() || 'sem-grupo';
        const groupName = String(item?.groupName || '').trim() || groupId;
        const userId = String(item?.userId || '').trim();

        if (!groups.has(groupId)) {
            groups.set(groupId, {
                groupId,
                groupName,
                totalMessages: 0,
                activeUsersSet: new Set()
            });
        }

        const row = groups.get(groupId);
        row.totalMessages += 1;
        if (userId) {
            row.activeUsersSet.add(userId);
        }
    }

    return Array.from(groups.values())
        .map((row) => ({
            groupId: row.groupId,
            groupName: row.groupName,
            totalMessages: row.totalMessages,
            activeUsers: row.activeUsersSet.size
        }))
        .sort((a, b) => b.totalMessages - a.totalMessages)
        .slice(0, Math.max(1, Number(limit) || 10));
}

export function classifyGroupTemperature(stats) {
    const totalMessages = Number(stats?.totalMessages || 0);
    const activeUsers = Math.max(0, Number(stats?.activeUsers || 0));
    const avgMessagesPerUser = activeUsers > 0 ? totalMessages / activeUsers : 0;

    let level = 'FRIO';
    let label = 'FRIO';
    if (totalMessages > 400) {
        level = 'QUENTE';
        label = 'QUENTE';
    } else if (totalMessages >= 150) {
        level = 'MORNO';
        label = 'MORNO';
    }

    return { level, label, totalMessages, activeUsers, avgMessagesPerUser };
}

function buildCacheKey(groupId, messages, now) {
    const safe = Array.isArray(messages) ? messages : [];
    const len = safe.length;
    const lastTs = len > 0 ? Number(safe[len - 1]?.timestamp || 0) : 0;
    const bucket = Math.floor(now / 10000);
    return `${groupId}::${len}::${lastTs}::${bucket}`;
}

function summarizeText(report) {
    const highlight = report?.highlightToken;
    const topUser = report?.topActiveUsers?.[0];
    const groupStatus = report?.summary?.groupTemperature?.label || 'FRIO';
    const tokenLabel = highlight ? highlight.token : 'sem variacao relevante';
    const growth = highlight ? `${highlight.growthRate.toFixed(1)}%` : '0.0%';
    const userLine = topUser ? `${topUser.name} (${topUser.totalMessages})` : 'sem dados';

    return [
        'IMAVY RADAR DO GRUPO',
        '',
        `Token em destaque: ${tokenLabel}`,
        `Crescimento: ${growth}`,
        '',
        `Mais ativo: ${userLine}`,
        '',
        `Grupo esta: ${groupStatus}`
    ].join('\n');
}

export async function runIntelRadar({ messages, chatId, now = Date.now() }) {
    const safeMessages = Array.isArray(messages) ? messages : [];
    const scope = String(chatId || '').endsWith('@g.us')
        ? safeMessages.filter((item) => item.groupId === chatId)
        : safeMessages;
    const last24h = scope.filter((item) => Number(item.timestamp || 0) >= (now - DAY_MS));

    if (last24h.length === 0) {
        return { text: 'Nenhum dado recente para gerar o radar.', images: [] };
    }

    const cacheKey = buildCacheKey(String(chatId || 'private'), last24h, now);
    const cached = radarCache.get(cacheKey);
    if (cached && (now - cached.createdAt) < CACHE_TTL_MS) {
        return cached.payload;
    }

    const aliasLookup = buildAliasLookup(await getAliasLookup());
    const tokenMentions = extractTokenMentions(last24h, { now, aliasLookup, limit: Number.POSITIVE_INFINITY });
    const hypeTokens = detectHype(tokenMentions);
    const tokenAnalytics = tokenMentions.map((item) => {
        const prev = Math.max(1, Number(item.previousHourMentions || 0));
        const growthRate = ((Number(item.lastHourMentions || 0) - Number(item.previousHourMentions || 0)) / prev) * 100;
        let status = 'ESTAVEL';
        if (growthRate >= 50) status = 'HYPE FORTE';
        else if (growthRate >= 20) status = 'HYPE MODERADO';
        return { ...item, growthRate, status };
    });

    const allUsers = getTopActiveUsers(last24h, Number.POSITIVE_INFINITY);
    const topGroups = getTopGroups(last24h, 10);
    const summary = classifyGroupTemperature({
        totalMessages: last24h.length,
        activeUsers: allUsers.length
    });

    const report = {
        tokenAnalytics,
        hypeTokens,
        topActiveUsers: allUsers,
        topGroups,
        summary: {
            totalMessages24h: summary.totalMessages,
            activeUsers: summary.activeUsers,
            avgMessagesPerUser: summary.avgMessagesPerUser,
            groupTemperature: summary
        },
        highlightToken: hypeTokens[0] || tokenAnalytics[0] || null,
        generatedAt: now
    };

    const images = await renderIntelRadarImages(report);
    const text = summarizeText({ ...report, topActiveUsers: allUsers.slice(0, 10) });
    const payload = { text, images, report };

    radarCache.set(cacheKey, { createdAt: now, payload });
    if (radarCache.size > 20) {
        const first = radarCache.keys().next().value;
        radarCache.delete(first);
    }

    return payload;
}
