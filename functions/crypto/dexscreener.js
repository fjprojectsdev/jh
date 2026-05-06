// functions/crypto/dexscreener.js
// Integracao leve com Dexscreener (Opcao A: polling)
// - Resolve link/token/pair
// - Snapshot com cache curto (anti rate-limit)

import axios from 'axios';

const API_BASE = 'https://api.dexscreener.com';
const DEXVIEW_API_BASE = 'https://api.dexview.com';
const DEXVIEW_SITE_BASE = 'https://www.dexview.com';
const DEXVIEW_API_SECRET = String(process.env.DEXVIEW_API_SECRET || '5ff3a258-2700-11ed-a261-0242ac120002').trim();
const DEXVIEW_CHAIN_ID_BY_SLUG = {
  ethereum: '1',
  eth: '1',
  bsc: '56',
  binance: '56',
  polygon: '137',
  matic: '137',
  arbitrum: '42161',
  arb: '42161',
  base: '8453',
  avalanche: '43114',
  avax: '43114',
  solana: 'solana',
  sol: 'solana'
};
const DEXVIEW_CHAIN_SLUG_BY_ID = {
  '1': 'ethereum',
  '56': 'bsc',
  '137': 'polygon',
  '8453': 'base',
  '43114': 'avalanche',
  '42161': 'arbitrum',
  solana: 'solana'
};

// Cache em memoria (10s por alvo) para reduzir chamadas repetidas
const snapshotCache = new Map();
const snapshotInflight = new Map();

export function getDexPairSnapshotFromCache(chain, pairAddress) {
  const key = `${chain}:${pairAddress}`;
  const cached = snapshotCache.get(key);
  if (!cached?.value?.ok) {
    return null;
  }

  return {
    ...cached.value,
    stale: true,
    staleTs: cached.ts,
    cacheOnly: true
  };
}

function normalizeHexAddress(input) {
  if (!input) return null;
  const raw = String(input).trim();
  const evmMatch = raw.match(/0x[a-fA-F0-9]{40}/);
  if (evmMatch) return evmMatch[0];

  // Suporte a enderecos base58 (ex.: Solana)
  const base58Match = raw.match(/[1-9A-HJ-NP-Za-km-z]{32,48}/);
  if (base58Match) return base58Match[0];

  return null;
}

