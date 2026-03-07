import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { sendSafeMessage } from './messageHandler.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'news_forwarder_state.json');

const DEFAULT_FEED_URL = String(process.env.IMAVY_NEWS_FEED_URL || 'https://www.noticiasaominuto.com.br/rss/ultima-hora').trim();
const DEFAULT_TARGET_GROUP = String(process.env.IMAVY_NEWS_TARGET_GROUP || 'DESENVOLVIMENTO IA').trim();
const DEFAULT_INTERVAL_MINUTES = Math.max(2, Number.parseInt(process.env.IMAVY_NEWS_INTERVAL_MINUTES || '10', 10) || 10);
const DEFAULT_BOOTSTRAP_SEND = Math.max(0, Number.parseInt(process.env.IMAVY_NEWS_BOOTSTRAP_SEND || '0', 10) || 0);
const MAX_SEEN_URLS = 500;
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

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) {
            return {
                initialized: false,
                seenUrls: [],
                lastRunAt: null
            };
        }
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return {
            initialized: Boolean(parsed?.initialized),
            seenUrls: Array.isArray(parsed?.seenUrls) ? parsed.seenUrls.filter(Boolean) : [],
            lastRunAt: parsed?.lastRunAt || null
        };
    } catch (_) {
        return {
            initialized: false,
            seenUrls: [],
            lastRunAt: null
        };
    }
}

function saveState(state) {
    const safeState = {
        initialized: Boolean(state?.initialized),
        seenUrls: Array.isArray(state?.seenUrls) ? state.seenUrls.slice(-MAX_SEEN_URLS) : [],
        lastRunAt: new Date().toISOString()
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(safeState, null, 2), 'utf8');
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

async function resolveTargetGroup(sock, targetGroupName) {
    const normalizedTarget = normalizeGroupName(targetGroupName);
    if (!normalizedTarget) return null;

    const groups = await sock.groupFetchAllParticipating();
    const match = Object.values(groups || {}).find((group) => normalizeGroupName(group?.subject) === normalizedTarget);

    if (!match) {
        return null;
    }

    return {
        id: String(match.id || '').trim(),
        subject: String(match.subject || '').trim()
    };
}

function buildNewsPayload(article) {
    const body = truncate(article.description || `Categoria: ${article.category || 'Última hora'}`, 140);

    return {
        text: `${article.url}\nLer mais`,
        contextInfo: {
            externalAdReply: {
                showAdAttribution: false,
                title: article.title,
                body,
                sourceUrl: article.url,
                thumbnailUrl: article.image || undefined,
                mediaType: 1,
                renderLargerThumbnail: true
            }
        }
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

async function pollNews(sock) {
    if (pollingInFlight) return;
    pollingInFlight = true;

    try {
        const targetGroup = await resolveTargetGroup(sock, DEFAULT_TARGET_GROUP);
        if (!targetGroup) {
            logger.warn('news_forwarder_group_not_found', { targetGroup: DEFAULT_TARGET_GROUP });
            return;
        }

        const xml = await fetchFeedXml(DEFAULT_FEED_URL);
        const items = parseFeedItems(xml);
        if (items.length === 0) {
            logger.warn('news_forwarder_empty_feed', { feedUrl: DEFAULT_FEED_URL });
            return;
        }

        const state = loadState();
        const seenSet = new Set(state.seenUrls || []);
        const freshItems = items.filter((item) => !seenSet.has(item.url));

        if (!state.initialized) {
            const bootstrapItems = DEFAULT_BOOTSTRAP_SEND > 0
                ? freshItems.slice(-DEFAULT_BOOTSTRAP_SEND)
                : [];

            if (bootstrapItems.length > 0) {
                await sendArticles(sock, targetGroup, bootstrapItems);
            }

            saveState({
                initialized: true,
                seenUrls: items.map((item) => item.url)
            });

            logger.info('news_forwarder_initialized', {
                targetGroup: targetGroup.subject,
                feedUrl: DEFAULT_FEED_URL,
                bootstrapSent: bootstrapItems.length,
                trackedItems: items.length
            });
            return;
        }

        if (freshItems.length === 0) {
            saveState({
                initialized: true,
                seenUrls: [...state.seenUrls]
            });
            return;
        }

        await sendArticles(sock, targetGroup, freshItems);
        saveState({
            initialized: true,
            seenUrls: [...state.seenUrls, ...freshItems.map((item) => item.url)]
        });
    } catch (error) {
        logger.error('news_forwarder_poll_failed', {
            error: error?.message || String(error),
            feedUrl: DEFAULT_FEED_URL
        });
    } finally {
        pollingInFlight = false;
    }
}

export async function startNewsForwarder(sock) {
    if (pollTimer) {
        return;
    }

    logger.info('news_forwarder_started', {
        feedUrl: DEFAULT_FEED_URL,
        targetGroup: DEFAULT_TARGET_GROUP,
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
