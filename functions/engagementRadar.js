import { renderEngagementRadarImage } from './engagementRadarImage.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const TEN_MIN_MS = 10 * 60 * 1000;

const STOP_WORDS = new Set([
    'de', 'do', 'da', 'dos', 'das', 'e', 'em', 'no', 'na', 'nos', 'nas', 'o', 'a', 'os', 'as',
    'um', 'uma', 'uns', 'umas', 'para', 'pra', 'com', 'sem', 'por', 'que', 'como', 'isso', 'agora',
    'the', 'and', 'for', 'this', 'that'
]);

const FIXED_GROUP_ORDER = [
    'CriptoNoPix e Vellora (1)',
    'CriptoNoPix e Vellora (2)',
    'SQUAD Web3 | @AlexCPO_'
];

const SPARK_CHARS = ['.', ':', '-', '=', '+', '*', '#'];
const KNOWN_TOKENS = new Set([
    'BNB', 'USDT', 'NIX', 'SNAPPY', 'FSX', 'KEN', 'KENESIS', 'DCAR', 'DIVICAR',
    'MASAKA', 'VEREM', 'NELORE', 'DYMX', 'GEG'
]);

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

    const upper = safe.match(/\b[A-Z]{2,12}\b/g) || [];
    upper.forEach((t) => tokens.push(t));

    const dollar = safe.match(/\$[A-Za-z]{2,12}\b/g) || [];
    dollar.forEach((t) => tokens.push(t.slice(1).toUpperCase()));

    const normalizedWords = normalize(safe)
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
    normalizedWords.forEach((word) => {
        const up = word.toUpperCase();
        if (KNOWN_TOKENS.has(up)) {
            tokens.push(up);
        }
    });

    const normalized = normalize(safe)
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter((w) => w.length >= 3)
        .filter((w) => !STOP_WORDS.has(w));

    for (let i = 0; i < normalized.length - 1; i += 1) {
        tokens.push(`${normalized[i]} ${normalized[i + 1]}`);
    }

    return tokens;
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

function buildTopicStats(messages24h, now) {
    const start = now - DAY_MS;
    const topicMap = new Map();

    messages24h.forEach((m) => {
        const ts = Number(m.timestamp || 0);
        const idx = Math.floor((ts - start) / HOUR_MS);
        if (idx < 0 || idx >= 24) return;

        const candidates = toTopicCandidates(m.text);
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
        .filter((row) => row.totalMentions >= 2 || KNOWN_TOKENS.has(row.label))
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

export function detectarPico(messages24h, now) {
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

        toTopicCandidates(m.text).forEach((candidate) => {
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

function topEngagersByGroup(messages24h, limitUsers = 5) {
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

    return FIXED_GROUP_ORDER.map((fixedName) => {
        const found = groupMap.get(normalizeGroupName(fixedName));
        if (!found) {
            return {
                groupId: '',
                groupName: fixedName,
                totalMessages: 0,
                topUsers: []
            };
        }

        return {
            groupId: found.groupId,
            groupName: fixedName,
            totalMessages: found.totalMessages,
            topUsers: Array.from(found.users.values())
                .sort((a, b) => b.totalMessages - a.totalMessages)
                .slice(0, Math.max(1, Number(limitUsers) || 5))
        };
    });
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

    const topicData = buildTopicStats(current24h, now);
    const hotTopics = topicData.top;

    const peak = detectarPico(current24h, now);

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
    const highlightedToken = topicData.highlighted?.label || tokenAcelerando?.label || 'SEM TOPICO';
    const suggestion = tokenAcelerando
        ? `${tokenAcelerando.label} acelerou ${tokenAcelerando.variationPct.toFixed(0)}% nas ultimas 2h. Abrir enquete/CTA agora.`
        : `${highlightedToken} esta puxando conversa. Considere abrir enquete e CTA no horario de pico.`;

    const report = {
        status: summarizeStatus(growthPct),
        summary: {
            totalMessages: current24h.length,
            activeUsers,
            growthPct,
            msgPerMin,
            peakWindow: peak.window,
            sparkline,
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
        `Pico real: ${report.peak.window} | +${report.peak.totalMessages} msgs | +${report.peak.activeUsers} usuarios | Velocidade: ${report.peak.speedPerMin.toFixed(1)} msg/min | Tema: ${report.peak.dominantToken} | ${report.peak.aboveAveragePct >= 0 ? '+' : ''}${report.peak.aboveAveragePct.toFixed(0)}% vs media horaria`,
        `Energia do Grupo: ${report.energiaGrupo.bar} ${report.energiaGrupo.score}% (${report.energiaGrupo.label})`,
        'Baseado em: volume de mensagens, participacao ativa e aceleracao recente.',
        `Insight Estrategico: ${report.insight}`,
        'Top por grupo:',
        ...groupLeadsLines,
        `Sugestao: ${report.suggestion}`
    ].join('\n');

    return { text, image, report };
}
