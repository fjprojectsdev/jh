const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const BOT_LOG_FILE = path.join(ROOT_DIR, 'bot.log');
const TOKENS_CONFIG_FILE = path.join(ROOT_DIR, 'imavy-bsc-buy-notifier', 'src', 'config', 'tokens.js');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const NETWORK_FALLBACK = ['ETHEREUM', 'BSC', 'BASE', 'POLYGON', 'SOLANA'];

let parsedLogCache = {
    key: '',
    payload: null
};

function toPositiveInt(value, fallback) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toFiniteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function safeUpper(value) {
    return String(value || '').trim().toUpperCase();
}

function readLines(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return [];
        }

        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw) {
            return [];
        }

        return raw.split(/\r?\n/).filter(Boolean);
    } catch (_) {
        return [];
    }
}

function parseLogTimestamp(line) {
    const match = /^\[([^\]]+)\]/.exec(String(line || ''));
    if (!match) {
        return null;
    }

    const ts = Date.parse(match[1]);
    return Number.isFinite(ts) ? ts : null;
}

function parseJsonSuffix(line) {
    const separatorIndex = String(line || '').indexOf('|');
    if (separatorIndex < 0) {
        return null;
    }

    const raw = String(line || '').slice(separatorIndex + 1).trim();
    if (!raw.startsWith('{') || !raw.endsWith('}')) {
        return null;
    }

    try {
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function buildCacheKey(filePath) {
    try {
        const stat = fs.statSync(filePath);
        return `${stat.size}:${stat.mtimeMs}`;
    } catch (_) {
        return '';
    }
}

function parseBuyAlertLog() {
    const cacheKey = buildCacheKey(BOT_LOG_FILE);
    if (cacheKey && parsedLogCache.key === cacheKey && parsedLogCache.payload) {
        return parsedLogCache.payload;
    }

    const lines = readLines(BOT_LOG_FILE);
    const events = [];
    let lastConnectedAt = null;
    let lastMinUsdAlert = null;

    for (const line of lines) {
        const timestamp = parseLogTimestamp(line);
        if (line.includes('Conectado ao WhatsApp') && timestamp) {
            lastConnectedAt = timestamp;
        }

        if (line.includes('BUY IGNORADO: abaixo do minimo USD')) {
            const payload = parseJsonSuffix(line) || {};
            const minUsd = toFiniteNumber(payload.minUsdAlert, NaN);
            if (Number.isFinite(minUsd)) {
                lastMinUsdAlert = minUsd;
            }
        }

        if (!line.includes('BUY processado com sucesso')) {
            continue;
        }

        const payload = parseJsonSuffix(line) || {};
        const usdValue = toFiniteNumber(payload.usdValue, 0);
        const tokenOut = toFiniteNumber(payload.tokenOut, 0);
        const token = safeUpper(payload.symbol);
        const txHash = String(payload.txHash || '').trim();

        events.push({
            id: `${timestamp || Date.now()}_${txHash || Math.random().toString(36).slice(2, 8)}`,
            timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
            token: token || 'SEM_TOKEN',
            network: safeUpper(payload.network) || 'BSC',
            buyer: String(payload.wallet || payload.buyer || '').trim(),
            amount: tokenOut,
            usd: usdValue,
            tx: txHash,
            pair: String(payload.pair || '').trim()
        });
    }

    const payload = {
        parsedAt: Date.now(),
        lastConnectedAt,
        lastMinUsdAlert,
        events
    };

    parsedLogCache = {
        key: cacheKey,
        payload
    };

    return payload;
}

function loadTokenCatalog() {
    try {
        delete require.cache[require.resolve(TOKENS_CONFIG_FILE)];
        const mod = require(TOKENS_CONFIG_FILE);
        const tokens = Array.isArray(mod && mod.TOKENS) ? mod.TOKENS : [];
        return tokens.map((item) => ({
            nome: safeUpper(item.symbol) || 'TOKEN',
            simbolo: safeUpper(item.symbol) || 'TOKEN',
            rede: 'BSC',
            tokenAddress: String(item.token || '').trim(),
            pairAddress: String(item.pair || '').trim(),
            decimals: 18,
            status: 'Ativo',
            imagemBuy: ''
        }));
    } catch (_) {
        return [];
    }
}

function buildTokenTrends(events) {
    const totals = new Map();

    for (const event of events) {
        const key = safeUpper(event.token) || 'SEM_TOKEN';
        totals.set(key, (totals.get(key) || 0) + 1);
    }

    return Array.from(totals.entries())
        .map(([token, total]) => ({ token, total }))
        .sort((a, b) => b.total - a.total);
}

function buildNetworkDistribution(events) {
    const totals = new Map();
    for (const network of NETWORK_FALLBACK) {
        totals.set(network, 0);
    }

    for (const event of events) {
        const key = safeUpper(event.network) || 'BSC';
        totals.set(key, (totals.get(key) || 0) + 1);
    }

    return Array.from(totals.entries()).map(([network, total]) => ({ network, total }));
}

function getBuyAlertsResumo(options = {}) {
    const days = toPositiveInt(options.days, 30);
    const recentLimit = Math.max(1, Math.min(toPositiveInt(options.recentLimit, 50), 200));
    const parsed = parseBuyAlertLog();
    const now = Date.now();
    const cutoff = now - (days * ONE_DAY_MS);
    const minUsdFallback = toFiniteNumber(process.env.MIN_USD_ALERT, 0);

    const eventsInPeriod = parsed.events.filter((item) => Number(item.timestamp || 0) >= cutoff);
    const totalUsd = eventsInPeriod.reduce((sum, item) => sum + toFiniteNumber(item.usd, 0), 0);
    const totalBuys = eventsInPeriod.length;

    const sortedByTime = eventsInPeriod
        .slice()
        .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
    const recentBuys = sortedByTime.slice(0, recentLimit);
    const topBuys = eventsInPeriod
        .slice()
        .sort((a, b) => toFiniteNumber(b.usd, 0) - toFiniteNumber(a.usd, 0))
        .slice(0, 25);
    const tokenTrends = buildTokenTrends(eventsInPeriod);
    const networkDistribution = buildNetworkDistribution(eventsInPeriod);
    const tokenCatalog = loadTokenCatalog();
    const uptimeSec = parsed.lastConnectedAt
        ? Math.max(0, Math.floor((now - parsed.lastConnectedAt) / 1000))
        : 0;

    return {
        ok: true,
        updatedAt: new Date().toISOString(),
        periodDays: days,
        summary: {
            totalBuys,
            totalUsd: Number(totalUsd.toFixed(2)),
            tokensAtivos: tokenCatalog.length > 0
                ? tokenCatalog.filter((item) => String(item.status).toLowerCase() === 'ativo').length
                : tokenTrends.length,
            alertasEnviados: totalBuys
        },
        meta: {
            minUsdAlert: Number((parsed.lastMinUsdAlert ?? minUsdFallback).toFixed(2)),
            lastConnectedAt: parsed.lastConnectedAt ? new Date(parsed.lastConnectedAt).toISOString() : null,
            uptimeSec
        },
        tokenTrends,
        networkDistribution,
        topBuys,
        recentBuys,
        tokenCatalog
    };
}

module.exports = {
    getBuyAlertsResumo
};
