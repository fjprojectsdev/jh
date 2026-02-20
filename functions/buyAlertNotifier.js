import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (typeof global.WebSocket === 'undefined') {
    global.WebSocket = require('ws');
}

const { JsonRpcProvider } = require('ethers');
const { BuyDetector } = require('../imavy-bsc-buy-notifier/src/bsc/buyDetector/index.js');
const { BscSwapListener } = require('../imavy-bsc-buy-notifier/src/bsc/listener/index.js');
const { DedupFilter } = require('../imavy-bsc-buy-notifier/src/filters/dedup/index.js');
const { CooldownFilter } = require('../imavy-bsc-buy-notifier/src/filters/cooldown/index.js');
const { MevFilter } = require('../imavy-bsc-buy-notifier/src/filters/mev/index.js');
const { BnbUsdPriceService } = require('../imavy-bsc-buy-notifier/src/pricing/bnbUsd/index.js');
const { TOKENS, WBNB } = require('../imavy-bsc-buy-notifier/src/config/tokens.js');

const DEFAULT_BUY_ALERT_GROUPS = [
    '120363394030123512@g.us',
    '120363418891665714@g.us'
];
const FIXED_BUY_ALERT_GROUP_SET = new Set(DEFAULT_BUY_ALERT_GROUPS);
const HARD_MIN_USD_ALERT = 200;
const BUY_ALERT_PROMO_SYMBOLS = new Set(['NIX', 'SNAP', 'SNAPPY']);
const DEFAULT_BUY_ALERT_PROMO_IMAGE = path.resolve(__dirname, '..', 'assets', 'buy-alert-vellora.png');

let runtime = null;
let promoImageMissingWarned = false;

function env(name, fallback = '') {
    const value = process.env[name];
    if (value === undefined || value === null || String(value).trim() === '') {
        return fallback;
    }
    return String(value).trim();
}

function envNumber(name, fallback) {
    const parsed = Number(env(name, String(fallback)));
    return Number.isFinite(parsed) ? parsed : fallback;
}

function envBoolean(name, fallback = false) {
    const raw = env(name, fallback ? 'true' : 'false').toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function envNumberList(name, fallback) {
    const raw = env(name, '');
    if (!raw) {
        return fallback;
    }
    const list = raw
        .split(',')
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isFinite(item) && item > 0);
    return list.length > 0 ? list : fallback;
}

function resolveBuyAlertGroups() {
    const fallback = DEFAULT_BUY_ALERT_GROUPS.join(',');
    const raw = env('BUY_ALERT_GROUPS', env('INTEL_GROUPS', fallback));
    const parsed = raw
        .split(',')
        .map((groupId) => groupId.trim())
        .filter(Boolean);
    const filtered = parsed.filter((groupId) => FIXED_BUY_ALERT_GROUP_SET.has(groupId));
    return filtered.length > 0 ? filtered : DEFAULT_BUY_ALERT_GROUPS;
}

function shortWallet(address) {
    const safe = String(address || '').trim();
    if (!safe.startsWith('0x') || safe.length < 10) {
        return '0x????...????';
    }
    return `${safe.slice(0, 6)}...${safe.slice(-4)}`;
}

