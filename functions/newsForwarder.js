import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { sendSafeMessage } from './messageHandler.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'news_forwarder_config.json');
const STATE_FILE = path.join(__dirname, '..', 'news_forwarder_state.json');

const DEFAULT_FEED_URL = String(process.env.IMAVY_NEWS_FEED_URL || 'https://www.noticiasaominuto.com.br/rss/ultima-hora').trim();
const DEFAULT_TARGET_GROUP = String(process.env.IMAVY_NEWS_TARGET_GROUP || 'DESENVOLVIMENTO IA').trim();
const DEFAULT_INTERVAL_MINUTES = Math.max(2, Number.parseInt(process.env.IMAVY_NEWS_INTERVAL_MINUTES || '10', 10) || 10);
const DEFAULT_BOOTSTRAP_SEND = Math.max(0, Number.parseInt(process.env.IMAVY_NEWS_BOOTSTRAP_SEND || '0', 10) || 0);
const MAX_SEEN_URLS = 500;
const MAX_SENT_URLS = 500;
const MAX_DESCRIPTION_LENGTH = 220;

let pollTimer = null;
let pollingInFlight = false;

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
        const sent = await sendSafeMessage(sock, targetGroup.id, buildNewsPayload(article));
        if (sent) {
            logger.info('news_forwarder_sent', {
                group: targetGroup.subject,
                title: article.title,
                url: article.url
            });
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
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

function resolveSubscriptionTarget(groups, subscription) {
    const byId = String(subscription?.groupId || '').trim();
    const byName = normalizeGroupName(subscription?.groupName);

    if (byId && groups[byId]) {
        const group = groups[byId];
        return { id: byId, subject: String(group?.subject || byId).trim() || byId };
    }

    if (!byName) return null;

    for (const [id, group] of Object.entries(groups || {})) {
        if (normalizeGroupName(group?.subject) === byName) {
            return { id, subject: String(group?.subject || id).trim() || id };
        }
    }

    return null;
}

async function pollSubscription(sock, groups, subscription, state) {
    const targetGroup = resolveSubscriptionTarget(groups, subscription);
    if (!targetGroup) {
        logger.warn('news_forwarder_group_not_found', {
            groupId: subscription?.groupId || '',
            groupName: subscription?.groupName || '',
            feedUrl: subscription?.feedUrl || ''
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

        const groups = await sock.groupFetchAllParticipating();
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

export async function startNewsForwarder(sock) {
    if (pollTimer) {
        return;
    }

    logger.info('news_forwarder_started', {
        intervalMinutes: DEFAULT_INTERVAL_MINUTES
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
