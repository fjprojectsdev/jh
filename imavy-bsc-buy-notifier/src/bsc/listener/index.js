const { EventEmitter } = require('events');
const { JsonRpcProvider, WebSocketProvider, getAddress } = require('ethers');
const { BuyDetector } = require('../buyDetector');

const DEFAULT_MAX_TX_AGE_MS = 5 * 60 * 1000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function sortLogs(logs) {
    return logs.sort((a, b) => {
        if (Number(a.blockNumber) !== Number(b.blockNumber)) {
            return Number(a.blockNumber) - Number(b.blockNumber);
        }
        const idxA = Number(a.index ?? a.logIndex ?? 0);
        const idxB = Number(b.index ?? b.logIndex ?? 0);
        return idxA - idxB;
    });
}

function buildTxTimingMeta({
    txHash,
    blockNumber,
    timestampMs,
    nowMs = Date.now(),
    source
}) {
    const safeBlockNumber = Number(blockNumber);
    const safeTimestampMs = Number(timestampMs);
    const hasTimestamp = Number.isFinite(safeTimestampMs) && safeTimestampMs > 0;
    const ageMs = hasTimestamp ? nowMs - safeTimestampMs : null;

    return {
        txHash: txHash || null,
        blockNumber: Number.isFinite(safeBlockNumber) ? safeBlockNumber : null,
        txTimestampUtc: hasTimestamp ? new Date(safeTimestampMs).toISOString() : null,
        serverNowUtc: new Date(nowMs).toISOString(),
        ageMinutes: ageMs === null ? null : Number((ageMs / 60_000).toFixed(3)),
        source
    };
}

function isPrunedHistoryError(error) {
    const message = String(error && error.message ? error.message : '');
    return /history has been pruned|pruned for this block/i.test(message);
}

class BscSwapListener extends EventEmitter {
    constructor({
        wsUrl,
        httpUrl,
        detectors,
        heartbeatMs,
        pollIntervalMs,
        pollBatchSize,
        maxTxAgeMs,
        wsBackoffStepsMs,
        initialPollCursor,
        onPollCursorUpdated,
        logger
    }) {
        super();
        this.wsUrl = wsUrl;
        this.httpUrl = httpUrl;
        this.detectors = detectors || [];
        this.heartbeatMs = Number(heartbeatMs) || 30_000;
        this.pollIntervalMs = Number(pollIntervalMs) || 5_000;
        this.pollBatchSize = Number(pollBatchSize) || 200;
        this.maxTxAgeMs = Number.isFinite(Number(maxTxAgeMs)) && Number(maxTxAgeMs) > 0
            ? Number(maxTxAgeMs)
            : DEFAULT_MAX_TX_AGE_MS;
        this.wsBackoffStepsMs = Array.isArray(wsBackoffStepsMs) && wsBackoffStepsMs.length > 0
            ? wsBackoffStepsMs
            : [2_000, 5_000, 10_000, 20_000, 30_000, 45_000, 60_000];
        this.logger = logger;
        this.initialPollCursor = Number.isFinite(Number(initialPollCursor))
            ? Math.max(0, Number(initialPollCursor))
            : null;
        this.onPollCursorUpdated = typeof onPollCursorUpdated === 'function'
            ? onPollCursorUpdated
            : null;

        this.swapTopic = BuyDetector.getSwapTopic();
        this.httpProvider = new JsonRpcProvider(this.httpUrl);
        this.wsProvider = null;
        this.wsNativeSocket = null;
        this.blockTimestampCache = new Map();

        this.running = false;
        this.wsOnline = false;
        this.wsReconnectTimer = null;
        this.wsBackoffIndex = 0;
        this.heartbeatTimer = null;
        this.pollTimer = null;
        this.pollCursor = null;
        this.polling = false;

        this.logFilter = null;
        this.logHandler = null;
        this.wsCloseHandler = null;
        this.wsErrorHandler = null;

        this.detectorByPair = new Map();
        for (const detector of this.detectors) {
            this.detectorByPair.set(detector.pair.toLowerCase(), detector);
        }
    }

