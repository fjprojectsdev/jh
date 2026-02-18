import { renderEngagementRadarImage } from './engagementRadarImage.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const STOP_WORDS = new Set([
    'de', 'do', 'da', 'dos', 'das', 'e', 'em', 'no', 'na', 'nos', 'nas', 'o', 'a', 'os', 'as',
    'um', 'uma', 'uns', 'umas', 'para', 'pra', 'com', 'sem', 'por', 'que', 'como', 'isso', 'agora',
    'the', 'and', 'for', 'this', 'that'
]);

function normalize(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function normalizeGroupName(value) {
    return normalize(value).replace(/\s+/g, ' ');
}

function getAllowedMessages(messages, allowedGroupNames) {
    const allowed = new Set((allowedGroupNames || []).map((name) => normalizeGroupName(name)).filter(Boolean));
    if (allowed.size === 0) {
        return [];
    }
    return (Array.isArray(messages) ? messages : []).filter((m) => allowed.has(normalizeGroupName(m.groupName)));
}

function toTopicCandidates(text) {
    const safe = String(text || '');
    const tokens = [];
    const upper = safe.match(/\b[A-Z]{3,8}\b/g) || [];
    upper.forEach((t) => tokens.push(t));
    const dollar = safe.match(/\$[A-Za-z]{2,10}\b/g) || [];
    dollar.forEach((t) => tokens.push(t.slice(1).toUpperCase()));

    const normalized = normalize(safe)
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter((w) => w.length >= 3)
        .filter((w) => !STOP_WORDS.has(w));

    for (let i = 0; i < normalized.length - 1; i += 1) {
        const phrase = `${normalized[i]} ${normalized[i + 1]}`;
        tokens.push(phrase);
    }

    return tokens;
}

function computePeakWindow(messages24h, now) {
    const buckets = Array(24).fill(0);
    messages24h.forEach((m) => {
        const ts = Number(m.timestamp || 0);
        const hourOffset = Math.floor((now - ts) / HOUR_MS);
        if (hourOffset >= 0 && hourOffset < 24) {
            const idx = 23 - hourOffset;
            buckets[idx] += 1;
        }
    });
    let best = 0;
    let bestIdx = 0;
    for (let i = 0; i < 23; i += 1) {
        const value = buckets[i] + buckets[i + 1];
        if (value > best) {
            best = value;
            bestIdx = i;
        }
    }
    const start = String(bestIdx).padStart(2, '0');
    const end = String((bestIdx + 2) % 24).padStart(2, '0');
    return `${start}h-${end}h`;
}

function summarizeStatus(growthPct) {
    if (growthPct >= 10) return { label: 'QUENTE' };
    if (growthPct >= 0) return { label: 'MORNO' };
    return { label: 'FRIO' };
}

function countQuestionsWithoutFollowup(messages24h) {
    const byGroup = new Map();
    messages24h.forEach((m) => {
        const gid = String(m.groupId || 'sem-grupo');
        if (!byGroup.has(gid)) byGroup.set(gid, []);
        byGroup.get(gid).push(m);
    });

    let unanswered = 0;
    for (const arr of byGroup.values()) {
        const sorted = [...arr].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
        for (let i = 0; i < sorted.length; i += 1) {
            const msg = sorted[i];
            if (!String(msg.text || '').includes('?')) continue;
            const baseTs = Number(msg.timestamp || 0);
            let answered = false;
            for (let j = i + 1; j < sorted.length; j += 1) {
                const next = sorted[j];
                const diff = Number(next.timestamp || 0) - baseTs;
                if (diff > (20 * 60 * 1000)) break;
                if (String(next.userId || '') !== String(msg.userId || '')) {
                    answered = true;
                    break;
                }
            }
            if (!answered) unanswered += 1;
        }
    }
    return unanswered;
}

function countReducedActivity(current, previous) {
    const cur = new Map();
    const prev = new Map();
    current.forEach((m) => {
        const id = String(m.userId || '');
        if (!id) return;
        cur.set(id, (cur.get(id) || 0) + 1);
    });
    previous.forEach((m) => {
        const id = String(m.userId || '');
        if (!id) return;
        prev.set(id, (prev.get(id) || 0) + 1);
    });

    let reduced = 0;
    for (const [id, prevCount] of prev.entries()) {
        const curCount = cur.get(id) || 0;
        if (prevCount >= 3 && curCount < (prevCount * 0.5)) {
            reduced += 1;
        }
    }
    return reduced;
}

function topGroups(messages24h) {
    const map = new Map();
    messages24h.forEach((m) => {
        const gid = String(m.groupId || 'sem-grupo');
        if (!map.has(gid)) {
            map.set(gid, {
                groupId: gid,
                groupName: String(m.groupName || gid),
                totalMessages: 0,
                users: new Set()
            });
        }
        const row = map.get(gid);
        row.totalMessages += 1;
        if (m.userId) row.users.add(String(m.userId));
    });
    return Array.from(map.values())
        .map((r) => ({
            groupId: r.groupId,
            groupName: r.groupName,
            totalMessages: r.totalMessages,
            activeUsers: r.users.size
        }))
        .sort((a, b) => b.totalMessages - a.totalMessages)
        .slice(0, 10);
}

function topEngagersByGroup(messages24h, limitGroups = 3, limitUsers = 5) {
    const groupMap = new Map();
    messages24h.forEach((m) => {
        const gid = String(m.groupId || 'sem-grupo');
        if (!groupMap.has(gid)) {
            groupMap.set(gid, {
                groupId: gid,
                groupName: String(m.groupName || gid),
                totalMessages: 0,
                users: new Map()
            });
        }
        const group = groupMap.get(gid);
        group.totalMessages += 1;

        const uid = String(m.userId || '').trim();
        if (!uid) return;
        if (!group.users.has(uid)) {
            group.users.set(uid, {
                userId: uid,
                name: String(m.displayName || '').trim() || uid,
                totalMessages: 0
            });
        }
        group.users.get(uid).totalMessages += 1;
    });

    return Array.from(groupMap.values())
        .sort((a, b) => b.totalMessages - a.totalMessages)
        .slice(0, Math.max(1, Number(limitGroups) || 3))
        .map((group) => ({
            groupId: group.groupId,
            groupName: group.groupName,
            totalMessages: group.totalMessages,
            topUsers: Array.from(group.users.values())
                .sort((a, b) => b.totalMessages - a.totalMessages)
                .slice(0, Math.max(1, Number(limitUsers) || 5))
        }));
}

export async function buildEngagementRadar({ messages, allowedGroupNames, now = Date.now() }) {
    const scoped = getAllowedMessages(messages, allowedGroupNames);
    const currentStart = now - DAY_MS;
    const prevStart = now - (2 * DAY_MS);

    const current24h = scoped.filter((m) => Number(m.timestamp || 0) >= currentStart);
    const previous24h = scoped.filter((m) => {
        const ts = Number(m.timestamp || 0);
        return ts >= prevStart && ts < currentStart;
    });

    if (current24h.length === 0) {
        return {
            text: 'Nenhum dado de engajamento nas ultimas 24h.',
            image: null
        };
    }

    const activeUsers = new Set(current24h.map((m) => String(m.userId || '')).filter(Boolean)).size;
    const prevCount = Math.max(1, previous24h.length);
    const growthPct = ((current24h.length - previous24h.length) / prevCount) * 100;
    const msgPerMin = current24h.length / 1440;

    const engagersMap = new Map();
    current24h.forEach((m) => {
        const id = String(m.userId || '');
        if (!id) return;
        if (!engagersMap.has(id)) {
            engagersMap.set(id, { name: String(m.displayName || '').trim() || id, totalMessages: 0 });
        }
        engagersMap.get(id).totalMessages += 1;
    });
    const topEngagers = Array.from(engagersMap.values())
        .sort((a, b) => b.totalMessages - a.totalMessages)
        .slice(0, 5);

    const topicMap = new Map();
    current24h.forEach((m) => {
        const candidates = toTopicCandidates(m.text);
        candidates.forEach((c) => topicMap.set(c, (topicMap.get(c) || 0) + 1));
    });
    const hotTopics = Array.from(topicMap.entries())
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([label, count]) => ({ label: String(label).toUpperCase(), count }));

    const opportunities = {
        unansweredQuestions: countQuestionsWithoutFollowup(current24h),
        reducedActivityUsers: countReducedActivity(current24h, previous24h)
    };

    const suggestionTopic = hotTopics[0]?.label || 'SEM TOPICO';
    const suggestion = `${suggestionTopic} esta puxando conversa. Considere abrir enquete e CTA no horario de pico.`;

    const report = {
        status: summarizeStatus(growthPct),
        summary: {
            totalMessages: current24h.length,
            activeUsers,
            growthPct,
            msgPerMin,
            peakWindow: computePeakWindow(current24h, now)
        },
        topEngagers,
        topEngagersByGroup: topEngagersByGroup(current24h, 3, 5),
        hotTopics,
        opportunities,
        topGroups: topGroups(current24h),
        suggestion
    };

    const image = await renderEngagementRadarImage(report);
    const groupLeadsLines = (report.topEngagersByGroup || []).map((group) => {
        const leaders = (group.topUsers || [])
            .slice(0, 3)
            .map((u) => `${u.name} (${u.totalMessages})`)
            .join(', ');
        return `- ${group.groupName}: ${leaders || 'sem dados'}`;
    });

    const text = [
        'IMAVY - Radar de Engajamento',
        `Status: ${report.status.label}`,
        `Mensagens: ${report.summary.totalMessages} | Ativos: ${report.summary.activeUsers} | Crescimento: ${report.summary.growthPct.toFixed(1)}%`,
        `Pico: ${report.summary.peakWindow}`,
        'Top por grupo:',
        ...groupLeadsLines,
        `Sugestao: ${report.suggestion}`
    ].join('\n');

    return { text, image, report };
}
