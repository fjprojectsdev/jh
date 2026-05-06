import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import OpenAI from 'openai';

import { sendSafeMessage } from './messageHandler.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'news_forwarder_config.json');
const STATE_FILE = path.join(__dirname, '..', 'news_forwarder_state.json');

const DEFAULT_FEED_URL = String(process.env.IMAVY_NEWS_FEED_URL || 'https://www.noticiasaominuto.com.br/rss/ultima-hora').trim();
const DEFAULT_TARGET_GROUP = String(process.env.IMAVY_NEWS_TARGET_GROUP || 'DESENVOLVIMENTO IA').trim();
const DEFAULT_INTERVAL_MINUTES = Math.max(2, Number.parseInt(process.env.IMAVY_NEWS_INTERVAL_MINUTES || '10', 10) || 10);
const DEFAULT_BOOTSTRAP_SEND = Math.max(0, Number.parseInt(process.env.IMAVY_NEWS_BOOTSTRAP_SEND || '0', 10) || 0);
const DEFAULT_SEND_DELAY_MS = Math.max(1000, Number.parseInt(process.env.IMAVY_NEWS_SEND_DELAY_MS || '12000', 10) || 12000);
const MAX_SEEN_URLS = 500;
const MAX_SENT_URLS = 500;
const MAX_DESCRIPTION_LENGTH = 220;
const NEWSLETTER_CACHE_TTL_MS = Math.max(5 * 60 * 1000, Number.parseInt(process.env.IMAVY_NEWSLETTER_CACHE_TTL_MS || String(60 * 60 * 1000), 10) || (60 * 60 * 1000));
const NEWS_TRANSLATION_CACHE_TTL_MS = Math.max(30 * 60 * 1000, Number.parseInt(process.env.IMAVY_NEWS_TRANSLATION_CACHE_TTL_MS || String(24 * 60 * 60 * 1000), 10) || (24 * 60 * 60 * 1000));
const NEWS_TRANSLATION_ENABLED = String(process.env.IMAVY_NEWS_TRANSLATE_TO_PTBR || 'true').trim().toLowerCase() !== 'false';
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const GROQ_API_KEY = String(process.env.GROQ_API_KEY || '').trim();
const OPENROUTER_API_KEY = String(process.env.OPENROUTER_API_KEY || '').trim();
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
const GROQ_MODEL = String(process.env.IMAVY_GROQ_MODEL || 'llama-3.3-70b-versatile').trim();
const OPENROUTER_MODEL = String(process.env.IMAVY_OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free').trim();
const AI_PROVIDER = String(process.env.IMAVY_AI_PROVIDER || 'openai,groq,openrouter')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
const ENGLISH_NEWS_HOSTS = new Set([
    'feeds.bbci.co.uk',
    'www.bbc.com',
    'bbc.com',
    'www.aljazeera.com',
    'aljazeera.com',
    'rss.dw.com',
    'dw.com',
    'www.dw.com'
]);
const NEWS_PRESETS = Object.freeze({
    monitor24h: Object.freeze({
        key: 'monitor24h',
        label: 'Monitor 24h Brasil + Mundo',
        description: 'Noticias continuas do Brasil e do mundo com fontes estaveis em RSS.',
        feedUrls: Object.freeze([
            'https://agenciabrasil.ebc.com.br/rss/ultimasnoticias/feed.xml',
            'https://g1.globo.com/rss/g1/',
            'https://feeds.folha.uol.com.br/emcimadahora/rss091.xml',
            'https://g1.globo.com/rss/g1/mundo/',
            'https://feeds.bbci.co.uk/news/world/rss.xml',
            'https://www.aljazeera.com/xml/rss/all.xml',
            'https://rss.dw.com/rdf/rss-en-all'
        ])
    })
});

let pollTimer = null;
let pollingInFlight = false;
const newsletterTargetCache = new Map();
const newsTranslationCache = new Map();
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

function normalizeGroupName(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function decodeXmlEntities(value) {
    return String(value || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function stripHtml(value) {
    return decodeXmlEntities(String(value || ''))
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function truncate(value, maxLen = MAX_DESCRIPTION_LENGTH) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen - 3).trim()}...`;
}

function normalizeFeedUrl(rawUrl) {
    const safeUrl = String(rawUrl || '').trim();
    if (!safeUrl) return '';
    try {
        const parsed = new URL(safeUrl);
        parsed.hash = '';
        return parsed.toString();
    } catch (_) {
        return '';
    }
}

function normalizePresetKey(value) {
    return String(value || '')
        .normalize('NFKC')
        .trim()
        .toLowerCase();
}

function readTag(block, tagName) {
    const match = String(block || '').match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
    return match ? decodeXmlEntities(match[1]).trim() : '';
}

function readEnclosureUrl(block) {
    const match = String(block || '').match(/<enclosure\b[^>]*url="([^"]+)"/i);
    return match ? decodeXmlEntities(match[1]).trim() : '';
}

function cleanArticleUrl(rawUrl) {
    const safeUrl = String(rawUrl || '').trim();
    if (!safeUrl) return '';

    try {
        const parsed = new URL(safeUrl);
        const params = new URLSearchParams(parsed.search);
        const kept = new URLSearchParams();
        for (const [key, value] of params.entries()) {
            if (!key.toLowerCase().startsWith('utm_')) {
                kept.append(key, value);
            }
        }
        parsed.search = kept.toString();
        return parsed.toString();
    } catch (_) {
        return safeUrl;
    }
}

function extractHostname(rawUrl) {
    try {
        return new URL(String(rawUrl || '').trim()).hostname.toLowerCase();
    } catch (_) {
        return '';
    }
}

function isLikelyEnglishNewsSource(article, subscription) {
    const hosts = [
        extractHostname(subscription?.feedUrl),
        extractHostname(article?.url)
    ].filter(Boolean);
    return hosts.some((host) => ENGLISH_NEWS_HOSTS.has(host));
}

async function callGroqTranslation(messages) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
            model: GROQ_MODEL,
            messages,
            max_tokens: 500,
            temperature: 0.2
        })
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Groq API error (${response.status}): ${errorData.error?.message || response.statusText}`);
    }

    return response.json();
}

