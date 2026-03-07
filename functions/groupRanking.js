import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RANKING_FILE = path.join(__dirname, '..', 'group_ranking.json');
const DEFAULT_REALTIME_TABLE = 'interacoes_texto';
const MAX_SEEN_MESSAGE_IDS = 150000;
const MAX_MONTH_BUCKETS = 12;
const RANKING_TIME_ZONE = 'America/Sao_Paulo';

const state = {
    loaded: false,
    groups: {},
    seenMessageIds: [],
    seenMessageSet: new Set(),
    lastBackfillAt: 0,
    lastBackfillMonthKey: '',
    flushTimer: null
};

function normalizeJid(jid) {
    return String(jid || '').split(':')[0].trim();
}

function toSafeTimestamp(value) {
    const ts = Number(value);
    if (Number.isFinite(ts) && ts > 0) {
        return ts;
    }
    return Date.now();
}

function getDatePartsInTimeZone(timestamp, timeZone = RANKING_TIME_ZONE) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    const parts = formatter.formatToParts(new Date(toSafeTimestamp(timestamp)));
    const out = {};
    for (const part of parts) {
        if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
            out[part.type] = part.value;
        }
    }
    return {
        year: Number(out.year || 0),
        month: Number(out.month || 0),
        day: Number(out.day || 0)
    };
}

function parseGmtOffsetToMs(rawOffset) {
    const match = String(rawOffset || '').match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
    if (!match) return 0;
    const sign = match[1] === '-' ? -1 : 1;
    const hours = Number(match[2] || 0);
    const minutes = Number(match[3] || 0);
    return sign * ((hours * 60) + minutes) * 60 * 1000;
}

function getTimeZoneOffsetMs(timeZone, timestamp) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        timeZoneName: 'shortOffset',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    });
    const parts = formatter.formatToParts(new Date(toSafeTimestamp(timestamp)));
    const tzName = parts.find((part) => part.type === 'timeZoneName')?.value || 'GMT+0';
    return parseGmtOffsetToMs(tzName);
}

function getUtcMsForZonedMidnight(year, month, day, timeZone = RANKING_TIME_ZONE) {
    const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
    const offsetAtGuess = getTimeZoneOffsetMs(timeZone, utcGuess);
    const firstPass = utcGuess - offsetAtGuess;
    const offsetAtFirstPass = getTimeZoneOffsetMs(timeZone, firstPass);
    return utcGuess - offsetAtFirstPass;
}

function getMonthKey(timestamp = Date.now()) {
    const parts = getDatePartsInTimeZone(timestamp, RANKING_TIME_ZONE);
    const now = new Date(toSafeTimestamp(timestamp));
    const year = Number(parts.year || now.getUTCFullYear());
    const monthNum = Number(parts.month || (now.getUTCMonth() + 1));
    const month = String(Math.max(1, Math.min(12, monthNum))).padStart(2, '0');
    return `${year}-${month}`;
}

