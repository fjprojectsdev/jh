// functions/crypto/watchManager.js
// Gerencia "assinatura automática" (watch) de preços via polling.
// Mantém timers em memória (não persiste após reiniciar o processo).

import { fetchDexPairSnapshot } from './dexscreener.js';
import { sendSafeMessage } from '../messageHandler.js';

const watches = new Map(); // key -> { intervalId, groupId, aliasKey, chain, pair, label, intervalMs, failCount }

function makeKey(groupId, aliasKey) {
  return `${groupId}::${aliasKey}`;
}

function formatUsdCompact(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 'N/A';
  const abs = Math.abs(num);
  if (abs >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(num / 1e3).toFixed(2)}K`;
  if (abs >= 1) return `$${num.toFixed(4)}`;
  return `$${num.toFixed(8)}`;
}

function formatPriceUsd(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 'N/A';
  if (Math.abs(num) >= 1) return `$${num.toFixed(6)}`;
  return `$${num.toFixed(10)}`;
}

function buildCryptoText({ label, chain, pairAddress, snap }) {
  const change = Number(snap.changeH24 ?? 0);
  const changeTxt = Number.isFinite(change) ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : 'N/A';
  const link = snap.url || `https://dexscreener.com/${chain}/${pairAddress}`;
  return `📈 ${label} (${String(chain).toUpperCase()})\n` +
    `💰 Preço: ${formatPriceUsd(snap.priceUsd)}\n` +
    `🕒 24h: ${changeTxt}\n` +
    `💧 Liquidez: ${formatUsdCompact(snap.liquidityUsd)}\n` +
    `🔁 Volume 24h: ${formatUsdCompact(snap.volumeH24)}\n` +
    `🔗 ${link}`;
}

export function listWatches(groupId) {
  const out = [];
  for (const [k, w] of watches.entries()) {
    if (!groupId || w.groupId === groupId) out.push({ key: k, ...w });
  }
  return out;
}

export function stopWatch(groupId, aliasKey) {
  const key = makeKey(groupId, aliasKey);
  const w = watches.get(key);
  if (!w) return { ok: false, error: 'Não existe assinatura ativa para esse alias.' };
  clearInterval(w.intervalId);
  watches.delete(key);
  return { ok: true };
}

export function stopAllWatches(groupId) {
  let count = 0;
  for (const [k, w] of [...watches.entries()]) {
    if (w.groupId === groupId) {
      clearInterval(w.intervalId);
      watches.delete(k);
      count++;
    }
  }
  return { ok: true, count };
}

export async function startWatch({ sock, groupId, aliasKey, alias, intervalMs }) {
  const key = makeKey(groupId, aliasKey);

  if (watches.has(key)) {
    return { ok: false, error: 'Já existe uma assinatura ativa para esse alias neste grupo.' };
  }

  const w = {
    groupId,
    aliasKey,
    chain: alias.chain,
    pair: alias.pair,
    label: alias.label || aliasKey.toUpperCase(),
    intervalMs,
    failCount: 0,
    intervalId: null
  };

  const tick = async () => {
    const snap = await fetchDexPairSnapshot(w.chain, w.pair, { allowCache: true });
    if (!snap?.ok) {
      w.failCount++;
      // se falhar várias vezes, desliga para não spammar erro
      if (w.failCount >= 5) {
        try {
          await sendSafeMessage(sock, groupId, { text: `⚠️ /watch ${w.aliasKey} foi desativado após 5 falhas seguidas ao buscar dados.` });
        } catch {}
        stopWatch(groupId, aliasKey);
      }
      return;
    }

    w.failCount = 0;
    const msg = buildCryptoText({ label: w.label, chain: w.chain, pairAddress: w.pair, snap });
    await sendSafeMessage(sock, groupId, { text: msg });
  };

  // dispara uma vez imediatamente
  await tick();

  w.intervalId = setInterval(() => {
    tick().catch(() => {});
  }, intervalMs);

  watches.set(key, w);
  return { ok: true };
}

// util: parse "5m", "1h", "30" (min), etc.
export function parseIntervalMs(input, defaultMinutes = 5) {
  if (!input) return defaultMinutes * 60_000;
  const s = String(input).trim().toLowerCase();
  const m = s.match(/^([0-9]+(?:\.[0-9]+)?)(s|m|h)?$/);
  if (!m) return defaultMinutes * 60_000;
  const val = Number(m[1]);
  const unit = m[2] || 'm';
  if (!Number.isFinite(val) || val <= 0) return defaultMinutes * 60_000;

  let ms;
  if (unit === 's') ms = val * 1000;
  else if (unit === 'h') ms = val * 60 * 60_000;
  else ms = val * 60_000;

  return ms;
}