async function callOpenRouterTranslation(messages) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://github.com/imavybot',
            'X-Title': 'iMavyBot'
        },
        body: JSON.stringify({
            model: OPENROUTER_MODEL,
            messages,
            max_tokens: 500,
            temperature: 0.2
        })
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`OpenRouter API error (${response.status}): ${errorData.error?.message || response.statusText}`);
    }

    return response.json();
}

function extractTranslationResult(rawText, fallback) {
    const raw = String(rawText || '').trim();
    if (!raw) return fallback;

    try {
        const parsed = JSON.parse(raw);
        return {
            title: String(parsed?.title || fallback.title || '').trim() || fallback.title,
            description: String(parsed?.description || fallback.description || '').trim() || fallback.description
        };
    } catch (_) {
        return fallback;
    }
}

async function translateArticleToPtBr(article, subscription) {
    if (!NEWS_TRANSLATION_ENABLED) return article;
    if (!isLikelyEnglishNewsSource(article, subscription)) return article;

    const cacheKey = `${article.url}|pt-br`;
    const cached = newsTranslationCache.get(cacheKey);
    if (cached && (Date.now() - cached.cachedAt) < NEWS_TRANSLATION_CACHE_TTL_MS) {
        return {
            ...article,
            title: cached.value.title,
            description: cached.value.description
        };
    }

    const fallback = {
        title: article.title,
        description: article.description
    };

    const messages = [
        {
            role: 'system',
            content: 'Traduza noticias para portugues do Brasil. Preserve nomes proprios, siglas, numeros e contexto jornalistico. Responda somente em JSON com as chaves "title" e "description".'
        },
        {
            role: 'user',
            content: JSON.stringify({
                title: article.title,
                description: article.description
            })
        }
    ];

    const providers = AI_PROVIDER.length ? AI_PROVIDER : ['openai', 'groq', 'openrouter'];
    for (const provider of providers) {
        try {
            let responseText = '';
            if (provider === 'openai' && openai) {
                const data = await openai.chat.completions.create({
                    model: OPENAI_MODEL,
                    messages,
                    max_tokens: 500,
                    temperature: 0.2,
                    response_format: { type: 'json_object' }
                });
                responseText = data?.choices?.[0]?.message?.content?.trim() || '';
            } else if (provider === 'groq' && GROQ_API_KEY) {
                const data = await callGroqTranslation(messages);
                responseText = data?.choices?.[0]?.message?.content?.trim() || '';
            } else if (provider === 'openrouter' && OPENROUTER_API_KEY) {
                const data = await callOpenRouterTranslation(messages);
                responseText = data?.choices?.[0]?.message?.content?.trim() || '';
            } else {
                continue;
            }

            const translated = extractTranslationResult(responseText, fallback);
            newsTranslationCache.set(cacheKey, {
                cachedAt: Date.now(),
                value: translated
            });
            logger.info('news_forwarder_translated', {
                provider,
                url: article.url
            });
            return {
                ...article,
                title: translated.title,
                description: translated.description
            };
        } catch (error) {
            logger.warn('news_forwarder_translation_failed', {
                provider,
                url: article.url,
                error: error?.message || String(error)
            });
        }
    }

    return article;
}

