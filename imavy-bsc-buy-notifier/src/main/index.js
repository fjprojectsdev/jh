const { JsonRpcProvider } = require('ethers');
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { createLogger } = require('../config/logger');
const { BuyDetector } = require('../bsc/buyDetector');
const { BscSwapListener } = require('../bsc/listener');
const { DedupFilter } = require('../filters/dedup');
const { CooldownFilter } = require('../filters/cooldown');
const { MevFilter } = require('../filters/mev');
const { BnbUsdPriceService } = require('../pricing/bnbUsd');
const { WhatsAppGroupClient } = require('../whatsapp/client');

if (typeof global.WebSocket === 'undefined') {
    global.WebSocket = require('ws');
}

const logger = createLogger(config.logLevel);
let promoImageMissingWarned = false;

function shortWallet(address) {
    const safe = String(address || '').trim();
    if (!safe || !safe.startsWith('0x') || safe.length < 10) {
        return '0x????...????';
    }
    return `${safe.slice(0, 6)}...${safe.slice(-4)}`;
}

function formatUsd(value) {
    return value.toLocaleString('en-US', {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3
    });
}

function formatTokenAmount(value) {
    if (!Number.isFinite(value)) {
        return '0';
    }

    if (value >= 1_000_000) {
        return value.toLocaleString('en-US', { maximumFractionDigits: 1 });
    }

    if (value >= 10_000) {
        return value.toLocaleString('en-US', { maximumFractionDigits: 3 });
    }

    if (value >= 1) {
        return value.toLocaleString('en-US', { maximumFractionDigits: 5 });
    }

    return value.toLocaleString('en-US', { maximumFractionDigits: 9 });
}

function buildDexviewTokenUrl(tokenAddress, chain = 'bsc') {
    const safeToken = String(tokenAddress || '').trim();
    if (!/^0x[a-f0-9]{40}$/i.test(safeToken)) {
        return null;
    }
    const safeChain = String(chain || 'bsc').trim().toLowerCase() || 'bsc';
    return `https://www.dexview.com/${safeChain}/${safeToken}`;
}

function buildDexscreenerPairUrl(pairAddress, chain = 'bsc') {
    const safePair = String(pairAddress || '').trim();
    if (!/^0x[a-f0-9]{40}$/i.test(safePair)) {
        return null;
    }
    const safeChain = String(chain || 'bsc').trim().toLowerCase() || 'bsc';
    return `https://dexscreener.com/${safeChain}/${safePair}`;
}

function buildMessage(payload) {
    const lines = [
        `BUY ALERT | ${payload.symbol}`,
        '',
        `USD: ${formatUsd(payload.usdValue)}`,
        `Tokens: ${formatTokenAmount(payload.tokenAmount)}`,
        `Wallet: ${shortWallet(payload.wallet)}`,
        'Origem: Swap na BSC',
        `Tx: https://bscscan.com/tx/${payload.txHash}`,
        'BSC'
    ];

    const dexviewUrl = buildDexviewTokenUrl(payload.token);
    const dexscreenerUrl = buildDexscreenerPairUrl(payload.pair);
    if (dexviewUrl) {
        lines.splice(lines.length - 1, 0, `Dexview: ${dexviewUrl}`);
    }
    if (dexscreenerUrl) {
        lines.splice(lines.length - 1, 0, `Dexscreener: ${dexscreenerUrl}`);
    }

    return lines.join('\n');
}

function normalizeTxHash(txHash) {
    const safe = String(txHash || '').trim().toLowerCase();
    return /^0x[a-f0-9]{64}$/.test(safe) ? safe : '';
}

function loadRuntimeState(filePath) {
    const state = {
        filePath,
        lastBlockNumber: null,
        sentTxHashes: {}
    };

    try {
        if (!filePath || !fs.existsSync(filePath)) {
            return state;
        }

        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const lastBlockNumber = Number(parsed?.lastBlockNumber);
        if (Number.isFinite(lastBlockNumber) && lastBlockNumber >= 0) {
            state.lastBlockNumber = lastBlockNumber;
        }
        if (parsed?.sentTxHashes && typeof parsed.sentTxHashes === 'object') {
            state.sentTxHashes = parsed.sentTxHashes;
        }
    } catch (error) {
        logger.warn('Falha ao carregar estado persistido do BUY ALERT. Iniciando vazio.', {
            filePath,
            error: error.message
        });
    }

    return state;
}