function getMonthStartMs(monthKey) {
    const match = String(monthKey || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) {
        const parts = getDatePartsInTimeZone(Date.now(), RANKING_TIME_ZONE);
        const fallbackYear = Number(parts.year || new Date().getUTCFullYear());
        const fallbackMonth = Number(parts.month || (new Date().getUTCMonth() + 1));
        return getUtcMsForZonedMidnight(fallbackYear, fallbackMonth, 1, RANKING_TIME_ZONE);
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    return getUtcMsForZonedMidnight(year, month, 1, RANKING_TIME_ZONE);
}

function ensureMonthCounters(holder, fieldName) {
    if (!holder || typeof holder !== 'object') return {};
    if (!holder[fieldName] || typeof holder[fieldName] !== 'object' || Array.isArray(holder[fieldName])) {
        holder[fieldName] = {};
    }
    return holder[fieldName];
}

function pruneOldMonthCounters(counters) {
    if (!counters || typeof counters !== 'object') return;
    const keys = Object.keys(counters)
        .filter((key) => /^\d{4}-\d{2}$/.test(key))
        .sort();

    if (keys.length <= MAX_MONTH_BUCKETS) return;
    const removeCount = keys.length - MAX_MONTH_BUCKETS;
    for (let i = 0; i < removeCount; i += 1) {
        delete counters[keys[i]];
    }
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

const CUSTOM_GRADE_SEEDS = [
    'Imperador do Teclado', 'Ditador do Caps Lock', 'Monstro do Enter', 'Lorde das Notificacoes', 'Barao do Textao',
    'General do Audio de 3 Min', 'Ninja do Responder Rapido', 'Mestre do Print', 'Oraculo do Grupo', 'Guardiao do Link',
    'Farao do Flood', 'Mago do Meme', 'Rei do Refresh', 'Conde do Debate', 'Duque do Textinho',
    'Profeta do Spoiler', 'Arquiteto do Caos', 'CEO do Assunto Paralelo', 'Patrono da Polemica', 'Ministro das Figurinhas',
    'Embaixador do Off-Topic', 'Xerife do Silencio', 'Sultao da Discussao', 'Samurai do Resumao', 'Czar das Threads',
    'Guru do Bom Dia', 'Hacker do Argumento', 'Gladiador do Grupo', 'Tita do Textao', 'Comandante da Resenha',
    'Alquimista da Ideia', 'Visionario do Grupo', 'Orquestrador da Conversa', 'Capitao do Flood', 'Sensei da Notificacao',
    'Imperador do Debate', 'Lorde da Treta', 'Domador de Bots', 'Guardiao do Resumo', 'Profeta do Insight',
    'Rei do "Fonte?"', 'Guru do Pitch Improvisado', 'Ninja do Resumo em 1 Linha', 'Gladiador da Argumentacao',
    'Rei da Mensagem as 3AM', 'Mestre do "kkkkk"', 'Profeta do Web3', 'Arquiteto da Blockchain', 'Lorde dos NFTs',
    'Barao do Token', 'Mestre do Whitepaper', 'Rei do Roadmap', 'Guardiao da DAO', 'Mago do Deploy',
    'Rei do Bug Misterioso', 'Cacador de Erro 404', 'Ninja do Hotfix', 'Imperador do Commit', 'Lorde do Merge',
    'Cavaleiro do Pull Request', 'Mestre da Ideia Genial', 'Guardiao da Diplomacia', 'Mestre da Treta Elegante',
    'Profeta da Paz', 'Imperador do GIF', 'Mestre do Clickbait', 'Rei do "Olha Isso"', 'Mago do Storytelling',
    'Rei do Crescimento', 'Guardiao do Dashboard', 'Mago do KPI Criativo', 'Imperador do ROI Mistico',
    'Rei do Timing Comico', 'Mago da Piada Interna', 'Imperador do Hall da Fama', 'Rei da Lenda Viva', 'Mestre do Status Mitico',
    'Profeta da Lideranca', 'Lorde do Comando', 'Guardiao da Direcao', 'Rei do Veredito', 'Imperador da Resposta Final',
    'Lorde do Epilogo', 'Sultao do Final Feliz', 'Rei do Final Aberto', 'Mago do Loop Infinito', 'Imperador da Saga',
    'Rei do Critical Hit', 'Mago do Power Up', 'Imperador da Energia Suprema', 'Rei do Fora da Curva',
    'Mestre do Fora da Caixa', 'Lorde do Extraordinario', 'Guardiao do Inedito', 'Imperador do Lendario', 'Rei Supremo do Grupo'
];

function buildLegendaryRankTitles() {
    const grand = ['Imperador', 'Rei', 'Supremo', 'Arquiteto', 'Monarca', 'Lorde', 'Comandante', 'Tita', 'Czar', 'General'];
    const mid = ['Mestre', 'Cavaleiro', 'Guardiao', 'Estrategista', 'Alquimista', 'Sensei', 'Oraculo', 'Samurai', 'Capitao', 'Conselheiro'];
    const rare = ['Lenda Oculta', 'Observador Supremo', 'Ninja do Silencio', 'Fantasma Tatico', 'Mito Reservado', 'Sombra do Grupo'];
    const themes = [
        'do Teclado', 'do Caps Lock', 'do Enter', 'das Notificacoes', 'do Textao', 'do Resumao', 'da Treta Elegante',
        'do Debate Tecnico', 'da Figurinhas', 'dos Memes', 'do Hype', 'da Organizacao', 'da Diplomacia', 'do Off-Topic',
        'do Print', 'do Hotfix', 'do Deploy', 'do Merge', 'do Brainstorm', 'do Engajamento', 'do Roadmap', 'da DAO',
        'do Web3', 'do Flood', 'da Ultima Palavra', 'do Timing Comico', 'da Madrugada', 'do Bom Dia', 'do Contexto Perdido',
        'do Retorno Triunfal', 'do Insight', 'da Persistencia', 'do Hall da Fama', 'do Nivel Maximo'
    ];

    const out = [];
    for (const t of CUSTOM_GRADE_SEEDS) {
        out.push(t);
    }
    for (const a of grand) {
        for (const b of themes) out.push(`${a} ${b}`);
    }
    for (const a of mid) {
        for (const b of themes) out.push(`${a} ${b}`);
    }
    for (const a of rare) {
        for (const b of ['do Grupo', 'da Conversa', 'da Madrugada', 'do Debate', 'do Timing']) out.push(`${a} ${b}`);
    }
    return Array.from(new Set(out));
}

const FUNNY_RANK_TITLES = buildLegendaryRankTitles();

function hashString(input) {
    const text = String(input || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function pickUniqueFunnyTitle({ groupId, senderId, monthKey, rankIndex = 0, usedIndexes = new Set() }) {
    const total = FUNNY_RANK_TITLES.length;
    if (total === 0) return 'Lenda do Teclado';

    const seed = `${groupId}|${senderId}|${monthKey}|${rankIndex}`;
    const start = hashString(seed) % total;
    for (let step = 0; step < total; step += 1) {
        const idx = (start + step) % total;
        if (usedIndexes.has(idx)) continue;
        usedIndexes.add(idx);
        return FUNNY_RANK_TITLES[idx];
    }

    return FUNNY_RANK_TITLES[start];
}

function getHourInTimeZone(timestamp, timeZone = RANKING_TIME_ZONE) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: '2-digit',
        hourCycle: 'h23'
    });
    const parts = formatter.formatToParts(new Date(toSafeTimestamp(timestamp)));
    const value = Number(parts.find((part) => part.type === 'hour')?.value || 0);
    return Number.isFinite(value) ? value : 0;
}

function getWeekdayInTimeZone(timestamp, timeZone = RANKING_TIME_ZONE) {
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(toSafeTimestamp(timestamp)));
    return String(weekday || '').toLowerCase();
}

