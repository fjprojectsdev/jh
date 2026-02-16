const path = require('path');
const dotenv = require('dotenv');
const { TOKENS, WBNB } = require('./tokens');

dotenv.config();

function env(name, fallback = '') {
    const value = process.env[name];
    if (value === undefined || value === null || String(value).trim() === '') {
        return fallback;
    }
    return String(value).trim();
}

function envNumber(name, fallback) {
    const raw = env(name, String(fallback));
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return parsed;
}

function envBoolean(name, fallback = false) {
    const raw = env(name, fallback ? 'true' : 'false').toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function envListNumbers(name, fallback) {
    const raw = env(name, '');
    if (!raw) {
        return fallback;
    }

    const values = raw
        .split(',')
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isFinite(item) && item > 0);

    return values.length > 0 ? values : fallback;
}

function assertRequired(name, value) {
    if (!value) {
        throw new Error(`Variavel obrigatoria ausente: ${name}`);
    }
    return value;
}

const config = {
    appName: 'imavy-bsc-buy-notifier',
    nodeEnv: env('NODE_ENV', 'production'),
    logLevel: env('LOG_LEVEL', 'info'),

    bsc: {
        wsUrl: assertRequired('BSC_WS_URL', env('BSC_WS_URL')),
        httpUrl: assertRequired('BSC_HTTP_URL', env('BSC_HTTP_URL')),
        heartbeatMs: envNumber('HEARTBEAT_MS', 30_000),
        pollIntervalMs: envNumber('POLL_INTERVAL_MS', 5_000),
        pollBatchSize: envNumber('POLL_BATCH_SIZE', 200),
        wsBackoffStepsMs: envListNumbers('WS_BACKOFF_STEPS_MS', [2_000, 5_000, 10_000, 20_000, 30_000, 45_000, 60_000])
    },

    filters: {
        minUsdAlert: envNumber('MIN_USD_ALERT', 5),
        tokenCooldownMs: envNumber('TOKEN_COOLDOWN_MS', 8_000),
        dedupTtlMs: envNumber('DEDUP_TTL_MS', 24 * 60 * 60 * 1_000),
        enableMevFilter: envBoolean('ENABLE_MEV_FILTER', true),
        mevSwapLimit: envNumber('MEV_SWAP_LIMIT', 3)
    },

    pricing: {
        bnbPriceUrl: env('BNB_PRICE_URL', 'https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT'),
        refreshMs: envNumber('BNB_PRICE_REFRESH_MS', 60_000)
    },

    whatsapp: {
        sessionDir: path.resolve(process.cwd(), env('WA_SESSION_DIR', './wa-session')),
        groupName: env('WA_GROUP_NAME', 'TESTE IMAVY')
    },

    tokens: TOKENS,
    wbnb: WBNB
};

module.exports = {
    config
};