function parseFeedItems(xml) {
    const itemBlocks = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || [];

    return itemBlocks
        .map((block) => {
            const title = stripHtml(readTag(block, 'title'));
            const url = cleanArticleUrl(stripHtml(readTag(block, 'link')));
            const description = truncate(stripHtml(readTag(block, 'description')));
            const category = stripHtml(readTag(block, 'category'));
            const image = readEnclosureUrl(block);
            const pubDateRaw = stripHtml(readTag(block, 'pubDate'));
            const publishedAt = Number.isNaN(Date.parse(pubDateRaw)) ? Date.now() : Date.parse(pubDateRaw);

            if (!title || !url) return null;

            return {
                title,
                url,
                description,
                category,
                image,
                pubDateRaw,
                publishedAt
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.publishedAt - b.publishedAt);
}

function getDefaultConfig() {
    return {
        subscriptions: DEFAULT_TARGET_GROUP && DEFAULT_FEED_URL
            ? [{
                groupId: '',
                groupName: DEFAULT_TARGET_GROUP,
                feedUrl: DEFAULT_FEED_URL,
                active: true,
                createdAt: Date.now(),
                updatedAt: Date.now()
            }]
            : []
    };
}

function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_FILE)) {
            const defaultConfig = getDefaultConfig();
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2), 'utf8');
            return defaultConfig;
        }
        const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const subscriptions = Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
        return { subscriptions };
    } catch (_) {
        return getDefaultConfig();
    }
}

function saveConfig(config) {
    const safeConfig = {
        updatedAt: new Date().toISOString(),
        subscriptions: Array.isArray(config?.subscriptions) ? config.subscriptions : []
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(safeConfig, null, 2), 'utf8');
}

function subscriptionKey(subscription) {
    return `${String(subscription?.groupId || subscription?.groupName || '').trim()}|${normalizeFeedUrl(subscription?.feedUrl)}`;
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) {
            return {
                subscriptions: {}
            };
        }
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return {
            subscriptions: parsed?.subscriptions && typeof parsed.subscriptions === 'object'
                ? parsed.subscriptions
                : {}
        };
    } catch (_) {
        return {
            subscriptions: {}
        };
    }
}

function saveState(state) {
    const safeState = {
        updatedAt: new Date().toISOString(),
        subscriptions: state?.subscriptions && typeof state.subscriptions === 'object'
            ? state.subscriptions
            : {}
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(safeState, null, 2), 'utf8');
}