function getDayKey(timestamp, timeZone = RANKING_TIME_ZONE) {
    const parts = getDatePartsInTimeZone(timestamp, timeZone);
    const y = String(parts.year || 0).padStart(4, '0');
    const m = String(parts.month || 0).padStart(2, '0');
    const d = String(parts.day || 0).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function buildMemberSignature({ messages, nightShare, morningShare, weekendShare, activeDays }) {
    if (messages >= 220) return 'Falou muito e segurou o ritmo do grupo quase sozinho.';
    if (nightShare >= 0.45) return 'Especialista em movimentar o chat na madrugada.';
    if (morningShare >= 0.45) return 'Puxa a conversa cedo e abre o dia do grupo.';
    if (weekendShare >= 0.5) return 'Nao larga o grupo nem no fim de semana.';
    if (activeDays >= 12) return 'Presenca constante, sem sumir da conversa.';
    if (messages <= 12) return 'Aparece pouco, mas sempre deixa impacto.';
    return 'Mantem o grupo vivo com participacao recorrente.';
}

function buildMemberReason({ messages, share, nightShare, morningShare, weekendShare, activeDays }) {
    const pct = Math.round(Math.max(0, Number(share || 0)) * 100);
    if (messages >= 220) return `Puxou ${messages} mensagens no mes e respondeu por ${pct}% do movimento total.`;
    if (nightShare >= 0.45) return `Concentrou ${Math.round(nightShare * 100)}% das mensagens na madrugada e dominou o horario alternativo.`;
    if (morningShare >= 0.45) return `Concentrou ${Math.round(morningShare * 100)}% das mensagens pela manha e abre conversa todo dia.`;
    if (weekendShare >= 0.5) return `Mandou ${Math.round(weekendShare * 100)}% das mensagens no fim de semana e manteve o chat quente.`;
    if (activeDays >= 12) return `Marcou presenca em ${activeDays} dias diferentes no mes, com consistencia acima da media.`;
    if (messages <= 12) return `Com apenas ${messages} mensagens, ainda assim apareceu em momentos que mudaram o rumo da conversa.`;
    return `Somou ${messages} mensagens no mes com participacao regular e boa presenca nas discussoes.`;
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
            state.lastBackfillMonthKey = String(parsed.lastBackfillMonthKey || '').trim();
            return;
        }
    } catch (_) {}
    state.groups = {};
    state.seenMessageIds = [];
    state.seenMessageSet = new Set();
    state.lastBackfillAt = 0;
    state.lastBackfillMonthKey = '';
}

