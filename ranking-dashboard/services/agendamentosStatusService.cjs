const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const LEMBRETES_FILE = path.join(ROOT_DIR, 'lembretes.json');
const SCHEDULED_FILE = path.join(ROOT_DIR, 'scheduled.json');

function readJsonFile(filePath, fallbackValue) {
    try {
        if (!fs.existsSync(filePath)) {
            return fallbackValue;
        }

        const raw = fs.readFileSync(filePath, 'utf8');
        return raw ? JSON.parse(raw) : fallbackValue;
    } catch (_) {
        return fallbackValue;
    }
}

function parseTimeToParts(value) {
    const safe = String(value || '').trim();
    const match = /^(\d{1,2}):(\d{2})$/.exec(safe);
    if (!match) {
        return null;
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
        return null;
    }

    return { hours, minutes };
}

function nextDailyTriggerTs(timeStr, nowMs = Date.now()) {
    const parsed = parseTimeToParts(timeStr);
    if (!parsed) {
        return null;
    }

    const now = new Date(nowMs);
    const candidate = new Date(now);
    candidate.setHours(parsed.hours, parsed.minutes, 0, 0);

    if (candidate.getTime() <= nowMs) {
        candidate.setDate(candidate.getDate() + 1);
    }

    return candidate.getTime();
}

function mapIntervalReminders(intervalBucket) {
    const out = [];
    const source = intervalBucket && typeof intervalBucket === 'object' ? intervalBucket : {};

    for (const [groupId, config] of Object.entries(source)) {
        const intervaloHoras = Number(config && config.intervalo || 0);
        const startTime = Number(config && config.startTime || 0);
        const explicitNext = Number(config && config.nextTrigger || 0);
        const derivedNext = intervaloHoras > 0 && startTime > 0
            ? (startTime + (intervaloHoras * 60 * 60 * 1000))
            : 0;

        out.push({
            type: 'interval',
            groupId: String(groupId || '').trim(),
            command: String(config && config.comando || '').trim(),
            intervalHours: Number.isFinite(intervaloHoras) && intervaloHoras > 0 ? intervaloHoras : 0,
            startTime: Number.isFinite(startTime) && startTime > 0 ? startTime : null,
            nextTrigger: Number.isFinite(explicitNext) && explicitNext > 0
                ? explicitNext
                : (Number.isFinite(derivedNext) && derivedNext > 0 ? derivedNext : null)
        });
    }

    return out;
}

function mapDailyReminders(dailyBucket) {
    const out = [];
    const source = dailyBucket && typeof dailyBucket === 'object' ? dailyBucket : {};

    for (const [groupId, config] of Object.entries(source)) {
        const horarios = Array.isArray(config && config.horarios)
            ? config.horarios.map((item) => String(item || '').trim()).filter(Boolean)
            : [];

        const triggers = horarios
            .map((timeStr) => nextDailyTriggerTs(timeStr))
            .filter((value) => Number.isFinite(value) && value > 0)
            .sort((a, b) => a - b);

        out.push({
            type: 'daily',
            groupId: String(groupId || '').trim(),
            command: String(config && config.comando || '').trim(),
            horarios,
            startTime: Number(config && config.startTime || 0) || null,
            nextTrigger: triggers.length > 0 ? triggers[0] : null
        });
    }

    return out;
}

function mapScheduledMessages(scheduledList) {
    const now = Date.now();
    const source = Array.isArray(scheduledList) ? scheduledList : [];

    return source
        .map((item) => {
            const timestamp = Number(item && item.timestamp || 0);
            return {
                id: String(item && item.id || '').trim(),
                groupId: String(item && item.groupId || '').trim(),
                time: String(item && item.time || '').trim(),
                message: String(item && item.message || '').trim(),
                timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null
            };
        })
        .filter((item) => !item.timestamp || item.timestamp >= now)
        .sort((a, b) => {
            const ta = Number(a.timestamp || Number.MAX_SAFE_INTEGER);
            const tb = Number(b.timestamp || Number.MAX_SAFE_INTEGER);
            return ta - tb;
        });
}

function splitReminderBuckets(lembretesRaw) {
    const source = lembretesRaw && typeof lembretesRaw === 'object' ? lembretesRaw : {};
    const hasBuckets = Object.prototype.hasOwnProperty.call(source, 'interval')
        || Object.prototype.hasOwnProperty.call(source, 'daily');

    if (hasBuckets) {
        return {
            intervalBucket: source.interval && typeof source.interval === 'object' ? source.interval : {},
            dailyBucket: source.daily && typeof source.daily === 'object' ? source.daily : {}
        };
    }

    // Compatibilidade com formato antigo:
    // {
    //   "<groupId>": { comando, intervalo, encerramento, startTime, nextTrigger }
    // }
    const intervalBucket = {};
    const dailyBucket = {};
    for (const [groupId, config] of Object.entries(source)) {
        if (!config || typeof config !== 'object') {
            continue;
        }

        if (Array.isArray(config.horarios)) {
            dailyBucket[groupId] = config;
            continue;
        }

        intervalBucket[groupId] = config;
    }

    return { intervalBucket, dailyBucket };
}

function getAgendamentosStatus() {
    const lembretesRaw = readJsonFile(LEMBRETES_FILE, {});
    const scheduledRaw = readJsonFile(SCHEDULED_FILE, []);
    const { intervalBucket, dailyBucket } = splitReminderBuckets(lembretesRaw);

    const intervalReminders = mapIntervalReminders(intervalBucket);
    const dailyReminders = mapDailyReminders(dailyBucket);
    const scheduledMessages = mapScheduledMessages(scheduledRaw);

    const lembretes = [...dailyReminders, ...intervalReminders].sort((a, b) => {
        const ta = Number(a.nextTrigger || Number.MAX_SAFE_INTEGER);
        const tb = Number(b.nextTrigger || Number.MAX_SAFE_INTEGER);
        return ta - tb;
    });

    return {
        ok: true,
        updatedAt: new Date().toISOString(),
        summary: {
            totalLembretes: lembretes.length,
            totalDailyGroups: dailyReminders.length,
            totalIntervalGroups: intervalReminders.length,
            totalMensagensAgendadas: scheduledMessages.length
        },
        lembretes,
        agendados: scheduledMessages
    };
}

module.exports = {
    getAgendamentosStatus
};
