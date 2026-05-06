import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { sendSafeMessage } from './messageHandler.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (typeof global.WebSocket === 'undefined') {
    global.WebSocket = require('ws');
}

const { Contract, Interface, JsonRpcProvider, formatUnits, getAddress, id, zeroPadValue } = require('ethers');
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
const DEFAULT_MIN_USD_ALERT = 50;
const DEFAULT_MIN_CRIPTO_NO_PIX_BRL_ALERT = 250;
const DEFAULT_CRIPTO_NO_PIX_FEE_PERCENT = 4.5196;
const DEFAULT_FSX_PRESALE_MIN_BRL_ALERT = 1;
const DEFAULT_FSX_PRESALE_STAGE = 'Phase 7';
const DEFAULT_FSX_PRESALE_STAGE_TEXT = 'Fase 7';
const DEFAULT_FSX_SITE_PRESALE_CONTRACT = getAddress('0x6d12AB1E393B35a487f52F6C758D19d12e4d7Ba4');
const DEFAULT_BUY_ALERT_PROMO_IMAGE = path.resolve(__dirname, '..', 'assets', 'buy-alert-vellora.png');
const DEFAULT_BUY_ALERT_WALLET_STATS_PATH = path.resolve(process.cwd(), 'buy_alert_wallet_stats.json');
const DEFAULT_BUY_ALERT_PROGRESS_PATH = path.resolve(process.cwd(), 'buy_alert_progress.json');
const DEFAULT_BUY_ALERT_MAX_TX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_BUY_ALERT_WHALE_USD = 500;
const DEFAULT_USDT_BRL_PRICE_URL = 'https://api.binance.com/api/v3/ticker/price?symbol=USDTBRL';
const DEFAULT_BNB_PRICE_URLS = [
    'https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT',
    'https://api.mexc.com/api/v3/ticker/price?symbol=BNBUSDT'
];
const DEFAULT_USDT_BRL_PRICE_URLS = [
    DEFAULT_USDT_BRL_PRICE_URL,
    'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=brl',
    'https://economia.awesomeapi.com.br/json/last/USD-BRL'
];
const DEFAULT_CRIPTO_NO_PIX_CONTRACT = getAddress('0x16F1b9B34F2596c5538E0ad1B10C85D4B2820b82');
const ERC20_DECIMALS_ABI = [
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)'
];
const CRIPTO_NO_PIX_ABI = [
    'function criptoNoPix(address _tokenAddress,address _holder,uint256 _amountInUSDT,uint256 _mintokenAmount,address _router)'
];
const FSX_SITE_PRESALE_ABI = [
    'event TokensPurchased(address indexed buyer,string paymentMethod,uint256 paymentAmount,uint256 tokensReceived,uint256 usdValue,address indexed referrer)'
];
const CRIPTO_NO_PIX_FUNCTION_SELECTOR = '0x9b6bb74e';
const TOKEN_TRANSFER_TOPIC = id('Transfer(address,address,uint256)');
const criptoNoPixInterface = new Interface(CRIPTO_NO_PIX_ABI);
const fsxSitePresaleInterface = new Interface(FSX_SITE_PRESALE_ABI);
const FSX_SITE_PRESALE_TOPIC = id('TokensPurchased(address,string,uint256,uint256,uint256,address)');
const NIX_TOKEN_ADDRESS = getAddress('0xBe96fcF736AD906b1821Ef74A0e4e346C74e6221');
const BURN_ADDRESS_SET = new Set([
    '0x000000000000000000000000000000000000dead',
    '0x0000000000000000000000000000000000000000'
]);
const TOKEN_DISPLAY_NAMES = {
    NIX: 'NIX',
    SNAP: 'Snappy',
    FSX: 'FSX'
};
const KNOWN_BSC_ROUTERS = new Map([
    [getAddress('0x10ED43C718714eb63d5aA57B78B54704E256024E'.toLowerCase()), 'PancakeSwap'],
    [getAddress('0x13f4EA83D0bd40E75C8222255bc855a974568Dd4'.toLowerCase()), 'PancakeSwap'],
    [getAddress('0x1b81D678ffb9C0263b24A97847620C99d213eB14'.toLowerCase()), 'PancakeSwap'],
    [getAddress('0xcF0feBd3f17CEf5b47b0dD58c314Bb8fB4fC06B2'.toLowerCase()), 'PancakeSwap']
]);
const CRIPTO_NO_PIX_SUPPORTED_TOKENS = [
    ...TOKENS.map((token) => ({
        symbol: token.symbol,
        token: getAddress(token.token),
        pair: token.pair ? getAddress(token.pair) : null
    })),
    {
        symbol: 'FSX',
        token: getAddress('0xcD4fA13B6f5Cad65534DC244668C5270EC7e961a'),
        pair: null
    }
];

let runtime = null;
let promoImageMissingWarned = false;
let walletStatsState = null;
let progressState = null;
const blockTimestampCache = new Map();

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

function envUrlList(name, fallback = []) {
    const raw = env(name, '');
    const source = raw
        ? raw.split(',')
        : (Array.isArray(fallback) ? fallback : []);

    return source
        .map((item) => String(item || '').trim())
        .filter(Boolean);
}

export function resolveBuyAlertGroups() {
    const fallback = DEFAULT_BUY_ALERT_GROUPS.join(',');
    const raw = env('BUY_ALERT_GROUPS', env('INTEL_GROUPS', fallback));
    const parsed = raw
        .split(',')
        .map((groupId) => groupId.trim())
        .filter(Boolean);
    const filtered = parsed.filter((groupId) => FIXED_BUY_ALERT_GROUP_SET.has(groupId));
    return filtered.length > 0 ? filtered : DEFAULT_BUY_ALERT_GROUPS;
}

function resolveWalletStatsFile() {
    return env('BUY_ALERT_WALLET_STATS_FILE', DEFAULT_BUY_ALERT_WALLET_STATS_PATH);
}

function resolveBuyAlertProgressFile() {
    return env('BUY_ALERT_PROGRESS_FILE', DEFAULT_BUY_ALERT_PROGRESS_PATH);
}

function normalizeWalletKey(address) {
    const safe = String(address || '').trim().toLowerCase();
    return safe.startsWith('0x') ? safe : '';
}

function createEmptyWalletStatsState(filePath) {
    return {
        filePath,
        wallets: {},
        dirty: false,
        saveTimer: null
    };
}

function createEmptyProgressState(filePath) {
    return {
        filePath,
        cursors: {},
        sentTxHashes: {},
        dirty: false,
        saveTimer: null
    };
}

function loadWalletStatsState() {
    const filePath = resolveWalletStatsFile();
    const state = createEmptyWalletStatsState(filePath);

    try {
        if (!fs.existsSync(filePath)) {
            return state;
        }

        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.wallets && typeof parsed.wallets === 'object') {
            state.wallets = parsed.wallets;
        }
    } catch (error) {
        logger.warn('Falha ao carregar historico de wallets do BUY ALERT. Iniciando vazio.', {
            filePath,
            error: error.message
        });
    }

    return state;
}

function flushWalletStatsState(state) {
    if (!state || !state.dirty) return;

    fs.writeFileSync(state.filePath, JSON.stringify({
        updatedAt: new Date().toISOString(),
        wallets: state.wallets
    }, null, 2), 'utf8');
    state.dirty = false;
}

function flushProgressState(state) {
    if (!state || !state.dirty) return;

    fs.writeFileSync(state.filePath, JSON.stringify({
        updatedAt: new Date().toISOString(),
        cursors: state.cursors,
        sentTxHashes: state.sentTxHashes || {}
    }, null, 2), 'utf8');
    state.dirty = false;
}

function scheduleWalletStatsFlush(state) {
    if (!state || state.saveTimer) return;

    state.saveTimer = setTimeout(() => {
        state.saveTimer = null;
        try {
            flushWalletStatsState(state);
        } catch (error) {
            logger.warn('Falha ao salvar historico de wallets do BUY ALERT.', {
                filePath: state.filePath,
                error: error.message
            });
        }
    }, 500);
}

function scheduleProgressFlush(state) {
    if (!state || state.saveTimer) return;

    state.saveTimer = setTimeout(() => {
        state.saveTimer = null;
        try {
            flushProgressState(state);
        } catch (error) {
            logger.warn('Falha ao salvar progresso de blocos do BUY ALERT.', {
                filePath: state.filePath,
                error: error.message
            });
        }
    }, 500);
}

function getSavedCursor(state, key) {
    if (!state || !key) return null;
    const raw = Number(state.cursors?.[key]?.lastSuccessfulBlock);
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
}

function setSavedCursor(state, key, blockNumber, meta = {}) {
    const safeBlock = Number(blockNumber);
    if (!state || !key || !Number.isFinite(safeBlock) || safeBlock < 0) {
        return null;
    }

    const previous = getSavedCursor(state, key);
    if (previous !== null && safeBlock < previous) {
        return previous;
    }

    state.cursors[key] = {
        lastSuccessfulBlock: safeBlock,
        updatedAt: new Date().toISOString(),
        ...meta
    };
    state.dirty = true;
    scheduleProgressFlush(state);
    return safeBlock;
}

function normalizeTxHash(txHash) {
    const safe = String(txHash || '').trim().toLowerCase();
    return /^0x[a-f0-9]{64}$/.test(safe) ? safe : '';
}

function hasSentTxHash(state, txHash) {
    const key = normalizeTxHash(txHash);
    if (!state || !key) return false;
    return Boolean(state.sentTxHashes && state.sentTxHashes[key]);
}

