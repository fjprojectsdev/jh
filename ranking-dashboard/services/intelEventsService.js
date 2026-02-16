const { sanitizeText } = require('./supabaseTenantClient.js');

const VALID_TYPES = new Set([
    'SOCIAL_SPIKE',
    'TOKEN_DOMINANCE',
    'SOCIAL_ONCHAIN_CONFIRM'
]);

const DEFAULT_BUFFER_SIZE = 800;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const eventsBuffer = [];

function nowMs() {
    return Date.now();
}

function toFiniteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function getBufferLimit() {
    const raw = Number(process.env.INTEL_EVENTS_BUFFER_SIZE || DEFAULT_BUFFER_SIZE);
    if (!Number.isFinite(raw) || raw < 100) {
        return DEFAULT_BUFFER_SIZE;
    }
    return Math.floor(raw);
}

function normalizeType(value) {
    const type = sanitizeText(value, 64).toUpperCase();
    return VALID_TYPES.has(type) ? type : '';
}

function normalizeIntelEvent(payload) {
    const safePayload = payload && typeof payload === 'object' ? payload : {};
    const type = normalizeType(safePayload.type);

    if (!type) {
        const error = new Error('Evento de inteligencia invalido: type ausente ou nao suportado.');
        error.statusCode = 400;
        throw error;
    }

    const timestamp = toFiniteNumber(safePayload.timestamp, nowMs());
    const normalized = {
        id: `intel_${timestamp}_${Math.random().toString(36).slice(2, 10)}`,
        type,
        timestamp,
        group: sanitizeText(safePayload.group, 180) || '',
        groupJid: sanitizeText(safePayload.groupJid, 180) || '',
        token: sanitizeText(safePayload.token || safePayload.topToken, 40).toUpperCase() || '',
        topToken: sanitizeText(safePayload.topToken, 40).toUpperCase() || '',
        messageRate: toFiniteNumber(safePayload.messageRate, 0),
        baselineRate: toFiniteNumber(safePayload.baselineRate, 0),
        socialIncrease: toFiniteNumber(safePayload.socialIncrease, 0),
        buyIncrease: toFiniteNumber(safePayload.buyIncrease, 0),
        emojiCount: toFiniteNumber(safePayload.emojiCount, 0),
        tokenCount: toFiniteNumber(safePayload.tokenCount, 0),
        othersCount: toFiniteNumber(safePayload.othersCount, 0),
        ratio: toFiniteNumber(safePayload.ratio, 0),
        raw: safePayload
    };

    return normalized;
}

function trimBuffer() {
    const limit = getBufferLimit();
    if (eventsBuffer.length <= limit) {
        return;
    }

    eventsBuffer.splice(0, eventsBuffer.length - limit);
}

function cleanupOldEvents() {
    const cutoff = nowMs() - ONE_DAY_MS;
    while (eventsBuffer.length > 0 && Number(eventsBuffer[0].timestamp || 0) < cutoff) {
        eventsBuffer.shift();
    }
}

function ingestIntelEvent(payload) {
    const normalized = normalizeIntelEvent(payload);
    eventsBuffer.push(normalized);
    cleanupOldEvents();
    trimBuffer();
    return normalized;
}

function listIntelEvents(filters = {}) {
    const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 300));
    const type = normalizeType(filters.type || '');
    const token = sanitizeText(filters.token, 40).toUpperCase();
    const group = sanitizeText(filters.group, 180);

    let rows = eventsBuffer;

    if (type) {
        rows = rows.filter((item) => item.type === type);
    }

    if (token) {
        rows = rows.filter((item) => item.token === token || item.topToken === token);
    }

    if (group) {
        rows = rows.filter((item) => item.group === group || item.groupJid === group);
    }

    return rows
        .slice()
        .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
        .slice(0, limit);
}

function getIntelOpsSummary() {
    cleanupOldEvents();

    const cutoff = nowMs() - ONE_DAY_MS;
    let socialSpike24h = 0;
    let tokenDominance24h = 0;
    let socialOnchainConfirm24h = 0;

    for (const item of eventsBuffer) {
        const ts = Number(item.timestamp || 0);
        if (!Number.isFinite(ts) || ts < cutoff) {
            continue;
        }

        if (item.type === 'SOCIAL_SPIKE') {
            socialSpike24h += 1;
        } else if (item.type === 'TOKEN_DOMINANCE') {
            tokenDominance24h += 1;
        } else if (item.type === 'SOCIAL_ONCHAIN_CONFIRM') {
            socialOnchainConfirm24h += 1;
        }
    }

    return {
        socialSpike24h,
        tokenDominance24h,
        socialOnchainConfirm24h,
        totalIntel24h: socialSpike24h + tokenDominance24h + socialOnchainConfirm24h
    };
}

function isIntelWebhookAuthorized(req) {
    const expected = sanitizeText(process.env.INTEL_WEBHOOK_SECRET, 180);
    if (!expected) {
        return true;
    }

    const header =
        sanitizeText(req && req.headers && req.headers['x-intel-key'], 180) ||
        sanitizeText(req && req.headers && req.headers['X-Intel-Key'], 180);

    return Boolean(header) && header === expected;
}

module.exports = {
    ingestIntelEvent,
    listIntelEvents,
    getIntelOpsSummary,
    isIntelWebhookAuthorized
};