function parseDexScreenerLink(input) {
  // Ex.: https://dexscreener.com/bsc/0x...
  try {
    const url = new URL(String(input).trim());
    if (!/dexscreener\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const chain = parts[0].toLowerCase();
    const addr = normalizeHexAddress(parts[1]);
    if (!addr) return null;
    return { chain, address: addr, kind: 'pair' };
  } catch {
    return null;
  }
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getDexviewHeaders() {
  return {
    secret: DEXVIEW_API_SECRET,
    Origin: DEXVIEW_SITE_BASE,
    Referer: `${DEXVIEW_SITE_BASE}/`,
    'User-Agent': 'Mozilla/5.0'
  };
}

function normalizeChainForDexview(chain) {
  const safe = String(chain || '').trim().toLowerCase();
  return DEXVIEW_CHAIN_ID_BY_SLUG[safe] || null;
}

function dexviewChainSlug(chainId, fallback = 'bsc') {
  const safe = String(chainId || '').trim().toLowerCase();
  return DEXVIEW_CHAIN_SLUG_BY_ID[safe] || String(fallback || 'bsc').trim().toLowerCase();
}

async function searchDexviewPairs(keyword) {
  const safeKeyword = String(keyword || '').trim();
  if (!safeKeyword) return [];

  try {
    const { data } = await axios.get(`${DEXVIEW_API_BASE}/pair/search`, {
      params: { keyword: safeKeyword },
      headers: getDexviewHeaders(),
      timeout: 10_000
    });
    return Array.isArray(data?.data) ? data.data : [];
  } catch {
    return [];
  }
}

function rankDexviewPairResults(results, { chain, exactAddress = null, tokenAddress = null } = {}) {
  const wantedChainId = normalizeChainForDexview(chain);
  const wantedAddress = normalizeHexAddress(exactAddress)?.toLowerCase() || null;
  const wantedToken = normalizeHexAddress(tokenAddress)?.toLowerCase() || null;

  const filtered = (Array.isArray(results) ? results : []).filter((item) => {
    const itemChainId = String(item?.chainId || '').trim().toLowerCase();
    if (wantedChainId && itemChainId !== wantedChainId) return false;
    if (wantedAddress) {
      return String(item?.address || '').trim().toLowerCase() === wantedAddress;
    }
    if (wantedToken) {
      const baseToken = String(item?.baseToken || '').trim().toLowerCase();
      const quoteToken = String(item?.quoteToken || '').trim().toLowerCase();
      return baseToken === wantedToken || quoteToken === wantedToken;
    }
    return true;
  });

  return filtered.sort((a, b) => {
    const liquidityDiff = safeNumber(b?.liquidity, 0) - safeNumber(a?.liquidity, 0);
    if (liquidityDiff !== 0) return liquidityDiff;
    return safeNumber(b?.volume24h, 0) - safeNumber(a?.volume24h, 0);
  });
}

function mapDexviewPairToSnapshot(item, chain, requestedPairAddress) {
  if (!item) {
    return { ok: false, error: 'Par nao encontrado.' };
  }

  const pairAddress = normalizeHexAddress(item?.address || requestedPairAddress);
  if (!pairAddress) {
    return { ok: false, error: 'Par nao encontrado.' };
  }

  const chainSlug = dexviewChainSlug(item?.chainId, chain);
  const tokenAddress = normalizeHexAddress(item?.baseToken || item?.quoteToken) || pairAddress;
  return {
    ok: true,
    chain: chainSlug,
    pairAddress,
    tokenAddress,
    baseSymbol: item?.baseTokenSymbol || 'TOKEN',
    quoteSymbol: item?.quoteTokenSymbol || '',
    priceUsd: safeNumber(item?.priceUsd, NaN),
    liquidityUsd: safeNumber(item?.liquidity, 0),
    volumeH24: safeNumber(item?.volume24h, 0),
    changeH24: safeNumber(item?.priceChange24h, 0),
    url: `${DEXVIEW_SITE_BASE}/${chainSlug}/${tokenAddress}`,
    ts: Date.now(),
    source: 'dexview'
  };
}

/**
 * Resolve entrada do usuario para um alvo Dexscreener.
 * Suporta:
 *  - link Dexscreener
 *  - /grafico bsc 0xPAIR
 *  - /grafico 0xPAIR (assume bsc)
 *  - /grafico bsc 0xTOKEN (vira "token" e escolhe a pool lider)
 */
export async function resolveDexTarget(argsText, defaultChain = 'bsc') {
  const raw = String(argsText || '').trim();
  if (!raw) return { ok: false, error: 'Use: /grafico <link|endereco> ou /grafico <chain> <endereco>' };

  // 1) Link
  const fromLink = parseDexScreenerLink(raw);
  if (fromLink) {
    return { ok: true, chain: fromLink.chain, pairAddress: fromLink.address, resolvedFrom: 'link' };
  }

  // 2) Tokens: aceitar "chain address" ou so "address"
  const parts = raw.split(/\s+/).filter(Boolean);
  let chain = defaultChain;
  let addr = null;

  if (parts.length >= 2 && /^[a-z0-9-]+$/i.test(parts[0])) {
    chain = parts[0].toLowerCase();
    addr = normalizeHexAddress(parts[1]);
  } else {
    addr = normalizeHexAddress(raw);
  }

  if (!addr) {
    return { ok: false, error: 'Nao encontrei um endereco 0x valido. Ex.: /grafico bsc 0x...' };
  }

  // 3) Tentar como PAIR primeiro
  const pair = await fetchDexPairSnapshot(chain, addr, { allowCache: false, timeoutMs: 8000 }).catch(() => null);
  if (pair && pair.ok) {
    return { ok: true, chain, pairAddress: addr, resolvedFrom: 'pair' };
  }

  // 4) Se nao for pair, tratar como TOKEN e escolher melhor pool
  const best = await resolveBestPairFromToken(chain, addr);
  if (!best.ok) return best;
  return { ok: true, chain, pairAddress: best.pairAddress, resolvedFrom: 'token' };
}

async function resolveBestPairFromToken(chain, tokenAddress) {
  const dexviewResults = await searchDexviewPairs(tokenAddress);
  const rankedDexview = rankDexviewPairResults(dexviewResults, {
    chain,
    tokenAddress
  });
  const dexviewTop = rankedDexview[0];
  const dexviewPairAddress = normalizeHexAddress(dexviewTop?.address);
  if (dexviewPairAddress) {
    return { ok: true, pairAddress: dexviewPairAddress, resolvedBy: 'dexview' };
  }

  const url = `${API_BASE}/token-pairs/v1/${encodeURIComponent(chain)}/${encodeURIComponent(tokenAddress)}`;
  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    if (!Array.isArray(data) || data.length === 0) {
      return { ok: false, error: 'Token nao encontrado na Dexview/Dexscreener para essa chain.' };
    }

    // Escolhe a pool lider por liquidez (usd). Fallback: volume 24h.
    const ranked = [...data].sort((a, b) => {
      const la = safeNumber(a?.liquidity?.usd, 0);
      const lb = safeNumber(b?.liquidity?.usd, 0);
      if (lb !== la) return lb - la;
      const va = safeNumber(a?.volume?.h24, 0);
      const vb = safeNumber(b?.volume?.h24, 0);
      return vb - va;
    });

    const top = ranked[0];
    const pairAddress = normalizeHexAddress(top?.pairAddress);
    if (!pairAddress) {
      return { ok: false, error: 'Nao consegui resolver a pool principal desse token.' };
    }
    return { ok: true, pairAddress, resolvedBy: 'dexscreener' };
  } catch (e) {
    return { ok: false, error: 'Falha ao consultar Dexview/Dexscreener para esse token.' };
  }
}

/**
 * Snapshot de um par na Dexscreener.
 */
export async function fetchDexPairSnapshot(chain, pairAddress, opts = {}) {
  const {
    allowCache = true,
    cacheTtlMs = 10_000,
    timeoutMs = 10_000,
    allowStale = false,
    staleMaxAgeMs = 35 * 60_000,
    backgroundRefresh = false,
    allowAnyCached = false
  } = opts;
  const key = `${chain}:${pairAddress}`;
  const now = Date.now();
  const cached = snapshotCache.get(key);
  const cacheAgeMs = cached ? (now - cached.ts) : Number.POSITIVE_INFINITY;

  if (allowCache && cached && cacheAgeMs < cacheTtlMs) {
    return cached.value;
  }

  if (allowStale && cached?.value?.ok && cacheAgeMs < staleMaxAgeMs) {
    if (backgroundRefresh && !snapshotInflight.has(key)) {
      fetchDexPairSnapshot(chain, pairAddress, {
        ...opts,
        allowStale: false,
        backgroundRefresh: false
      }).catch(() => {});
    }

    return {
      ...cached.value,
      stale: true,
      staleTs: cached.ts
    };
  }

  if (allowAnyCached && cached?.value?.ok) {
    if (backgroundRefresh && !snapshotInflight.has(key)) {
      fetchDexPairSnapshot(chain, pairAddress, {
        ...opts,
        allowStale: false,
        allowAnyCached: false,
        backgroundRefresh: false
      }).catch(() => {});
    }

    return {
      ...cached.value,
      stale: true,
      staleTs: cached.ts,
      cacheOnly: true
    };
  }

  if (snapshotInflight.has(key)) {
    return snapshotInflight.get(key);
  }

  const url = `${API_BASE}/latest/dex/pairs/${encodeURIComponent(chain)}/${encodeURIComponent(pairAddress)}`;

  const request = (async () => {
    const dexviewResults = await searchDexviewPairs(pairAddress);
    const dexviewPair = rankDexviewPairResults(dexviewResults, {
      chain,
      exactAddress: pairAddress
    })[0];
    if (dexviewPair) {
      const out = mapDexviewPairToSnapshot(dexviewPair, chain, pairAddress);
      if (allowCache) snapshotCache.set(key, { ts: now, value: out });
      return out;
    }

    try {
      const { data } = await axios.get(url, { timeout: timeoutMs });
      const p = data?.pair;
      if (!p) {
        const out = { ok: false, error: 'Par nao encontrado.' };
        if (allowCache) snapshotCache.set(key, { ts: now, value: out });
        return out;
      }

      const out = {
        ok: true,
        chain,
        pairAddress,
        tokenAddress: normalizeHexAddress(p?.baseToken?.address) || normalizeHexAddress(p?.quoteToken?.address) || null,
        baseSymbol: p?.baseToken?.symbol || 'TOKEN',
        quoteSymbol: p?.quoteToken?.symbol || '',
        priceUsd: safeNumber(p?.priceUsd, NaN),
        liquidityUsd: safeNumber(p?.liquidity?.usd, 0),
        volumeH24: safeNumber(p?.volume?.h24, 0),
        changeH24: safeNumber(p?.priceChange?.h24, 0),
        url: p?.url || null,
        ts: now
      };

      if (allowCache) snapshotCache.set(key, { ts: now, value: out });
      return out;
    } catch (e) {
      if (cached?.value?.ok) {
        return {
          ...cached.value,
          stale: true,
          staleTs: cached.ts
        };
      }

      const out = { ok: false, error: 'Falha ao consultar a Dexscreener (pairs).' };
      if (allowCache) snapshotCache.set(key, { ts: now, value: out });
      return out;
    } finally {
      snapshotInflight.delete(key);
    }
  })();

  snapshotInflight.set(key, request);
  return request;
}
