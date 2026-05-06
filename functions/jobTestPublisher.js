import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { sendSafeMessage } from './messageHandler.js';
import { buildJobPayload } from './jobForwarder.js';
import { dispatchPrivateJobAlertsForJobs } from './privateJobAlerts.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = path.join(__dirname, '..', 'job_test_queue.json');
const DEFAULT_TIMEZONE = 'America/Porto_Velho';
const DEFAULT_WEEKEND_REPEAT_HOUR = 9;

let timer = null;
let running = false;

function normalizeSpace(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeGroupName(value) {
    return normalizeSpace(value).toLowerCase();
}

function loadQueue() {
    try {
        if (!fs.existsSync(QUEUE_FILE)) return null;
        const parsed = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        logger.error('job_test_queue_load_failed', {
            error: error?.message || String(error)
        });
        return null;
    }
}

function saveQueue(queue) {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
}

function resolveTargetGroups(queue, groups) {
    const desired = Array.isArray(queue?.targetGroups)
        ? queue.targetGroups.map((item) => normalizeGroupName(item)).filter(Boolean)
        : [];
    const resolved = [];

    for (const [id, group] of Object.entries(groups || {})) {
        const subject = String(group?.subject || id).trim() || id;
        if (!desired.length || desired.includes(normalizeGroupName(subject))) {
            resolved.push({ id, subject });
        }
    }

    return resolved;
}

function randomInt(min, max) {
    const safeMin = Math.ceil(Math.min(min, max));
    const safeMax = Math.floor(Math.max(min, max));
    return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

function getLocalDateParts(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    const parts = Object.fromEntries(
        formatter.formatToParts(date).map((part) => [part.type, part.value])
    );

    return {
        weekday: String(parts.weekday || '').toLowerCase(),
        year: Number.parseInt(parts.year || '0', 10) || 0,
        month: Number.parseInt(parts.month || '0', 10) || 0,
        day: Number.parseInt(parts.day || '0', 10) || 0,
        hour: Number.parseInt(parts.hour || '0', 10) || 0,
        minute: Number.parseInt(parts.minute || '0', 10) || 0,
        second: Number.parseInt(parts.second || '0', 10) || 0
    };
}

function toDateKey(parts) {
    const year = String(parts.year || 0).padStart(4, '0');
    const month = String(parts.month || 0).padStart(2, '0');
    const day = String(parts.day || 0).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function isWeekendWeekday(parts) {
    return parts.weekday === 'sat' || parts.weekday === 'sun';
}

function computeDelayUntilNextWeekendSlot(timeZone = DEFAULT_TIMEZONE, repeatHourLocal = DEFAULT_WEEKEND_REPEAT_HOUR) {
    const now = new Date();
    const safeRepeatHour = Math.min(23, Math.max(0, Number.parseInt(repeatHourLocal || DEFAULT_WEEKEND_REPEAT_HOUR, 10) || DEFAULT_WEEKEND_REPEAT_HOUR));
    const nowParts = getLocalDateParts(now, timeZone);

    for (let dayOffset = 0; dayOffset < 14; dayOffset += 1) {
        const candidate = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
        const candidateParts = getLocalDateParts(candidate, timeZone);
        if (!isWeekendWeekday(candidateParts)) continue;
        if (dayOffset === 0 && nowParts.hour >= safeRepeatHour) continue;

        const waitDays = dayOffset;
        const waitHours = Math.max(0, safeRepeatHour - nowParts.hour);
        const waitMinutes = nowParts.minute;
        const waitSeconds = nowParts.second;
        const totalMs = (
            waitDays * 24 * 60 * 60 * 1000
            + waitHours * 60 * 60 * 1000
            - waitMinutes * 60 * 1000
            - waitSeconds * 1000
        );
        return Math.max(60_000, totalMs);
    }

    return 24 * 60 * 60 * 1000;
}

function scheduleProcess(sock, delayMs, metadata = {}) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
        processNextBatch(sock).catch((error) => {
            logger.error('job_test_queue_timer_failed', {
                error: error?.message || String(error)
            });
        });
    }, delayMs);

    logger.info('job_test_queue_next_batch_scheduled', {
        delayMs,
        ...metadata
    });
}

