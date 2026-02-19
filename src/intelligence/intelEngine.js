import OpenAI from 'openai';
import SocialEngine from './socialEngine.js';

const MINUTE_MS = 60_000;
const SOCIAL_SPIKE_TTL_MS = 3 * MINUTE_MS;
const BUY_RATE_HISTORY_MS = 10 * MINUTE_MS;
const SOCIAL_ONCHAIN_COOLDOWN_MS = 2 * MINUTE_MS;
const INTERNAL_EVENT_BUFFER_LIMIT = 200;
const DEFAULT_CHATGPT_MODEL = String(process.env.IMAVY_INTEL_OPENAI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
const DEFAULT_CHATGPT_MAX_QUEUE = 200;

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

function extractContentFromMessage(messageContent) {
    if (!messageContent || typeof messageContent !== 'object') {
        return null;
    }

    const wrappers = [
        messageContent.ephemeralMessage,
        messageContent.viewOnceMessage,
        messageContent.viewOnceMessageV2,
        messageContent.viewOnceMessageV2Extension,
        messageContent.documentWithCaptionMessage
    ];

    for (const wrapped of wrappers) {
        if (wrapped && wrapped.message) {
            return extractContentFromMessage(wrapped.message);
        }
    }

    return messageContent;
}

function extractMessageText(message) {
    const content = extractContentFromMessage(message && message.message);
    if (!content) {
        return '';
    }

    const candidates = [
        content.conversation,
        content.extendedTextMessage && content.extendedTextMessage.text,
        content.imageMessage && content.imageMessage.caption,
        content.videoMessage && content.videoMessage.caption,
        content.documentMessage && content.documentMessage.caption,
        content.buttonsResponseMessage && content.buttonsResponseMessage.selectedDisplayText,
        content.listResponseMessage && content.listResponseMessage.title,
        content.templateButtonReplyMessage && content.templateButtonReplyMessage.selectedDisplayText
    ];

    for (const value of candidates) {
        const text = String(value || '').trim();
        if (text) {
            return text;
        }
    }

    return '';
}

function normalizeList(value, limit = 6) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, limit);
}

function safeJsonParse(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (_) {
        return null;
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
            trackedEmojis: options.trackedEmojis || ['ðŸš€', 'ðŸ”¥', 'ðŸ’Ž']
        });
        this.onchainBuyBuckets = new Map();
        this.recentSocialSpikes = new Map();
        this.lastConfirmAt = new Map();

        this.intelChatGPTEnabled = String(process.env.IMAVY_INTEL_CHATGPT_ENABLED || 'true').toLowerCase() !== 'false';
        this.intelChatGPTModel = DEFAULT_CHATGPT_MODEL;
        this.intelChatGPTMaxQueue = Math.max(10, Number(process.env.IMAVY_INTEL_CHATGPT_MAX_QUEUE || DEFAULT_CHATGPT_MAX_QUEUE));
        this.intelChatGPTMinChars = Math.max(1, Number(process.env.IMAVY_INTEL_CHATGPT_MIN_CHARS || 8));
        this.openai = null;
        this.chatAnalysisChain = Promise.resolve();
        this.chatAnalysisQueued = 0;

        const openaiKey = String(process.env.OPENAI_API_KEY || '').trim();
        if (this.intelChatGPTEnabled && openaiKey) {
            this.openai = new OpenAI({ apiKey: openaiKey });
            console.log(`[INTEL] ChatGPT analysis ativo (model=${this.intelChatGPTModel})`);
        } else {
            console.log('[INTEL] ChatGPT analysis inativo (configure OPENAI_API_KEY e IMAVY_INTEL_CHATGPT_ENABLED=true)');
        }

        this.cleanupTimer = setInterval(() => {
            const now = Date.now();
            this.socialEngine.cleanupAll(now);
            this.cleanup(now);
        }, 30_000);
        if (typeof this.cleanupTimer.unref === 'function') {
            this.cleanupTimer.unref();
        }
    }

    async processMessage(message, groupJid, now = Date.now(), meta = {}) {
        const result = this.socialEngine.processMessage(message, groupJid, now);
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

        const text = String(meta.text || extractMessageText(message) || '').trim();
        if (text.length >= this.intelChatGPTMinChars) {
            const senderId = String(meta.senderId || message?.key?.participant || message?.key?.remoteJid || '').trim();
            const isGroup = typeof meta.isGroup === 'boolean'
                ? meta.isGroup
                : String(groupJid || '').endsWith('@g.us');
            const groupName = String(meta.groupName || this.groupNames[groupJid] || groupJid || '').trim();

            this.queueConversationAnalysis({
                text,
                senderId,
                groupJid: String(groupJid || '').trim(),
                groupName,
                isGroup,
                timestamp: toNumber(meta.timestamp, now)
            });
        }

        this.cleanup(now);
    }

    queueConversationAnalysis(payload) {
        if (!this.openai) return;
        if (this.chatAnalysisQueued >= this.intelChatGPTMaxQueue) return;

        this.chatAnalysisQueued += 1;
        this.chatAnalysisChain = this.chatAnalysisChain
            .then(() => this.analyzeConversation(payload))
            .catch((error) => {
                console.warn('[INTEL] Falha na analise ChatGPT:', error.message || String(error));
            })
            .finally(() => {
                this.chatAnalysisQueued = Math.max(0, this.chatAnalysisQueued - 1);
            });
    }

    async analyzeConversation(payload) {
        const completion = await this.openai.chat.completions.create({
            model: this.intelChatGPTModel,
            temperature: 0.2,
            max_tokens: 220,
            messages: [
                {
                    role: 'system',
                    content:
                        'Voce analisa mensagens de WhatsApp para inteligencia operacional. Responda somente JSON valido com as chaves: sentiment (POSITIVO|NEGATIVO|NEUTRO), intent (texto curto), riskLevel (BAIXO|MEDIO|ALTO), topics (array curto), summary (1 frase curta), relevanceScore (0-100).'
                },
                {
                    role: 'user',
                    content:
                        `Grupo: ${payload.groupName}\n` +
                        `Eh grupo: ${payload.isGroup ? 'sim' : 'nao'}\n` +
                        `Mensagem: ${payload.text}`
                }
            ]
        });

        const rawResponse = completion?.choices?.[0]?.message?.content || '';
        const parsed = safeJsonParse(rawResponse) || {};
        const sentiment = safeUpper(parsed.sentiment || 'NEUTRO');
        const riskLevel = safeUpper(parsed.riskLevel || 'BAIXO');
        const topics = normalizeList(parsed.topics, 8);
        const summary = String(parsed.summary || '').trim().slice(0, 320);
        const intent = String(parsed.intent || '').trim().slice(0, 120);
        const relevanceScore = Math.max(0, Math.min(100, toNumber(parsed.relevanceScore, 0)));

        const eventPayload = {
            type: 'CHATGPT_CONVERSATION_ANALYSIS',
            group: payload.groupName,
            groupJid: payload.groupJid,
            senderId: payload.senderId,
            isGroup: payload.isGroup,
            snippet: String(payload.text || '').slice(0, 280),
            sentiment,
            intent,
            riskLevel,
            topics,
            summary,
            relevanceScore,
            model: this.intelChatGPTModel,
            timestamp: payload.timestamp || Date.now(),
            raw: parsed
        };

        await this.safeSend(eventPayload);
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