function saveRuntimeState(state) {
    if (!state || !state.filePath) {
        return;
    }

    fs.mkdirSync(path.dirname(state.filePath), { recursive: true });
    fs.writeFileSync(state.filePath, JSON.stringify({
        updatedAt: new Date().toISOString(),
        lastBlockNumber: state.lastBlockNumber,
        sentTxHashes: state.sentTxHashes || {}
    }, null, 2), 'utf8');
}

function setRuntimeLastBlock(state, blockNumber) {
    const safeBlock = Number(blockNumber);
    if (!state || !Number.isFinite(safeBlock) || safeBlock < 0) {
        return;
    }

    if (state.lastBlockNumber !== null && safeBlock < state.lastBlockNumber) {
        return;
    }

    state.lastBlockNumber = safeBlock;
    saveRuntimeState(state);
}

function hasSentTxHash(state, txHash) {
    const key = normalizeTxHash(txHash);
    return Boolean(key && state?.sentTxHashes && state.sentTxHashes[key]);
}

function markSentTxHash(state, txHash, meta = {}) {
    const key = normalizeTxHash(txHash);
    if (!state || !key) {
        return;
    }

    if (!state.sentTxHashes || typeof state.sentTxHashes !== 'object') {
        state.sentTxHashes = {};
    }

    state.sentTxHashes[key] = {
        txHash: key,
        sentAt: new Date().toISOString(),
        ...meta
    };
    saveRuntimeState(state);
}

function buildTxTimingMeta(buyEvent) {
    const timestampMs = Number(buyEvent?.blockTimestampMs || 0);
    const nowMs = Date.now();
    const ageMs = timestampMs > 0 ? nowMs - timestampMs : null;

    return {
        txHash: buyEvent?.txHash || null,
        blockNumber: Number.isFinite(Number(buyEvent?.blockNumber)) ? Number(buyEvent.blockNumber) : null,
        txTimestampUtc: timestampMs > 0 ? new Date(timestampMs).toISOString() : (buyEvent?.blockTimestampUtc || null),
        serverNowUtc: new Date(nowMs).toISOString(),
        ageMinutes: ageMs === null ? buyEvent?.ageMinutes ?? null : Number((ageMs / 60_000).toFixed(3)),
        source: buyEvent?.source || null
    };
}

function isTxOlderThanMax(timingMeta, maxTxAgeMs) {
    if (!timingMeta?.txTimestampUtc) {
        return false;
    }
    const timestampMs = Date.parse(timingMeta.txTimestampUtc);
    return Number.isFinite(timestampMs) && Date.now() - timestampMs > maxTxAgeMs;
}

function logBuyDecision(message, timingMeta, meta = {}, level = 'info') {
    const method = typeof logger[level] === 'function' ? level : 'info';
    logger[method](message, {
        ...(timingMeta || {}),
        ...meta
    });
}

function resolveMediaUrl(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw) {
        return null;
    }

    const candidates = [raw];

    for (const candidate of candidates) {
        if (/^https?:\/\//i.test(candidate)) {
            return candidate;
        }

        const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate);
        if (fs.existsSync(absolute)) {
            return absolute;
        }
    }

    return null;
}

function resolvePromoImageUrl() {
    return resolveMediaUrl(process.env.BUY_ALERT_PROMO_IMAGE)
        || resolveMediaUrl(path.resolve(process.cwd(), 'assets', 'buy-alert-vellora.png'))
        || resolveMediaUrl(path.resolve(process.cwd(), '..', 'assets', 'buy-alert-vellora.png'));
}

function buildMessagePayload(payload) {
    const text = buildMessage(payload);
    const imageUrl = resolvePromoImageUrl();

    if (!imageUrl) {
        if (!promoImageMissingWarned) {
            promoImageMissingWarned = true;
            logger.warn('Imagem promocional BUY ALERT nao encontrada; fallback para texto.', {
                envVar: 'BUY_ALERT_PROMO_IMAGE'
            });
        }
        return { text };
    }

    return {
        image: { url: imageUrl },
        caption: text
    };
}