function scheduleWeekendReplay(sock, queue, jobs) {
    const timeZone = String(queue.repeatTimezone || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
    const repeatHourLocal = Number.parseInt(queue.repeatHourLocal || DEFAULT_WEEKEND_REPEAT_HOUR, 10) || DEFAULT_WEEKEND_REPEAT_HOUR;
    const nowParts = getLocalDateParts(new Date(), timeZone);
    const todayKey = toDateKey(nowParts);
    const alreadyRepeatedToday = String(queue.lastWeekendReplayDate || '').trim() === todayKey;

    if (isWeekendWeekday(nowParts) && nowParts.hour >= repeatHourLocal && !alreadyRepeatedToday) {
        queue.nextIndex = 0;
        queue.completedAt = null;
        queue.lastWeekendReplayDate = todayKey;
        queue.lastRepeatStartedAt = new Date().toISOString();
        saveQueue(queue);

        const minDelayMs = Math.max(60_000, Number.parseInt(queue.minDelayMs || '60000', 10) || 60_000);
        const maxDelayMs = Math.max(minDelayMs, Number.parseInt(queue.maxDelayMs || '180000', 10) || 180_000);
        const nextDelayMs = randomInt(minDelayMs, maxDelayMs);
        scheduleProcess(sock, nextDelayMs, {
            repeatMode: 'weekend',
            nextIndex: queue.nextIndex,
            remaining: jobs.length,
            reason: 'weekend_replay'
        });
        return true;
    }

    const delayMs = computeDelayUntilNextWeekendSlot(timeZone, repeatHourLocal);
    saveQueue(queue);
    scheduleProcess(sock, delayMs, {
        repeatMode: 'weekend',
        nextIndex: queue.nextIndex,
        remaining: 0,
        reason: 'waiting_for_weekend'
    });
    return true;
}

async function processNextBatch(sock) {
    if (running) return;
    running = true;

    try {
        const queue = loadQueue();
        if (!queue?.enabled) return;

        const jobs = Array.isArray(queue.jobs) ? queue.jobs : [];
        const nextIndex = Number.isInteger(queue.nextIndex) ? queue.nextIndex : 0;
        if (nextIndex >= jobs.length) {
            queue.completedAt = new Date().toISOString();
            saveQueue(queue);
            logger.info('job_test_queue_completed', {
                totalJobs: jobs.length
            });
            if (queue.repeatOnWeekends) {
                scheduleWeekendReplay(sock, queue, jobs);
                return;
            }
            queue.enabled = false;
            saveQueue(queue);
            return;
        }

        const groups = await sock.groupFetchAllParticipating();
        const targetGroups = resolveTargetGroups(queue, groups);
        if (!targetGroups.length) {
            logger.warn('job_test_queue_no_target_groups');
            return;
        }

        const maxBatchSize = Math.max(1, Number.parseInt(queue.maxBatchSize || '5', 10) || 5);
        const batchSize = Math.min(randomInt(1, maxBatchSize), jobs.length - nextIndex);
        const batch = jobs.slice(nextIndex, nextIndex + batchSize);

        for (const job of batch) {
            for (const targetGroup of targetGroups) {
                const sent = await sendSafeMessage(sock, targetGroup.id, buildJobPayload(job, { targetType: 'group' }));
                if (sent) {
                    logger.info('job_test_queue_sent', {
                        group: targetGroup.subject,
                        title: job.title,
                        url: job.url
                    });
                }
                await new Promise((resolve) => setTimeout(resolve, 1200));
            }
        }

        await dispatchPrivateJobAlertsForJobs(sock, batch, {
            mode: 'test_queue_delivery',
            limit: batch.length
        });

        queue.nextIndex = nextIndex + batch.length;
        queue.lastBatchAt = new Date().toISOString();
        queue.lastBatchSize = batch.length;
        saveQueue(queue);

        if (queue.nextIndex >= jobs.length) {
            queue.completedAt = new Date().toISOString();
            saveQueue(queue);
            logger.info('job_test_queue_completed', {
                totalJobs: jobs.length
            });
            if (queue.repeatOnWeekends) {
                scheduleWeekendReplay(sock, queue, jobs);
                return;
            }
            queue.enabled = false;
            saveQueue(queue);
            return;
        }

        const minDelayMs = Math.max(60_000, Number.parseInt(queue.minDelayMs || '60000', 10) || 60_000);
        const maxDelayMs = Math.max(minDelayMs, Number.parseInt(queue.maxDelayMs || '180000', 10) || 180_000);
        const nextDelayMs = randomInt(minDelayMs, maxDelayMs);
        scheduleProcess(sock, nextDelayMs, {
            nextIndex: queue.nextIndex,
            remaining: jobs.length - queue.nextIndex
        });
    } catch (error) {
        logger.error('job_test_queue_failed', {
            error: error?.message || String(error)
        });
    } finally {
        running = false;
    }
}

export function stopJobTestPublisher() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
}

export async function startJobTestPublisher(sock) {
    stopJobTestPublisher();
    const queue = loadQueue();
    if (!queue?.enabled) return;

    logger.info('job_test_queue_started', {
        totalJobs: Array.isArray(queue.jobs) ? queue.jobs.length : 0,
        nextIndex: Number.isInteger(queue.nextIndex) ? queue.nextIndex : 0
    });

    await processNextBatch(sock);
}
