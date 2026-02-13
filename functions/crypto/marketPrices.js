// functions/crypto/marketPrices.js
// Quotes for major market coins (USD/BRL) with short in-memory cache.

import axios from 'axios';

const COINGECKO_SIMPLE_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price';
const BINANCE_TICKER_URL = 'https://api.binance.com/api/v3/ticker/price';
const DEFAULT_CACHE_TTL_MS = 12_000;

const COMMAND_MARKET_MAP = {
  '/usdt': { id: 'tether', symbol: 'USDT', label: 'Tether', cmcSlug: 'tether', useBinanceSpotBrl: true },
  '/btc': { id: 'bitcoin', symbol: 'BTC', label: 'Bitcoin', cmcSlug: 'bitcoin' },
  '/sol': { id: 'solana', symbol: 'SOL', label: 'Solana', cmcSlug: 'solana' },
  '/xrp': { id: 'ripple', symbol: 'XRP', label: 'XRP', cmcSlug: 'xrp' },
  '/bnb': { id: 'binancecoin', symbol: 'BNB', label: 'BNB', cmcSlug: 'bnb' },
  '/eth': { id: 'ethereum', symbol: 'ETH', label: 'Ethereum', cmcSlug: 'ethereum' },
  '/ouro': { id: 'pax-gold', symbol: 'PAXG', label: 'Pax Gold', cmcSlug: 'pax-gold' },
  '/paxg': { id: 'pax-gold', symbol: 'PAXG', label: 'Pax Gold', cmcSlug: 'pax-gold' }
};

const TRACKED_IDS = Array.from(new Set(Object.values(COMMAND_MARKET_MAP).map((x) => x.id)));
const BINANCE_USDT_PAIRS = {
  USDT: 'USDTUSDT',
  BTC: 'BTCUSDT',
  SOL: 'SOLUSDT',
  XRP: 'XRPUSDT',
  BNB: 'BNBUSDT',
  ETH: 'ETHUSDT',
  PAXG: 'PAXGUSDT'
};

let marketCache = {
  ts: 0,
  data: null
};

