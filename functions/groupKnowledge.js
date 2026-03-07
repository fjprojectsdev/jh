import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_FILE = path.join(__dirname, '..', 'group_knowledge.json');
const MAX_ITEMS_PER_GROUP = 600;
const MAX_URLS_PER_ITEM = 8;
const MAX_TEXT_SNIPPET = 220;
const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 2000;

const state = {
    loaded: false,
    groups: {},
    flushTimer: null
};

const HELPFUL_KEYWORDS = [
    'tutorial', 'tutoriais', 'guia', 'passo', 'investir', 'cripto', 'criptomoeda',
    'carteira', 'pix', 'comprar', 'vender', 'contrato', 'dex', 'como'
];

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function truncate(value, maxLen = MAX_TEXT_SNIPPET) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen - 3)}...`;
}

function normalizeUrl(value) {
    let url = String(value || '').trim();
    if (!url) return '';
    if (/^www\./i.test(url)) {
        url = `https://${url}`;
    }
    url = url.replace(/[),.;!?]+$/g, '');
    return url;
}

function extractUrls(text) {
    const raw = String(text || '');
    const matches = raw.match(/((?:https?:\/\/|www\.)[^\s<>"'`]+)/gi) || [];
    const urls = [];
    const seen = new Set();

    for (const candidate of matches) {
        const normalized = normalizeUrl(candidate);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        urls.push(normalized);
        if (urls.length >= MAX_URLS_PER_ITEM) break;
    }

    return urls;
}

function hasHelpfulContext(text) {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    for (const keyword of HELPFUL_KEYWORDS) {
        if (normalized.includes(keyword)) {
            return true;
        }
    }
    return false;
}

function ensureLoaded() {
    if (state.loaded) return;
    state.loaded = true;
    try {
        if (!fs.existsSync(KNOWLEDGE_FILE)) {
            state.groups = {};
            return;
        }
        const parsed = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
        state.groups = parsed && typeof parsed.groups === 'object' ? parsed.groups : {};
    } catch (_) {
        state.groups = {};
    }
}

function flushNow() {
    state.flushTimer = null;
    try {
        fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify({
            updatedAt: new Date().toISOString(),
            groups: state.groups
        }, null, 2), 'utf8');
    } catch (_) {
        // noop
    }
}

function scheduleFlush() {
    if (state.flushTimer) return;
    state.flushTimer = setTimeout(flushNow, SAVE_DEBOUNCE_MS);
    if (typeof state.flushTimer.unref === 'function') {
        state.flushTimer.unref();
    }
}

function cleanupGroup(group, now = Date.now()) {
    if (!group || !Array.isArray(group.items)) return;
    const cutoff = now - RETENTION_MS;
    group.items = group.items
        .filter((item) => Number(item?.createdAt || 0) >= cutoff)
        .slice(-MAX_ITEMS_PER_GROUP);
}

function ensureGroup(groupId, groupName = '') {
    ensureLoaded();
    const gid = String(groupId || '').trim();
    if (!gid) return null;

    if (!state.groups[gid] || typeof state.groups[gid] !== 'object') {
        state.groups[gid] = {
            groupId: gid,
            groupName: String(groupName || gid).trim() || gid,
            items: [],
            updatedAt: Date.now()
        };
    }

    const group = state.groups[gid];
    if (!Array.isArray(group.items)) {
        group.items = [];
    }
    if (groupName) {
        group.groupName = String(groupName).trim() || group.groupName || gid;
    }
    cleanupGroup(group);
    return group;
}

function hasDuplicate(group, url, messageId = '') {
    if (!group || !Array.isArray(group.items)) return false;
    const safeMessageId = String(messageId || '').trim();
    return group.items.some((item) => {
        if (safeMessageId && String(item?.messageId || '').trim() === safeMessageId) return true;
        const urls = Array.isArray(item?.urls) ? item.urls : [];
        return urls.includes(url);
    });
}

export function captureGroupKnowledge({
    groupId,
    groupName = '',
    senderId = '',
    senderName = '',
    text = '',
    timestamp = Date.now(),
    messageId = ''
} = {}) {
    const safeText = String(text || '').trim();
    if (!safeText || safeText.startsWith('/')) {
        return { saved: false, reason: 'not_eligible' };
    }

    const urls = extractUrls(safeText);
    if (!urls.length) {
        return { saved: false, reason: 'no_url' };
    }
    if (!hasHelpfulContext(safeText)) {
        return { saved: false, reason: 'not_helpful' };
    }

    const group = ensureGroup(groupId, groupName);
    if (!group) {
        return { saved: false, reason: 'invalid_group' };
    }

    const newUrls = urls.filter((url) => !hasDuplicate(group, url, messageId));
    if (!newUrls.length) {
        return { saved: false, reason: 'duplicate' };
    }

    const createdAt = Number(timestamp) || Date.now();
    const entry = {
        id: String(messageId || `${createdAt}:${Math.random().toString(36).slice(2, 10)}`),
        messageId: String(messageId || '').trim(),
        senderId: String(senderId || '').trim(),
        senderName: String(senderName || '').trim(),
        text: truncate(safeText),
        urls: newUrls,
        createdAt
    };

    group.items.push(entry);
    group.updatedAt = Date.now();
    cleanupGroup(group, Date.now());
    scheduleFlush();

    return {
        saved: true,
        groupId: group.groupId,
        urls: newUrls,
        count: newUrls.length
    };
}

function tokenizeQuery(query) {
    return normalizeText(query)
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 3);
}

function scoreEntry(entry, tokens) {
    if (!tokens.length) return 1;
    const text = normalizeText(entry?.text || '');
    const urls = (Array.isArray(entry?.urls) ? entry.urls : []).join(' ').toLowerCase();
    let score = 0;
    for (const token of tokens) {
        if (text.includes(token)) score += 2;
        if (urls.includes(token)) score += 1;
    }
    return score;
}

export function getGroupKnowledgeItems(groupId, { query = '', limit = 10 } = {}) {
    const group = ensureGroup(groupId);
    if (!group || !Array.isArray(group.items) || !group.items.length) {
        return [];
    }

    const safeLimit = Math.max(1, Math.min(30, Number(limit) || 10));
    const items = [...group.items].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    const tokens = tokenizeQuery(query);

    if (!tokens.length) {
        return items.slice(0, safeLimit);
    }

    const scored = items
        .map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return Number(b.entry.createdAt || 0) - Number(a.entry.createdAt || 0);
        })
        .map((row) => row.entry)
        .slice(0, safeLimit);

    if (scored.length > 0) {
        return scored;
    }

    return items.slice(0, safeLimit);
}