function markSentTxHash(state, txHash, meta = {}) {
    const key = normalizeTxHash(txHash);
    if (!state || !key) return false;

    if (!state.sentTxHashes || typeof state.sentTxHashes !== 'object') {
        state.sentTxHashes = {};
    }

    state.sentTxHashes[key] = {
        txHash: key,
        sentAt: new Date().toISOString(),
        ...meta
    };
    state.dirty = true;
    try {
        flushProgressState(state);
    } catch (error) {
        logger.warn('Falha ao persistir hash publicado do BUY ALERT; tentando salvar em lote.', {
            txHash: key,
            filePath: state.filePath,
            error: error.message || String(error)
        });
        scheduleProgressFlush(state);
    }
    return true;
}

function registerWalletBuy(state, payload) {
    const walletKey = normalizeWalletKey(payload.wallet);
    if (!state || !walletKey) {
        return { totalBuys: 1, symbolBuys: 1 };
    }

    if (!state.wallets[walletKey] || typeof state.wallets[walletKey] !== 'object') {
        state.wallets[walletKey] = {
            totalBuys: 0,
            firstSeenAt: null,
            lastSeenAt: null,
            symbols: {}
        };
    }

    const entry = state.wallets[walletKey];
    const symbolKey = String(payload.symbol || '').trim().toUpperCase() || 'UNKNOWN';
    const nowIso = new Date(payload.timestamp || Date.now()).toISOString();

    if (!entry.symbols[symbolKey] || typeof entry.symbols[symbolKey] !== 'object') {
        entry.symbols[symbolKey] = {
            buys: 0,
            totalUsd: 0,
            totalBrl: 0,
            firstBuyAt: null,
            lastBuyAt: null,
            lastTxHash: null
        };
    }

    entry.totalBuys = Number(entry.totalBuys || 0) + 1;
    entry.firstSeenAt = entry.firstSeenAt || nowIso;
    entry.lastSeenAt = nowIso;

    entry.symbols[symbolKey].buys = Number(entry.symbols[symbolKey].buys || 0) + 1;
    entry.symbols[symbolKey].totalUsd = Number(entry.symbols[symbolKey].totalUsd || 0) + Number(payload.usdValue || 0);
    entry.symbols[symbolKey].totalBrl = Number(entry.symbols[symbolKey].totalBrl || 0) + Number(payload.brlValue || 0);
    entry.symbols[symbolKey].firstBuyAt = entry.symbols[symbolKey].firstBuyAt || nowIso;
    entry.symbols[symbolKey].lastBuyAt = nowIso;
    entry.symbols[symbolKey].lastTxHash = payload.txHash || entry.symbols[symbolKey].lastTxHash || null;

    state.dirty = true;
    scheduleWalletStatsFlush(state);

    return {
        totalBuys: entry.totalBuys,
        symbolBuys: entry.symbols[symbolKey].buys
    };
}

function classifyBuyAlert(payload, stats, whaleUsdThreshold) {
    const usdValue = Number(payload.usdValue || 0);
    const symbolBuys = Number(stats?.symbolBuys || 1);
    const isWhale = Number.isFinite(usdValue) && usdValue >= whaleUsdThreshold;

    if (isWhale && symbolBuys > 1) return `ðŸ‹ BALEIA COMPRANDO NOVAMENTE | ${payload.symbol}`;
    if (isWhale) return `ðŸ‹ WHALE ALERT | ${payload.symbol}`;
    if (symbolBuys <= 1) return `ðŸ†• NOVO HOLDER | ${payload.symbol}`;
    if (symbolBuys === 2) return `ðŸ” COMPRANDO NOVAMENTE | ${payload.symbol}`;
    return `ðŸ¦ HOLDER ANTIGO | ${payload.symbol}`;
}

function formatHolderSince(dateLike) {
    if (!dateLike) return null;
    const date = new Date(dateLike);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toLocaleDateString('pt-BR');
}

function decorateBuyAlertMessage(text, payload) {
    const lines = String(text || '').split('\n');

    if (payload.title) {
        lines[0] = payload.title;
    }

    const walletIndex = lines.findIndex((line) => String(line || '').includes('Wallet:'));
    const holderSince = formatHolderSince(payload.holderSince);
    if (holderSince && walletIndex >= 0) {
        lines.splice(walletIndex + 1, 0, `Holder desde: ${holderSince}`);
    }

    return lines.join('\n');
}

async function getBlockTimestampDetails(provider, blockNumber) {
    const key = Number(blockNumber);
    if (!Number.isFinite(key) || key <= 0) return null;

    if (blockTimestampCache.has(key)) {
        const cached = blockTimestampCache.get(key);
        if (cached && typeof cached === 'object') {
            return cached;
        }
        if (typeof cached === 'string') {
            const cachedMs = Date.parse(cached);
            return {
                iso: Number.isFinite(cachedMs) ? new Date(cachedMs).toISOString() : null,
                ms: Number.isFinite(cachedMs) ? cachedMs : null
            };
        }
    }

    try {
        const block = await provider.getBlock(key);
        const timestampMs = Number(block?.timestamp || 0) * 1000;
        const details = {
            iso: timestampMs > 0 ? new Date(timestampMs).toISOString() : null,
            ms: timestampMs > 0 ? timestampMs : null
        };
        blockTimestampCache.set(key, details);
        return details;
    } catch (_) {
        return null;
    }
}

async function getBlockTimestamp(provider, blockNumber) {
    const details = await getBlockTimestampDetails(provider, blockNumber);
    return details?.iso || null;
}

function buildTxTimingMeta({
    txHash,
    blockNumber,
    blockTimestampMs,
    blockTimestampUtc,
    nowMs = Date.now(),
    source
}) {
    const safeBlockNumber = Number(blockNumber);
    const parsedTimestampMs = Number(blockTimestampMs);
    const fallbackTimestampMs = blockTimestampUtc ? Date.parse(blockTimestampUtc) : NaN;
    const timestampMs = Number.isFinite(parsedTimestampMs) && parsedTimestampMs > 0
        ? parsedTimestampMs
        : fallbackTimestampMs;
    const hasTimestamp = Number.isFinite(timestampMs) && timestampMs > 0;
    const ageMs = hasTimestamp ? nowMs - timestampMs : null;

    return {
        txHash: txHash || null,
        blockNumber: Number.isFinite(safeBlockNumber) ? safeBlockNumber : null,
        txTimestampUtc: hasTimestamp ? new Date(timestampMs).toISOString() : null,
        serverNowUtc: new Date(nowMs).toISOString(),
        ageMinutes: ageMs === null ? null : Number((ageMs / 60_000).toFixed(3)),
        source
    };
}

async function getTxTimingMeta(provider, blockNumber, txHash, source) {
    const details = await getBlockTimestampDetails(provider, blockNumber);
    return buildTxTimingMeta({
        txHash,
        blockNumber,
        blockTimestampMs: details?.ms || null,
        blockTimestampUtc: details?.iso || null,
        source
    });
}

function isTxOlderThanMax(timingMeta, maxTxAgeMs) {
    if (!timingMeta || !timingMeta.txTimestampUtc) {
        return false;
    }

    const timestampMs = Date.parse(timingMeta.txTimestampUtc);
    if (!Number.isFinite(timestampMs)) {
        return false;
    }

    return Date.now() - timestampMs > maxTxAgeMs;
}

function logBuyDecision(message, timingMeta, meta = {}, level = 'info') {
    const method = typeof logger[level] === 'function' ? level : 'info';
    logger[method](message, {
        ...(timingMeta || {}),
        ...meta
    });
}

async function getLogsChunked(provider, baseFilter, fromBlock, toBlock, chunkSize = 100_000) {
    if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || toBlock < fromBlock) {
        return [];
    }

    const logs = [];
    for (let start = fromBlock; start <= toBlock; start += chunkSize) {
        const end = Math.min(start + chunkSize - 1, toBlock);
        const partial = await getLogsWithRetry(provider, {
            ...baseFilter,
            fromBlock: start,
            toBlock: end
        }, 3, 1200);
        if (Array.isArray(partial) && partial.length > 0) {
            logs.push(...partial);
        }
    }
    return logs;
}

async function analyzeWalletOnChainHistory({
    provider,
    tokenAddress,
    pairAddress,
    wallet,
    blockNumber
}) {
    const normalizedWallet = normalizeWalletKey(wallet);
    const normalizedToken = normalizeWalletKey(tokenAddress);
    if (!provider || !normalizedWallet || !normalizedToken || !Number.isFinite(Number(blockNumber))) {
        return null;
    }

    const currentBlock = Number(blockNumber);
    const preBlock = Math.max(0, currentBlock - 1);
    const tokenContract = new Contract(getAddress(tokenAddress), ERC20_DECIMALS_ABI, provider);

    let hadBalanceBefore = false;
    if (preBlock > 0) {
        try {
            const preBalance = await tokenContract.balanceOf(getAddress(wallet), { blockTag: preBlock });
            hadBalanceBefore = Boolean(preBalance && preBalance > 0n);
        } catch (error) {
            logger.warn('Falha ao consultar balanceOf historico do BUY ALERT.', {
                tokenAddress,
                wallet,
                blockNumber: preBlock,
                error: error.message
            });
        }
    }

    const toTopic = zeroPadValue(normalizedWallet, 32);
    const baseFilter = {
        address: getAddress(tokenAddress),
        topics: [TOKEN_TRANSFER_TOPIC]
    };

    let matchingLogs = [];
    let mode = 'inbound-transfer';

    try {
        if (pairAddress) {
            mode = 'pair-buy';
            matchingLogs = await getLogsChunked(provider, {
                ...baseFilter,
                topics: [TOKEN_TRANSFER_TOPIC, zeroPadValue(String(pairAddress).toLowerCase(), 32), toTopic]
            }, 1, preBlock);
        }

        if (!pairAddress || matchingLogs.length === 0) {
            mode = 'inbound-transfer';
            matchingLogs = await getLogsChunked(provider, {
                ...baseFilter,
                topics: [TOKEN_TRANSFER_TOPIC, null, toTopic]
            }, 1, preBlock);
        }
    } catch (error) {
        logger.warn('Falha ao consultar historico on-chain da wallet no BUY ALERT.', {
            tokenAddress,
            pairAddress: pairAddress || null,
            wallet,
            blockNumber,
            error: error.message
        });
        return {
            available: false,
            hadBalanceBefore
        };
    }

    const priorCount = Array.isArray(matchingLogs) ? matchingLogs.length : 0;
    const firstLog = priorCount > 0 ? matchingLogs[0] : null;
    const firstSeenAt = firstLog ? await getBlockTimestamp(provider, Number(firstLog.blockNumber)) : null;

    return {
        available: true,
        mode,
        priorCount,
        totalCount: priorCount + 1,
        hadBalanceBefore,
        firstSeenAt
    };
}