function getSubscriptionState(state, subscription) {
    const key = subscriptionKey(subscription);
    if (!state.subscriptions[key]) {
        state.subscriptions[key] = {
            initialized: false,
            seenUrls: [],
            sentUrls: [],
            lastRunAt: null
        };
    }
    return state.subscriptions[key];
}

async function fetchFeedXml(feedUrl) {
    const response = await fetch(feedUrl, {
        headers: {
            'user-agent': 'iMavyBot/1.0 (+https://github.com/fjprojectsdev/jh)'
        }
    });

    if (!response.ok) {
        throw new Error(`RSS retornou HTTP ${response.status}`);
    }

    return response.text();
}

function buildNewsPayload(article) {
    const body = truncate(article.description || `Categoria: ${article.category || 'Última hora'}`, 140);
    const displayUrl = article.url.replace('https://', 'https://\u200B');
    const caption = [
        `📰 *${article.title}*`,
        '',
        body,
        '',
        `🔗 ${displayUrl}`,
        'Ler mais'
    ].join('\n');

    if (article.image) {
        return {
            image: { url: article.image },
            caption
        };
    }

    return {
        text: caption
    };
}

async function sendArticles(sock, targetGroup, articles) {
    for (const article of articles) {
        const translatedArticle = await translateArticleToPtBr(article, targetGroup.subscription || null);
        const sent = await sendSafeMessage(sock, targetGroup.id, buildNewsPayload(translatedArticle));
        if (sent) {
            logger.info('news_forwarder_sent', {
                group: targetGroup.subject,
                title: translatedArticle.title,
                url: translatedArticle.url
            });
        }
        await new Promise((resolve) => setTimeout(resolve, DEFAULT_SEND_DELAY_MS));
    }
}

function getSeenUrlsSnapshot(items) {
    return items.map((item) => item.url).slice(-MAX_SEEN_URLS);
}

function mergeSeenUrls(items, sentUrls = [], extraUrls = []) {
    return Array.from(new Set([
        ...(Array.isArray(sentUrls) ? sentUrls : []).filter(Boolean),
        ...getSeenUrlsSnapshot(items),
        ...(Array.isArray(extraUrls) ? extraUrls : []).filter(Boolean)
    ])).slice(-Math.max(MAX_SEEN_URLS, MAX_SENT_URLS));
}

function mergeSentUrls(current = [], extraUrls = []) {
    return Array.from(new Set([
        ...(Array.isArray(current) ? current : []).filter(Boolean),
        ...(Array.isArray(extraUrls) ? extraUrls : []).filter(Boolean)
    ])).slice(-MAX_SENT_URLS);
}

async function resolveNewsletterTarget(sock, subscription) {
    const explicitJid = String(
        subscription?.newsletterJid
        || subscription?.channelJid
        || ''
    ).trim();
    const displayName = String(
        subscription?.newsletterName
        || subscription?.channelName
        || subscription?.groupName
        || 'Canal'
    ).trim();

    if (explicitJid) {
        return { id: explicitJid, subject: displayName || explicitJid, targetType: 'newsletter', subscription };
    }

    const inviteCode = String(
        subscription?.newsletterInviteCode
        || subscription?.channelInviteCode
        || ''
    ).trim();

    if (!inviteCode || typeof sock?.newsletterMetadata !== 'function') {
        return null;
    }

    const cacheKey = inviteCode.toLowerCase();
    const cached = newsletterTargetCache.get(cacheKey);
    if (cached && (Date.now() - cached.cachedAt) < NEWSLETTER_CACHE_TTL_MS) {
        return cached.value;
    }

    try {
        const metadata = await sock.newsletterMetadata('invite', inviteCode);
        if (!metadata?.id) {
            return null;
        }

        const resolved = {
            id: String(metadata.id).trim(),
            subject: String(metadata.name || displayName || metadata.id).trim() || String(metadata.id).trim(),
            targetType: 'newsletter',
            subscription
        };
        newsletterTargetCache.set(cacheKey, {
            cachedAt: Date.now(),
            value: resolved
        });
        return resolved;
    } catch (error) {
        logger.warn('news_forwarder_newsletter_lookup_failed', {
            inviteCode,
            error: error?.message || String(error)
        });
        return null;
    }
}

