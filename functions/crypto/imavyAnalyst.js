// functions/crypto/imavyAnalyst.js
// Mention-triggered crypto analyst powered by CoinGecko + Groq.

import axios from 'axios';
import Groq from 'groq-sdk';
import { getMarketQuote } from './marketPrices.js';

const COINGECKO_BASE_URL = process.env.COINGECKO_BASE_URL || 'https://api.coingecko.com/api/v3';
const GROQ_MODEL = process.env.IMAVY_GROQ_MODEL || 'llama-3.3-70b-versatile';
const MAX_COINS_PER_REQUEST = Math.max(1, Math.min(Number(process.env.IMAVY_MAX_COINS || 4), 8));
const REQUEST_TIMEOUT_MS = 12000;
const SNAPSHOT_CACHE_TTL_MS = Math.max(5000, Number(process.env.IMAVY_SNAPSHOT_CACHE_MS || 30000));
const SNAPSHOT_STALE_TTL_MS = Math.max(SNAPSHOT_CACHE_TTL_MS, Number(process.env.IMAVY_SNAPSHOT_STALE_MS || 900000));

const KNOWN_COINS = [
    { id: 'bitcoin', symbol: 'BTC', keywords: ['btc', 'bitcoin'] },
    { id: 'ethereum', symbol: 'ETH', keywords: ['eth', 'ethereum'] },
    { id: 'solana', symbol: 'SOL', keywords: ['sol', 'solana'] },
    { id: 'ripple', symbol: 'XRP', keywords: ['xrp', 'ripple'] },
    { id: 'binancecoin', symbol: 'BNB', keywords: ['bnb', 'binance coin', 'binancecoin'] },
    { id: 'tether', symbol: 'USDT', keywords: ['usdt', 'tether'] },
    { id: 'pax-gold', symbol: 'PAXG', keywords: ['paxg', 'pax gold', 'ouro'] }
];

const FALLBACK_COIN_IDS = ['bitcoin', 'ethereum'];
const CRYPTO_SCOPE_KEYWORDS = [
    'crypto', 'cripto', 'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'xrp', 'bnb', 'usdt',
    'paxg', 'ouro', 'blockchain', 'web3', 'defi', 'nft', 'token', 'tokenomics', 'on-chain',
    'onchain', 'funding', 'open interest', 'dominancia', 'dominance', 'market cap', 'altcoin'
];

function getCoinGeckoHeaders() {
    const key = String(process.env.COINGECKO_API_KEY || '').trim();
    if (!key) return {};

    const customHeader = String(process.env.COINGECKO_API_HEADER || '').trim();
    if (customHeader) {
        return { [customHeader]: key };
    }

    const plan = String(process.env.COINGECKO_API_PLAN || 'demo').trim().toLowerCase();
    if (plan === 'pro') {
        return { 'x-cg-pro-api-key': key };
    }
    return { 'x-cg-demo-api-key': key };
}

function safeNumber(value, fallback = NaN) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function formatUsdPrice(value) {
    const num = safeNumber(value);
    if (!Number.isFinite(num)) return 'N/D';
    if (Math.abs(num) >= 1000) return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (Math.abs(num) >= 1) return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
    return `$${num.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 8 })}`;
}

