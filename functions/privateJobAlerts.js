import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import cron from 'node-cron';

import { analyzeJobForPublishing } from './jobAnalyzer.js';
import { collectJobs, buildJobPayload } from './jobForwarder.js';
import { sendSafeMessage } from './messageHandler.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'private_job_alerts_config.json');
const STATE_FILE = path.join(__dirname, '..', 'private_job_alerts_state.json');

const DEFAULT_TARGETS = Array.from(new Set(
    String(process.env.IMAVY_PRIVATE_JOB_TARGETS || '246265120075930@lid')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
));

const ALERT_TIMEZONE = String(process.env.IMAVY_PRIVATE_JOB_TIMEZONE || 'America/Porto_Velho').trim();
const ALERT_CRON = String(process.env.IMAVY_PRIVATE_JOB_CRON || '0 8,13,18 * * *').trim();
const MAX_PRIVATE_JOBS_PER_RUN = Math.max(1, Number.parseInt(process.env.IMAVY_PRIVATE_JOB_MAX_PER_RUN || '3', 10) || 3);
const MAX_TRACKED_URLS = 2000;

let cronTask = null;
let pollingInFlight = false;

function normalizeSpace(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeUrl(value) {
    const safe = String(value || '').trim();
    if (!safe) return '';
    try {
        const parsed = new URL(safe);
        parsed.hash = '';
        return parsed.toString();
    } catch (_) {
        return safe;
    }
}

function getDefaultConfig() {
    return {
        enabled: true,
        subscriptions: DEFAULT_TARGETS.map((jid) => ({
            jid,
            label: jid,
            role: 'jovem_aprendiz',
            city: 'Porto Velho/RO',
            active: true
        }))
    };
}

function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_FILE)) {
            const config = getDefaultConfig();
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
            return config;
        }

        const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return {
            enabled: parsed?.enabled !== false,
            subscriptions: Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : []
        };
    } catch (_) {
        return getDefaultConfig();
    }
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
        updatedAt: new Date().toISOString(),
        enabled: config?.enabled !== false,
        subscriptions: Array.isArray(config?.subscriptions) ? config.subscriptions : []
    }, null, 2), 'utf8');
}

function getDefaultState() {
    return {
        subscriptions: {}
    };
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return getDefaultState();
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return {
            subscriptions: parsed?.subscriptions && typeof parsed.subscriptions === 'object'
                ? parsed.subscriptions
                : {}
        };
    } catch (_) {
        return getDefaultState();
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
        updatedAt: new Date().toISOString(),
        subscriptions: state?.subscriptions && typeof state.subscriptions === 'object'
            ? state.subscriptions
            : {}
    }, null, 2), 'utf8');
}

function getSubscriptionState(state, jid) {
    const key = String(jid || '').trim();
    if (!state.subscriptions[key]) {
        state.subscriptions[key] = {
            initialized: false,
            seenUrls: [],
            lastRunAt: null
        };
    }
    return state.subscriptions[key];
}

function mergeEntries(current = [], extra = []) {
    return Array.from(new Set([...(Array.isArray(current) ? current : []), ...(Array.isArray(extra) ? extra : [])]))
        .slice(-MAX_TRACKED_URLS);
}

function isYoungApprenticeJob(job) {
    const haystack = normalizeSpace([
        job?.title,
        job?.role,
        job?.summary,
        job?.requirements,
        job?.applyInfo
    ].join(' ')).toLowerCase();

    if (!haystack) return false;
    if (!haystack.includes('aprendiz')) return false;
    return haystack.includes('jovem aprendiz') || /\baprendiz\b/i.test(haystack);
}

async function pollPrivateJobAlerts(sock) {
    if (pollingInFlight) return;
    pollingInFlight = true;

    try {
        const config = loadConfig();
        if (config.enabled === false) {
            logger.info('private_job_alerts_paused');
            return;
        }

        const subscriptions = (Array.isArray(config.subscriptions) ? config.subscriptions : [])
            .filter((item) => item?.active !== false && String(item?.jid || '').trim());

        if (!subscriptions.length) {
            logger.info('private_job_alerts_no_subscriptions');
            return;
        }

        const rawJobs = await collectJobs();
        const matchingJobs = rawJobs.filter(isYoungApprenticeJob);
        const urlsSnapshot = matchingJobs.map((job) => normalizeUrl(job.url));
        const state = loadState();

        for (const subscription of subscriptions) {
            const subscriptionState = getSubscriptionState(state, subscription.jid);

            if (!subscriptionState.initialized) {
                subscriptionState.initialized = true;
                subscriptionState.seenUrls = mergeEntries(subscriptionState.seenUrls, urlsSnapshot);
                subscriptionState.lastRunAt = new Date().toISOString();
                continue;
            }

            const freshJobs = matchingJobs.filter((job) => !new Set(subscriptionState.seenUrls || []).has(normalizeUrl(job.url)));
            if (!freshJobs.length) {
                subscriptionState.seenUrls = mergeEntries(subscriptionState.seenUrls, urlsSnapshot);
                subscriptionState.lastRunAt = new Date().toISOString();
                continue;
            }

            const analyzedJobs = [];
            for (const job of freshJobs) {
                const analyzed = await analyzeJobForPublishing(job);
                if (analyzed?.publish && isYoungApprenticeJob(analyzed)) {
                    analyzedJobs.push(analyzed);
                }
            }

            const jobsToSend = analyzedJobs.slice(0, MAX_PRIVATE_JOBS_PER_RUN);
            for (const job of jobsToSend) {
                const sent = await sendSafeMessage(sock, subscription.jid, buildJobPayload(job));
                if (sent) {
                    logger.info('private_job_alert_sent', {
                        jid: subscription.jid,
                        title: job.title,
                        url: job.url
                    });
                }
                await new Promise((resolve) => setTimeout(resolve, 1200));
            }

            subscriptionState.initialized = true;
            subscriptionState.seenUrls = mergeEntries(subscriptionState.seenUrls, [
                ...urlsSnapshot,
                ...freshJobs.map((job) => normalizeUrl(job.url))
            ]);
            subscriptionState.lastRunAt = new Date().toISOString();
        }

        saveState(state);
    } catch (error) {
        logger.error('private_job_alerts_failed', {
            error: error?.message || String(error)
        });
    } finally {
        pollingInFlight = false;
    }
}

export async function startPrivateJobAlerts(sock) {
    if (cronTask) return;

    const config = loadConfig();
    logger.info('private_job_alerts_started', {
        enabled: config.enabled !== false,
        cron: ALERT_CRON,
        timezone: ALERT_TIMEZONE,
        maxJobsPerRun: MAX_PRIVATE_JOBS_PER_RUN,
        targets: (config.subscriptions || []).map((item) => item.jid)
    });

    await pollPrivateJobAlerts(sock);

    cronTask = cron.schedule(ALERT_CRON, () => {
        pollPrivateJobAlerts(sock).catch((error) => {
            logger.error('private_job_alerts_schedule_failed', {
                error: error?.message || String(error)
            });
        });
    }, {
        timezone: ALERT_TIMEZONE
    });
}

export function stopPrivateJobAlerts() {
    if (!cronTask) return;
    cronTask.stop();
    cronTask = null;
}

export function enablePrivateJobAlerts() {
    const nextConfig = { ...loadConfig(), enabled: true };
    saveConfig(nextConfig);
    return nextConfig;
}

export function disablePrivateJobAlerts() {
    const nextConfig = { ...loadConfig(), enabled: false };
    saveConfig(nextConfig);
    return nextConfig;
}
