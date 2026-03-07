import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'group_bot_state.json');

const state = {
    loaded: false,
    pausedGroups: {},
    flushTimer: null
};

function normalizeGroupId(groupId) {
    return String(groupId || '').trim();
}

function ensureLoaded() {
    if (state.loaded) return;
    state.loaded = true;
    try {
        if (!fs.existsSync(STATE_FILE)) {
            state.pausedGroups = {};
            return;
        }

        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        const pausedGroups = parsed && typeof parsed.pausedGroups === 'object'
            ? parsed.pausedGroups
            : {};
        state.pausedGroups = pausedGroups;
    } catch (_) {
        state.pausedGroups = {};
    }
}

function flushNow() {
    state.flushTimer = null;
    try {
        const payload = {
            updatedAt: new Date().toISOString(),
            pausedGroups: state.pausedGroups
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (_) {
        // noop
    }
}

function scheduleFlush() {
    if (state.flushTimer) return;
    state.flushTimer = setTimeout(flushNow, 1000);
    if (typeof state.flushTimer.unref === 'function') {
        state.flushTimer.unref();
    }
}

export function isGroupBotPaused(groupId) {
    ensureLoaded();
    const gid = normalizeGroupId(groupId);
    if (!gid) return false;
    return Boolean(state.pausedGroups[gid]?.paused);
}

export function setGroupBotPaused(groupId, paused, meta = {}) {
    ensureLoaded();
    const gid = normalizeGroupId(groupId);
    if (!gid) {
        return { ok: false, error: 'invalid_group_id' };
    }

    if (paused) {
        state.pausedGroups[gid] = {
            paused: true,
            groupId: gid,
            groupName: String(meta.groupName || '').trim(),
            pausedAt: Date.now(),
            pausedBy: String(meta.by || '').trim(),
            reason: String(meta.reason || '').trim()
        };
    } else {
        delete state.pausedGroups[gid];
    }

    scheduleFlush();
    return {
        ok: true,
        groupId: gid,
        paused: Boolean(paused),
        info: state.pausedGroups[gid] || null
    };
}

export function getPausedGroups() {
    ensureLoaded();
    return Object.values(state.pausedGroups || {})
        .filter((item) => item && item.paused)
        .map((item) => ({
            groupId: normalizeGroupId(item.groupId),
            groupName: String(item.groupName || '').trim(),
            pausedAt: Number(item.pausedAt || 0),
            pausedBy: String(item.pausedBy || '').trim()
        }));
}
