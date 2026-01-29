// functions/crypto/dexscreener.js
// Integração leve com Dexscreener (Opção A: polling)
// - Resolve link/token/pair
// - Snapshot com cache curto (anti rate-limit)

import axios from 'axios';

const API_BASE = 'https://api.dexscreener.com';

// Cache em memória (10s por alvo) para reduzir chamadas repetidas
const snapshotCache = new Map();

function normalizeHexAddress(input) {
  if (!input) return null;
  const m = String(input).trim().match(/0x[a-fA-F0-9]{40}/);
  return m ? m[0] : null;
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

/**
 * Resolve entrada do usuário para um alvo Dexscreener.
 * Suporta:
 *  - link Dexscreener
 *  - /grafico bsc 0xPAIR
 *  - /grafico 0xPAIR (assume bsc)
 *  - /grafico bsc 0xTOKEN (vira "token" e escolhe a pool líder)
 */
export async function resolveDexTarget(argsText, defaultChain = 'bsc') {
  const raw = String(argsText || '').trim();
  if (!raw) return { ok: false, error: 'Use: /grafico <link|0x...> ou /grafico <chain> <0x...>' };

  // 1) Link
  const fromLink = parseDexScreenerLink(raw);
  if (fromLink) {
    return { ok: true, chain: fromLink.chain, pairAddress: fromLink.address, resolvedFrom: 'link' };
  }

  // 2) Tokens: aceitar "chain address" ou só "address"
  const parts = raw.split(/\s+/).filter(Boolean);
  let chain = defaultChain;
  let addr = null;

  if (parts.length >= 2 && /^[a-z0-9-]+$/i.test(parts[0]) && parts[1].includes('0x')) {
    chain = parts[0].toLowerCase();
    addr = normalizeHexAddress(parts[1]);
  } else {
    addr = normalizeHexAddress(raw);
  }

  if (!addr) {
    return { ok: false, error: 'Não encontrei um endereço 0x válido. Ex.: /grafico bsc 0x...' };
  }

  // 3) Tentar como PAIR primeiro
  const pair = await fetchDexPairSnapshot(chain, addr, { allowCache: false, timeoutMs: 8000 }).catch(() => null);
  if (pair && pair.ok) {
    return { ok: true, chain, pairAddress: addr, resolvedFrom: 'pair' };
  }

  // 4) Se não for pair, tratar como TOKEN e escolher melhor pool
  const best = await resolveBestPairFromToken(chain, addr);
  if (!best.ok) return best;
  return { ok: true, chain, pairAddress: best.pairAddress, resolvedFrom: 'token' };
}

async function resolveBestPairFromToken(chain, tokenAddress) {
  const url = `${API_BASE}/token-pairs/v1/${encodeURIComponent(chain)}/${encodeURIComponent(tokenAddress)}`;
  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    if (!Array.isArray(data) || data.length === 0) {
      return { ok: false, error: 'Token não encontrado na Dexscreener para essa chain.' };
    }

    // Escolhe a pool líder por liquidez (usd). Fallback: volume 24h.
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
      return { ok: false, error: 'Não consegui resolver a pool principal desse token.' };
    }
    return { ok: true, pairAddress };
  } catch (e) {
    return { ok: false, error: 'Falha ao consultar a Dexscreener (token-pairs).' };
  }
}

/**
 * Snapshot de um par na Dexscreener.
 */
export async function fetchDexPairSnapshot(chain, pairAddress, opts = {}) {
  const { allowCache = true, cacheTtlMs = 10_000, timeoutMs = 10_000 } = opts;
  const key = `${chain}:${pairAddress}`;
  const now = Date.now();

  if (allowCache) {
    const cached = snapshotCache.get(key);
    if (cached && (now - cached.ts) < cacheTtlMs) return cached.value;
  }

  const url = `${API_BASE}/latest/dex/pairs/${encodeURIComponent(chain)}/${encodeURIComponent(pairAddress)}`;

  try {
    const { data } = await axios.get(url, { timeout: timeoutMs });
    const p = data?.pair;
    if (!p) {
      const out = { ok: false, error: 'Par não encontrado.' };
      if (allowCache) snapshotCache.set(key, { ts: now, value: out });
      return out;
    }

    const out = {
      ok: true,
      chain,
      pairAddress,
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
    const out = { ok: false, error: 'Falha ao consultar a Dexscreener (pairs).' };
    if (allowCache) snapshotCache.set(key, { ts: now, value: out });
    return out;
  }
}