function classifyOnChainBuyAlert(payload, onChainStats, whaleUsdThreshold) {
    const usdValue = Number(payload.usdValue || 0);
    const isWhale = Number.isFinite(usdValue) && usdValue >= whaleUsdThreshold;
    if (!onChainStats || onChainStats.available === false) {
        return isWhale
            ? `Ã°Å¸Ââ€¹ WHALE ALERT | ${payload.symbol}`
            : `Ã°Å¸Å¸Â¢ NOVA COMPRA | ${payload.symbol}`;
    }
    const priorCount = Number(onChainStats?.priorCount || 0);
    const hadBalanceBefore = Boolean(onChainStats?.hadBalanceBefore);

    if (isWhale && (priorCount > 0 || hadBalanceBefore)) {
        return `Ã°Å¸Ââ€¹ BALEIA COMPRANDO NOVAMENTE | ${payload.symbol}`;
    }
    if (isWhale) {
        return `Ã°Å¸Ââ€¹ WHALE ALERT | ${payload.symbol}`;
    }
    if (!hadBalanceBefore && priorCount === 0) {
        return `Ã°Å¸â€ â€¢ NOVO HOLDER | ${payload.symbol}`;
    }
    if (priorCount >= 2) {
        return `Ã°Å¸ÂÂ¦ HOLDER ANTIGO | ${payload.symbol}`;
    }
    if (priorCount >= 1 || hadBalanceBefore) {
        return `Ã°Å¸â€Â COMPRANDO NOVAMENTE | ${payload.symbol}`;
    }
    return `Ã°Å¸Å¸Â¢ NOVA COMPRA | ${payload.symbol}`;
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

function formatBrl(value) {
    return Number(value || 0).toLocaleString('pt-BR', {
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
        return number.toLocaleString('en-US', { maximumFractionDigits: 1 });
    }
    if (number >= 10_000) {
        return number.toLocaleString('en-US', { maximumFractionDigits: 3 });
    }
    if (number >= 1) {
        return number.toLocaleString('en-US', { maximumFractionDigits: 5 });
    }
    return number.toLocaleString('en-US', { maximumFractionDigits: 9 });
}

function getTokenDisplayName(symbol) {
    const safeSymbol = String(symbol || '').trim().toUpperCase();
    return TOKEN_DISPLAY_NAMES[safeSymbol] || safeSymbol || 'Token';
}

function normalizeAddressLower(address) {
    try {
        return getAddress(address).toLowerCase();
    } catch (_) {
        return String(address || '').trim().toLowerCase();
    }
}

function formatPixBonusAmount(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number <= 0) {
        return '0';
    }
    if (number >= 1) {
        return number.toLocaleString('pt-BR', {
            minimumFractionDigits: 4,
            maximumFractionDigits: 4
        });
    }
    return number.toLocaleString('pt-BR', {
        minimumFractionDigits: 5,
        maximumFractionDigits: 9
    });
}

function restoreGrossPixBrlValue(netBrlValue, feePercent) {
    const net = Number(netBrlValue || 0);
    const fee = Number(feePercent || 0);
    if (!Number.isFinite(net) || net <= 0) {
        return 0;
    }
    if (!Number.isFinite(fee) || fee <= 0 || fee >= 100) {
        return net;
    }
    return net / (1 - (fee / 100));
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

function buildCriptoNoPixAlertMessage(payload) {
    const tokenName = getTokenDisplayName(payload.symbol);
    const lines = [
        '---------------------------',
        'COMPRA NO PIX',
        '---------------------------'
    ];

    if (Number.isFinite(Number(payload.brlValue))) {
        lines.push(`\u{1F4B0} Valor: R$${formatBrl(payload.brlValue)} via PIX!`);
    }

    lines.push(`\u{1FA99} Token: ${tokenName} (${payload.symbol})`);
    lines.push('\u{1F3F7}\uFE0F Origem: Via Pix');

    if (Number.isFinite(Number(payload.cashbackNix)) && Number(payload.cashbackNix) > 0) {
        lines.push(`\u{21A9}\u{FE0F} Cashback: ${formatPixBonusAmount(payload.cashbackNix)} NIX`);
    }

    if (Number.isFinite(Number(payload.referralNix)) && Number(payload.referralNix) > 0) {
        lines.push(`\u{1F3F7}\u{FE0F} Ref: ${formatPixBonusAmount(payload.referralNix)} NIX`);
    }

    if (Number.isFinite(Number(payload.burnNix)) && Number(payload.burnNix) > 0) {
        lines.push(`\u{1F525} Burn: ${formatPixBonusAmount(payload.burnNix)} NIX`);
    }

    lines.push(`\u{1F310} Tx: https://bscscan.com/tx/${payload.txHash}`);

    const dexscreenerUrl = buildDexscreenerPairUrl(payload.pair);
    if (dexscreenerUrl) {
        lines.push(`\u{1F4C8} Dexscreener: ${dexscreenerUrl}`);
    }

    lines.push('\u26D3\uFE0F Chain: BSC');
    lines.push('');
    lines.push('\u{1F48E} Compre você também!');
    lines.push('\u{1F310} Site: criptonopix.app.br');

    return lines.join('\n');
}

function buildFsxPresaleAlertMessage(payload) {
    const lines = [
        '\u{1F525} FSX GLOBAL Presale - New Purchase!',
        ''
    ];

    if (Number.isFinite(Number(payload.usdValue))) {
        lines.push(`\u{1F4B8} Payment: $${formatUsd(payload.usdValue)} in ${String(payload.paymentMethod || 'USDT').trim().toUpperCase()}`);
    }

    lines.push('\u{1FA99} Token acquired: FSX');
    lines.push(`\u{1F4E6} Amount received: ${formatTokenAmount(payload.tokenOut)} FSX`);

    const stageLine = DEFAULT_FSX_PRESALE_STAGE_TEXT;
    if (stageLine) {
        lines.push(`\u{1F3C1} Current Stage: ${stageLine}`);
    }

    lines.push(`\u{1F464} Wallet used: ${shortWallet(payload.wallet)}`);
    lines.push(`\u{1F517} TX: https://bscscan.com/tx/${payload.txHash}`);

    return lines.join('\n');
}

function buildBuyAlertMessage(payload) {
    const isCriptoNoPix = String(payload.origin || '').trim().toLowerCase() === 'cripto no pix';
    const isFsxPresale = String(payload.origin || '').trim().toLowerCase() === 'fsx presale';
    if (isFsxPresale) {
        return buildFsxPresaleAlertMessage(payload);
    }
    if (isCriptoNoPix) {
        return buildCriptoNoPixAlertMessage(payload);
    }

    const lines = [
        `\u{1F7E2} NOVA COMPRA | ${payload.symbol}`,
        ''
    ];

    if (Number.isFinite(Number(payload.brlValue))) {
        lines.push(`\u{1F4B8} BRL: R$${formatBrl(payload.brlValue)}`);
    }

    if (Number.isFinite(Number(payload.usdValue))) {
        lines.push(`\u{1F4B0} USD: $${formatUsd(payload.usdValue)}`);
    }

    lines.push(`\u{1FA99} Tokens: ${formatTokenAmount(payload.tokenOut)}`);
    lines.push(`\u{1F464} Wallet: ${shortWallet(payload.wallet)}`);
    lines.push(`\u{1F3F7}\uFE0F Origem: ${payload.origin || 'Compra on-chain'}`);
    lines.push(`\u{1F517} Tx: https://bscscan.com/tx/${payload.txHash}`);

    const dexscreenerUrl = buildDexscreenerPairUrl(payload.pair);
    if (dexscreenerUrl) {
        lines.push(`\u{1F4C8} Dexscreener: ${dexscreenerUrl}`);
    }

    lines.push('\u{1F310} BSC');
    return lines.join('\n');
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
    const text = decorateBuyAlertMessage(buildBuyAlertMessage(payload), payload);
    const imageUrl = resolvePromoImageUrl();
    if (!imageUrl) {
        if (!promoImageMissingWarned) {
            promoImageMissingWarned = true;
            logger.warn('Imagem promocional BUY ALERT nao encontrada; fallback para texto.', {
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

export function buildConfig() {
    const configuredMinUsdAlert = envNumber('MIN_USD_ALERT', DEFAULT_MIN_USD_ALERT);
    const configuredCriptoNoPixMinBrlAlert = envNumber('CRIPTO_NO_PIX_MIN_BRL_ALERT', DEFAULT_MIN_CRIPTO_NO_PIX_BRL_ALERT);
    return {
        bscWsUrl: env('BSC_WS_URL', 'wss://bsc.publicnode.com'),
        bscHttpUrl: env('BSC_HTTP_URL', 'https://bsc.publicnode.com'),
        enableCriptoNoPixPolling: envBoolean('ENABLE_CRIPTO_NO_PIX_POLLING', false),
        enableFsxSitePresalePolling: envBoolean('ENABLE_FSX_SITE_PRESALE_POLLING', false),
        minUsdAlert: Math.max(1, configuredMinUsdAlert),
        criptoNoPixMinBrlAlert: Math.max(1, configuredCriptoNoPixMinBrlAlert),
        fsxPresaleMinBrlAlert: Math.max(1, envNumber('FSX_PRESALE_MIN_BRL_ALERT', DEFAULT_FSX_PRESALE_MIN_BRL_ALERT)),
        // Keep the outgoing FSX presale alert stage aligned with the live campaign.
        fsxPresaleStage: env('FSX_PRESALE_STAGE', DEFAULT_FSX_PRESALE_STAGE),
        fsxPresaleStageText: env('FSX_PRESALE_STAGE_TEXT', DEFAULT_FSX_PRESALE_STAGE_TEXT),
        fsxSitePresaleContract: getAddress(env('FSX_SITE_PRESALE_CONTRACT', DEFAULT_FSX_SITE_PRESALE_CONTRACT)),
        fsxSitePresaleReplayFromBlock: Math.max(0, envNumber('FSX_SITE_PRESALE_REPLAY_FROM_BLOCK', 0)),
        criptoNoPixReplayFromBlock: Math.max(0, envNumber('CRIPTO_NO_PIX_REPLAY_FROM_BLOCK', 0)),
        whaleUsdAlert: Math.max(1, envNumber('BUY_ALERT_WHALE_USD', DEFAULT_BUY_ALERT_WHALE_USD)),
        criptoNoPixContract: getAddress(env('CRIPTO_NO_PIX_CONTRACT', DEFAULT_CRIPTO_NO_PIX_CONTRACT)),
        criptoNoPixFeePercent: Math.max(0, envNumber('CRIPTO_NO_PIX_FEE_PERCENT', DEFAULT_CRIPTO_NO_PIX_FEE_PERCENT)),
        tokenCooldownMs: envNumber('TOKEN_COOLDOWN_MS', 8_000),
        dedupTtlMs: envNumber('DEDUP_TTL_MS', 24 * 60 * 60 * 1_000),
        maxTxAgeMs: Math.max(1_000, envNumber('BUY_ALERT_MAX_TX_AGE_MINUTES', DEFAULT_BUY_ALERT_MAX_TX_AGE_MS / 60_000) * 60_000),
        enableMevFilter: envBoolean('ENABLE_MEV_FILTER', true),
        mevSwapLimit: envNumber('MEV_SWAP_LIMIT', 3),
        bnbPriceUrls: envUrlList('BNB_PRICE_URL', DEFAULT_BNB_PRICE_URLS),
        usdtBrlPriceUrls: envUrlList('USDT_BRL_PRICE_URL', DEFAULT_USDT_BRL_PRICE_URLS),
        bnbPriceRefreshMs: envNumber('BNB_PRICE_REFRESH_MS', 60_000),
        heartbeatMs: envNumber('HEARTBEAT_MS', 30_000),
        pollIntervalMs: envNumber('POLL_INTERVAL_MS', 5_000),
        pollBatchSize: envNumber('POLL_BATCH_SIZE', 25),
        wsBackoffMs: envNumberList('WS_BACKOFF_STEPS_MS', [2_000, 5_000, 10_000, 20_000, 30_000, 45_000, 60_000])
    };
}

async function sendBuyAlert(sock, payload, groups) {
    const results = await Promise.allSettled(
        groups.map(async (groupId) => {
            const sent = await sendSafeMessage(sock, groupId, cloneMessagePayload(payload));
            if (!sent) {
                throw new Error('Payload bloqueado por validacao de mensagem vazia.');
            }
            return sent;
        })
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

    return { delivered, failed };
}

async function getLogsWithRetry(provider, filter, maxAttempts = 4, baseDelayMs = 1_500) {
    let attempt = 0;
    let lastError = null;

    while (attempt < maxAttempts) {
        attempt += 1;
        try {
            return await provider.getLogs(filter);
        } catch (error) {
            lastError = error;
            const message = String(error && error.message ? error.message : '');
            const invalidBlockRange = /invalid block range params/i.test(message);
            const shouldRetry = !invalidBlockRange && /(429|rate|limit|timeout|busy|too many)/i.test(message);
            if (!shouldRetry || attempt >= maxAttempts) {
                throw error;
            }

            const waitMs = baseDelayMs * attempt;
            logger.warn('Rate limit em getLogs do BUY ALERT. Tentando novamente.', {
                attempt,
                waitMs,
                error: message
            });
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
    }

    throw lastError || new Error('Falha desconhecida em getLogsWithRetry do BUY ALERT.');
}

async function getLogsWithProviderFallback(provider, filter, maxAttempts = 4, baseDelayMs = 1_500) {
    try {
        return await getLogsWithRetry(provider, filter, maxAttempts, baseDelayMs);
    } catch (error) {
        const message = String(error && error.message ? error.message : '');
        const fromBlock = Number(filter?.fromBlock ?? 0);
        const toBlock = Number(filter?.toBlock ?? fromBlock);
        if (/invalid block range params/i.test(message) && Number.isFinite(fromBlock) && Number.isFinite(toBlock) && toBlock > fromBlock) {
            const span = toBlock - fromBlock;
            const mid = fromBlock + Math.floor(span / 2);
            logger.warn('RPC rejeitou range do BUY ALERT. Dividindo consulta.', {
                fromBlock,
                toBlock,
                span
            });

            const left = await getLogsWithProviderFallback(provider, {
                ...filter,
                fromBlock,
                toBlock: mid
            }, Math.max(2, maxAttempts - 1), baseDelayMs);
            const right = await getLogsWithProviderFallback(provider, {
                ...filter,
                fromBlock: mid + 1,
                toBlock
            }, Math.max(2, maxAttempts - 1), baseDelayMs);

            return [...left, ...right].sort((a, b) => {
                const blockA = Number(a?.blockNumber ?? 0);
                const blockB = Number(b?.blockNumber ?? 0);
                if (blockA !== blockB) return blockA - blockB;
                const indexA = Number(a?.index ?? a?.logIndex ?? 0);
                const indexB = Number(b?.index ?? b?.logIndex ?? 0);
                return indexA - indexB;
            });
        }

        const addresses = Array.isArray(filter?.address) ? filter.address.filter(Boolean) : [];
        if (!/invalid block range params/i.test(message) || addresses.length <= 1) {
            throw error;
        }

        logger.warn('RPC rejeitou getLogs em lote do BUY ALERT. Tentando por token.', {
            fromBlock: filter?.fromBlock ?? null,
            toBlock: filter?.toBlock ?? null,
            addresses: addresses.length
        });

        const collected = [];
        for (const address of addresses) {
            const partialLogs = await getLogsWithRetry(provider, {
                ...filter,
                address
            }, Math.max(2, maxAttempts - 1), baseDelayMs);
            if (Array.isArray(partialLogs) && partialLogs.length > 0) {
                collected.push(...partialLogs);
            }
        }

        return collected.sort((a, b) => {
            const blockA = Number(a?.blockNumber ?? 0);
            const blockB = Number(b?.blockNumber ?? 0);
            if (blockA !== blockB) return blockA - blockB;
            const indexA = Number(a?.index ?? a?.logIndex ?? 0);
            const indexB = Number(b?.index ?? b?.logIndex ?? 0);
            return indexA - indexB;
        });
    }
}

function sortLogsChronologically(logs) {
    return [...(Array.isArray(logs) ? logs : [])].sort((a, b) => {
        const blockA = Number(a?.blockNumber ?? 0);
        const blockB = Number(b?.blockNumber ?? 0);
        if (blockA !== blockB) return blockA - blockB;
        const indexA = Number(a?.index ?? a?.logIndex ?? 0);
        const indexB = Number(b?.index ?? b?.logIndex ?? 0);
        return indexA - indexB;
    });
}

async function loadCriptoNoPixTokenMeta(httpProvider) {
    const entries = await Promise.all(
        CRIPTO_NO_PIX_SUPPORTED_TOKENS.map(async (token) => {
            let decimals = 18;
            try {
                const contract = new Contract(token.token, ERC20_DECIMALS_ABI, httpProvider);
                const rawDecimals = await contract.decimals();
                const parsed = Number(rawDecimals);
                if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 36) {
                    decimals = parsed;
                }
            } catch (error) {
                logger.warn('Falha ao buscar decimals do token Cripto no Pix. Usando 18.', {
                    symbol: token.symbol,
                    token: token.token,
                    error: error.message
                });
            }

            return [
                token.token.toLowerCase(),
                {
                    ...token,
                    decimals
                }
            ];
        })
    );

    return new Map(entries);
}

function normalizeRouterLabel(routerAddress) {
    const normalized = normalizeAddressLower(routerAddress);
    if (!normalized) {
        return null;
    }

    try {
        return KNOWN_BSC_ROUTERS.get(getAddress(normalized)) || null;
    } catch {
        return null;
    }
}

async function getTransactionsForAddressInRange(provider, address, fromBlock, toBlock) {
    const normalizedAddress = getAddress(address);
    const transactions = [];

    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1) {
        let block = null;
        try {
            block = await provider.getBlock(blockNumber, true);
        } catch (error) {
            logger.warn('Falha ao carregar bloco com transacoes no BUY ALERT.', {
                blockNumber,
                error: error.message || String(error)
            });
        }

        let blockTransactions = Array.isArray(block?.transactions) ? block.transactions : [];
        if (blockTransactions.length > 0 && typeof blockTransactions[0] === 'string') {
            blockTransactions = await Promise.all(blockTransactions.map(async (txHash) => provider.getTransaction(txHash)));
        }

        for (const tx of blockTransactions) {
            if (!tx?.to) continue;
            try {
                if (getAddress(tx.to) !== normalizedAddress) continue;
            } catch {
                continue;
            }
            transactions.push({
                ...tx,
                blockNumber: Number(tx.blockNumber || blockNumber)
            });
        }
    }

    return transactions.sort((a, b) => {
        const blockA = Number(a?.blockNumber ?? 0);
        const blockB = Number(b?.blockNumber ?? 0);
        if (blockA !== blockB) return blockA - blockB;
        const indexA = Number(a?.index ?? a?.transactionIndex ?? 0);
        const indexB = Number(b?.index ?? b?.transactionIndex ?? 0);
        return indexA - indexB;
    });
}

function createCriptoNoPixPollingState({
    sock,
    groups,
    httpProvider,
    config,
    dedupFilter,
    cooldownFilter,
    usdtBrlPriceService,
    cnpTokenMeta,
    onBuyProcessed,
    initialCursor = null,
    onCursorAdvanced = null
}) {
    const state = {
        timer: null,
        cursor: null,
        running: true,
        polling: false,
        replayApplied: false
    };

    async function resolveCriptoNoPixTokenOut(txHash, tokenMeta, holder, fallbackRawAmount) {
        try {
            const receipt = await httpProvider.getTransactionReceipt(txHash);
            const holderTopic = holder ? zeroPadValue(getAddress(holder).toLowerCase(), 32) : null;
            const transferLog = (receipt?.logs || []).find((entry) => {
                if (!entry?.address) return false;
                if (String(entry.address).toLowerCase() !== String(tokenMeta.token).toLowerCase()) return false;
                const topics = Array.isArray(entry.topics) ? entry.topics : [];
                if (topics[0] !== TOKEN_TRANSFER_TOPIC) return false;
                if (holderTopic && topics[2] !== holderTopic) return false;
                return true;
            });

            if (transferLog?.data) {
                const amount = Number(formatUnits(transferLog.data, tokenMeta.decimals));
                if (Number.isFinite(amount) && amount > 0) {
                    return amount;
                }
            }
        } catch (error) {
            logger.warn('Falha ao resolver tokenOut do Cripto no Pix pelo receipt.', {
                txHash,
                symbol: tokenMeta.symbol,
                error: error.message || String(error)
            });
        }

        const fallbackAmount = Number(formatUnits(fallbackRawAmount || 0n, tokenMeta.decimals));
        return Number.isFinite(fallbackAmount) ? fallbackAmount : 0;
    }

    function extractCriptoNoPixNixBonusInfo(receipt, wallet, purchasedTokenAddress, tokenOut, cnpContractAddress) {
        const normalizedWallet = normalizeAddressLower(wallet);
        const normalizedPurchasedToken = normalizeAddressLower(purchasedTokenAddress);
        const transfers = (receipt?.logs || [])
            .filter((entry) => {
                if (!entry?.address) return false;
                if (String(entry.address).toLowerCase() !== NIX_TOKEN_ADDRESS.toLowerCase()) return false;
                const topics = Array.isArray(entry.topics) ? entry.topics : [];
                return topics[0] === TOKEN_TRANSFER_TOPIC && topics.length >= 3;
            })
            .map((entry) => {
                const topics = Array.isArray(entry.topics) ? entry.topics : [];
                const from = normalizeAddressLower(`0x${String(topics[1] || '').slice(-40)}`);
                const to = normalizeAddressLower(`0x${String(topics[2] || '').slice(-40)}`);
                const amount = Number(formatUnits(entry.data || '0x0', 18));
                return { from, to, amount };
            })
            .filter((entry) => Number.isFinite(entry.amount) && entry.amount > 0);

        if (!transfers.length) {
            return { cashbackNix: 0, referralNix: 0, burnNix: 0 };
        }

        let remaining = [...transfers];
        if (normalizedPurchasedToken === NIX_TOKEN_ADDRESS.toLowerCase()) {
            const walletTransfers = remaining
                .map((entry, index) => ({ entry, index }))
                .filter((item) => item.entry.to === normalizedWallet);
            if (walletTransfers.length > 0) {
                let selectedIndex = walletTransfers[0].index;
                let bestDiff = Number.POSITIVE_INFINITY;
                for (const item of walletTransfers) {
                    const diff = Math.abs(Number(item.entry.amount || 0) - Number(tokenOut || 0));
                    if (diff < bestDiff) {
                        bestDiff = diff;
                        selectedIndex = item.index;
                    }
                }
                remaining = remaining.filter((_, index) => index !== selectedIndex);
            }
        }

        const cashbackNix = remaining
            .filter((entry) => entry.to === normalizedWallet)
            .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
        const burnNix = remaining
            .filter((entry) => BURN_ADDRESS_SET.has(entry.to))
            .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
        const referralNix = remaining
            .filter((entry) => entry.to && entry.to !== normalizedWallet && !BURN_ADDRESS_SET.has(entry.to) && entry.to !== normalizeAddressLower(cnpContractAddress))
            .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);

        return {
            cashbackNix,
            referralNix,
            burnNix
        };
    }

    async function processTransaction(tx) {
        const txHash = String(tx?.hash || tx?.transactionHash || '').trim();
        if (!txHash) {
            return;
        }

        const timingMeta = await getTxTimingMeta(httpProvider, Number(tx.blockNumber), txHash, 'cripto-no-pix');

        if (!normalizeTxHash(txHash)) {
            logBuyDecision('BUY Cripto no Pix ignorado: hash invalido', timingMeta, {
                reason: 'invalid-tx-hash'
            }, 'warn');
            return;
        }

        if (!timingMeta.txTimestampUtc) {
            logBuyDecision('BUY Cripto no Pix ignorado: timestamp UTC indisponivel', timingMeta, {
                reason: 'missing-block-timestamp'
            }, 'warn');
            return;
        }

        if (isTxOlderThanMax(timingMeta, config.maxTxAgeMs)) {
            logBuyDecision('BUY Cripto no Pix ignorado: transacao antiga', timingMeta, {
                maxAgeMinutes: Number((config.maxTxAgeMs / 60_000).toFixed(3)),
                reason: 'older-than-max-age'
            });
            return;
        }

        if (hasSentTxHash(progressState, txHash)) {
            logBuyDecision('BUY Cripto no Pix ignorado: hash ja publicado anteriormente', timingMeta, {
                reason: 'already-published'
            });
            return;
        }

        if (!tx || !tx.to || getAddress(tx.to) !== config.criptoNoPixContract) {
            return;
        }

        if (!String(tx.data || '').startsWith(CRIPTO_NO_PIX_FUNCTION_SELECTOR)) {
            logBuyDecision('BUY Cripto no Pix ignorado: interacao generica de contrato', timingMeta, {
                reason: 'not-cripto-no-pix-function'
            }, 'debug');
            return;
        }

        const dedupKey = `cnp:${txHash}`;
        if (dedupFilter.isDuplicateAndMark(dedupKey)) {
            logBuyDecision('BUY Cripto no Pix ignorado: duplicado em memoria', timingMeta, {
                dedupKey,
                reason: 'memory-duplicate'
            });
            return;
        }

        const decoded = criptoNoPixInterface.decodeFunctionData('criptoNoPix', tx.data);
        const tokenAddress = getAddress(decoded._tokenAddress).toLowerCase();
        const tokenMeta = cnpTokenMeta.get(tokenAddress);
        if (!tokenMeta) {
            logBuyDecision('BUY Cripto no Pix ignorado: token nao monitorado', timingMeta, {
                tokenAddress,
                reason: 'unmonitored-token'
            }, 'debug');
            return;
        }

        const usdValue = Number(formatUnits(decoded._amountInUSDT, 18));
        if (!Number.isFinite(usdValue) || usdValue <= 0) {
            logBuyDecision('BUY Cripto no Pix ignorado: valor USDT invalido', timingMeta, {
                symbol: tokenMeta.symbol,
                reason: 'invalid-usdt-value'
            });
            return;
        }

        const usdtBrlPrice = usdtBrlPriceService.getPrice();
        if (!Number.isFinite(usdtBrlPrice) || usdtBrlPrice <= 0) {
            logBuyDecision('BUY Cripto no Pix ignorado: preco USDT/BRL indisponivel', timingMeta, {
                symbol: tokenMeta.symbol,
                reason: 'usdt-brl-price-unavailable'
            }, 'warn');
            return;
        }

        const netBrlValue = usdValue * usdtBrlPrice;
        const brlValue = restoreGrossPixBrlValue(netBrlValue, config.criptoNoPixFeePercent);
        const isFsxPresale = tokenMeta.symbol === 'FSX';
        const minBrlAlert = isFsxPresale ? config.fsxPresaleMinBrlAlert : config.criptoNoPixMinBrlAlert;
        if (!Number.isFinite(brlValue) || brlValue < minBrlAlert) {
            logBuyDecision('BUY Cripto no Pix ignorado: abaixo do minimo BRL', timingMeta, {
                symbol: tokenMeta.symbol,
                brlValue,
                netBrlValue,
                minBrlAlert,
                reason: 'below-min-brl'
            });
            return;
        }

        const cooldownKey = `cnp:${tokenMeta.symbol}`;
        if (cooldownFilter.isInCooldown(cooldownKey)) {
            logBuyDecision('BUY Cripto no Pix ignorado: cooldown ativo', timingMeta, {
                symbol: tokenMeta.symbol,
                reason: 'cooldown-active'
            });
            return;
        }

        cooldownFilter.hit(cooldownKey);

        const wallet = decoded._holder ? getAddress(decoded._holder) : (tx.from || '');
        const receipt = await httpProvider.getTransactionReceipt(txHash);
        const tokenOut = await resolveCriptoNoPixTokenOut(
            txHash,
            tokenMeta,
            wallet,
            decoded._mintokenAmount
        );
        const nixBonusInfo = extractCriptoNoPixNixBonusInfo(receipt, wallet, tokenMeta.token, tokenOut, config.criptoNoPixContract);
        const routerAddress = decoded._router ? getAddress(decoded._router) : null;
        const routerLabel = normalizeRouterLabel(routerAddress);
        const onChainStats = await analyzeWalletOnChainHistory({
            provider: httpProvider,
            tokenAddress: tokenMeta.token,
            pairAddress: tokenMeta.pair,
            wallet,
            blockNumber: Number(tx.blockNumber)
        });
        const walletStats = registerWalletBuy(walletStatsState, {
            wallet,
            symbol: tokenMeta.symbol,
            usdValue,
            brlValue,
            netBrlValue,
            txHash,
            timestamp: Date.parse(timingMeta.txTimestampUtc) || Date.now()
        });
        const messagePayload = buildBuyAlertPayload({
            symbol: tokenMeta.symbol,
            token: tokenMeta.token,
            usdValue,
            brlValue,
            netBrlValue,
            tokenOut,
            wallet,
            walletBuyCount: Number(onChainStats?.available ? onChainStats.totalCount : walletStats.symbolBuys),
            holderSince: onChainStats?.firstSeenAt || null,
            cashbackNix: nixBonusInfo.cashbackNix,
            referralNix: nixBonusInfo.referralNix,
            burnNix: nixBonusInfo.burnNix,
            routerAddress,
            routerLabel,
            title: null,
            stage: isFsxPresale ? config.fsxPresaleStage : null,
            stageText: isFsxPresale ? (config.fsxPresaleStageText || config.fsxPresaleStage) : null,
            txHash,
            pair: tokenMeta.pair,
            origin: isFsxPresale ? 'FSX Presale' : 'Cripto no Pix'
        });

        const delivery = await sendBuyAlert(sock, messagePayload, groups);
        if (!delivery || !Array.isArray(delivery.delivered) || delivery.delivered.length === 0) {
            logBuyDecision('BUY Cripto no Pix nao publicado: falha no envio para todos os grupos', timingMeta, {
                symbol: tokenMeta.symbol,
                reason: 'delivery-failed'
            }, 'warn');
            return;
        }

        markSentTxHash(progressState, txHash, {
            stream: 'cripto-no-pix',
            symbol: tokenMeta.symbol,
            blockNumber: Number(tx.blockNumber),
            txTimestampUtc: timingMeta.txTimestampUtc,
            groups: delivery.delivered
        });

        if (onBuyProcessed) {
            try {
                await onBuyProcessed({
                    symbol: tokenMeta.symbol,
                    txHash,
                    tokenOut,
                    usdValue,
                    brlValue,
                    source: 'cripto-no-pix',
                    timestamp: Date.parse(timingMeta.txTimestampUtc) || Date.now()
                });
            } catch (callbackError) {
                logger.warn('Falha no callback onBuyProcessed do BUY ALERT Cripto no Pix', {
                    symbol: tokenMeta.symbol,
                    txHash,
                    error: callbackError.message || String(callbackError)
                });
            }
        }

        logBuyDecision('BUY PUBLICADO: Cripto no Pix', timingMeta, {
            symbol: tokenMeta.symbol,
            usdValue,
            brlValue,
            netBrlValue,
            routerLabel: routerLabel || null,
            routerAddress: routerAddress || null,
            groups: delivery.delivered,
            reason: 'published'
        });
    }

    async function pollOnce() {
        if (state.cursor === null) {
            const latest = Number(await httpProvider.getBlockNumber());
            if (Number.isFinite(initialCursor) && initialCursor >= 0) {
                state.cursor = Math.max(0, Number(initialCursor));
                state.replayApplied = true;
                logger.info('Retomando polling BUY ALERT Cripto no Pix do ultimo bloco salvo', {
                    savedCursor: state.cursor,
                    latestBlock: latest
                });
            } else {
                const replayFromBlock = Number(config.criptoNoPixReplayFromBlock || 0);
                if (!state.replayApplied && Number.isFinite(replayFromBlock) && replayFromBlock > 0) {
                    state.cursor = Math.max(0, replayFromBlock - 1);
                    state.replayApplied = true;
                    logger.info('Replay do BUY ALERT Cripto no Pix configurado', {
                        replayFromBlock,
                        latestBlock: latest
                    });
                } else {
                    state.cursor = Math.max(0, latest - 1);
                    return;
                }
            }
        }

        const latestBlock = Number(await httpProvider.getBlockNumber());
        if (!Number.isFinite(latestBlock) || latestBlock < 0) {
            throw new Error('latest block invalido no polling Cripto no Pix');
        }
        const safeLatestBlock = Math.max(0, latestBlock - 1);

        if (!Number.isFinite(state.cursor) || state.cursor < 0) {
            state.cursor = Math.max(0, safeLatestBlock - 1);
            return;
        }

        if (state.cursor >= safeLatestBlock) {
            return;
        }

        const fromBlock = state.cursor + 1;
        if (fromBlock > safeLatestBlock) {
            return;
        }

        const toBlock = Math.min(fromBlock + Math.max(1, config.pollBatchSize) - 1, safeLatestBlock);
        const transactions = await getTransactionsForAddressInRange(
            httpProvider,
            config.criptoNoPixContract,
            fromBlock,
            toBlock
        );

        for (const tx of transactions) {
            await processTransaction(tx);
        }

        state.cursor = toBlock;
        if (onCursorAdvanced) {
            await onCursorAdvanced(toBlock);
        }

        if (transactions.length > 0) {
            logger.info('Batch Cripto no Pix processado', {
                fromBlock,
                toBlock,
                transactions: transactions.length
            });
        }
    }

    state.timer = setInterval(async () => {
        if (!state.running || state.polling) {
            return;
        }

        state.polling = true;
        try {
            await pollOnce();
        } catch (error) {
            const message = error.message || String(error);
            if (/invalid block range params/i.test(message)) {
                logger.warn('Polling do BUY ALERT Cripto no Pix mantera o cursor atual apos range invalido', {
                    cursor: state.cursor
                });
            }
            logger.error('Falha no polling do BUY ALERT Cripto no Pix', {
                error: message
            });
        } finally {
            state.polling = false;
        }
    }, config.pollIntervalMs);

    if (typeof state.timer.unref === 'function') {
        state.timer.unref();
    }

    return state;
}

function createFsxSitePresalePollingState({
    sock,
    groups,
    httpProvider,
    config,
    dedupFilter,
    cooldownFilter,
    usdtBrlPriceService,
    onBuyProcessed,
    initialCursor = null,
    onCursorAdvanced = null
}) {
    const state = {
        timer: null,
        cursor: null,
        running: true,
        polling: false,
        replayApplied: false
    };

    async function processLog(log) {
        const txHash = String(log?.transactionHash || '').trim();
        if (!txHash) {
            return;
        }

        const timingMeta = await getTxTimingMeta(httpProvider, Number(log.blockNumber), txHash, 'fsx-site-presale');

        if (!normalizeTxHash(txHash)) {
            logBuyDecision('BUY FSX site presale ignorado: hash invalido', timingMeta, {
                reason: 'invalid-tx-hash'
            }, 'warn');
            return;
        }

        if (!timingMeta.txTimestampUtc) {
            logBuyDecision('BUY FSX site presale ignorado: timestamp UTC indisponivel', timingMeta, {
                reason: 'missing-block-timestamp'
            }, 'warn');
            return;
        }

        if (isTxOlderThanMax(timingMeta, config.maxTxAgeMs)) {
            logBuyDecision('BUY FSX site presale ignorado: transacao antiga', timingMeta, {
                maxAgeMinutes: Number((config.maxTxAgeMs / 60_000).toFixed(3)),
                reason: 'older-than-max-age'
            });
            return;
        }

        if (hasSentTxHash(progressState, txHash)) {
            logBuyDecision('BUY FSX site presale ignorado: hash ja publicado anteriormente', timingMeta, {
                reason: 'already-published'
            });
            return;
        }

        const dedupKey = `fsx-site:${txHash}:${String(log?.index ?? log?.logIndex ?? 0)}`;
        if (dedupFilter.isDuplicateAndMark(dedupKey)) {
            logBuyDecision('BUY FSX site presale ignorado: duplicado em memoria', timingMeta, {
                dedupKey,
                reason: 'memory-duplicate'
            });
            return;
        }

        let parsed;
        try {
            parsed = fsxSitePresaleInterface.parseLog(log);
        } catch (error) {
            logBuyDecision('BUY FSX site presale ignorado: evento invalido', timingMeta, {
                error: error.message || String(error),
                reason: 'invalid-event'
            }, 'debug');
            return;
        }

        const wallet = getAddress(parsed?.args?.buyer || '0x0000000000000000000000000000000000000000');
        const paymentMethod = String(parsed?.args?.paymentMethod || 'USDT').trim().toUpperCase() || 'USDT';
        const usdValue = Number(formatUnits(parsed?.args?.usdValue || 0n, 18));
        if (!Number.isFinite(usdValue) || usdValue <= 0) {
            logBuyDecision('BUY FSX site presale ignorado: usdValue invalido', timingMeta, {
                reason: 'invalid-usd-value'
            });
            return;
        }

        const usdtBrlPrice = usdtBrlPriceService.getPrice();
        if (!Number.isFinite(usdtBrlPrice) || usdtBrlPrice <= 0) {
            logBuyDecision('BUY FSX site presale ignorado: preco USDT/BRL indisponivel', timingMeta, {
                reason: 'usdt-brl-price-unavailable'
            }, 'warn');
            return;
        }

        const brlValue = usdValue * usdtBrlPrice;
        if (!Number.isFinite(brlValue) || brlValue < config.fsxPresaleMinBrlAlert) {
            logBuyDecision('BUY FSX site presale ignorado: abaixo do minimo BRL', timingMeta, {
                brlValue,
                minBrlAlert: config.fsxPresaleMinBrlAlert,
                reason: 'below-min-brl'
            });
            return;
        }

        const cooldownKey = 'fsx-site:FSX';
        if (cooldownFilter.isInCooldown(cooldownKey)) {
            logBuyDecision('BUY FSX site presale ignorado: cooldown ativo', timingMeta, {
                reason: 'cooldown-active'
            });
            return;
        }

        cooldownFilter.hit(cooldownKey);

        const tokenOut = Number(formatUnits(parsed?.args?.tokensReceived || 0n, 18));
        const onChainStats = await analyzeWalletOnChainHistory({
            provider: httpProvider,
            tokenAddress: getAddress('0xcD4fA13B6f5Cad65534DC244668C5270EC7e961a'),
            pairAddress: null,
            wallet,
            blockNumber: Number(log.blockNumber)
        });
        const walletStats = registerWalletBuy(walletStatsState, {
            wallet,
            symbol: 'FSX',
            usdValue,
            brlValue,
            txHash,
            timestamp: Date.parse(timingMeta.txTimestampUtc) || Date.now()
        });

        const messagePayload = buildBuyAlertPayload({
            symbol: 'FSX',
            token: getAddress('0xcD4fA13B6f5Cad65534DC244668C5270EC7e961a'),
            usdValue,
            brlValue,
            tokenOut,
            wallet,
            walletBuyCount: Number(onChainStats?.available ? onChainStats.totalCount : walletStats.symbolBuys),
            holderSince: onChainStats?.firstSeenAt || null,
            title: null,
            stage: config.fsxPresaleStage,
            stageText: config.fsxPresaleStageText || config.fsxPresaleStage,
            txHash,
            pair: null,
            origin: 'FSX Presale',
            paymentMethod
        });

        const delivery = await sendBuyAlert(sock, messagePayload, groups);
        if (!delivery || !Array.isArray(delivery.delivered) || delivery.delivered.length === 0) {
            logBuyDecision('BUY FSX site presale nao publicado: falha no envio para todos os grupos', timingMeta, {
                symbol: 'FSX',
                reason: 'delivery-failed'
            }, 'warn');
            return;
        }

        markSentTxHash(progressState, txHash, {
            stream: 'fsx-site-presale',
            symbol: 'FSX',
            blockNumber: Number(log.blockNumber),
            txTimestampUtc: timingMeta.txTimestampUtc,
            groups: delivery.delivered
        });

        if (onBuyProcessed) {
            try {
                await onBuyProcessed({
                    symbol: 'FSX',
                    txHash,
                    tokenOut,
                    usdValue,
                    brlValue,
                    source: 'fsx-site-presale',
                    timestamp: Date.parse(timingMeta.txTimestampUtc) || Date.now()
                });
            } catch (callbackError) {
                logger.warn('Falha no callback onBuyProcessed do BUY ALERT FSX site presale', {
                    txHash,
                    error: callbackError.message || String(callbackError)
                });
            }
        }

        logBuyDecision('BUY PUBLICADO: FSX site presale', timingMeta, {
            symbol: 'FSX',
            usdValue,
            brlValue,
            paymentMethod,
            groups: delivery.delivered,
            reason: 'published'
        });
    }

    async function pollOnce() {
        if (state.cursor === null) {
            const latest = Number(await httpProvider.getBlockNumber());
            if (Number.isFinite(initialCursor) && initialCursor >= 0) {
                state.cursor = Math.max(0, Number(initialCursor));
                state.replayApplied = true;
                logger.info('Retomando polling BUY ALERT FSX site presale do ultimo bloco salvo', {
                    savedCursor: state.cursor,
                    latestBlock: latest
                });
            } else {
                const replayFromBlock = Number(config.fsxSitePresaleReplayFromBlock || 0);
                if (!state.replayApplied && Number.isFinite(replayFromBlock) && replayFromBlock > 0) {
                    state.cursor = Math.max(0, replayFromBlock - 1);
                    state.replayApplied = true;
                    logger.info('Replay do BUY ALERT FSX site presale configurado', {
                        replayFromBlock,
                        latestBlock: latest
                    });
                } else {
                    state.cursor = Math.max(0, latest - 1);
                    return;
                }
            }
        }

        const latestBlock = Number(await httpProvider.getBlockNumber());
        if (!Number.isFinite(latestBlock) || latestBlock < 0) {
            throw new Error('latest block invalido no polling FSX site presale');
        }
        const safeLatestBlock = Math.max(0, latestBlock - 1);

        if (!Number.isFinite(state.cursor) || state.cursor < 0) {
            state.cursor = Math.max(0, safeLatestBlock - 1);
            return;
        }

        if (state.cursor >= safeLatestBlock) {
            return;
        }

        const fromBlock = state.cursor + 1;
        if (fromBlock > safeLatestBlock) {
            return;
        }

        const toBlock = Math.min(fromBlock + Math.max(1, config.pollBatchSize) - 1, safeLatestBlock);
        const logs = await getLogsWithProviderFallback(httpProvider, {
            address: config.fsxSitePresaleContract,
            topics: [FSX_SITE_PRESALE_TOPIC],
            fromBlock,
            toBlock
        });

        for (const log of sortLogsChronologically(logs)) {
            await processLog(log);
        }

        state.cursor = toBlock;
        if (onCursorAdvanced) {
            await onCursorAdvanced(toBlock);
        }

        if (Array.isArray(logs) && logs.length > 0) {
            logger.info('Batch FSX site presale processado', {
                fromBlock,
                toBlock,
                logs: logs.length
            });
        }
    }

    state.timer = setInterval(async () => {
        if (!state.running || state.polling) {
            return;
        }

        state.polling = true;
        try {
            await pollOnce();
        } catch (error) {
            const message = error.message || String(error);
            if (/invalid block range params/i.test(message)) {
                logger.warn('Polling do BUY ALERT FSX site presale mantera o cursor atual apos range invalido', {
                    cursor: state.cursor
                });
            }
            logger.error('Falha no polling do BUY ALERT FSX site presale', {
                error: message
            });
        } finally {
            state.polling = false;
        }
    }, config.pollIntervalMs);

    if (typeof state.timer.unref === 'function') {
        state.timer.unref();
    }

    return state;
}

function loadProgressState() {
    const filePath = resolveBuyAlertProgressFile();
    const state = createEmptyProgressState(filePath);

    try {
        if (!fs.existsSync(filePath)) {
            return state;
        }

        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.cursors && typeof parsed.cursors === 'object') {
            state.cursors = parsed.cursors;
        }
        if (parsed && typeof parsed === 'object' && parsed.sentTxHashes && typeof parsed.sentTxHashes === 'object') {
            state.sentTxHashes = parsed.sentTxHashes;
        }
    } catch (error) {
        logger.warn('Falha ao carregar progresso de blocos do BUY ALERT. Iniciando vazio.', {
            filePath,
            error: error.message
        });
    }

    return state;
}

function hasAnySavedCursor(state) {
    if (!state || !state.cursors || typeof state.cursors !== 'object') {
        return false;
    }

    return Object.values(state.cursors).some((entry) => {
        const block = Number(entry?.lastSuccessfulBlock);
        return Number.isFinite(block) && block >= 0;
    });
}

async function bootstrapProgressCursorsIfNeeded(state, provider, config) {
    if (!state || hasAnySavedCursor(state)) {
        return;
    }

    const latestBlock = Number(await provider.getBlockNumber());
    if (!Number.isFinite(latestBlock) || latestBlock < 0) {
        return;
    }

    const checkpointBlock = Math.max(0, latestBlock - 1);
    const meta = {
        stream: 'bootstrap',
        reason: 'initial-safe-checkpoint'
    };

    setSavedCursor(state, 'swapListener', checkpointBlock, meta);

    if (config.enableCriptoNoPixPolling) {
        setSavedCursor(state, 'criptoNoPix', checkpointBlock, meta);
    }

    if (config.enableFsxSitePresalePolling) {
        setSavedCursor(state, 'fsxSitePresale', checkpointBlock, meta);
    }

    try {
        flushProgressState(state);
    } catch (error) {
        logger.warn('Falha ao persistir checkpoint inicial do BUY ALERT.', {
            filePath: state.filePath,
            error: error.message || String(error)
        });
    }

    logger.info('BUY ALERT inicializado com checkpoint seguro para evitar replay antigo.', {
        checkpointBlock,
        progressFile: state.filePath
    });
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
        if (runtime.usdtBrlPriceService) {
            runtime.usdtBrlPriceService.stop();
        }
    } catch (error) {
        logger.warn('Falha ao parar precificacao USDT/BRL do BUY ALERT', { error: error.message });
    }

    try {
        if (runtime.dedupFilter) {
            runtime.dedupFilter.stop();
        }
    } catch (error) {
        logger.warn('Falha ao parar dedup BUY ALERT', { error: error.message });
    }

    try {
        if (runtime.criptoNoPixPolling) {
            runtime.criptoNoPixPolling.running = false;
            if (runtime.criptoNoPixPolling.timer) {
                clearInterval(runtime.criptoNoPixPolling.timer);
            }
        }
    } catch (error) {
        logger.warn('Falha ao parar polling Cripto no Pix do BUY ALERT', { error: error.message });
    }

    try {
        if (runtime.fsxSitePresalePolling) {
            runtime.fsxSitePresalePolling.running = false;
            if (runtime.fsxSitePresalePolling.timer) {
                clearInterval(runtime.fsxSitePresalePolling.timer);
            }
        }
    } catch (error) {
        logger.warn('Falha ao parar polling FSX site presale do BUY ALERT', { error: error.message });
    }

    if (walletStatsState) {
        try {
            if (walletStatsState.saveTimer) {
                clearTimeout(walletStatsState.saveTimer);
                walletStatsState.saveTimer = null;
            }
            flushWalletStatsState(walletStatsState);
        } catch (error) {
            logger.warn('Falha ao persistir historico de wallets do BUY ALERT ao parar.', {
                filePath: walletStatsState.filePath,
                error: error.message
            });
        }
    }

    if (progressState) {
        try {
            if (progressState.saveTimer) {
                clearTimeout(progressState.saveTimer);
                progressState.saveTimer = null;
            }
            flushProgressState(progressState);
        } catch (error) {
            logger.warn('Falha ao persistir progresso de blocos do BUY ALERT ao parar.', {
                filePath: progressState.filePath,
                error: error.message
            });
        }
    }

    runtime = null;
    walletStatsState = null;
    progressState = null;
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
    walletStatsState = loadWalletStatsState();
    progressState = loadProgressState();

    if (groups.length === 0) {
        throw new Error('Nenhum grupo configurado para BUY ALERT (BUY_ALERT_GROUPS/INTEL_GROUPS).');
    }

    logger.info('Iniciando BUY ALERT integrado ao bot principal', {
        groups,
        tokens: TOKENS.map((token) => token.symbol),
        criptoNoPixTokens: CRIPTO_NO_PIX_SUPPORTED_TOKENS.map((token) => token.symbol),
        enableCriptoNoPixPolling: config.enableCriptoNoPixPolling,
        enableFsxSitePresalePolling: config.enableFsxSitePresalePolling,
        fsxSitePresaleContract: config.fsxSitePresaleContract,
        criptoNoPixMinBrlAlert: config.criptoNoPixMinBrlAlert,
        whaleUsdAlert: config.whaleUsdAlert,
        minUsdAlert: config.minUsdAlert,
        maxTxAgeMinutes: Number((config.maxTxAgeMs / 60_000).toFixed(3)),
        bnbPriceUrls: config.bnbPriceUrls,
        usdtBrlPriceUrls: config.usdtBrlPriceUrls,
        progressFile: progressState?.filePath || null
    });

    const httpProvider = new JsonRpcProvider(config.bscHttpUrl);
    await bootstrapProgressCursorsIfNeeded(progressState, httpProvider, config);
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
        urls: config.bnbPriceUrls,
        refreshMs: config.bnbPriceRefreshMs,
        logger,
        label: 'Preco BNB'
    });
    await priceService.start({ tolerateInitialFailure: true });

    const usdtBrlPriceService = new BnbUsdPriceService({
        urls: config.usdtBrlPriceUrls,
        refreshMs: config.bnbPriceRefreshMs,
        logger,
        label: 'Preco USDT/BRL'
    });
    await usdtBrlPriceService.start({ tolerateInitialFailure: true });

    logger.info('Servicos de precificacao BUY ALERT preparados', {
        bnbSnapshot: priceService.getSnapshot(),
        usdtBrlSnapshot: usdtBrlPriceService.getSnapshot()
    });

    const cnpTokenMeta = config.enableCriptoNoPixPolling
        ? await loadCriptoNoPixTokenMeta(httpProvider)
        : new Map();

    const listener = new BscSwapListener({
        wsUrl: config.bscWsUrl,
        httpUrl: config.bscHttpUrl,
        detectors,
        heartbeatMs: config.heartbeatMs,
        pollIntervalMs: config.pollIntervalMs,
        pollBatchSize: config.pollBatchSize,
        maxTxAgeMs: config.maxTxAgeMs,
        wsBackoffStepsMs: config.wsBackoffMs,
        initialPollCursor: getSavedCursor(progressState, 'swapListener'),
        onPollCursorUpdated: async (blockNumber) => {
            setSavedCursor(progressState, 'swapListener', blockNumber, {
                stream: 'swap-listener'
            });
        },
        logger
    });

    listener.on('buy', async (buyEvent) => {
        try {
            let timingMeta = buildTxTimingMeta({
                txHash: buyEvent.txHash,
                blockNumber: buyEvent.blockNumber,
                blockTimestampMs: buyEvent.blockTimestampMs,
                blockTimestampUtc: buyEvent.blockTimestampUtc,
                source: buyEvent.source
            });

            if (!timingMeta.txTimestampUtc) {
                timingMeta = await getTxTimingMeta(httpProvider, buyEvent.blockNumber, buyEvent.txHash, buyEvent.source);
            }

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

            if (isTxOlderThanMax(timingMeta, config.maxTxAgeMs)) {
                logBuyDecision('BUY IGNORADO: transacao antiga', timingMeta, {
                    symbol: buyEvent.symbol,
                    maxAgeMinutes: Number((config.maxTxAgeMs / 60_000).toFixed(3)),
                    reason: 'older-than-max-age'
                });
                return;
            }

            if (hasSentTxHash(progressState, buyEvent.txHash)) {
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

            const usdValue = Number(buyEvent.bnbIn || 0) * bnbPrice;
            if (!Number.isFinite(usdValue) || usdValue <= config.minUsdAlert) {
                logBuyDecision('BUY IGNORADO: abaixo do minimo USD', timingMeta, {
                    symbol: buyEvent.symbol,
                    usdValue,
                    minUsdAlert: config.minUsdAlert,
                    reason: 'below-min-usd'
                });
                return;
            }

            const cooldownKey = String(buyEvent.cooldownKey || buyEvent.symbol);
            if (cooldownFilter.isInCooldown(cooldownKey)) {
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

            cooldownFilter.hit(cooldownKey);
            const onChainStats = await analyzeWalletOnChainHistory({
                provider: httpProvider,
                tokenAddress: buyEvent.token,
                pairAddress: buyEvent.pair,
                wallet,
                blockNumber: Number(buyEvent.blockNumber)
            });
            const walletStats = registerWalletBuy(walletStatsState, {
                wallet,
                symbol: buyEvent.symbol,
                usdValue,
                txHash: buyEvent.txHash,
                timestamp: Date.parse(timingMeta.txTimestampUtc) || Date.now()
            });

            const messagePayload = buildBuyAlertPayload({
                symbol: buyEvent.symbol,
                usdValue,
                tokenOut: buyEvent.tokenOut,
                wallet,
                walletBuyCount: Number(onChainStats?.available ? onChainStats.totalCount : walletStats.symbolBuys),
                holderSince: onChainStats?.firstSeenAt || null,
                title: null,
                txHash: buyEvent.txHash,
                token: buyEvent.token,
                pair: buyEvent.pair,
                origin: 'Swap na BSC'
            });

            const delivery = await sendBuyAlert(sock, messagePayload, groups);
            if (!delivery || !Array.isArray(delivery.delivered) || delivery.delivered.length === 0) {
                logBuyDecision('BUY NAO PUBLICADO: falha no envio para todos os grupos', timingMeta, {
                    symbol: buyEvent.symbol,
                    reason: 'delivery-failed'
                }, 'warn');
                return;
            }

            markSentTxHash(progressState, buyEvent.txHash, {
                stream: 'swap-listener',
                symbol: buyEvent.symbol,
                blockNumber: Number(buyEvent.blockNumber),
                txTimestampUtc: timingMeta.txTimestampUtc,
                groups: delivery.delivered
            });

            if (onBuyProcessed) {
                try {
                    await onBuyProcessed({
                        symbol: buyEvent.symbol,
                        txHash: buyEvent.txHash,
                        tokenOut: buyEvent.tokenOut,
                        bnbIn: buyEvent.bnbIn,
                        usdValue,
                        source: buyEvent.source,
                        timestamp: Date.parse(timingMeta.txTimestampUtc) || Date.now()
                    });
                } catch (callbackError) {
                    logger.warn('Falha no callback onBuyProcessed do BUY ALERT', {
                        symbol: buyEvent.symbol,
                        txHash: buyEvent.txHash,
                        error: callbackError.message || String(callbackError)
                    });
                }
            }
            logBuyDecision('BUY PUBLICADO: Swap na BSC', timingMeta, {
                symbol: buyEvent.symbol,
                usdValue,
                source: buyEvent.source,
                groups: delivery.delivered,
                reason: 'published'
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

    logger.info('Iniciando listener do BUY ALERT', {
        wsUrl: config.bscWsUrl,
        httpUrl: config.bscHttpUrl,
        pairs: TOKENS.map((token) => token.pair)
    });

    await listener.start();

    logger.info('Listener do BUY ALERT iniciou', {
        pairs: TOKENS.map((token) => token.pair)
    });

    let criptoNoPixPolling = null;
    if (config.enableCriptoNoPixPolling) {
        criptoNoPixPolling = createCriptoNoPixPollingState({
            sock,
            groups,
            httpProvider,
            config,
            dedupFilter,
            cooldownFilter,
            usdtBrlPriceService,
            cnpTokenMeta,
            onBuyProcessed,
            initialCursor: getSavedCursor(progressState, 'criptoNoPix'),
            onCursorAdvanced: async (blockNumber) => {
                setSavedCursor(progressState, 'criptoNoPix', blockNumber, {
                    stream: 'cripto-no-pix'
                });
            }
        });
    } else {
        logger.info('Polling de compras Cripto no Pix desativado por configuracao.');
    }

    let fsxSitePresalePolling = null;
    if (config.enableFsxSitePresalePolling) {
        fsxSitePresalePolling = createFsxSitePresalePollingState({
            sock,
            groups,
            httpProvider,
            config,
            dedupFilter,
            cooldownFilter,
            usdtBrlPriceService,
            onBuyProcessed,
            initialCursor: getSavedCursor(progressState, 'fsxSitePresale'),
            onCursorAdvanced: async (blockNumber) => {
                setSavedCursor(progressState, 'fsxSitePresale', blockNumber, {
                    stream: 'fsx-site-presale'
                });
            }
        });
    } else {
        logger.info('Polling de compras FSX site presale desativado por configuracao.');
    }

    runtime = {
        listener,
        priceService,
        usdtBrlPriceService,
        dedupFilter,
        criptoNoPixPolling,
        fsxSitePresalePolling
    };

    logger.info('BUY ALERT integrado iniciou e esta monitorando compras validas.', {
        bnbSnapshot: priceService.getSnapshot(),
        usdtBrlSnapshot: usdtBrlPriceService.getSnapshot()
    });
}

export async function sendBuyAlertDirect(sock, text) {
    const groups = resolveBuyAlertGroups();
    await sendBuyAlert(sock, { text }, groups);
}

export async function sendBuyAlertPayloadDirect(sock, payload) {
    const groups = resolveBuyAlertGroups();
    await sendBuyAlert(sock, payload, groups);
}

