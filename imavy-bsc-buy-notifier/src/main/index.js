const { JsonRpcProvider } = require('ethers');
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

function shortWallet(address) {
    const safe = String(address || '').trim();
    if (!safe || !safe.startsWith('0x') || safe.length < 10) {
        return '0x????...????';
    }
    return `${safe.slice(0, 6)}...${safe.slice(-4)}`;
}

function formatUsd(value) {
    return value.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function formatTokenAmount(value) {
    if (!Number.isFinite(value)) {
        return '0';
    }

    if (value >= 1_000_000) {
        return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }

    if (value >= 10_000) {
        return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }

    if (value >= 1) {
        return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
    }

    return value.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function buildMessage(payload) {
    return [
        `🟢 NOVA COMPRA | ${payload.symbol}`,
        '',
        `💰 USD: $${formatUsd(payload.usdValue)}`,
        `🪙 Tokens: ${formatTokenAmount(payload.tokenAmount)}`,
        `👤 Wallet: ${shortWallet(payload.wallet)}`,
        `🔗 Tx: https://bscscan.com/tx/${payload.txHash}`,
        `📊 Chart: https://dexscreener.com/bsc/${payload.pair}`,
        '🌐 BSC'
    ].join('\n');
}

async function run() {
    logger.info('Inicializando imavy-bsc-buy-notifier...', {
        tokens: config.tokens.map((t) => t.symbol),
        groupName: config.whatsapp.groupName
    });

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
        wsBackoffStepsMs: config.bsc.wsBackoffStepsMs,
        logger
    });

    listener.on('buy', async (buyEvent) => {
        try {
            const dedupKey = `${buyEvent.txHash}:${buyEvent.logIndex}`;
            if (dedupFilter.isDuplicateAndMark(dedupKey)) {
                logger.debug('Swap duplicado ignorado.', {
                    key: dedupKey,
                    symbol: buyEvent.symbol
                });
                return;
            }

            const bnbPrice = priceService.getPrice();
            if (!Number.isFinite(bnbPrice) || bnbPrice <= 0) {
                logger.warn('Preco BNB indisponivel. Compra ignorada temporariamente.', {
                    symbol: buyEvent.symbol,
                    txHash: buyEvent.txHash
                });
                return;
            }

            const usdValue = buyEvent.bnbIn * bnbPrice;
            if (!Number.isFinite(usdValue) || usdValue <= config.filters.minUsdAlert) {
                logger.debug('Compra abaixo do valor minimo. Ignorada.', {
                    symbol: buyEvent.symbol,
                    txHash: buyEvent.txHash,
                    usdValue
                });
                return;
            }

            if (cooldownFilter.isInCooldown(buyEvent.symbol)) {
                logger.debug('Compra em cooldown. Ignorada.', {
                    symbol: buyEvent.symbol,
                    txHash: buyEvent.txHash
                });
                return;
            }

            const suspicious = await mevFilter.isSuspicious(buyEvent.txHash);
            if (suspicious) {
                logger.warn('Compra suspeita de MEV/arbitragem ignorada.', {
                    symbol: buyEvent.symbol,
                    txHash: buyEvent.txHash
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
                logger.warn('Falha ao resolver wallet da transacao. Usando campo "to" do swap.', {
                    txHash: buyEvent.txHash,
                    error: error.message
                });
            }

            cooldownFilter.hit(buyEvent.symbol);

            const message = buildMessage({
                symbol: buyEvent.symbol,
                usdValue,
                tokenAmount: buyEvent.tokenOut,
                wallet,
                txHash: buyEvent.txHash,
                pair: buyEvent.pair
            });

            await whatsappClient.sendMessageWithRetry(message);

            logger.info('Alerta BUY enviado com sucesso.', {
                symbol: buyEvent.symbol,
                txHash: buyEvent.txHash,
                usdValue,
                source: buyEvent.source
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
