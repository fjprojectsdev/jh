import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RANKING_FILE = path.join(__dirname, '..', 'group_ranking.json');
const DEFAULT_REALTIME_TABLE = 'interacoes_texto';
const MAX_SEEN_MESSAGE_IDS = 20000;

const state = {
    loaded: false,
    groups: {},
    seenMessageIds: [],
    seenMessageSet: new Set(),
    lastBackfillAt: 0,
    flushTimer: null
};

function normalizeJid(jid) {
    return String(jid || '').split(':')[0].trim();
}

function safeName(name, fallback = '') {
    const raw = String(name || '').trim();
    return raw || fallback;
}

function levelFromMessages(totalMessages) {
    const total = Number(totalMessages || 0);
    return Math.max(1, Math.floor(total / 5) + 1);
}

function gradeFromLevel(level) {
    if (level >= 15) return 'Rei do Teclado';
    if (level >= 10) return 'Mago do Grupo';
    if (level >= 6) return 'Foguetinho';
    if (level >= 3) return 'Tagarela Premium';
    return 'Aquecendo os Dedos';
}

function ensureLoaded() {
    if (state.loaded) return;
    state.loaded = true;
    try {
        if (!fs.existsSync(RANKING_FILE)) {
            state.groups = {};
            state.seenMessageIds = [];
            state.seenMessageSet = new Set();
            state.lastBackfillAt = 0;
            return;
        }
        const parsed = JSON.parse(fs.readFileSync(RANKING_FILE, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.groups && typeof parsed.groups === 'object') {
            state.groups = parsed.groups;
            state.seenMessageIds = Array.isArray(parsed.seenMessageIds) ? parsed.seenMessageIds.map((v) => String(v || '').trim()).filter(Boolean) : [];
            state.seenMessageSet = new Set(state.seenMessageIds);
            state.lastBackfillAt = Number(parsed.lastBackfillAt || 0);
            return;
        }
    } catch (_) {}
    state.groups = {};
    state.seenMessageIds = [];
    state.seenMessageSet = new Set();
    state.lastBackfillAt = 0;
}

function flushNow() {
    state.flushTimer = null;
    const payload = {
        updatedAt: new Date().toISOString(),
        lastBackfillAt: Number(state.lastBackfillAt || 0),
        seenMessageIds: state.seenMessageIds,
        groups: state.groups
    };
    try {
        fs.writeFileSync(RANKING_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
        console.error('Falha ao salvar ranking de grupo:', error.message || String(error));
    }
}

function scheduleFlush() {
    if (state.flushTimer) return;
    state.flushTimer = setTimeout(flushNow, 1500);
}

function normalizeMessageId(messageId) {
    return String(messageId || '').trim();
}

function markMessageSeen(messageId) {
    const safe = normalizeMessageId(messageId);
    if (!safe) return;
    if (state.seenMessageSet.has(safe)) return;
    state.seenMessageSet.add(safe);
    state.seenMessageIds.push(safe);
    if (state.seenMessageIds.length <= MAX_SEEN_MESSAGE_IDS) return;

    const overflow = state.seenMessageIds.length - MAX_SEEN_MESSAGE_IDS;
    const removed = state.seenMessageIds.splice(0, overflow);
    for (const id of removed) {
        state.seenMessageSet.delete(id);
    }
}

function isMessageSeen(messageId) {
    const safe = normalizeMessageId(messageId);
    if (!safe) return false;
    return state.seenMessageSet.has(safe);
}

function getSupabaseConfig() {
    const url = String(process.env.IMAVY_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
    const key = String(
        process.env.IMAVY_SUPABASE_SERVICE_KEY
        || process.env.SUPABASE_SERVICE_ROLE_KEY
        || process.env.IMAVY_SUPABASE_ANON_KEY
        || process.env.SUPABASE_ANON_KEY
        || process.env.IMAVY_SUPABASE_PUBLISHABLE_KEY
        || process.env.SUPABASE_PUBLISHABLE_KEY
        || process.env.SUPABASE_KEY
        || ''
    ).trim();
    const table = String(process.env.IMAVY_REALTIME_TABLE || DEFAULT_REALTIME_TABLE).trim() || DEFAULT_REALTIME_TABLE;
    return { url, key, table };
}

export function trackGroupMessage({ groupId, groupName, senderId, senderName, timestamp = Date.now(), messageId = '' }) {
    const gid = String(groupId || '').trim();
    const uid = normalizeJid(senderId);
    if (!gid || !uid) return;

    ensureLoaded();
    const safeMessageId = normalizeMessageId(messageId);
    if (safeMessageId && isMessageSeen(safeMessageId)) return;

    if (!state.groups[gid]) {
        state.groups[gid] = {
            groupId: gid,
            groupName: safeName(groupName, gid),
            users: {},
            totalMessages: 0,
            updatedAt: Number(timestamp) || Date.now()
        };
    }

    const group = state.groups[gid];
    group.groupName = safeName(groupName, group.groupName || gid);
    group.totalMessages = Number(group.totalMessages || 0) + 1;
    group.updatedAt = Number(timestamp) || Date.now();

    if (!group.users || typeof group.users !== 'object') {
        group.users = {};
    }

    if (!group.users[uid]) {
        group.users[uid] = {
            senderId: uid,
            senderName: safeName(senderName, uid),
            messages: 0,
            lastMessageAt: Number(timestamp) || Date.now()
        };
    }

    const user = group.users[uid];
    user.senderId = uid;
    user.senderName = safeName(senderName, user.senderName || uid);
    user.messages = Number(user.messages || 0) + 1;
    user.lastMessageAt = Number(timestamp) || Date.now();
    if (safeMessageId) {
        markMessageSeen(safeMessageId);
    }

    scheduleFlush();
}

export async function backfillRankingFromLastHour({ hours = 1, maxRows = 5000 } = {}) {
    ensureLoaded();

    const { url, key, table } = getSupabaseConfig();
    if (!url || !key) {
        return { ok: false, skipped: true, reason: 'supabase_not_configured' };
    }

    const safeHours = Math.max(1, Math.min(24, Number(hours) || 1));
    const safeMaxRows = Math.max(100, Math.min(10000, Number(maxRows) || 5000));
    const fromIso = new Date(Date.now() - (safeHours * 60 * 60 * 1000)).toISOString();
    const endpoint = `${url}/rest/v1/${table}?select=message_id,nome,grupo,grupo_id,sender_id,created_at,texto&created_at=gte.${encodeURIComponent(fromIso)}&order=created_at.asc&limit=${safeMaxRows}`;

    const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json'
        }
    });

    if (!response.ok) {
        const err = await response.text();
        return { ok: false, error: `Falha no backfill (${response.status}): ${err}` };
    }

    const rows = await response.json();
    const list = Array.isArray(rows) ? rows : [];
    let counted = 0;
    let skippedDuplicates = 0;
    let skippedCommands = 0;

    for (const row of list) {
        const text = String(row?.texto || '').trimStart();
        if (text.startsWith('/')) {
            skippedCommands += 1;
            continue;
        }

        const messageId = normalizeMessageId(row?.message_id);
        if (messageId && isMessageSeen(messageId)) {
            skippedDuplicates += 1;
            continue;
        }

        const groupId = String(row?.grupo_id || row?.grupo || '').trim();
        const senderId = String(row?.sender_id || row?.nome || '').trim();
        if (!groupId || !senderId) continue;

        const createdAtMs = Date.parse(String(row?.created_at || ''));
        trackGroupMessage({
            groupId,
            groupName: String(row?.grupo || row?.grupo_id || '').trim(),
            senderId,
            senderName: String(row?.nome || row?.sender_id || '').trim(),
            timestamp: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
            messageId
        });
        counted += 1;
    }

    state.lastBackfillAt = Date.now();
    scheduleFlush();

    return {
        ok: true,
        counted,
        scanned: list.length,
        skippedDuplicates,
        skippedCommands,
        fromIso
    };
}

export function getGroupTopRanking(groupId, limit = 10) {
    const gid = String(groupId || '').trim();
    ensureLoaded();
    const group = state.groups[gid];
    if (!group || !group.users || typeof group.users !== 'object') {
        return {
            groupId: gid,
            groupName: gid,
            totalMessages: 0,
            top: []
        };
    }

    const top = Object.values(group.users)
        .map((user) => {
            const messages = Number(user.messages || 0);
            const level = levelFromMessages(messages);
            return {
                senderId: user.senderId,
                senderName: safeName(user.senderName, user.senderId),
                messages,
                level,
                grade: gradeFromLevel(level),
                lastMessageAt: Number(user.lastMessageAt || 0)
            };
        })
        .sort((a, b) => {
            if (b.messages !== a.messages) return b.messages - a.messages;
            if (b.level !== a.level) return b.level - a.level;
            return a.lastMessageAt - b.lastMessageAt;
        })
        .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));

    return {
        groupId: gid,
        groupName: safeName(group.groupName, gid),
        totalMessages: Number(group.totalMessages || 0),
        top
    };
}
