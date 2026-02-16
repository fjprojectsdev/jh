import SocialEngine from './socialEngine.js';

const MINUTE_MS = 60_000;
const SOCIAL_SPIKE_TTL_MS = 3 * MINUTE_MS;
const BUY_RATE_HISTORY_MS = 10 * MINUTE_MS;
const SOCIAL_ONCHAIN_COOLDOWN_MS = 2 * MINUTE_MS;
const INTERNAL_EVENT_BUFFER_LIMIT = 200;

const internalEventBuffer = [];

function minuteBucket(timestamp) {
    return Math.floor(timestamp / MINUTE_MS) * MINUTE_MS;
}

function safeUpper(value) {
    return String(value || '').trim().toUpperCase();
}

function toNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function pushInternalBuffer(payload) {
    internalEventBuffer.push(payload);
    if (internalEventBuffer.length > INTERNAL_EVENT_BUFFER_LIMIT) {
        internalEventBuffer.shift();
    }
}

export function getIntelEventBuffer() {
    return internalEventBuffer.slice();
}

export function storeIntelEvent(payload) {
    pushInternalBuffer(payload);
}

export async function sendIntelEvent(payload) {
    const webhook = String(process.env.DASHBOARD_WEBHOOK_URL || '').trim();
    if (webhook) {
        const webhookSecret = String(process.env.INTEL_WEBHOOK_SECRET || '').trim();
        const response = await fetch(webhook, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(webhookSecret ? { 'X-Intel-Key': webhookSecret } : {})
            },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Dashboard webhook respondeu ${response.status}: ${err}`);
        }
        return;
    }

    pushInternalBuffer(payload);
    console.log('INTEL EVENT:', payload);
}

export class IntelEngine {
    constructor(options = {}) {
        this.groupNames = options.groupNames || {};
        this.sendEvent = typeof options.sendEvent === 'function' ? options.sendEvent : sendIntelEvent;
        this.socialEngine = new SocialEngine({
            monitoredTokens: options.monitoredTokens || ['NIX', 'SNAP'],
            trackedEmojis: options.trackedEmojis || ['🚀', '🔥', '💎']
        });
        this.onchainBuyBuckets = new Map();
        this.recentSocialSpikes = new Map();
        this.lastConfirmAt = new Map();
        this.cleanupTimer = setInterval(() => {
            const now = Date.now();
            this.socialEngine.cleanupAll(now);
            this.cleanup(now);
        }, 30_000);
        if (typeof this.cleanupTimer.unref === 'function') {
            this.cleanupTimer.unref();
        }
    }

    async processMessage(message, groupJid, now = Date.now()) {
        const result = this.socialEngine.processMessage(message, groupJid, now);
        if (!result) {
            return;
        }

        if (result.socialSpike) {
            const socialSpikePayload = {
                type: 'SOCIAL_SPIKE',
                group: this.groupNames[result.socialSpike.groupJid] || result.socialSpike.groupJid,
                groupJid: result.socialSpike.groupJid,
                messageRate: result.socialSpike.messageRate,
                baselineRate: Number(result.socialSpike.baselineRate.toFixed(2)),
                topToken: result.socialSpike.topToken || null,
                emojiCount: result.socialSpike.emojiCount,
                socialIncrease: Math.round(result.socialSpike.socialIncrease),
                timestamp: result.socialSpike.timestamp
            };

            console.log(
                `[INTEL] SOCIAL_SPIKE detectado | grupo=${socialSpikePayload.group} | rate=${socialSpikePayload.messageRate} | baseline=${socialSpikePayload.baselineRate}`
            );
            await this.safeSend(socialSpikePayload);

            if (socialSpikePayload.topToken) {
                this.recentSocialSpikes.set(socialSpikePayload.topToken, {
                    timestamp: now,
                    socialIncrease: socialSpikePayload.socialIncrease
                });
                await this.tryEmitSocialOnchainConfirm(socialSpikePayload.topToken, now);
            }
        }

        if (result.tokenDominance) {
            const payload = {
                type: 'TOKEN_DOMINANCE',
                group: this.groupNames[result.tokenDominance.groupJid] || result.tokenDominance.groupJid,
                groupJid: result.tokenDominance.groupJid,
                token: result.tokenDominance.token,
                tokenCount: result.tokenDominance.tokenCount,
                othersCount: result.tokenDominance.othersCount,
                ratio: Number(result.tokenDominance.ratio.toFixed(2)),
                timestamp: result.tokenDominance.timestamp
            };

            console.log(
                `[INTEL] TOKEN_DOMINANCE detectado | grupo=${payload.group} | token=${payload.token} | ratio=${payload.ratio}`
            );
            await this.safeSend(payload);
        }

        this.cleanup(now);
    }

    async registerOnchainBuy(buyEvent, now = Date.now()) {
        const token = safeUpper(buyEvent && buyEvent.symbol);
        if (!token) {
            return;
        }

        const ts = toNumber(buyEvent && buyEvent.timestamp, now);
        const bucket = minuteBucket(ts);
        if (!this.onchainBuyBuckets.has(token)) {
            this.onchainBuyBuckets.set(token, new Map());
        }
        const tokenBuckets = this.onchainBuyBuckets.get(token);
        tokenBuckets.set(bucket, (tokenBuckets.get(bucket) || 0) + 1);

        await this.tryEmitSocialOnchainConfirm(token, ts);
        this.cleanup(now);
    }

    async tryEmitSocialOnchainConfirm(token, now = Date.now()) {
        const spike = this.recentSocialSpikes.get(token);
        if (!spike) {
            return;
        }

        if (now < spike.timestamp) {
            return;
        }

        if (now - spike.timestamp > SOCIAL_SPIKE_TTL_MS) {
            this.recentSocialSpikes.delete(token);
            return;
        }

        const lastConfirm = this.lastConfirmAt.get(token) || 0;
        if (now - lastConfirm < SOCIAL_ONCHAIN_COOLDOWN_MS) {
            return;
        }

        const buyStats = this.getBuyIncrease(token, now);
        if (!buyStats) {
            return;
        }

        if (buyStats.buyIncrease <= 150) {
            return;
        }

        const payload = {
            type: 'SOCIAL_ONCHAIN_CONFIRM',
            token,
            socialIncrease: Math.round(spike.socialIncrease),
            buyIncrease: Math.round(buyStats.buyIncrease),
            timestamp: now
        };

        console.log(
            `[INTEL] SOCIAL_ONCHAIN_CONFIRM detectado | token=${token} | social=${payload.socialIncrease}% | buy=${payload.buyIncrease}%`
        );
        await this.safeSend(payload);
        this.lastConfirmAt.set(token, now);
    }

    getBuyIncrease(token, now = Date.now()) {
        const tokenBuckets = this.onchainBuyBuckets.get(token);
        if (!tokenBuckets) {
            return null;
        }

        const currentBucket = minuteBucket(now);
        const current = tokenBuckets.get(currentBucket) || 0;
        const history = [];
        for (let i = 1; i <= 5; i += 1) {
            history.push(tokenBuckets.get(currentBucket - (i * MINUTE_MS)) || 0);
        }
        const baseline = history.reduce((acc, value) => acc + value, 0) / history.length;
        if (baseline <= 0) {
            return null;
        }

        const buyIncrease = ((current - baseline) / baseline) * 100;
        return {
            current,
            baseline,
            buyIncrease
        };
    }

    async safeSend(payload) {
        try {
            await this.sendEvent(payload);
        } catch (error) {
            console.warn('[INTEL] Falha ao enviar evento para dashboard:', error.message || String(error));
        }
    }

    cleanup(now = Date.now()) {
        const buyCutoff = now - BUY_RATE_HISTORY_MS;
        const spikeCutoff = now - SOCIAL_SPIKE_TTL_MS;
        const confirmCutoff = now - SOCIAL_ONCHAIN_COOLDOWN_MS;

        for (const [token, buckets] of this.onchainBuyBuckets.entries()) {
            for (const [bucket] of buckets.entries()) {
                if (bucket < buyCutoff) {
                    buckets.delete(bucket);
                }
            }
            if (buckets.size === 0) {
                this.onchainBuyBuckets.delete(token);
            }
        }

        for (const [token, spike] of this.recentSocialSpikes.entries()) {
            if (!spike || spike.timestamp < spikeCutoff) {
                this.recentSocialSpikes.delete(token);
            }
        }

        for (const [token, ts] of this.lastConfirmAt.entries()) {
            if (ts < confirmCutoff) {
                this.lastConfirmAt.delete(token);
            }
        }
    }

    stop() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }
}

export function createIntelEngine(options = {}) {
    return new IntelEngine(options);
}