function formatUsd(value) {
    return Number(value || 0).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function formatTokenAmount(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number <= 0) {
        return '0';
    }
    if (number >= 1_000_000) {
        return number.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }
    if (number >= 10_000) {
        return number.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
    if (number >= 1) {
        return number.toLocaleString('en-US', { maximumFractionDigits: 4 });
    }
    return number.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function buildBuyAlertMessage(payload) {
    return [
        `🟢 NOVA COMPRA | ${payload.symbol}`,
        '',
        `💰 USD: $${formatUsd(payload.usdValue)}`,
        `🪙 Tokens: ${formatTokenAmount(payload.tokenOut)}`,
        `👤 Wallet: ${shortWallet(payload.wallet)}`,
        `🔗 Tx: https://bscscan.com/tx/${payload.txHash}`,
        `📊 Chart: https://dexscreener.com/bsc/${payload.pair}`,
        '🌐 BSC'
    ].join('\n');
}

function resolvePromoImageUrl() {
    const configured = env('BUY_ALERT_PROMO_IMAGE', '');
    const source = configured || DEFAULT_BUY_ALERT_PROMO_IMAGE;

    if (!source) {
        return null;
    }

    if (/^https?:\/\//i.test(source)) {
        return source;
    }

    const absolute = path.isAbsolute(source) ? source : path.resolve(process.cwd(), source);
    if (!fs.existsSync(absolute)) {
        return null;
    }

    return absolute;
}

function buildBuyAlertPayload(payload) {
    const text = buildBuyAlertMessage(payload);
    const symbol = String(payload.symbol || '').trim().toUpperCase();

    if (!BUY_ALERT_PROMO_SYMBOLS.has(symbol)) {
        return { text };
    }

    const imageUrl = resolvePromoImageUrl();
    if (!imageUrl) {
        if (!promoImageMissingWarned) {
            promoImageMissingWarned = true;
            logger.warn('Imagem promocional BUY ALERT nao encontrada; fallback para texto.', {
                symbol,
                envVar: 'BUY_ALERT_PROMO_IMAGE',
                defaultPath: DEFAULT_BUY_ALERT_PROMO_IMAGE
            });
        }
        return { text };
    }

    return {
        image: { url: imageUrl },
        caption: text
    };
}

function cloneMessagePayload(payload) {
    if (payload && payload.image && payload.image.url) {
        return {
            image: { url: payload.image.url },
            caption: String(payload.caption || '')
        };
    }

    return {
        text: String(payload && payload.text || '')
    };
}

function buildConfig() {
    const configuredMinUsdAlert = envNumber('MIN_USD_ALERT', HARD_MIN_USD_ALERT);
    return {
        bscWsUrl: env('BSC_WS_URL', 'wss://bsc.publicnode.com'),
        bscHttpUrl: env('BSC_HTTP_URL', 'https://bsc.publicnode.com'),
        minUsdAlert: Math.max(HARD_MIN_USD_ALERT, configuredMinUsdAlert),
        tokenCooldownMs: envNumber('TOKEN_COOLDOWN_MS', 8_000),
        dedupTtlMs: envNumber('DEDUP_TTL_MS', 24 * 60 * 60 * 1_000),
        enableMevFilter: envBoolean('ENABLE_MEV_FILTER', true),
        mevSwapLimit: envNumber('MEV_SWAP_LIMIT', 3),
        bnbPriceUrl: env('BNB_PRICE_URL', 'https://api.mexc.com/api/v3/ticker/price?symbol=BNBUSDT'),
        bnbPriceRefreshMs: envNumber('BNB_PRICE_REFRESH_MS', 60_000),
        heartbeatMs: envNumber('HEARTBEAT_MS', 30_000),
        pollIntervalMs: envNumber('POLL_INTERVAL_MS', 5_000),
        pollBatchSize: envNumber('POLL_BATCH_SIZE', 200),
        wsBackoffMs: envNumberList('WS_BACKOFF_STEPS_MS', [2_000, 5_000, 10_000, 20_000, 30_000, 45_000, 60_000])
    };
}

async function sendBuyAlert(sock, payload, groups) {
    const results = await Promise.allSettled(
        groups.map((groupId) => sock.sendMessage(groupId, cloneMessagePayload(payload)))
    );

    const delivered = [];
    const failed = [];

    results.forEach((result, index) => {
        const groupId = groups[index];
        if (result.status === 'fulfilled') {
            delivered.push(groupId);
        } else {
            failed.push({
                groupId,
                error: result.reason?.message || String(result.reason)
            });
        }
    });

    if (delivered.length > 0) {
        logger.info('BUY ALERT enviado para grupos Vellora', { delivered });
    }

    if (failed.length > 0) {
        logger.error('Erro ao enviar BUY ALERT para alguns grupos', { failed });
    }
}

async function stopRuntime() {
    if (!runtime) {
        return;
    }

    try {
        if (runtime.listener) {
            await runtime.listener.stop();
        }
    } catch (error) {
        logger.warn('Falha ao parar listener BUY ALERT', { error: error.message });
    }

    try {
        if (runtime.priceService) {
            runtime.priceService.stop();
        }
    } catch (error) {
        logger.warn('Falha ao parar precificacao BUY ALERT', { error: error.message });
    }

    try {
        if (runtime.dedupFilter) {
            runtime.dedupFilter.stop();
        }
    } catch (error) {
        logger.warn('Falha ao parar dedup BUY ALERT', { error: error.message });
    }

    runtime = null;
}

export async function stopBuyAlertNotifier() {
    await stopRuntime();
}

export async function startBuyAlertNotifier(sock, options = {}) {
    if (!sock) {
        throw new Error('Socket Baileys nao fornecido para startBuyAlertNotifier.');
    }

    const onBuyProcessed = typeof options.onBuyProcessed === 'function'
        ? options.onBuyProcessed
        : null;

    await stopRuntime();

    const config = buildConfig();
    const groups = resolveBuyAlertGroups();

    if (groups.length === 0) {
        throw new Error('Nenhum grupo configurado para BUY ALERT (BUY_ALERT_GROUPS/INTEL_GROUPS).');
    }

    logger.info('Iniciando BUY ALERT integrado ao bot principal', {
        groups,
        tokens: TOKENS.map((token) => token.symbol)
    });

    const httpProvider = new JsonRpcProvider(config.bscHttpUrl);
    const detectors = TOKENS.map((tokenConfig) => new BuyDetector({
        tokenConfig,
        wbnbAddress: WBNB,
        logger
    }));

    for (const detector of detectors) {
        await detector.initialize(httpProvider);
    }

    const dedupFilter = new DedupFilter(config.dedupTtlMs, logger);
    dedupFilter.start();

    const cooldownFilter = new CooldownFilter(config.tokenCooldownMs);
    const mevFilter = new MevFilter({
        provider: httpProvider,
        swapTopic: BuyDetector.getSwapTopic(),
        enabled: config.enableMevFilter,
        maxSwapLogsPerTx: config.mevSwapLimit,
        logger
    });

    const priceService = new BnbUsdPriceService({
        url: config.bnbPriceUrl,
        refreshMs: config.bnbPriceRefreshMs,
        logger
    });
    await priceService.start();

    const listener = new BscSwapListener({
        wsUrl: config.bscWsUrl,
        httpUrl: config.bscHttpUrl,
        detectors,
        heartbeatMs: config.heartbeatMs,
        pollIntervalMs: config.pollIntervalMs,
        pollBatchSize: config.pollBatchSize,
        wsBackoffStepsMs: config.wsBackoffMs,
        logger
    });

    listener.on('buy', async (buyEvent) => {
        try {
            const dedupKey = `${buyEvent.txHash}:${buyEvent.logIndex}`;
            if (dedupFilter.isDuplicateAndMark(dedupKey)) {
                logger.info('BUY IGNORADO: duplicado', {
                    txHash: buyEvent.txHash,
                    symbol: buyEvent.symbol,
                    dedupKey
                });
                return;
            }

            const bnbPrice = priceService.getPrice();
            if (!Number.isFinite(bnbPrice) || bnbPrice <= 0) {
                logger.warn('BUY IGNORADO: preco BNB indisponivel', {
                    txHash: buyEvent.txHash,
                    symbol: buyEvent.symbol
                });
                return;
            }

            const usdValue = Number(buyEvent.bnbIn || 0) * bnbPrice;
            if (!Number.isFinite(usdValue) || usdValue <= config.minUsdAlert) {
                logger.info('BUY IGNORADO: abaixo do minimo USD', {
                    txHash: buyEvent.txHash,
                    symbol: buyEvent.symbol,
                    usdValue,
                    minUsdAlert: config.minUsdAlert
                });
                return;
            }

            if (cooldownFilter.isInCooldown(buyEvent.symbol)) {
                logger.info('BUY IGNORADO: cooldown ativo', {
                    txHash: buyEvent.txHash,
                    symbol: buyEvent.symbol
                });
                return;
            }

            const suspicious = await mevFilter.isSuspicious(buyEvent.txHash);
            if (suspicious) {
                logger.info('BUY IGNORADO: filtro MEV/arbitragem', {
                    txHash: buyEvent.txHash,
                    symbol: buyEvent.symbol
                });
                return;
            }

            let wallet = buyEvent.to;
            try {
                const tx = await httpProvider.getTransaction(buyEvent.txHash);
                if (tx && tx.from) {
                    wallet = tx.from;
                }
            } catch (error) {
                logger.warn('Falha ao resolver wallet do BUY ALERT. Usando campo "to".', {
                    txHash: buyEvent.txHash,
                    error: error.message
                });
            }

            cooldownFilter.hit(buyEvent.symbol);

            const messagePayload = buildBuyAlertPayload({
                symbol: buyEvent.symbol,
                usdValue,
                tokenOut: buyEvent.tokenOut,
                wallet,
                txHash: buyEvent.txHash,
                pair: buyEvent.pair
            });

            await sendBuyAlert(sock, messagePayload, groups);
            if (onBuyProcessed) {
                try {
                    await onBuyProcessed({
                        symbol: buyEvent.symbol,
                        txHash: buyEvent.txHash,
                        tokenOut: buyEvent.tokenOut,
                        bnbIn: buyEvent.bnbIn,
                        usdValue,
                        timestamp: Date.now()
                    });
                } catch (callbackError) {
                    logger.warn('Falha no callback onBuyProcessed do BUY ALERT', {
                        symbol: buyEvent.symbol,
                        txHash: buyEvent.txHash,
                        error: callbackError.message || String(callbackError)
                    });
                }
            }
            logger.info('BUY processado com sucesso', {
                txHash: buyEvent.txHash,
                symbol: buyEvent.symbol,
                usdValue,
                source: buyEvent.source
            });
        } catch (error) {
            logger.error('Erro ao processar evento BUY integrado', {
                txHash: buyEvent && buyEvent.txHash,
                symbol: buyEvent && buyEvent.symbol,
                error: error.message || String(error)
            });
        }
    });

    listener.on('ws:offline', ({ reason }) => {
        logger.warn('BUY ALERT listener WS offline (fallback polling ativo)', { reason });
    });

    listener.on('ws:online', () => {
        logger.info('BUY ALERT listener WS online');
    });

    await listener.start();

    runtime = {
        listener,
        priceService,
        dedupFilter
    };

    logger.info('BUY ALERT integrado iniciou e esta monitorando compras validas.');
}

export async function sendBuyAlertDirect(sock, text) {
    const groups = resolveBuyAlertGroups();
    await sendBuyAlert(sock, { text }, groups);
}
