import { fetchDexPairSnapshot, resolveDexTarget } from './dexscreener.js';
import { listAliases } from './aliasStore.js';
import { PROJECT_TOKENS } from './projectTokens.js';
import { logger } from '../logger.js';

const DEFAULT_WARM_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_STALE_MAX_AGE_MS = 20 * 60 * 1000;

let warmTimer = null;
let warmInFlight = null;

function getWarmIntervalMs() {
    const raw = Number.parseInt(process.env.CRYPTO_WARM_INTERVAL_MINUTES || '5', 10);
    const minutes = Number.isFinite(raw) && raw >= 1 ? raw : 5;
    return minutes * 60 * 1000;
}

function getWarmTargetsFromProjectTokens() {
    return Object.values(PROJECT_TOKENS).map((token) => ({
        key: `${token.chain}:${token.address}`,
        chain: token.chain,
        pairAddress: String(token.pair || '').trim(),
        tokenAddress: token.address,
        label: token.label
    }));
}

async function resolveProjectTokenTarget(target) {
    if (target.pairAddress) {
        return { chain: target.chain, pairAddress: target.pairAddress, source: 'config' };
    }

    const resolved = await resolveDexTarget(`${target.chain} ${target.tokenAddress}`, target.chain);
    if (!resolved?.ok || !resolved?.pairAddress) {
        throw new Error(`Falha ao resolver pool para ${target.label || target.tokenAddress}`);
    }

    return { chain: resolved.chain, pairAddress: resolved.pairAddress, source: resolved.resolvedFrom || 'resolve' };
}

async function collectWarmTargets() {
    const targets = [];
    const seen = new Set();

    for (const target of getWarmTargetsFromProjectTokens()) {
        try {
            const resolved = await resolveProjectTokenTarget(target);
            const key = `${resolved.chain}:${resolved.pairAddress}`;
            if (!seen.has(key)) {
                seen.add(key);
                targets.push({
                    key,
                    chain: resolved.chain,
                    pairAddress: resolved.pairAddress,
                    label: target.label || key
                });
            }
        } catch (error) {
            logger.warn('Warmup: falha ao resolver token do projeto', {
                token: target.label || target.tokenAddress,
                error: error.message
            });
        }
    }

    const aliases = await listAliases().catch(() => []);
    for (const alias of aliases) {
        const pairAddress = String(alias?.pair || '').trim();
        const chain = String(alias?.chain || '').trim().toLowerCase();
        if (!pairAddress || !chain) continue;
        const key = `${chain}:${pairAddress}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({
            key,
            chain,
            pairAddress,
            label: alias.label || alias.alias || key
        });
    }

    return targets;
}

export async function warmCryptoCache() {
    if (warmInFlight) {
        return warmInFlight;
    }

    warmInFlight = (async () => {
        const startedAt = Date.now();
        const targets = await collectWarmTargets();
        let ok = 0;
        let failed = 0;

        await Promise.all(targets.map(async (target) => {
            const snap = await fetchDexPairSnapshot(target.chain, target.pairAddress, {
                allowCache: true,
                cacheTtlMs: 5_000,
                allowStale: true,
                staleMaxAgeMs: DEFAULT_STALE_MAX_AGE_MS,
                backgroundRefresh: false,
                timeoutMs: 4_000
            }).catch(() => null);

            if (snap?.ok) ok += 1;
            else failed += 1;
        }));

        const summary = {
            total: targets.length,
            ok,
            failed,
            durationMs: Date.now() - startedAt
        };

        logger.info('Warmup cripto concluido', summary);
        return summary;
    })();

    try {
        return await warmInFlight;
    } finally {
        warmInFlight = null;
    }
}

export function startCryptoCacheWarmer() {
    if (warmTimer) {
        return { started: false, intervalMs: getWarmIntervalMs() };
    }

    const intervalMs = getWarmIntervalMs() || DEFAULT_WARM_INTERVAL_MS;

    warmCryptoCache().catch((error) => {
        logger.warn('Warmup cripto inicial falhou', { error: error.message });
    });

    warmTimer = setInterval(() => {
        warmCryptoCache().catch((error) => {
            logger.warn('Warmup cripto agendado falhou', { error: error.message });
        });
    }, intervalMs);

    return {
        started: true,
        intervalMs,
        staleMaxAgeMs: DEFAULT_STALE_MAX_AGE_MS
    };
}

export function stopCryptoCacheWarmer() {
    if (warmTimer) {
        clearInterval(warmTimer);
        warmTimer = null;
    }
}