function flushNow() {
    state.flushTimer = null;
    const payload = {
        updatedAt: new Date().toISOString(),
        lastBackfillAt: Number(state.lastBackfillAt || 0),
        lastBackfillMonthKey: String(state.lastBackfillMonthKey || '').trim(),
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
    const safeTimestamp = toSafeTimestamp(timestamp);
    const monthKey = getMonthKey(safeTimestamp);
    const safeMessageId = normalizeMessageId(messageId);
    if (safeMessageId && isMessageSeen(safeMessageId)) return;

    if (!state.groups[gid]) {
        state.groups[gid] = {
            groupId: gid,
            groupName: safeName(groupName, gid),
            users: {},
            totalMessages: 0,
            monthlyTotals: {},
            updatedAt: safeTimestamp
        };
    }

    const group = state.groups[gid];
    group.groupName = safeName(groupName, group.groupName || gid);
    group.totalMessages = Number(group.totalMessages || 0) + 1;
    group.updatedAt = safeTimestamp;
    const groupMonthlyTotals = ensureMonthCounters(group, 'monthlyTotals');
    groupMonthlyTotals[monthKey] = Number(groupMonthlyTotals[monthKey] || 0) + 1;
    pruneOldMonthCounters(groupMonthlyTotals);

    if (!group.users || typeof group.users !== 'object') {
        group.users = {};
    }

    if (!group.users[uid]) {
        group.users[uid] = {
            senderId: uid,
            senderName: safeName(senderName, uid),
            messages: 0,
            monthlyMessages: {},
            monthlyNightMessages: {},
            monthlyMorningMessages: {},
            monthlyWeekendMessages: {},
            monthlyWeekdayMessages: {},
            monthlyActiveDays: {},
            lastMessageAt: safeTimestamp
        };
    }

    const user = group.users[uid];
    user.senderId = uid;
    user.senderName = safeName(senderName, user.senderName || uid);
    user.messages = Number(user.messages || 0) + 1;
    user.lastMessageAt = safeTimestamp;
    const userMonthlyMessages = ensureMonthCounters(user, 'monthlyMessages');
    userMonthlyMessages[monthKey] = Number(userMonthlyMessages[monthKey] || 0) + 1;
    pruneOldMonthCounters(userMonthlyMessages);

    const hour = getHourInTimeZone(safeTimestamp, RANKING_TIME_ZONE);
    const isMorning = hour >= 5 && hour <= 11;
    const isNight = hour <= 5 || hour >= 22;
    const weekday = getWeekdayInTimeZone(safeTimestamp, RANKING_TIME_ZONE);
    const isWeekend = weekday === 'sat' || weekday === 'sun';

    const nightCounters = ensureMonthCounters(user, 'monthlyNightMessages');
    const morningCounters = ensureMonthCounters(user, 'monthlyMorningMessages');
    const weekendCounters = ensureMonthCounters(user, 'monthlyWeekendMessages');
    const weekdayCounters = ensureMonthCounters(user, 'monthlyWeekdayMessages');
    nightCounters[monthKey] = Number(nightCounters[monthKey] || 0) + (isNight ? 1 : 0);
    morningCounters[monthKey] = Number(morningCounters[monthKey] || 0) + (isMorning ? 1 : 0);
    weekendCounters[monthKey] = Number(weekendCounters[monthKey] || 0) + (isWeekend ? 1 : 0);
    weekdayCounters[monthKey] = Number(weekdayCounters[monthKey] || 0) + (!isWeekend ? 1 : 0);
    pruneOldMonthCounters(nightCounters);
    pruneOldMonthCounters(morningCounters);
    pruneOldMonthCounters(weekendCounters);
    pruneOldMonthCounters(weekdayCounters);

    const monthlyActiveDays = ensureMonthCounters(user, 'monthlyActiveDays');
    if (!monthlyActiveDays[monthKey] || typeof monthlyActiveDays[monthKey] !== 'object') {
        monthlyActiveDays[monthKey] = {};
    }
    monthlyActiveDays[monthKey][getDayKey(safeTimestamp, RANKING_TIME_ZONE)] = 1;
    const activeDayKeys = Object.keys(monthlyActiveDays[monthKey]);
    if (activeDayKeys.length > 35) {
        activeDayKeys.sort();
        const toDrop = activeDayKeys.length - 35;
        for (let i = 0; i < toDrop; i += 1) {
            delete monthlyActiveDays[monthKey][activeDayKeys[i]];
        }
    }
    pruneOldMonthCounters(monthlyActiveDays);

    if (safeMessageId) {
        markMessageSeen(safeMessageId);
    }

    scheduleFlush();
}

export async function backfillRankingFromCurrentMonth({ maxRows = 50000, overlapMinutes = 5, now = Date.now() } = {}) {
    ensureLoaded();

    const { url, key, table } = getSupabaseConfig();
    if (!url || !key) {
        return { ok: false, skipped: true, reason: 'supabase_not_configured' };
    }

    const nowTs = toSafeTimestamp(now);
    const monthKey = getMonthKey(nowTs);
    const monthStartMs = getMonthStartMs(monthKey);
    const overlapMs = Math.max(0, Math.min(60, Number(overlapMinutes) || 5)) * 60 * 1000;
    const incrementalFromMs = Number(state.lastBackfillAt || 0) > 0
        ? Math.max(monthStartMs, Number(state.lastBackfillAt || 0) - overlapMs)
        : monthStartMs;
    const fromMs = state.lastBackfillMonthKey === monthKey ? incrementalFromMs : monthStartMs;
    const fromIso = new Date(fromMs).toISOString();
    const safeMaxRows = Math.max(1000, Math.min(100000, Number(maxRows) || 50000));
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

    state.lastBackfillAt = nowTs;
    state.lastBackfillMonthKey = monthKey;
    scheduleFlush();

    return {
        ok: true,
        counted,
        scanned: list.length,
        skippedDuplicates,
        skippedCommands,
        fromIso,
        monthKey
    };
}

export async function backfillRankingFromLastHour({ maxRows = 5000 } = {}) {
    // Compatibilidade retroativa: agora o ranking opera em janela mensal.
    return backfillRankingFromCurrentMonth({ maxRows });
}

export function getGroupTopRanking(groupId, limit = 10, options = {}) {
    const gid = String(groupId || '').trim();
    const monthKey = String(options?.monthKey || getMonthKey(Date.now())).trim();
    ensureLoaded();
    const group = state.groups[gid];
    if (!group || !group.users || typeof group.users !== 'object') {
        return {
            groupId: gid,
            groupName: gid,
            monthKey,
            totalMessages: 0,
            top: []
        };
    }

    const groupMonthlyTotals = ensureMonthCounters(group, 'monthlyTotals');
    const totalMessages = Number(groupMonthlyTotals[monthKey] || 0) || Number(group.totalMessages || 0);
    const top = Object.values(group.users)
        .map((user) => {
            const monthlyMessages = ensureMonthCounters(user, 'monthlyMessages');
            const monthlyValue = Number(monthlyMessages[monthKey] || 0);
            const messages = monthlyValue > 0 ? monthlyValue : Number(user.messages || 0);
            if (messages <= 0) return null;
            const level = levelFromMessages(messages);
            const nightMessages = Number(ensureMonthCounters(user, 'monthlyNightMessages')[monthKey] || 0);
            const morningMessages = Number(ensureMonthCounters(user, 'monthlyMorningMessages')[monthKey] || 0);
            const weekendMessages = Number(ensureMonthCounters(user, 'monthlyWeekendMessages')[monthKey] || 0);
            const activeDaysMap = ensureMonthCounters(user, 'monthlyActiveDays')[monthKey];
            const activeDays = (activeDaysMap && typeof activeDaysMap === 'object') ? Object.keys(activeDaysMap).length : 0;
            return {
                senderId: user.senderId,
                senderName: safeName(user.senderName, user.senderId),
                messages,
                level,
                grade: gradeFromLevel(level),
                nightMessages,
                morningMessages,
                weekendMessages,
                activeDays,
                lastMessageAt: Number(user.lastMessageAt || 0)
            };
        })
        .filter(Boolean)
        .sort((a, b) => {
            if (b.messages !== a.messages) return b.messages - a.messages;
            if (b.level !== a.level) return b.level - a.level;
            return a.lastMessageAt - b.lastMessageAt;
        })
        .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));

    const usedTitleIndexes = new Set();
    const topWithFunnyTitles = top.map((item, index) => {
        const safeMessages = Math.max(1, Number(item.messages || 0));
        const nightShare = item.nightMessages / safeMessages;
        const morningShare = item.morningMessages / safeMessages;
        const weekendShare = item.weekendMessages / safeMessages;
        const share = totalMessages > 0 ? (safeMessages / totalMessages) : 0;
        const funnyTitle = pickUniqueFunnyTitle({
            groupId: gid,
            senderId: item.senderId,
            monthKey,
            rankIndex: index,
            usedIndexes: usedTitleIndexes
        });
        const signature = buildMemberSignature({
            messages: safeMessages,
            share,
            nightShare,
            morningShare,
            weekendShare,
            activeDays: item.activeDays
        });
        const reason = buildMemberReason({
            messages: safeMessages,
            share,
            nightShare,
            morningShare,
            weekendShare,
            activeDays: item.activeDays
        });

        return {
            ...item,
            baseGrade: item.grade,
            funnyTitle,
            signature,
            reason,
            grade: funnyTitle
        };
    });

    return {
        groupId: gid,
        groupName: safeName(group.groupName, gid),
        monthKey,
        totalMessages,
        top: topWithFunnyTitles
    };
}
