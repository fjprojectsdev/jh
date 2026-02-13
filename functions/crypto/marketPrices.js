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

let marketCache = {
  ts: 0,
  data: null
};

function safeNumber(v, fallback = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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

async function getMarketDataCached() {
  const now = Date.now();
  const ttlMs = getCacheTtlMs();

  if (marketCache.data && (now - marketCache.ts) < ttlMs) {
    return marketCache.data;
  }

  const data = await fetchAllTrackedFromCoinGecko();
  marketCache = { ts: now, data };
  return data;
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

  try {
    const allData = await getMarketDataCached();
    const quote = allData[meta.id];

    if (!quote) {
      return { ok: false, error: `Sem cotacao disponivel para ${meta.symbol}.` };
    }

    let brlPrice = safeNumber(quote?.brl, NaN);
    const source = ['CoinGecko'];

    if (meta.useBinanceSpotBrl) {
      try {
        const usdtBrlSpot = await fetchUsdtBrlSpotBinance();
        if (Number.isFinite(usdtBrlSpot)) {
          brlPrice = usdtBrlSpot;
          source.push('Binance (spot BRL)');
        }
      } catch {
        // Keep CoinGecko BRL as fallback when Binance is unavailable.
      }
    }

    const lastUpdatedSeconds = safeNumber(quote?.last_updated_at, NaN);
    const lastUpdatedAt = Number.isFinite(lastUpdatedSeconds)
      ? (lastUpdatedSeconds * 1000)
      : null;

    return {
      ok: true,
      command: token,
      symbol: meta.symbol,
      label: meta.label,
      usd: safeNumber(quote?.usd, NaN),
      brl: brlPrice,
      change24h: safeNumber(quote?.usd_24h_change, NaN),
      lastUpdatedAt,
      cmcUrl: buildCoinMarketCapUrl(meta.cmcSlug),
      source: source.join(' + ')
    };
  } catch {
    return { ok: false, error: 'Falha ao consultar cotacao de mercado agora.' };
  }
}