async function resolveSubscriptionTarget(sock, groups, subscription) {
    const byId = String(subscription?.groupId || '').trim();
    const byName = normalizeGroupName(subscription?.groupName);
    const targetType = String(subscription?.targetType || '').trim().toLowerCase();

    if (targetType === 'newsletter' || subscription?.newsletterJid || subscription?.channelJid || subscription?.newsletterInviteCode || subscription?.channelInviteCode) {
        return resolveNewsletterTarget(sock, subscription);
    }

    if (byId && groups[byId]) {
        const group = groups[byId];
        return { id: byId, subject: String(group?.subject || byId).trim() || byId, targetType: 'group', subscription };
    }

    if (!byName) return null;

    for (const [id, group] of Object.entries(groups || {})) {
        if (normalizeGroupName(group?.subject) === byName) {
            return { id, subject: String(group?.subject || id).trim() || id, targetType: 'group', subscription };
        }
    }

    return null;
}

async function pollSubscription(sock, groups, subscription, state) {
    const targetGroup = await resolveSubscriptionTarget(sock, groups, subscription);
    if (!targetGroup) {
        logger.warn('news_forwarder_group_not_found', {
            groupId: subscription?.groupId || '',
            groupName: subscription?.groupName || '',
            feedUrl: subscription?.feedUrl || '',
            targetType: subscription?.targetType || '',
            newsletterInviteCode: subscription?.newsletterInviteCode || subscription?.channelInviteCode || ''
        });
        return;
    }

    const feedUrl = normalizeFeedUrl(subscription?.feedUrl);
    if (!feedUrl) {
        logger.warn('news_forwarder_invalid_feed', { subscription });
        return;
    }

    const xml = await fetchFeedXml(feedUrl);
    const items = parseFeedItems(xml);
    if (items.length === 0) {
        logger.warn('news_forwarder_empty_feed', { feedUrl, group: targetGroup.subject });
        return;
    }

    const subscriptionState = getSubscriptionState(state, subscription);
    const sentUrls = Array.isArray(subscriptionState.sentUrls) ? subscriptionState.sentUrls : [];
    const seenSet = new Set([
        ...(Array.isArray(subscriptionState.seenUrls) ? subscriptionState.seenUrls : []),
        ...sentUrls
    ]);
    const freshItems = items.filter((item) => !seenSet.has(item.url));

    if (!subscriptionState.initialized) {
        const bootstrapItems = DEFAULT_BOOTSTRAP_SEND > 0
            ? freshItems.slice(-DEFAULT_BOOTSTRAP_SEND)
            : [];

        if (bootstrapItems.length > 0) {
            await sendArticles(sock, targetGroup, bootstrapItems);
        }

        subscriptionState.initialized = true;
        subscriptionState.sentUrls = mergeSentUrls(sentUrls, bootstrapItems.map((item) => item.url));
        subscriptionState.seenUrls = mergeSeenUrls(items, subscriptionState.sentUrls, bootstrapItems.map((item) => item.url));
        subscriptionState.lastRunAt = new Date().toISOString();

        logger.info('news_forwarder_initialized', {
            targetGroup: targetGroup.subject,
            feedUrl,
            targetType: targetGroup.targetType || 'group',
            bootstrapSent: bootstrapItems.length,
            trackedItems: items.length
        });
        return;
    }

    if (freshItems.length === 0) {
        subscriptionState.lastRunAt = new Date().toISOString();
        subscriptionState.seenUrls = mergeSeenUrls(items, sentUrls);
        return;
    }

    const latestFreshItem = freshItems[freshItems.length - 1];
    await sendArticles(sock, targetGroup, [latestFreshItem]);
    subscriptionState.initialized = true;
    subscriptionState.lastRunAt = new Date().toISOString();
    subscriptionState.sentUrls = mergeSentUrls(sentUrls, [latestFreshItem.url]);
    subscriptionState.seenUrls = mergeSeenUrls(items, subscriptionState.sentUrls, [latestFreshItem.url]);
}