function formatUsdCompact(value) {
    const num = safeNumber(value);
    if (!Number.isFinite(num)) return 'N/D';
    const abs = Math.abs(num);
    const sign = num < 0 ? '-' : '';
    if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`;
    return `${sign}$${abs.toFixed(2)}`;
}

function formatPct(value, fractionDigits = 2) {
    const num = safeNumber(value);
    if (!Number.isFinite(num)) return 'N/D';
    return `${num >= 0 ? '+' : ''}${num.toFixed(fractionDigits)}%`;
}

function detectRequestedCoinIds(question) {
    const text = String(question || '').toLowerCase();
    const out = [];

    for (const coin of KNOWN_COINS) {
        const hasMatch = coin.keywords.some((k) => {
            const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`(^|[^a-z0-9])\\$?${escaped}([^a-z0-9]|$)`, 'i');
            return re.test(text);
        });
        if (hasMatch) out.push(coin.id);
    }

    const unique = [...new Set(out)];
    if (unique.length) return unique.slice(0, MAX_COINS_PER_REQUEST);
    return FALLBACK_COIN_IDS.slice(0, MAX_COINS_PER_REQUEST);
}

function mapById(items) {
    const out = {};
    for (const item of items) {
        if (item?.id) out[item.id] = item;
    }
    return out;
}

const SYMBOL_BY_ID = Object.fromEntries(KNOWN_COINS.map((c) => [c.id, c.symbol]));
const ID_BY_SYMBOL = Object.fromEntries(KNOWN_COINS.map((c) => [c.symbol.toUpperCase(), c.id]));
let snapshotCache = {
    ts: 0,
    snapshot: null
};

function snapshotHasAllIds(snapshot, requiredIds) {
    if (!snapshot || !Array.isArray(snapshot.markets)) return false;
    const have = new Set(snapshot.markets.map((m) => m?.id).filter(Boolean));
    return requiredIds.every((id) => have.has(id));
}

async function fetchCoinGeckoSnapshot(coinIds) {
    const headers = getCoinGeckoHeaders();

    const [marketsResp, globalResp] = await Promise.all([
        axios.get(`${COINGECKO_BASE_URL}/coins/markets`, {
            headers,
            timeout: REQUEST_TIMEOUT_MS,
            params: {
                vs_currency: 'usd',
                ids: coinIds.join(','),
                order: 'market_cap_desc',
                per_page: coinIds.length,
                page: 1,
                sparkline: false,
                price_change_percentage: '24h'
            }
        }),
        axios.get(`${COINGECKO_BASE_URL}/global`, {
            headers,
            timeout: REQUEST_TIMEOUT_MS
        })
    ]);

    const markets = Array.isArray(marketsResp?.data) ? marketsResp.data : [];
    const globalData = globalResp?.data?.data || {};
    return {
        markets,
        globalData,
        fetchedAt: Date.now(),
        source: 'CoinGecko'
    };
}

async function buildFallbackSnapshotFromMarketQuotes(orderedCoinIds) {
    const markets = [];
    for (const id of orderedCoinIds) {
        const symbol = SYMBOL_BY_ID[id];
        if (!symbol) continue;
        const quote = await getMarketQuote(`/${symbol.toLowerCase()}`);
        if (!quote?.ok) continue;
        markets.push({
            id,
            symbol: symbol.toLowerCase(),
            current_price: safeNumber(quote.usd, NaN),
            total_volume: NaN,
            market_cap: NaN,
            price_change_percentage_24h: safeNumber(quote.change24h, NaN)
        });
    }

    if (!markets.length) return null;

    return {
        markets,
        globalData: {},
        fetchedAt: Date.now(),
        source: 'Market fallback'
    };
}

async function getSnapshotWithFallback(coinIds) {
    const now = Date.now();

    if (
        snapshotCache.snapshot
        && (now - snapshotCache.ts) <= SNAPSHOT_CACHE_TTL_MS
        && snapshotHasAllIds(snapshotCache.snapshot, coinIds)
    ) {
        return snapshotCache.snapshot;
    }

    try {
        const fresh = await fetchCoinGeckoSnapshot(coinIds);
        snapshotCache = { ts: now, snapshot: fresh };
        return fresh;
    } catch (error) {
        const status = Number(error?.response?.status || 0);
        if (status === 429) {
            console.warn('CoinGecko 429 no IMAVY, usando fallback.');
        } else {
            console.error('Falha CoinGecko no IMAVY:', error?.message || error);
        }

        if (
            snapshotCache.snapshot
            && (now - snapshotCache.ts) <= SNAPSHOT_STALE_TTL_MS
            && snapshotHasAllIds(snapshotCache.snapshot, coinIds)
        ) {
            return {
                ...snapshotCache.snapshot,
                source: `${snapshotCache.snapshot.source || 'CoinGecko'} (cache/stale)`
            };
        }

        const fallback = await buildFallbackSnapshotFromMarketQuotes(coinIds);
        if (fallback) return fallback;
        throw error;
    }
}

function buildDataBlock(snapshot, orderedCoinIds) {
    const marketById = mapById(snapshot.markets);
    const coinLines = [];

    for (const id of orderedCoinIds) {
        const coin = marketById[id];
        if (!coin) continue;
        const symbol = String(coin?.symbol || '').toUpperCase() || id.toUpperCase();
        const line =
            `${symbol}: Preco ${formatUsdPrice(coin.current_price)} | ` +
            `Volume 24h ${formatUsdCompact(coin.total_volume)} | ` +
            `Market cap ${formatUsdCompact(coin.market_cap)} | ` +
            `Variacao 24h ${formatPct(coin.price_change_percentage_24h)}`;
        coinLines.push(line);
    }

    const btcDominance = safeNumber(snapshot.globalData?.market_cap_percentage?.btc);
    const totalMarketCap = safeNumber(snapshot.globalData?.total_market_cap?.usd);
    const totalVolume24h = safeNumber(snapshot.globalData?.total_volume?.usd);
    const globalCapChange24h = safeNumber(snapshot.globalData?.market_cap_change_percentage_24h_usd);
    const updatedAt = new Date(snapshot.fetchedAt).toLocaleString('pt-BR', { hour12: false });
    const source = snapshot?.source || 'CoinGecko';

    return [
        `Dados atuais (${source}):`,
        ...coinLines,
        `Dominancia BTC: ${Number.isFinite(btcDominance) ? `${btcDominance.toFixed(2)}%` : 'N/D'}`,
        `Market cap total: ${formatUsdCompact(totalMarketCap)}`,
        `Volume total 24h: ${formatUsdCompact(totalVolume24h)}`,
        `Variacao market cap 24h: ${formatPct(globalCapChange24h)}`,
        'Funding rate: N/D no backend atual',
        'Open interest: N/D no backend atual',
        'Noticias recentes: N/D no backend atual',
        `Atualizado em: ${updatedAt}`
    ].join('\n');
}

function buildSystemPrompt(liveDataBlock) {
    return `Voce e IMAVY, analista avancado focado exclusivamente em criptomoedas, blockchain, Web3, DeFi, tokenomics e macroeconomia cripto.

Regras obrigatorias:
- Fale apenas sobre cripto e temas diretamente relacionados.
- Se o usuario pedir outro assunto, responda educadamente que seu escopo e exclusivamente o mercado cripto.
- Use somente os dados ao vivo fornecidos abaixo. Nao invente numeros.
- Se os dados ao vivo estiverem ausentes, diga exatamente: "Nao tenho dados atualizados disponiveis neste momento."
- Entregue resposta tecnica, racional, probabilistica, sem euforia e sem maximalismo.
- Nao de recomendacao financeira direta.
- Trate a resposta como analise informativa.

Formato obrigatorio:
📊 Dados atuais:
🧠 Analise:
📈 Cenarios:
- Bullish:
- Bearish:
- Neutro:
⚠️ Pontos de atencao:
🎯 Conclusao estrategica:

Dados ao vivo do backend:
${liveDataBlock}`;
}

function cleanUserQuestion(rawQuestion) {
    const q = String(rawQuestion || '').replace(/@imavy/gi, '').trim();
    return q || 'Analise o mercado cripto neste momento.';
}

function isCryptoScopeQuestion(question) {
    const text = String(question || '').toLowerCase();
    if (!text) return true;
    return CRYPTO_SCOPE_KEYWORDS.some((k) => text.includes(k));
}

export async function generateImavyCryptoReply(rawQuestion) {
    const groqApiKey = String(process.env.GROQ_API_KEY || '').trim();
    if (!groqApiKey) {
        return 'Nao tenho dados atualizados disponiveis neste momento.';
    }

    const question = cleanUserQuestion(rawQuestion);
    if (!isCryptoScopeQuestion(question)) {
        return 'Meu escopo e exclusivamente o mercado cripto (criptomoedas, blockchain, DeFi, Web3 e dados relacionados).';
    }
    const requestedCoinIds = detectRequestedCoinIds(question);

    let snapshot;
    try {
        snapshot = await getSnapshotWithFallback(requestedCoinIds);
    } catch (error) {
        console.error('Erro ao buscar snapshot CoinGecko para IMAVY:', error?.message || error);
        return 'Nao tenho dados atualizados disponiveis neste momento.';
    }

    if (!Array.isArray(snapshot.markets) || snapshot.markets.length === 0) {
        return 'Nao tenho dados atualizados disponiveis neste momento.';
    }

    const liveDataBlock = buildDataBlock(snapshot, requestedCoinIds);
    const systemPrompt = buildSystemPrompt(liveDataBlock);

    try {
        const groq = new Groq({ apiKey: groqApiKey });
        const completion = await groq.chat.completions.create({
            model: GROQ_MODEL,
            temperature: 0.35,
            max_tokens: 1100,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: question }
            ]
        });

        const content = completion?.choices?.[0]?.message?.content?.trim();
        if (!content) {
            return 'Nao tenho dados atualizados disponiveis neste momento.';
        }
        return content;
    } catch (error) {
        console.error('Erro ao gerar resposta IMAVY via Groq:', error?.message || error);
        return 'Nao tenho dados atualizados disponiveis neste momento.';
    }
}