function formatDatePtBr(timestamp) {
    try {
        return new Date(Number(timestamp || 0)).toLocaleDateString('pt-BR');
    } catch (_) {
        return '';
    }
}

export function buildGroupKnowledgeMessage(groupId, { query = '', limit = 8 } = {}) {
    const items = getGroupKnowledgeItems(groupId, { query, limit });
    if (!items.length) {
        return 'Ainda nao encontrei materiais salvos para este grupo.';
    }

    const lines = ['Materiais salvos deste grupo:'];
    let index = 1;
    for (const item of items) {
        const when = formatDatePtBr(item.createdAt);
        const author = String(item.senderName || item.senderId || '').trim();
        const summary = truncate(item.text, 140);
        lines.push(`${index}. ${summary}`);
        if (author || when) {
            lines.push(`   Fonte: ${author || '-'}${when ? ` | ${when}` : ''}`);
        }
        const urls = Array.isArray(item.urls) ? item.urls : [];
        for (const url of urls) {
            lines.push(`   ${url}`);
        }
        index += 1;
    }

    return lines.join('\n');
}

export function buildKnowledgeContext(groupId, query = '', limit = 6) {
    const items = getGroupKnowledgeItems(groupId, { query, limit });
    if (!items.length) {
        return '';
    }

    const lines = [
        'Base interna de materiais do grupo (links ja compartilhados no grupo):'
    ];

    let index = 1;
    for (const item of items) {
        const summary = truncate(item.text, 120);
        const urls = Array.isArray(item.urls) ? item.urls : [];
        lines.push(`${index}. ${summary}`);
        for (const url of urls) {
            lines.push(`- ${url}`);
        }
        index += 1;
    }

    return lines.join('\n');
}