async function pollNews(sock) {
    if (pollingInFlight) return;
    pollingInFlight = true;

    try {
        const config = loadConfig();
        const subscriptions = (config.subscriptions || []).filter((item) => item && item.active !== false && normalizeFeedUrl(item.feedUrl));
        if (!subscriptions.length) {
            return;
        }

        let groups = {};
        try {
            groups = await sock.groupFetchAllParticipating();
        } catch (error) {
            logger.warn('news_forwarder_group_fetch_failed', {
                error: error?.message || String(error)
            });
        }
        const state = loadState();

        for (const subscription of subscriptions) {
            try {
                await pollSubscription(sock, groups, subscription, state);
            } catch (error) {
                logger.error('news_forwarder_subscription_failed', {
                    error: error?.message || String(error),
                    groupId: subscription?.groupId || '',
                    groupName: subscription?.groupName || '',
                    feedUrl: subscription?.feedUrl || ''
                });
            }
        }

        saveState(state);
    } catch (error) {
        logger.error('news_forwarder_poll_failed', {
            error: error?.message || String(error)
        });
    } finally {
        pollingInFlight = false;
    }
}

export function listNewsSubscriptions() {
    return loadConfig().subscriptions || [];
}

export function listNewsPresets() {
    return Object.values(NEWS_PRESETS).map((preset) => ({
        key: preset.key,
        label: preset.label,
        description: preset.description,
        feedUrls: [...preset.feedUrls]
    }));
}

export function upsertNewsSubscription({ groupId = '', groupName = '', feedUrl = '' } = {}) {
    const normalizedFeed = normalizeFeedUrl(feedUrl);
    if (!normalizedFeed) {
        return { ok: false, message: 'Link invalido. Envie um URL HTTP/HTTPS valido.' };
    }

    const safeGroupId = String(groupId || '').trim();
    const safeGroupName = String(groupName || '').trim();
    if (!safeGroupId && !safeGroupName) {
        return { ok: false, message: 'Grupo invalido.' };
    }

    const config = loadConfig();
    const now = Date.now();
    const existingIndex = config.subscriptions.findIndex((item) => (
        String(item.groupId || '').trim() === safeGroupId
        && normalizeFeedUrl(item.feedUrl) === normalizedFeed
    ));
    const subscription = {
        groupId: safeGroupId,
        groupName: safeGroupName,
        feedUrl: normalizedFeed,
        active: true,
        createdAt: existingIndex >= 0 ? config.subscriptions[existingIndex].createdAt || now : now,
        updatedAt: now
    };

    if (existingIndex >= 0) {
        config.subscriptions[existingIndex] = subscription;
    } else {
        config.subscriptions.push(subscription);
    }
    saveConfig(config);

    return {
        ok: true,
        subscription
    };
}

export function upsertMultipleNewsSubscriptions({ groupId = '', groupName = '', feedUrls = [] } = {}) {
    const uniqueFeeds = Array.from(new Set(
        (Array.isArray(feedUrls) ? feedUrls : [])
            .map((item) => normalizeFeedUrl(item))
            .filter(Boolean)
    ));

    if (!uniqueFeeds.length) {
        return { ok: false, message: 'Nenhum link valido foi informado.' };
    }

    const saved = [];
    for (const feedUrl of uniqueFeeds) {
        const result = upsertNewsSubscription({ groupId, groupName, feedUrl });
        if (!result.ok) {
            return result;
        }
        saved.push(result.subscription);
    }

    return {
        ok: true,
        subscriptions: saved
    };
}

