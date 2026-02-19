import { renderEngagementRadarImage } from './engagementRadarImage.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const TEN_MIN_MS = 10 * 60 * 1000;

const SPARK_CHARS = ['.', ':', '-', '=', '+', '*', '#'];
const DEFAULT_TRACKED_TOKENS = ['NIX', 'SNAP', 'SNAPPY', 'BNB', 'USDT'];
const TOKEN_EQUIVALENTS = [
    ['SNAP', 'SNAPPY'],
    ['KEN', 'KENESIS'],
    ['DCAR', 'DIVICAR']
];
const IGNORED_GROUP_PATTERN = /\b(squad|teste|test)\b/;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function normalize(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function normalizeGroupName(value) {
    return normalize(value).replace(/\s+/g, ' ').trim();
}

function isIgnoredGroupName(value) {
    const normalized = normalizeGroupName(value);
    return Boolean(normalized) && IGNORED_GROUP_PATTERN.test(normalized);
}

function getAllowedMessages(messages, allowedGroupNames) {
    const allowed = new Set((allowedGroupNames || []).map((name) => normalizeGroupName(name)).filter(Boolean));
    if (allowed.size === 0) {
        return [];
    }

    return (Array.isArray(messages) ? messages : []).filter((m) => {
        const groupName = normalizeGroupName(m && m.groupName);
        if (!groupName || !allowed.has(groupName)) {
            return false;
        }
        return !isIgnoredGroupName(groupName);
    });
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeToken(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
}

function parseTrackedTokens(monitoredTokens) {
    const raw = Array.isArray(monitoredTokens) && monitoredTokens.length > 0
        ? monitoredTokens
        : String(process.env.INTEL_MONITORED_TOKENS || DEFAULT_TRACKED_TOKENS.join(','))
            .split(',');

    const parsed = raw
        .map((token) => sanitizeToken(token))
        .filter((token) => token.length >= 2 && token.length <= 15);

    return Array.from(new Set(parsed));
}

function buildTokenConfig(monitoredTokens) {
    const tracked = parseTrackedTokens(monitoredTokens);
    const canonical = tracked.length > 0 ? tracked : DEFAULT_TRACKED_TOKENS;
    const aliasToCanonical = new Map();
    const regexByCanonical = new Map();

    canonical.forEach((token) => {
        aliasToCanonical.set(token, token);
        regexByCanonical.set(token, [new RegExp(`\\b${escapeRegex(token)}\\b`, 'gi')]);
    });

    TOKEN_EQUIVALENTS.forEach(([a, b]) => {
        const hasA = canonical.includes(a);
        const hasB = canonical.includes(b);
        if (hasA && !hasB) {
            aliasToCanonical.set(b, a);
            regexByCanonical.get(a).push(new RegExp(`\\b${escapeRegex(b)}\\b`, 'gi'));
        }
        if (hasB && !hasA) {
            aliasToCanonical.set(a, b);
            regexByCanonical.get(b).push(new RegExp(`\\b${escapeRegex(a)}\\b`, 'gi'));
        }
    });

    return {
        canonical,
        aliasToCanonical,
        regexByCanonical
    };
}

function toTopicCandidates(text, tokenConfig) {
    const safe = String(text || '');
    if (!safe || !tokenConfig || !tokenConfig.regexByCanonical) {
        return [];
    }

    const mentions = [];
    for (const [token, regexList] of tokenConfig.regexByCanonical.entries()) {
        let totalHits = 0;
        for (const regex of regexList) {
            const hits = safe.match(regex);
            totalHits += Array.isArray(hits) ? hits.length : 0;
        }
        for (let i = 0; i < totalHits; i += 1) {
            mentions.push(token);
        }
    }

    const specialMatches = safe.match(/[$#]([A-Za-z0-9]{2,15})\b/g) || [];
    specialMatches.forEach((raw) => {
        const normalized = sanitizeToken(raw.replace(/[$#]/g, ''));
        const canonical = tokenConfig.aliasToCanonical.get(normalized);
        if (canonical) {
            mentions.push(canonical);
        }
    });

    return mentions;
}

function getHourlySeries(messages24h, now) {
    const start = now - DAY_MS;
    const buckets = Array(24).fill(0);

    messages24h.forEach((m) => {
        const ts = Number(m.timestamp || 0);
        if (ts < start || ts > now) return;
        const idx = Math.floor((ts - start) / HOUR_MS);
        if (idx >= 0 && idx < 24) {
            buckets[idx] += 1;
        }
    });

    return buckets;
}

export function calcularTendencia(totalMensagens24h, mensagensUltimaHora) {
    const media24h = Number(totalMensagens24h || 0) / 24;
    const ratio = media24h > 0 ? Number(mensagensUltimaHora || 0) / media24h : 0;
    const growthPct = (ratio - 1) * 100;

    if (ratio > 1.25) {
        return {
            ratio,
            growthPct,
            arrow: 'UP',
            label: 'Acelerando',
            description: `Acelerando (${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(0)}%)`
        };
    }

    if (ratio >= 0.85) {
        return {
            ratio,
            growthPct,
            arrow: 'FLAT',
            label: 'Estavel',
            description: `Estavel (${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(0)}%)`
        };
    }

    return {
        ratio,
        growthPct,
        arrow: 'DOWN',
        label: 'Perdendo forca',
        description: `Perdendo forca (${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(0)}%)`
    };
}

export function gerarSparkline(values) {
    const input = Array.isArray(values) ? values.map((v) => Number(v || 0)) : [];
    if (input.length === 0) {
        return '';
    }

    const min = Math.min(...input);
    const max = Math.max(...input);
    if (max === min) {
        return input.map(() => SPARK_CHARS[0]).join('');
    }

    return input
        .map((v) => {
            const norm = (v - min) / (max - min);
            const idx = clamp(Math.round(norm * (SPARK_CHARS.length - 1)), 0, SPARK_CHARS.length - 1);
            return SPARK_CHARS[idx];
        })
        .join('');
}

export function calcularVariacaoToken(totalMentions24h, mentionsUltimas2h) {
    const mediaToken24h = Number(totalMentions24h || 0) / 24;
    const baseline2h = mediaToken24h * 2;
    if (baseline2h <= 0) {
        return mentionsUltimas2h > 0 ? 100 : 0;
    }
    return ((Number(mentionsUltimas2h || 0) / baseline2h) - 1) * 100;
}

function classifyTopicVariation(variationPct) {
    if (variationPct > 40) return { color: 'red', icon: 'BOOM', status: 'Hype explosivo' };
    if (variationPct > 15) return { color: 'green', icon: 'UP', status: 'Crescimento' };
    if (variationPct >= 5) return { color: 'orange', icon: 'ALERT', status: 'Atencao' };
    if (variationPct < 0) return { color: 'gray', icon: 'DOWN', status: 'Queda' };
    return { color: 'gray', icon: 'FLAT', status: 'Estavel' };
}

function buildTopicStats(messages24h, now, tokenConfig) {
    const start = now - DAY_MS;
    const topicMap = new Map();

    messages24h.forEach((m) => {
        const ts = Number(m.timestamp || 0);
        const idx = Math.floor((ts - start) / HOUR_MS);
        if (idx < 0 || idx >= 24) return;

        const candidates = toTopicCandidates(m.text, tokenConfig);
        candidates.forEach((candidate) => {
            const raw = String(candidate || '').trim();
            if (!raw) return;

            const label = raw.toUpperCase();
            if (!topicMap.has(label)) {
                topicMap.set(label, {
                    label,
                    totalMentions: 0,
                    hourlyMentions: Array(24).fill(0)
                });
            }

            const row = topicMap.get(label);
            row.totalMentions += 1;
            row.hourlyMentions[idx] += 1;
        });
    });

    const stats = Array.from(topicMap.values())
        .filter((row) => row.totalMentions >= 1)
        .map((row) => {
            const last2h = Number(row.hourlyMentions[22] || 0) + Number(row.hourlyMentions[23] || 0);
            const variationPct = calcularVariacaoToken(row.totalMentions, last2h);
            const visual = classifyTopicVariation(variationPct);
            return {
                ...row,
                mentionsUltimas2h: last2h,
                variationPct,
                visual
            };
        });

    const hottestByGrowth = [...stats].sort((a, b) => b.variationPct - a.variationPct)[0] || null;

    const topByMentions = [...stats]
        .sort((a, b) => b.totalMentions - a.totalMentions)
        .slice(0, 3);

    return {
        all: stats,
        top: topByMentions,
        highlighted: hottestByGrowth
    };
}

export function detectarPico(messages24h, now, tokenConfig) {
    const start = now - DAY_MS;
    const buckets = Array.from({ length: 24 }, () => ({
        totalMessages: 0,
        users: new Set(),
        tokenMentions: new Map()
    }));

    messages24h.forEach((m) => {
        const ts = Number(m.timestamp || 0);
        const idx = Math.floor((ts - start) / HOUR_MS);
        if (idx < 0 || idx >= 24) return;

        const bucket = buckets[idx];
        bucket.totalMessages += 1;
        if (m.userId) bucket.users.add(String(m.userId));

        toTopicCandidates(m.text, tokenConfig).forEach((candidate) => {
            const label = String(candidate || '').trim().toUpperCase();
            if (!label) return;
            bucket.tokenMentions.set(label, (bucket.tokenMentions.get(label) || 0) + 1);
        });
    });

    let bestIdx = 0;
    let bestCount = -1;
    buckets.forEach((bucket, idx) => {
        if (bucket.totalMessages > bestCount) {
            bestCount = bucket.totalMessages;
            bestIdx = idx;
        }
    });

    const peakBucket = buckets[bestIdx] || { totalMessages: 0, users: new Set(), tokenMentions: new Map() };
    const peakTs = start + (bestIdx * HOUR_MS);
    const peakHour = new Date(peakTs).getHours();
    const nextHour = (peakHour + 1) % 24;
    const dominantToken = Array.from(peakBucket.tokenMentions.entries())
        .sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/D';
    const avgPerHour = messages24h.length / 24;
    const speedPerMin = peakBucket.totalMessages / 60;
    const aboveAveragePct = avgPerHour > 0
        ? ((peakBucket.totalMessages / avgPerHour) - 1) * 100
        : 0;

    return {
        window: `${String(peakHour).padStart(2, '0')}h-${String(nextHour).padStart(2, '0')}h`,
        totalMessages: peakBucket.totalMessages,
        activeUsers: peakBucket.users.size,
        dominantToken,
        speedPerMin,
        aboveAveragePct
    };
}

export function calcularEnergiaGrupo({ participantesAtivos, totalParticipantes, totalMensagens24h, crescimentoPct }) {
    const activeRatio = totalParticipantes > 0 ? (participantesAtivos / totalParticipantes) : 0;
    const normalizacaoMensagens = clamp(Number(totalMensagens24h || 0) / 400, 0, 1);
    const normalizacaoCrescimento = clamp((Number(crescimentoPct || 0) + 20) / 80, 0, 1);

    const energia =
        (activeRatio * 0.4) +
        (normalizacaoMensagens * 0.4) +
        (normalizacaoCrescimento * 0.2);

    const score = Math.round(clamp(energia, 0, 1) * 100);
    const blocks = clamp(Math.round(score / 10), 0, 10);
    const bar = `${'#'.repeat(blocks)}${'-'.repeat(10 - blocks)}`;

    let label = 'Fraco';
    if (score >= 80) label = 'Explosivo';
    else if (score >= 60) label = 'Forte';
    else if (score >= 30) label = 'Moderado';

    return {
        score,
        bar,
        label,
        blocks
    };
}

export function detectarOportunidades({ current24h, scoped, now, topicStats }) {
    const byGroup = new Map();
    current24h.forEach((m) => {
        const gid = String(m.groupId || 'sem-grupo');
        if (!byGroup.has(gid)) byGroup.set(gid, []);
        byGroup.get(gid).push(m);
    });

    let ignoredQuestions = 0;
    for (const rows of byGroup.values()) {
        const sorted = [...rows].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
        for (let i = 0; i < sorted.length; i += 1) {
            const msg = sorted[i];
            if (!String(msg.text || '').includes('?')) continue;

            const baseTs = Number(msg.timestamp || 0);
            let answered = false;
            for (let j = i + 1; j < sorted.length; j += 1) {
                const next = sorted[j];
                const delta = Number(next.timestamp || 0) - baseTs;
                if (delta > TEN_MIN_MS) break;
                if (String(next.userId || '') !== String(msg.userId || '')) {
                    answered = true;
                    break;
                }
            }
            if (!answered) ignoredQuestions += 1;
        }
    }

    const nowDate = new Date(now);
    const todayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
    const yesterdayStart = todayStart - DAY_MS;

    const yesterdayUsers = new Set(
        (scoped || [])
            .filter((m) => {
                const ts = Number(m.timestamp || 0);
                return ts >= yesterdayStart && ts < todayStart;
            })
            .map((m) => String(m.userId || '').trim())
            .filter(Boolean)
    );

    const todayUsers = new Set(
        (scoped || [])
            .filter((m) => Number(m.timestamp || 0) >= todayStart)
            .map((m) => String(m.userId || '').trim())
            .filter(Boolean)
    );

    let usersDropOff = 0;
    for (const userId of yesterdayUsers.values()) {
        if (!todayUsers.has(userId)) {
            usersDropOff += 1;
        }
    }

    const acceleratingToken = [...(topicStats || [])]
        .filter((topic) => Number(topic.variationPct || 0) > 25)
        .sort((a, b) => Number(b.variationPct || 0) - Number(a.variationPct || 0))[0] || null;

    return {
        ignoredQuestions,
        usersDropOff,
        acceleratingToken: acceleratingToken ? {
            label: acceleratingToken.label,
            variationPct: acceleratingToken.variationPct
        } : null
    };
}

function summarizeStatus(growthPct) {
    if (growthPct >= 10) return { label: 'QUENTE' };
    if (growthPct >= 0) return { label: 'MORNO' };
    return { label: 'FRIO' };
}

function gerarInsightEstrategico({ growthPct, topEngagers, activeUsers, peak, topicData }) {
    const leadingTopic = topicData?.highlighted || topicData?.top?.[0] || null;
    const totalTopicMentions = Math.max(
        1,
        Number((topicData?.all || []).reduce((sum, item) => sum + Number(item.totalMentions || 0), 0))
    );
    const leadingShare = leadingTopic
        ? (Number(leadingTopic.totalMentions || 0) / totalTopicMentions) * 100
        : 0;

    const top3Msg = (topEngagers || []).slice(0, 3).reduce((sum, row) => sum + Number(row.totalMessages || 0), 0);
    const concentration = activeUsers > 0
        ? (top3Msg / Math.max(1, Number(peak?.totalMessages || 0))) * 100
        : 0;

    if (leadingTopic && Number(leadingTopic.variationPct || 0) > 25) {
        return `${leadingTopic.label} esta acelerando rapidamente nas ultimas 2h e concentra ${leadingShare.toFixed(0)}% das conversas.`;
    }

    if (Number(growthPct || 0) > 150) {
        return `Grupo apresenta crescimento explosivo com aumento de ${Number(growthPct).toFixed(0)}% nas ultimas 24h.`;
    }

    if (concentration > 45) {
        return 'Conversa esta concentrada em poucos usuarios, risco de falsa percepcao de hype.';
    }

    return 'Engajamento distribuido e saudavel, com espaco para CTA no horario de pico.';
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
        .map((row) => ({
            groupId: row.groupId,
            groupName: row.groupName,
            totalMessages: row.totalMessages,
            activeUsers: row.users.size
        }))
        .sort((a, b) => b.totalMessages - a.totalMessages)
        .slice(0, 10);
}

function topEngagersByGroup(messages24h, limitUsers = 5, limitGroups = 3) {
    const groupMap = new Map();
    messages24h.forEach((m) => {
        const groupName = String(m.groupName || m.groupId || 'sem-grupo');
        const groupKey = normalizeGroupName(groupName);
        if (!groupMap.has(groupKey)) {
            groupMap.set(groupKey, {
                groupId: String(m.groupId || 'sem-grupo'),
                groupName,
                totalMessages: 0,
                users: new Map()
            });
        }

        const group = groupMap.get(groupKey);
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

export async function buildEngagementRadar({ messages, allowedGroupNames, monitoredTokens, now = Date.now() }) {
    const scoped = getAllowedMessages(messages, allowedGroupNames);
    const tokenConfig = buildTokenConfig(monitoredTokens);
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

    const hourlySeries = getHourlySeries(current24h, now);
    const mensagensUltimaHora = hourlySeries[23] || 0;
    const tendencia = calcularTendencia(current24h.length, mensagensUltimaHora);
    const sparkline = gerarSparkline(hourlySeries);

    const engagersMap = new Map();
    current24h.forEach((m) => {
        const id = String(m.userId || '').trim();
        if (!id) return;
        if (!engagersMap.has(id)) {
            engagersMap.set(id, {
                name: String(m.displayName || '').trim() || id,
                totalMessages: 0
            });
        }
        engagersMap.get(id).totalMessages += 1;
    });

    const topEngagers = Array.from(engagersMap.values())
        .sort((a, b) => b.totalMessages - a.totalMessages)
        .slice(0, 5);

    const topicData = buildTopicStats(current24h, now, tokenConfig);
    const hotTopics = topicData.top;

    const peak = detectarPico(current24h, now, tokenConfig);

    const participants7d = new Set(
        scoped
            .filter((m) => Number(m.timestamp || 0) >= (now - WEEK_MS))
            .map((m) => String(m.userId || '').trim())
            .filter(Boolean)
    ).size;

    const energiaGrupo = calcularEnergiaGrupo({
        participantesAtivos: activeUsers,
        totalParticipantes: participants7d,
        totalMensagens24h: current24h.length,
        crescimentoPct: tendencia.growthPct
    });

    const opportunities = detectarOportunidades({
        current24h,
        scoped,
        now,
        topicStats: topicData.all
    });

    const tokenAcelerando = opportunities.acceleratingToken;
    const highlightedToken = topicData.highlighted?.label || tokenAcelerando?.label || '';
    const suggestion = tokenAcelerando
        ? `${tokenAcelerando.label} acelerou ${tokenAcelerando.variationPct.toFixed(0)}% nas ultimas 2h. Abrir enquete/CTA agora.`
        : highlightedToken
            ? `${highlightedToken} esta puxando conversa. Considere abrir enquete e CTA no horario de pico.`
            : 'Sem token dominante no periodo. Foque em CTA de participacao e perguntas objetivas no pico.';

    const report = {
        status: summarizeStatus(growthPct),
        summary: {
            totalMessages: current24h.length,
            activeUsers,
            growthPct,
            msgPerMin,
            peakWindow: peak.window,
            sparkline,
            hourlySeries,
            tendencia
        },
        topEngagers,
        topEngagersByGroup: topEngagersByGroup(current24h, 5),
        hotTopics,
        highlightedTopic: topicData.highlighted,
        peak,
        opportunities,
        energiaGrupo,
        topGroups: topGroups(current24h),
        suggestion
    };
    report.insight = gerarInsightEstrategico({
        growthPct,
        topEngagers,
        activeUsers,
        peak,
        topicData
    });

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
        `Tendencia: ${report.summary.tendencia.description} | Sparkline: ${report.summary.sparkline}`,
        `Mensagens: ${report.summary.totalMessages} | Ativos: ${report.summary.activeUsers} | Crescimento: ${report.summary.growthPct.toFixed(1)}%`,
        `Topicos monitorados: ${tokenConfig.canonical.join(', ') || 'N/D'}`,
        `Pico real: ${report.peak.window} | +${report.peak.totalMessages} msgs | +${report.peak.activeUsers} usuarios | Velocidade: ${report.peak.speedPerMin.toFixed(1)} msg/min | Tema: ${report.peak.dominantToken} | ${report.peak.aboveAveragePct >= 0 ? '+' : ''}${report.peak.aboveAveragePct.toFixed(0)}% vs media horaria`,
        `Energia do Grupo: ${report.energiaGrupo.bar} ${report.energiaGrupo.score}% (${report.energiaGrupo.label})`,
        'Baseado em: volume de mensagens, participacao ativa e aceleracao recente.',
        'Obs: mensagens de grupos com "squad" e "teste" sao desconsideradas neste radar.',
        `Insight Estrategico: ${report.insight}`,
        'Top por grupo:',
        ...groupLeadsLines,
        `Sugestao: ${report.suggestion}`
    ].join('\n');

    return { text, image, report };
}