async function run() {
    logger.info('Inicializando imavy-bsc-buy-notifier...', {
        tokens: config.tokens.map((t) => t.symbol),
        groupName: config.whatsapp.groupName,
        maxTxAgeMinutes: Number((config.filters.maxTxAgeMs / 60_000).toFixed(3)),
        stateFile: config.stateFile
    });

    const runtimeState = loadRuntimeState(config.stateFile);
    const httpProvider = new JsonRpcProvider(config.bsc.httpUrl);

    const detectors = config.tokens.map((tokenConfig) => new BuyDetector({
        tokenConfig,
        wbnbAddress: config.wbnb,
        logger
    }));

    for (const detector of detectors) {
        await detector.initialize(httpProvider);
    }

    const dedupFilter = new DedupFilter(config.filters.dedupTtlMs, logger);
    dedupFilter.start();

    const cooldownFilter = new CooldownFilter(config.filters.tokenCooldownMs);
    const mevFilter = new MevFilter({
        provider: httpProvider,
        swapTopic: BuyDetector.getSwapTopic(),
        enabled: config.filters.enableMevFilter,
        maxSwapLogsPerTx: config.filters.mevSwapLimit,
        logger
    });

    const priceService = new BnbUsdPriceService({
        url: config.pricing.bnbPriceUrl,
        refreshMs: config.pricing.refreshMs,
        logger
    });
    await priceService.start();

    const whatsappClient = new WhatsAppGroupClient({
        sessionDir: config.whatsapp.sessionDir,
        groupName: config.whatsapp.groupName,
        logger
    });
    await whatsappClient.start();
    await whatsappClient.waitUntilReady();

    const listener = new BscSwapListener({
        wsUrl: config.bsc.wsUrl,
        httpUrl: config.bsc.httpUrl,
        detectors,
        heartbeatMs: config.bsc.heartbeatMs,
        pollIntervalMs: config.bsc.pollIntervalMs,
        pollBatchSize: config.bsc.pollBatchSize,
        maxTxAgeMs: config.filters.maxTxAgeMs,
        wsBackoffStepsMs: config.bsc.wsBackoffStepsMs,
        initialPollCursor: runtimeState.lastBlockNumber,
        onPollCursorUpdated: async (blockNumber) => {
            setRuntimeLastBlock(runtimeState, blockNumber);
        },
        logger
    });

    listener.on('buy', async (buyEvent) => {
        try {
            const timingMeta = buildTxTimingMeta(buyEvent);

            if (!normalizeTxHash(buyEvent.txHash)) {
                logBuyDecision('BUY IGNORADO: hash invalido', timingMeta, {
                    symbol: buyEvent.symbol,
                    reason: 'invalid-tx-hash'
                }, 'warn');
                return;
            }

            if (!timingMeta.txTimestampUtc) {
                logBuyDecision('BUY IGNORADO: timestamp UTC da transacao indisponivel', timingMeta, {
                    symbol: buyEvent.symbol,
                    reason: 'missing-block-timestamp'
                }, 'warn');
                return;
            }

            if (isTxOlderThanMax(timingMeta, config.filters.maxTxAgeMs)) {
                logBuyDecision('BUY IGNORADO: transacao antiga', timingMeta, {
                    symbol: buyEvent.symbol,
                    maxAgeMinutes: Number((config.filters.maxTxAgeMs / 60_000).toFixed(3)),
                    reason: 'older-than-max-age'
                });
                return;
            }

            if (hasSentTxHash(runtimeState, buyEvent.txHash)) {
                logBuyDecision('BUY IGNORADO: hash ja publicado anteriormente', timingMeta, {
                    symbol: buyEvent.symbol,
                    reason: 'already-published'
                });
                return;
            }

            const dedupKey = `${buyEvent.txHash}:${buyEvent.logIndex}`;
            if (dedupFilter.isDuplicateAndMark(dedupKey)) {
                logBuyDecision('BUY IGNORADO: duplicado em memoria', timingMeta, {
                    symbol: buyEvent.symbol,
                    dedupKey,
                    reason: 'memory-duplicate'
                });
                return;
            }

            const bnbPrice = priceService.getPrice();
            if (!Number.isFinite(bnbPrice) || bnbPrice <= 0) {
                logBuyDecision('BUY IGNORADO: preco BNB indisponivel', timingMeta, {
                    symbol: buyEvent.symbol,
                    reason: 'bnb-price-unavailable'
                }, 'warn');
                return;
            }

            const usdValue = buyEvent.bnbIn * bnbPrice;
            if (!Number.isFinite(usdValue) || usdValue <= config.filters.minUsdAlert) {
                logBuyDecision('BUY IGNORADO: abaixo do minimo USD', timingMeta, {
                    symbol: buyEvent.symbol,
                    usdValue,
                    minUsdAlert: config.filters.minUsdAlert,
                    reason: 'below-min-usd'
                });
                return;
            }

            if (cooldownFilter.isInCooldown(buyEvent.symbol)) {
                logBuyDecision('BUY IGNORADO: cooldown ativo', timingMeta, {
                    symbol: buyEvent.symbol,
                    reason: 'cooldown-active'
                });
                return;
            }

            const suspicious = await mevFilter.isSuspicious(buyEvent.txHash);
            if (suspicious) {
                logBuyDecision('BUY IGNORADO: filtro MEV/arbitragem', timingMeta, {
                    symbol: buyEvent.symbol,
                    reason: 'mev-filter'
                }, 'warn');
                return;
            }

            let wallet = buyEvent.to;
            try {
                const tx = await httpProvider.getTransaction(buyEvent.txHash);
                if (tx && tx.from) {
                    wallet = tx.from;
                }
            } catch (error) {
                logger.warn('Falha ao resolver wallet da transacao. Usando campo "to" do swap.', {
                    txHash: buyEvent.txHash,
                    error: error.message
                });
            }

            cooldownFilter.hit(buyEvent.symbol);

            const messagePayload = buildMessagePayload({
                symbol: buyEvent.symbol,
                usdValue,
                tokenAmount: buyEvent.tokenOut,
                wallet,
                txHash: buyEvent.txHash,
                token: buyEvent.token,
                pair: buyEvent.pair
            });

            await whatsappClient.sendMessageWithRetry(messagePayload);
            markSentTxHash(runtimeState, buyEvent.txHash, {
                stream: 'swap-listener',
                symbol: buyEvent.symbol,
                blockNumber: Number(buyEvent.blockNumber),
                txTimestampUtc: timingMeta.txTimestampUtc
            });

            logBuyDecision('BUY PUBLICADO: Swap na BSC', timingMeta, {
                symbol: buyEvent.symbol,
                usdValue,
                source: buyEvent.source,
                reason: 'published'
            });
        } catch (error) {
            logger.error('Erro ao processar evento BUY.', {
                txHash: buyEvent.txHash,
                symbol: buyEvent.symbol,
                error: error.message
            });
        }
    });

    listener.on('ws:offline', ({ reason }) => {
        logger.warn('Listener WS offline. Fallback polling HTTP ativo.', { reason });
    });

    listener.on('ws:online', () => {
        logger.info('Listener WS online novamente.');
    });

    await listener.start();
    logger.info('Servico pronto e monitorando compras BUY.');

    async function shutdown(signal) {
        logger.warn('Encerrando servico...', { signal });
        try {
            await listener.stop();
        } catch (_) {}
        try {
            await whatsappClient.stop();
        } catch (_) {}
        try {
            dedupFilter.stop();
        } catch (_) {}
        try {
            priceService.stop();
        } catch (_) {}
        try {
            saveRuntimeState(runtimeState);
        } catch (_) {}
        process.exit(0);
    }

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
    logger.error('UnhandledRejection capturado.', {
        reason: reason && reason.message ? reason.message : String(reason)
    });
});

process.on('uncaughtException', (error) => {
    logger.fatal('UncaughtException capturada.', { error: error.message });
    process.exit(1);
});

run().catch((error) => {
    logger.fatal('Falha fatal ao iniciar servico.', { error: error.message });
    process.exit(1);
});