export function upsertNewsPresetSubscriptions({ groupId = '', groupName = '', presetKey = '' } = {}) {
    const preset = NEWS_PRESETS[normalizePresetKey(presetKey)];
    if (!preset) {
        return { ok: false, message: 'Preset de noticias invalido.' };
    }

    const result = upsertMultipleNewsSubscriptions({
        groupId,
        groupName,
        feedUrls: preset.feedUrls
    });

    if (!result.ok) {
        return result;
    }

    return {
        ...result,
        preset: {
            key: preset.key,
            label: preset.label
        }
    };
}

export function removeNewsSubscription(groupId, groupName = '') {
    const safeGroupId = String(groupId || '').trim();
    const safeGroupName = normalizeGroupName(groupName);
    if (!safeGroupId && !safeGroupName) {
        return { ok: false, removed: 0 };
    }

    const config = loadConfig();
    const before = config.subscriptions.length;
    config.subscriptions = config.subscriptions.filter((item) => {
        const itemGroupId = String(item.groupId || '').trim();
        const itemGroupName = normalizeGroupName(item.groupName);
        const matchesById = safeGroupId && itemGroupId === safeGroupId;
        const matchesByName = safeGroupName && itemGroupName === safeGroupName;
        return !(matchesById || matchesByName);
    });
    const removed = before - config.subscriptions.length;
    saveConfig(config);

    return {
        ok: removed > 0,
        removed
    };
}

export function removeMultipleNewsSubscriptions({ groupId = '', groupName = '', feedUrls = [] } = {}) {
    const safeGroupId = String(groupId || '').trim();
    const safeGroupName = normalizeGroupName(groupName);
    const normalizedFeeds = new Set(
        (Array.isArray(feedUrls) ? feedUrls : [])
            .map((item) => normalizeFeedUrl(item))
            .filter(Boolean)
    );

    if ((!safeGroupId && !safeGroupName) || normalizedFeeds.size === 0) {
        return { ok: false, removed: 0 };
    }

    const config = loadConfig();
    const before = config.subscriptions.length;
    config.subscriptions = config.subscriptions.filter((item) => {
        const itemGroupId = String(item.groupId || '').trim();
        const itemGroupName = normalizeGroupName(item.groupName);
        const itemFeed = normalizeFeedUrl(item.feedUrl);
        const matchesById = safeGroupId && itemGroupId === safeGroupId;
        const matchesByName = safeGroupName && itemGroupName === safeGroupName;
        const matchesGroup = matchesById || matchesByName;
        if (!matchesGroup) return true;
        return !normalizedFeeds.has(itemFeed);
    });
    const removed = before - config.subscriptions.length;
    saveConfig(config);

    return {
        ok: removed > 0,
        removed
    };
}

export function removeNewsPresetSubscriptions({ groupId = '', groupName = '', presetKey = '' } = {}) {
    const preset = NEWS_PRESETS[normalizePresetKey(presetKey)];
    if (!preset) {
        return { ok: false, removed: 0 };
    }

    return removeMultipleNewsSubscriptions({
        groupId,
        groupName,
        feedUrls: preset.feedUrls
    });
}

export async function startNewsForwarder(sock) {
    if (pollTimer) {
        return;
    }

    logger.info('news_forwarder_started', {
        intervalMinutes: DEFAULT_INTERVAL_MINUTES,
        sendDelayMs: DEFAULT_SEND_DELAY_MS
    });

    await pollNews(sock);

    pollTimer = setInterval(() => {
        pollNews(sock).catch((error) => {
            logger.error('news_forwarder_interval_failed', { error: error?.message || String(error) });
        });
    }, DEFAULT_INTERVAL_MINUTES * 60 * 1000);

    if (typeof pollTimer.unref === 'function') {
        pollTimer.unref();
    }
}

export function stopNewsForwarder() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
}

export async function runNewsForwarderNow(sock) {
    await pollNews(sock);
}