function safeNumber(v, fallback = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getCoinGeckoHeaders() {
  const key = String(process.env.COINGECKO_API_KEY || '').trim();
  if (!key) return {};

  const customHeader = String(process.env.COINGECKO_API_HEADER || '').trim();
  if (customHeader) return { [customHeader]: key };

  const plan = String(process.env.COINGECKO_API_PLAN || 'demo').trim().toLowerCase();
  if (plan === 'pro') return { 'x-cg-pro-api-key': key };
  return { 'x-cg-demo-api-key': key };
}

function getCacheTtlMs() {
  const raw = Number(process.env.CRYPTO_MARKET_CACHE_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_CACHE_TTL_MS;
  return raw;
}

async function fetchAllTrackedFromCoinGecko() {
  const params = {
    ids: TRACKED_IDS.join(','),
    vs_currencies: 'usd,brl',
    include_24hr_change: 'true',
    include_last_updated_at: 'true'
  };

  const { data } = await axios.get(COINGECKO_SIMPLE_PRICE_URL, {
    params,
    headers: getCoinGeckoHeaders(),
    timeout: 10_000
  });

  if (!data || typeof data !== 'object') {
    throw new Error('Resposta invalida da API de mercado.');
  }

  return data;
}

async function fetchUsdtBrlSpotBinance() {
  const { data } = await axios.get(BINANCE_TICKER_URL, {
    params: { symbol: 'USDTBRL' },
    timeout: 5_000
  });

  return safeNumber(data?.price, NaN);
}

async function fetchBinanceUsdPrice(symbol) {
  const pair = BINANCE_USDT_PAIRS[String(symbol || '').toUpperCase()];
  if (!pair || pair === 'USDTUSDT') {
    if (String(symbol || '').toUpperCase() === 'USDT') return 1;
    return NaN;
  }

  const { data } = await axios.get(BINANCE_TICKER_URL, {
    params: { symbol: pair },
    timeout: 5_000
  });
  return safeNumber(data?.price, NaN);
}

async function getMarketDataCached() {
  const now = Date.now();
  const ttlMs = getCacheTtlMs();

  if (marketCache.data && (now - marketCache.ts) < ttlMs) {
    return marketCache.data;
  }

  try {
    const data = await fetchAllTrackedFromCoinGecko();
    marketCache = { ts: now, data };
    return data;
  } catch (error) {
    // Fallback para cache antigo caso CoinGecko esteja limitado/instável.
    if (marketCache.data) return marketCache.data;
    throw error;
  }
}

function buildCoinMarketCapUrl(cmcSlug) {
  return `https://coinmarketcap.com/currencies/${cmcSlug}/`;
}

export function isMarketPriceCommand(commandToken) {
  return Boolean(COMMAND_MARKET_MAP[String(commandToken || '').toLowerCase()]);
}

export async function getMarketQuote(commandToken) {
  const token = String(commandToken || '').toLowerCase();
  const meta = COMMAND_MARKET_MAP[token];

  if (!meta) {
    return { ok: false, error: 'Comando de mercado nao reconhecido.' };
  }

  let quote = null;
  let allData = null;
  try {
    allData = await getMarketDataCached();
    quote = allData?.[meta.id] || null;
  } catch (error) {
    console.error('CoinGecko indisponivel para getMarketQuote:', error?.message || error);
  }

  try {
    let brlPrice = safeNumber(quote?.brl, NaN);
    let usdPrice = safeNumber(quote?.usd, NaN);
    let change24h = safeNumber(quote?.usd_24h_change, NaN);
    let lastUpdatedAt = Number.isFinite(safeNumber(quote?.last_updated_at, NaN))
      ? safeNumber(quote?.last_updated_at, NaN) * 1000
      : null;
    const source = [];

    if (quote) source.push('CoinGecko');

    // Fallback geral: Binance spot para simbolos com par USDT.
    if (!Number.isFinite(usdPrice)) {
      try {
        const usdFromBinance = await fetchBinanceUsdPrice(meta.symbol);
        if (Number.isFinite(usdFromBinance)) {
          usdPrice = usdFromBinance;
          source.push('Binance (spot USD)');
        }
      } catch (error) {
        console.error(`Binance USD indisponivel para ${meta.symbol}:`, error?.message || error);
      }
    }

    if (!Number.isFinite(brlPrice) || meta.useBinanceSpotBrl) {
      try {
        const usdtBrlSpot = await fetchUsdtBrlSpotBinance();
        if (Number.isFinite(usdtBrlSpot)) {
          if (meta.symbol === 'USDT') {
            brlPrice = usdtBrlSpot;
          } else if (Number.isFinite(usdPrice)) {
            brlPrice = usdPrice * usdtBrlSpot;
          }
          source.push('Binance (spot BRL)');
        }
      } catch (error) {
        console.error(`Binance BRL indisponivel para ${meta.symbol}:`, error?.message || error);
      }
    }

    if (!lastUpdatedAt && source.length > 0) {
      lastUpdatedAt = Date.now();
    }

    if (!Number.isFinite(usdPrice) && !Number.isFinite(brlPrice)) {
      return { ok: false, error: `Sem cotacao disponivel para ${meta.symbol} agora.` };
    }

    return {
      ok: true,
      command: token,
      symbol: meta.symbol,
      label: meta.label,
      usd: usdPrice,
      brl: brlPrice,
      change24h,
      lastUpdatedAt,
      cmcUrl: buildCoinMarketCapUrl(meta.cmcSlug),
      source: source.length ? source.join(' + ') : 'N/D'
    };
  } catch (error) {
    console.error(`Falha ao montar cotacao para ${meta.symbol}:`, error?.message || error);
    return { ok: false, error: 'Falha ao consultar cotacao de mercado agora.' };
  }
}
