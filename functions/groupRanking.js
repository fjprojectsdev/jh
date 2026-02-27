import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RANKING_FILE = path.join(__dirname, '..', 'group_ranking.json');

const state = {
    loaded: false,
    groups: {},
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
            return;
        }
        const parsed = JSON.parse(fs.readFileSync(RANKING_FILE, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.groups && typeof parsed.groups === 'object') {
            state.groups = parsed.groups;
            return;
        }
    } catch (_) {}
    state.groups = {};
}

function flushNow() {
    state.flushTimer = null;
    const payload = {
        updatedAt: new Date().toISOString(),
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

export function trackGroupMessage({ groupId, groupName, senderId, senderName, timestamp = Date.now() }) {
    const gid = String(groupId || '').trim();
    const uid = normalizeJid(senderId);
    if (!gid || !uid) return;

    ensureLoaded();

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

    scheduleFlush();
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