    async start() {
        this.running = true;
        if (this.pollCursor === null && Number.isFinite(this.initialPollCursor)) {
            this.pollCursor = this.initialPollCursor;
        }
        await this.connectWebSocket();
        this.startHeartbeat();
        this.startPollingFallback();
        try {
            await this.pollOnce();
        } catch (error) {
            if (this.logger) {
                this.logger.warn('Falha no catch-up inicial do BUY ALERT.', { error: error.message });
            }
        }
    }

    async stop() {
        this.running = false;
        this.wsOnline = false;

        if (this.wsReconnectTimer) {
            clearTimeout(this.wsReconnectTimer);
            this.wsReconnectTimer = null;
        }

        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }

        await this.detachWebSocket();
    }

    getPairAddresses() {
        return this.detectors.map((detector) => detector.pair);
    }

    async detachWebSocket() {
        if (!this.wsProvider) {
            return;
        }

        try {
            if (this.logFilter && this.logHandler) {
                this.wsProvider.off(this.logFilter, this.logHandler);
            }
        } catch (_) {
            // noop
        }

        try {
            if (this.wsNativeSocket && this.wsCloseHandler && typeof this.wsNativeSocket.off === 'function') {
                this.wsNativeSocket.off('close', this.wsCloseHandler);
            }
            if (this.wsNativeSocket && this.wsErrorHandler && typeof this.wsNativeSocket.off === 'function') {
                this.wsNativeSocket.off('error', this.wsErrorHandler);
            }
        } catch (_) {
            // noop
        }

        try {
            await this.wsProvider.destroy();
        } catch (_) {
            // noop
        }

        this.wsProvider = null;
        this.wsNativeSocket = null;
        this.logFilter = null;
        this.logHandler = null;
        this.wsCloseHandler = null;
        this.wsErrorHandler = null;
    }

    async connectWebSocket() {
        if (!this.running) {
            return;
        }

        await this.detachWebSocket();

        const provider = new WebSocketProvider(this.wsUrl);
        this.wsProvider = provider;
        this.logFilter = {
            address: this.getPairAddresses(),
            topics: [this.swapTopic]
        };

        this.logHandler = async (log) => {
            try {
                await this.processLog(log, 'ws');
            } catch (error) {
                if (this.logger) {
                    this.logger.error('Erro ao processar log WS.', { error: error.message });
                }
            }
        };

        provider.on(this.logFilter, this.logHandler);

        const blockNumber = await provider.getBlockNumber();
        this.wsOnline = true;
        this.wsBackoffIndex = 0;

        if (this.pollCursor === null) {
            this.pollCursor = Math.max(0, Number(blockNumber) - 1);
        }

        this.attachNativeWebSocketHandlers(provider);

        if (this.logger) {
            this.logger.info('WebSocket conectado e inscrito no Swap.', {
                blockNumber,
                pairs: this.getPairAddresses()
            });
        }

        this.emit('ws:online');
    }

    attachNativeWebSocketHandlers(provider) {
        const nativeSocket = provider.websocket || provider._websocket;
        this.wsNativeSocket = nativeSocket || null;

        if (!nativeSocket || typeof nativeSocket.on !== 'function') {
            if (this.logger) {
                this.logger.warn('Provider WS sem acesso direto ao socket para eventos close/error.');
            }
            return;
        }

        this.wsCloseHandler = async (code) => {
            await this.handleWebSocketFailure(`close:${code}`);
        };

        this.wsErrorHandler = async (error) => {
            await this.handleWebSocketFailure('error', error);
        };

        nativeSocket.on('close', this.wsCloseHandler);
        nativeSocket.on('error', this.wsErrorHandler);
    }

    async handleWebSocketFailure(reason, error) {
        if (!this.running) {
            return;
        }

        if (this.logger) {
            this.logger.warn('WebSocket indisponivel. Iniciando reconexao.', {
                reason,
                error: error ? error.message : undefined
            });
        }

        const wasOnline = this.wsOnline;
        this.wsOnline = false;
        if (wasOnline) {
            this.emit('ws:offline', { reason });
        }

        await this.detachWebSocket();
        this.scheduleReconnect();
    }

    scheduleReconnect() {
        if (!this.running || this.wsReconnectTimer) {
            return;
        }

        const idx = Math.min(this.wsBackoffIndex, this.wsBackoffStepsMs.length - 1);
        const delayMs = this.wsBackoffStepsMs[idx];
        this.wsBackoffIndex += 1;

        if (this.logger) {
            this.logger.info('Agendando reconexao WebSocket.', { delayMs });
        }

        this.wsReconnectTimer = setTimeout(async () => {
            this.wsReconnectTimer = null;

            try {
                await this.connectWebSocket();
            } catch (error) {
                if (this.logger) {
                    this.logger.error('Falha na reconexao WebSocket.', { error: error.message });
                }
                this.scheduleReconnect();
            }
        }, delayMs);

        if (typeof this.wsReconnectTimer.unref === 'function') {
            this.wsReconnectTimer.unref();
        }
    }

    startHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }

        this.heartbeatTimer = setInterval(async () => {
            if (!this.running || !this.wsOnline || !this.wsProvider) {
                return;
            }

            try {
                await this.wsProvider.getBlockNumber();
            } catch (error) {
                await this.handleWebSocketFailure('heartbeat-failed', error);
            }
        }, this.heartbeatMs);

        if (typeof this.heartbeatTimer.unref === 'function') {
            this.heartbeatTimer.unref();
        }
    }

    startPollingFallback() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
        }

        this.pollTimer = setInterval(async () => {
            if (!this.running) {
                return;
            }

            if (this.polling) {
                return;
            }

            this.polling = true;
            try {
                await this.pollOnce();
            } catch (error) {
                if (this.logger) {
                    this.logger.error('Falha no fallback polling HTTP.', { error: error.message });
                }
            } finally {
                this.polling = false;
            }
        }, this.pollIntervalMs);

        if (typeof this.pollTimer.unref === 'function') {
            this.pollTimer.unref();
        }
    }

    async pollOnce() {
        if (this.pollCursor === null) {
            const latest = await this.httpProvider.getBlockNumber();
            this.pollCursor = Math.max(0, Number(latest) - 1);
            return;
        }

        const latestBlock = Number(await this.httpProvider.getBlockNumber());
        const fromBlock = this.pollCursor + 1;

        if (fromBlock > latestBlock) {
            return;
        }

        const toBlock = Math.min(fromBlock + this.pollBatchSize - 1, latestBlock);
        const filter = {
            address: this.getPairAddresses(),
            topics: [this.swapTopic],
            fromBlock,
            toBlock
        };

        let logs;
        try {
            logs = await this.getLogsWithRetry(filter, 4, 1_500);
        } catch (error) {
            if (!isPrunedHistoryError(error)) {
                throw error;
            }

            const latestSafeCursor = Math.max(0, latestBlock - 1);
            this.pollCursor = latestSafeCursor;
            if (this.onPollCursorUpdated) {
                await this.onPollCursorUpdated(latestSafeCursor);
            }

            if (this.logger) {
                this.logger.warn('Historico podado no polling HTTP do BUY ALERT. Avancando cursor para checkpoint seguro.', {
                    fromBlock,
                    toBlock,
                    latestBlock,
                    newCursor: latestSafeCursor,
                    error: error.message
                });
            }
            return;
        }

        for (const log of sortLogs(logs)) {
            await this.processLog(log, 'poll');
        }

        this.pollCursor = toBlock;
        if (this.onPollCursorUpdated) {
            await this.onPollCursorUpdated(toBlock);
        }

        if (this.logger) {
            this.logger.debug('Batch de polling processado.', {
                fromBlock,
                toBlock,
                logs: logs.length
            });
        }
    }

    async getLogsWithRetry(filter, maxAttempts = 4, baseDelayMs = 1_500) {
        let attempt = 0;
        let lastError = null;

        while (attempt < maxAttempts) {
            attempt += 1;
            try {
                return await this.httpProvider.getLogs(filter);
            } catch (error) {
                lastError = error;
                const message = String(error && error.message ? error.message : '');
                const shouldRetry = /(429|rate|limit|timeout|busy|too many)/i.test(message);
                if (!shouldRetry || attempt >= maxAttempts) {
                    throw error;
                }

                const waitMs = baseDelayMs * attempt;
                if (this.logger) {
                    this.logger.warn('Rate limit em getLogs. Tentando novamente.', {
                        attempt,
                        waitMs,
                        error: message
                    });
                }
                await sleep(waitMs);
            }
        }

        throw lastError || new Error('Falha desconhecida em getLogsWithRetry.');
    }

    async getBlockTimestampMs(blockNumber) {
        const key = Number(blockNumber);
        if (!Number.isFinite(key) || key <= 0) {
            return null;
        }

        if (this.blockTimestampCache.has(key)) {
            return this.blockTimestampCache.get(key);
        }

        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                const block = await this.httpProvider.getBlock(key);
                const timestampMs = Number(block && block.timestamp ? block.timestamp : 0) * 1000;
                const safeTimestampMs = Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : null;
                if (safeTimestampMs) {
                    this.blockTimestampCache.set(key, safeTimestampMs);
                    return safeTimestampMs;
                }
            } catch (error) {
                lastError = error;
            }

            await sleep(400 * attempt);
        }

        this.blockTimestampCache.set(key, null);
        if (this.logger) {
            this.logger.warn('Falha ao ler timestamp UTC do bloco do BUY ALERT.', {
                blockNumber: key,
                error: lastError ? (lastError.message || String(lastError)) : 'block-without-timestamp'
            });
        }
        return null;
    }

    async processLog(log, source) {
        if (log && log.removed) {
            return;
        }

        let pairAddress;
        try {
            pairAddress = getAddress(log.address).toLowerCase();
        } catch (_) {
            return;
        }

        const detector = this.detectorByPair.get(pairAddress);

        if (!detector) {
            return;
        }

        const txHash = String(log.transactionHash || '').trim();
        const blockNumber = Number(log.blockNumber);
        const timestampMs = await this.getBlockTimestampMs(blockNumber);
        const nowMs = Date.now();
        const timingMeta = buildTxTimingMeta({
            txHash,
            blockNumber,
            timestampMs,
            nowMs,
            source
        });

        if (!timestampMs) {
            if (this.logger) {
                this.logger.warn('BUY DEBUG: log Swap ignorado sem timestamp UTC do bloco.', {
                    ...timingMeta,
                    reason: 'missing-block-timestamp'
                });
            }
            return;
        }

        const ageMs = nowMs - timestampMs;
        if (ageMs > this.maxTxAgeMs) {
            if (this.logger) {
                this.logger.info('BUY DEBUG: log Swap ignorado por ser antigo.', {
                    ...timingMeta,
                    maxAgeMinutes: Number((this.maxTxAgeMs / 60_000).toFixed(3)),
                    reason: 'older-than-max-age'
                });
            }
            return;
        }

        const buyEvent = detector.detectBuyFromLog(log);
        if (!buyEvent) {
            if (this.logger) {
                this.logger.debug('BUY DEBUG: Swap ignorado; nao e compra real do token monitorado.', {
                    ...timingMeta,
                    reason: 'not-target-token-buy'
                });
            }
            return;
        }

        this.emit('buy', {
            ...buyEvent,
            source,
            blockTimestampMs: timestampMs,
            blockTimestampUtc: timingMeta.txTimestampUtc,
            serverNowUtc: timingMeta.serverNowUtc,
            ageMinutes: timingMeta.ageMinutes
        });
    }
}

module.exports = {
    BscSwapListener
};
