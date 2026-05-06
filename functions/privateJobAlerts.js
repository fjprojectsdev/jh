import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import cron from 'node-cron';

import { collectPreparedJobsForPublishing, buildJobPayload } from './jobForwarder.js';
import {
    getPrivateJobConversation,
    getPrivateJobDeliveryState,
    getPrivateJobProfile,
    getPrivateJobProfiles,
    upsertPrivateJobConversation,
    upsertPrivateJobDeliveryState,
    upsertPrivateJobProfile,
    deletePrivateJobConversation
} from './database.js';
import { sendInteractiveButtonsMessage, sendInteractiveListMessage, sendSafeMessage } from './messageHandler.js';
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
const PROFILE_REFRESH_BATCH_SIZE = Math.max(1, Number.parseInt(process.env.IMAVY_PRIVATE_JOB_REFRESH_BATCH_SIZE || '10', 10) || 10);
const PROFILE_REFRESH_BATCH_DELAY_MS = Math.max(1_000, Number.parseInt(process.env.IMAVY_PRIVATE_JOB_REFRESH_BATCH_DELAY_MS || '30000', 10) || 30000);
const PROFILE_REFRESH_OLD_JOBS_LIMIT = Math.max(1, Number.parseInt(process.env.IMAVY_PRIVATE_JOB_REFRESH_OLD_LIMIT || '10', 10) || 10);
const MAX_TRACKED_URLS = 2000;
const MAX_TRACKED_SENT_JOBS = Math.max(50, Number.parseInt(process.env.IMAVY_PRIVATE_JOB_SENT_HISTORY_LIMIT || '300', 10) || 300);
const FACEBOOK_HOST_REGEX = /(?:^|\.)facebook\.com$/i;

let cronTask = null;
let pollingInFlight = false;

function normalizeSpace(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeExternalJid(value) {
    const safe = String(value || '').trim();
    if (!safe) return '';
    if (/@(c\.us|s\.whatsapp\.net|lid)$/i.test(safe)) {
        return safe;
    }

    const digits = safe.replace(/\D+/g, '');
    if (!digits) return '';
    return `${digits}@c.us`;
}

function normalizeIntentText(value) {
    return normalizeSpace(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
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

function mergeEntries(current = [], extra = []) {
    return Array.from(new Set([...(Array.isArray(current) ? current : []), ...(Array.isArray(extra) ? extra : [])]))
        .slice(-MAX_TRACKED_URLS);
}

function extractJidIdentity(jid) {
    const safe = String(jid || '').trim().toLowerCase();
    if (!safe) return '';
    const localPart = safe.split('@')[0] || safe;
    const digits = localPart.replace(/\D+/g, '');
    return digits.length >= 8 ? digits : localPart;
}

function resolveStateKey(collection, jid) {
    const key = String(jid || '').trim();
    if (!key || !collection || typeof collection !== 'object') return key;
    if (collection[key]) return key;

    const identity = extractJidIdentity(key);
    if (!identity) return key;

    for (const existingKey of Object.keys(collection)) {
        if (extractJidIdentity(existingKey) === identity) {
            return existingKey;
        }
    }

    return key;
}

function decodeHtml(value) {
    return String(value || '')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#039;/gi, '\'')
        .replace(/&#x27;/gi, '\'')
        .replace(/&#x2F;/gi, '/')
        .replace(/&#(\d+);/g, (_, code) => {
            const parsed = Number.parseInt(code, 10);
            return Number.isFinite(parsed) ? String.fromCharCode(parsed) : '';
        })
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
            const parsed = Number.parseInt(code, 16);
            return Number.isFinite(parsed) ? String.fromCharCode(parsed) : '';
        });
}

function stripHtml(value) {
    return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function cleanLine(value, maxLength = 320) {
    const normalized = normalizeSpace(value);
    if (!normalized) return '';
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3).trim()}...` : normalized;
}

function readFirst(value, regex) {
    const match = String(value || '').match(regex);
    return match ? match[1] : '';
}

function readMeta(html, property) {
    return decodeHtml(readFirst(
        html,
        new RegExp(`<meta[^>]+(?:property|name)=["']${String(property).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]+content=["']([^"']+)["']`, 'i')
    ));
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
        subscriptions: {},
        profiles: {},
        conversations: {}
    };
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return getDefaultState();
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return {
            subscriptions: parsed?.subscriptions && typeof parsed.subscriptions === 'object' ? parsed.subscriptions : {},
            profiles: parsed?.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},
            conversations: parsed?.conversations && typeof parsed.conversations === 'object' ? parsed.conversations : {}
        };
    } catch (_) {
        return getDefaultState();
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
        updatedAt: new Date().toISOString(),
        subscriptions: state?.subscriptions && typeof state.subscriptions === 'object' ? state.subscriptions : {},
        profiles: state?.profiles && typeof state.profiles === 'object' ? state.profiles : {},
        conversations: state?.conversations && typeof state.conversations === 'object' ? state.conversations : {}
    }, null, 2), 'utf8');
}

function syncStateShape(target, source) {
    if (!target || typeof target !== 'object' || !source || typeof source !== 'object') return;
    target.subscriptions = source.subscriptions && typeof source.subscriptions === 'object' ? source.subscriptions : {};
    target.profiles = source.profiles && typeof source.profiles === 'object' ? source.profiles : {};
    target.conversations = source.conversations && typeof source.conversations === 'object' ? source.conversations : {};
}

function updateAndSaveLatestState(mutator) {
    const latestState = loadState();
    if (typeof mutator === 'function') {
        mutator(latestState);
    }
    saveState(latestState);
    return latestState;
}

function getSubscriptionState(state, jid) {
    const key = resolveStateKey(state?.subscriptions, jid);
    if (!state.subscriptions[key]) {
        state.subscriptions[key] = {
            initialized: false,
            sentUrls: [],
            sentJobs: [],
            historicalReplayUrls: [],
            seenUrls: [],
            lastRunAt: null
        };
    }
    return state.subscriptions[key];
}

function getTrackedSentUrls(subscriptionState) {
    if (Array.isArray(subscriptionState?.sentUrls)) return subscriptionState.sentUrls;
    if (Array.isArray(subscriptionState?.seenUrls)) return subscriptionState.seenUrls;
    return [];
}

function getTrackedSentJobs(subscriptionState) {
    return Array.isArray(subscriptionState?.sentJobs) ? subscriptionState.sentJobs : [];
}

function getHistoricalReplayUrls(subscriptionState) {
    return Array.isArray(subscriptionState?.historicalReplayUrls) ? subscriptionState.historicalReplayUrls : [];
}

function setTrackedSentUrls(subscriptionState, urls) {
    const merged = mergeEntries(getTrackedSentUrls(subscriptionState), urls);
    subscriptionState.sentUrls = merged;
    subscriptionState.seenUrls = merged;
}

function serializeJobSnapshot(job = {}) {
    return {
        title: String(job?.title || '').trim(),
        url: normalizeUrl(job?.url || ''),
        company: String(job?.company || '').trim(),
        location: String(job?.location || '').trim(),
        area: String(job?.area || '').trim(),
        summary: String(job?.summary || '').trim(),
        requirements: String(job?.requirements || '').trim(),
        salaryInfo: String(job?.salaryInfo || '').trim(),
        applyInfo: String(job?.applyInfo || '').trim(),
        sourceLabel: String(job?.sourceLabel || '').trim(),
        publishedAt: job?.publishedAt || null,
        trackedAt: new Date().toISOString()
    };
}

function mergeSentJobSnapshots(current = [], extra = []) {
    const mergedMap = new Map();
    for (const item of Array.isArray(current) ? current : []) {
        const key = normalizeUrl(item?.url || '');
        if (!key) continue;
        mergedMap.set(key, item);
    }
    for (const item of Array.isArray(extra) ? extra : []) {
        const safeItem = serializeJobSnapshot(item);
        if (!safeItem.url) continue;
        mergedMap.set(safeItem.url, {
            ...(mergedMap.get(safeItem.url) || {}),
            ...safeItem
        });
    }
    return Array.from(mergedMap.values()).slice(-MAX_TRACKED_SENT_JOBS);
}

function setTrackedSentJobs(subscriptionState, jobs) {
    subscriptionState.sentJobs = mergeSentJobSnapshots(getTrackedSentJobs(subscriptionState), jobs);
}

function setHistoricalReplayUrls(subscriptionState, urls) {
    subscriptionState.historicalReplayUrls = mergeEntries(getHistoricalReplayUrls(subscriptionState), urls);
}

function getProfile(state, jid) {
    const key = resolveStateKey(state?.profiles, jid);
    const profile = state?.profiles?.[key];
    return profile && typeof profile === 'object' ? profile : null;
}

function setProfile(state, jid, profile) {
    const key = String(jid || '').trim();
    if (!key) return null;
    const now = new Date().toISOString();
    state.profiles[key] = {
        ...profile,
        jid: key,
        updatedAt: now,
        createdAt: profile?.createdAt || now
    };
    return state.profiles[key];
}

function getConversation(state, jid) {
    const key = resolveStateKey(state?.conversations, jid);
    const conversation = state?.conversations?.[key];
    return conversation && typeof conversation === 'object' ? conversation : null;
}

function setConversation(state, jid, conversation) {
    const key = String(jid || '').trim();
    if (!key) return;
    state.conversations[key] = { ...(conversation || {}), updatedAt: new Date().toISOString() };
}

function clearConversation(state, jid) {
    const key = resolveStateKey(state?.conversations, jid);
    if (!key || !state?.conversations) return;
    delete state.conversations[key];
}

async function hydrateProfile(state, jid) {
    const key = String(jid || '').trim();
    if (!key) return null;
    const remoteProfile = await getPrivateJobProfile(key);
    if (remoteProfile) state.profiles[key] = remoteProfile;
    return getProfile(state, key);
}

async function hydrateConversation(state, jid) {
    const key = String(jid || '').trim();
    if (!key) return null;
    const remoteConversation = await getPrivateJobConversation(key);
    if (remoteConversation) state.conversations[key] = remoteConversation;
    return getConversation(state, key);
}

async function hydrateSubscriptionState(state, jid) {
    const key = String(jid || '').trim();
    const subscriptionState = getSubscriptionState(state, key);
    if (!key) return subscriptionState;

    const remoteState = await getPrivateJobDeliveryState(key);
    if (remoteState && typeof remoteState === 'object') {
        state.subscriptions[key] = {
            ...subscriptionState,
            ...remoteState
        };
        state.subscriptions[key].sentUrls = mergeEntries(subscriptionState.sentUrls, remoteState.sentUrls);
        state.subscriptions[key].seenUrls = mergeEntries(subscriptionState.seenUrls, remoteState.seenUrls);
        state.subscriptions[key].sentJobs = mergeSentJobSnapshots(subscriptionState.sentJobs, remoteState.sentJobs);
        state.subscriptions[key].historicalReplayUrls = mergeEntries(subscriptionState.historicalReplayUrls, remoteState.historicalReplayUrls);
    }
    return getSubscriptionState(state, key);
}

async function hydrateStateForJid(state, jid) {
    await Promise.all([
        hydrateProfile(state, jid),
        hydrateConversation(state, jid),
        hydrateSubscriptionState(state, jid)
    ]);
    return state;
}

async function hydrateActiveProfiles(state) {
    const remoteProfiles = await getPrivateJobProfiles();
    for (const profile of remoteProfiles) {
        if (!profile?.jid) continue;
        state.profiles[profile.jid] = profile;
    }
    return getActiveProfiles(state);
}

async function persistProfileState(state, jid, profile) {
    const latestState = updateAndSaveLatestState((draft) => {
        setProfile(draft, jid, profile);
    });
    syncStateShape(state, latestState);
    const savedProfile = getProfile(latestState, jid);
    if (savedProfile?.jid) await upsertPrivateJobProfile(savedProfile);
    return savedProfile;
}

async function persistConversationState(state, jid, conversation) {
    const latestState = updateAndSaveLatestState((draft) => {
        setConversation(draft, jid, conversation);
    });
    syncStateShape(state, latestState);
    if (jid) await upsertPrivateJobConversation(String(jid).trim(), getConversation(latestState, jid));
}

async function clearConversationState(state, jid) {
    const latestState = updateAndSaveLatestState((draft) => {
        clearConversation(draft, jid);
    });
    syncStateShape(state, latestState);
    if (jid) await deletePrivateJobConversation(String(jid).trim());
}

async function persistSubscriptionState(state, jid) {
    const localSnapshot = getSubscriptionState(state, jid);
    const latestState = updateAndSaveLatestState((draft) => {
        const latestSubscriptionState = getSubscriptionState(draft, jid);
        latestSubscriptionState.initialized = localSnapshot.initialized;
        latestSubscriptionState.sentUrls = Array.isArray(localSnapshot.sentUrls) ? [...localSnapshot.sentUrls] : [];
        latestSubscriptionState.sentJobs = Array.isArray(localSnapshot.sentJobs) ? [...localSnapshot.sentJobs] : [];
        latestSubscriptionState.historicalReplayUrls = Array.isArray(localSnapshot.historicalReplayUrls) ? [...localSnapshot.historicalReplayUrls] : [];
        latestSubscriptionState.seenUrls = Array.isArray(localSnapshot.seenUrls) ? [...localSnapshot.seenUrls] : [];
        latestSubscriptionState.lastRunAt = localSnapshot.lastRunAt || null;
    });
    syncStateShape(state, latestState);
    const subscriptionState = getSubscriptionState(latestState, jid);
    if (jid) await upsertPrivateJobDeliveryState(String(jid).trim(), subscriptionState);
    return subscriptionState;
}

function getActiveSubscriptions(config) {
    return (Array.isArray(config?.subscriptions) ? config.subscriptions : [])
        .filter((item) => item?.active !== false && String(item?.jid || '').trim());
}

function getActiveProfiles(state) {
    return Object.values(state?.profiles || {})
        .filter((profile) => profile && profile.active !== false && String(profile.jid || '').trim());
}

function chunkItems(items, size) {
    const safeItems = Array.isArray(items) ? items : [];
    const chunkSize = Math.max(1, Number(size || 1));
    const chunks = [];
    for (let index = 0; index < safeItems.length; index += chunkSize) {
        chunks.push(safeItems.slice(index, index + chunkSize));
    }
    return chunks;
}

function buildProfileRefreshBroadcastMessage(profile) {
    const currentRole = normalizeSpace(profile?.jobType || '');
    return [
        'Estamos fazendo uma atualizacao no sistema de vagas para corrigir envios fora do perfil e enviar vagas mais proximas do que voce realmente procura.',
        '',
        currentRole ? `Seu cargo atual cadastrado: ${currentRole}` : 'Seu cargo atual cadastrado precisa ser revisado.',
        '',
        'Para atualizar, responda com apenas 1 cargo que voce prefere receber agora.',
        'Exemplos: auxiliar administrativo, recepcionista, vendedor, jovem aprendiz, estagio, auxiliar de estoque.',
        '',
        'Importante: jovem aprendiz e primeiro emprego sao diferentes, entao responda exatamente o que voce procura hoje.'
    ].join('\n');
}

function buildProfileRefreshFollowUpMessage(profile) {
    const currentRole = normalizeSpace(profile?.jobType || '');
    return [
        'Iniciando um novo wizard.',
        '',
        'Vamos editar seu perfil novamente?',
        currentRole ? `Cargo atual salvo: ${currentRole}` : '',
        '',
        'Me responda com apenas 1 cargo que voce prefere receber agora.'
    ].filter(Boolean).join('\n');
}

function buildMoreHistoricalJobsNoticeMessage(profile) {
    const currentRole = normalizeSpace(profile?.jobType || '');
    return [
        'Agora voce ja pode pedir mais vagas.',
        '',
        currentRole ? `Cargo atual: ${currentRole}` : '',
        'Se quiser, envie mensagens como:',
        '- quero ver mais vagas',
        '- mais vagas',
        '- mostre mais vagas',
        '',
        'Eu vou buscar vagas antigas que ja existem no banco de dados e te mostrar em lotes, sem flood.',
        'Se nao houver mais vagas antigas compativeis, eu continuo te avisando quando entrarem vagas novas.'
    ].filter(Boolean).join('\n');
}

function extractFacebookUrl(text) {
    const match = String(text || '').match(/https?:\/\/(?:(?:www|m|mbasic)\.)?facebook\.com\/[^\s]+/i);
    return match ? match[0].replace(/[)\]}>,.!?]+$/, '') : '';
}

function isFacebookHost(hostname) {
    const safe = String(hostname || '').toLowerCase().replace(/^(www|m|mbasic)\./, '');
    return FACEBOOK_HOST_REGEX.test(safe);
}

function looksLikeFacebookPostUrl(value) {
    const safe = String(value || '').trim();
    if (!safe) return false;
    try {
        const parsed = new URL(safe);
        if (!isFacebookHost(parsed.hostname)) return false;
        const target = `${parsed.pathname}${parsed.search}`.toLowerCase();
        return target.includes('/posts/')
            || target.includes('/permalink.php')
            || target.includes('/story.php')
            || target.includes('/reel/')
            || target.includes('/videos/')
            || target.includes('/watch/')
            || target.includes('/photo/');
    } catch (_) {
        return false;
    }
}

function inferFacebookJobTitle(text, fallbackTitle = '') {
    const lines = normalizeSpace(text)
        .split(/\s*(?:\n|\||•|-{2,})\s*/)
        .map((item) => item.trim())
        .filter(Boolean);
    const titlePattern = /\b(vaga(?:s)?(?: de)?(?: emprego)?(?: para)?|contrata[- ]?se|oportunidade|procura[- ]?se|estamos contratando)\b[:\s-]*(.+)/i;

    for (const line of lines) {
        const match = line.match(titlePattern);
        if (match?.[2]) return cleanLine(match[2], 110);
    }

    const fallback = cleanLine(fallbackTitle.replace(/\s*\|\s*facebook$/i, ''), 110);
    if (fallback) return fallback;
    return cleanLine(lines[0] || 'Vaga publicada no Facebook', 110);
}

function inferFacebookLocation(text) {
    const normalized = normalizeIntentText(text);
    if (normalized.includes('porto velho')) return 'Porto Velho/RO';
    if (normalized.includes('rondonia') || normalized.includes('rondônia')) return 'Rondonia/RO';
    return '';
}

function inferFacebookApplyInfo(text, url) {
    const phone = String(text || '').match(/(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?(?:9?\d{4})-?\d{4}/);
    if (phone) return `Contato informado no post: ${phone[0]}`;

    const email = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (email) return `Enviar contato/curriculo para: ${email[0]}`;

    return `Acesse o post publico no Facebook para se candidatar: ${url}`;
}

function buildFacebookJobFromHtml(html, sourceUrl) {
    const canonicalUrl = normalizeUrl(readMeta(html, 'og:url') || sourceUrl);
    const rawTitle = readMeta(html, 'og:title') || readMeta(html, 'twitter:title') || '';
    const ogDescription = readMeta(html, 'og:description') || readMeta(html, 'description') || '';
    const embeddedMessage = decodeHtml(
        readFirst(html, /"message"\s*:\s*\{"text":"([\s\S]*?)","ranges"/i)
        || readFirst(html, /"story"\s*:\s*\{"message"\s*:\s*\{"text":"([\s\S]*?)","ranges"/i)
    ).replace(/\\"/g, '"');
    const combinedText = cleanLine([embeddedMessage, ogDescription].filter(Boolean).join(' | '), 520);

    if (!combinedText) return null;

    const normalized = normalizeIntentText(combinedText);
    if (!/\b(vaga|contrata|contratando|curriculo|selecao|seleção|oportunidade)\b/.test(normalized)) return null;

    const pageName = cleanLine(rawTitle.split('|')[0], 80);
    const title = inferFacebookJobTitle(combinedText, rawTitle);
    const location = inferFacebookLocation(combinedText) || 'Porto Velho/RO';

    return {
        sourceId: 'facebook_public_link',
        sourceLabel: 'Facebook publico',
        title,
        company: pageName || 'Anuncio publicado no Facebook',
        location,
        area: '',
        summary: combinedText,
        requirements: combinedText,
        salaryInfo: '',
        role: title,
        applyInfo: inferFacebookApplyInfo(combinedText, canonicalUrl || sourceUrl),
        url: canonicalUrl || sourceUrl,
        publishedAt: null
    };
}

async function fetchHtml(url) {
    const response = await fetch(url, {
        headers: {
            'user-agent': 'Mozilla/5.0 (compatible; iMavyBot/1.0; +https://github.com/fjprojectsdev/jh)'
        }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} em ${url}`);
    return response.text();
}

function normalizeWorkModels(value) {
    const normalized = normalizeIntentText(value);
    const models = [];
    if (/\bremot|home office|homeoffice|online\b/.test(normalized)) models.push('remote');
    if (/\bhibri|hybrid\b/.test(normalized)) models.push('hybrid');
    if (/\bpresenc|local\b/.test(normalized)) models.push('onsite');
    return models.length ? Array.from(new Set(models)) : ['remote', 'hybrid', 'onsite'];
}

function normalizeSeniority(value) {
    const normalized = normalizeIntentText(value);
    if (!normalized || /\bqualquer|tanto faz|nao sei|não sei\b/.test(normalized)) return 'any';
    if (/\bestagio\b/.test(normalized)) return 'intern';
    if (/\bjunior|jr\b/.test(normalized)) return 'junior';
    if (/\bpleno|pl\b/.test(normalized)) return 'mid';
    if (/\bsenior|sr\b/.test(normalized)) return 'senior';
    return 'any';
}

function normalizeExperiencePreference(value) {
    const normalized = normalizeIntentText(value);
    if (normalized === 'entry') return 'entry';
    if (normalized === 'experienced') return 'experienced';
    if (normalized === 'noexperience' || normalized === 'no_experience') return 'no_experience';
    if (!normalized || /\bqualquer|tanto faz|nao sei|nÃ£o sei\b/.test(normalized)) return 'any';
    if (/\b(primeiro emprego|jovem aprendiz|aprendiz|estagio|estÃ¡gio)\b/.test(normalized)) return 'entry';
    if (/\b(sem experiencia|sem experiÃªncia|nao precisa experiencia|nÃ£o precisa experiÃªncia|sem exp)\b/.test(normalized)) return 'no_experience';
    if (/\b(com experiencia|com experiÃªncia|experiente|tenho experiencia|tenho experiÃªncia)\b/.test(normalized)) return 'experienced';
    return 'any';
}

function inferExperiencePreferenceFromProfile(profile = {}) {
    const direct = normalizeExperiencePreference(profile?.experiencePreference || profile?.seniority || '');
    if (direct !== 'any') return direct;

    const combined = [
        profile?.jobType,
        Array.isArray(profile?.keywords) ? profile.keywords.join(', ') : ''
    ].join(' ');

    return normalizeExperiencePreference(combined);
}

function formatExperiencePreference(value) {
    const normalized = String(value || 'any');
    if (normalized === 'entry') return 'primeiro emprego/aprendiz/estagio';
    if (normalized === 'no_experience') return 'sem experiencia';
    if (normalized === 'experienced') return 'com experiencia';
    return 'qualquer';
}

function formatSeniority(value) {
    const normalized = String(value || 'any');
    if (normalized === 'intern') return 'Primeiro emprego / Estagio';
    if (normalized === 'junior') return 'Junior';
    if (normalized === 'mid') return 'Pleno';
    if (normalized === 'senior') return 'Senior';
    return 'Qualquer';
}

function formatWorkModelsForDisplay(models = []) {
    const safeModels = Array.isArray(models) ? models : [];
    if (!safeModels.length || safeModels.length === 3) {
        return 'Presencial, Hibrido e Remoto';
    }

    const labels = [];
    if (safeModels.includes('onsite')) labels.push('Presencial');
    if (safeModels.includes('hybrid')) labels.push('Hibrido');
    if (safeModels.includes('remote')) labels.push('Remoto');
    return labels.join(', ') || 'Presencial, Hibrido e Remoto';
}

function normalizeStateText(value) {
    const normalized = normalizeIntentText(value);
    const map = {
        ro: 'RO',
        rondonia: 'RO',
        'rondônia': 'RO',
        sp: 'SP',
        'sao paulo': 'SP',
        'são paulo': 'SP',
        rj: 'RJ',
        'rio de janeiro': 'RJ'
    };
    return map[normalized] || String(value || '').trim().toUpperCase().slice(0, 2);
}

function parseOptionalValue(value) {
    const normalized = normalizeIntentText(value);
    if (!normalized || /^(pular|nenhum|nenhuma|nao|não|sem|skip)$/i.test(normalized)) return '';
    return normalizeSpace(value);
}

function tokenizeSearch(value) {
    return normalizeIntentText(value)
        .split(/[^a-z0-9]+/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 3);
}

function splitProfileJobInterests(value) {
    return uniqueTokens(
        String(value || '')
            .split(/\s*(?:,|;|\||\/|\be\b|\bou\b)\s*/i)
            .map((item) => normalizeSpace(item))
            .filter(Boolean)
    );
}

const ROLE_TOKEN_EQUIVALENTS = new Map([
    ['aux', ['auxiliar']],
    ['adm', ['administrativo', 'administrativa', 'administracao']],
    ['admin', ['administrativo', 'administrativa', 'administracao']],
    ['aprendiz', ['jovem', 'jovemaprendiz']],
    ['jovem', ['aprendiz', 'jovemaprendiz']],
    ['jovemaprendiz', ['jovem', 'aprendiz']],
    ['estagio', ['estagiario', 'estagiaria']],
    ['estagiario', ['estagio', 'estagiaria']],
    ['estagiaria', ['estagio', 'estagiario']],
    ['rh', ['recursos', 'humanos']],
    ['ti', ['tecnologia', 'informatica', 'informacao']],
    ['dev', ['desenvolvedor', 'desenvolvimento']]
]);

const GENERIC_ROLE_TOKENS = new Set([
    'aux',
    'auxiliar',
    'assistente',
    'analista',
    'tecnico',
    'tecnica',
    'tecnologo',
    'tecnologa',
    'operador',
    'operadora',
    'consultor',
    'consultora',
    'vendedor',
    'vendedora',
    'atendente',
    'supervisor',
    'supervisora',
    'coordenador',
    'coordenadora',
    'gerente',
    'especialista',
    'lider',
    'profissional'
]);

function uniqueTokens(tokens) {
    return Array.from(new Set((Array.isArray(tokens) ? tokens : []).filter(Boolean)));
}

function expandRoleTokens(tokens) {
    const expanded = new Set(uniqueTokens(tokens));
    const joinedTokens = uniqueTokens(tokens);

    for (const token of joinedTokens) {
        const equivalents = ROLE_TOKEN_EQUIVALENTS.get(token) || [];
        for (const equivalent of equivalents) expanded.add(equivalent);
    }

    if (expanded.has('jovem') && expanded.has('aprendiz')) {
        expanded.add('jovemaprendiz');
    }

    return Array.from(expanded);
}

function splitRoleTokens(tokens) {
    const allTokens = uniqueTokens(tokens);
    const specificTokens = allTokens.filter((token) => !GENERIC_ROLE_TOKENS.has(token));
    return { allTokens, specificTokens };
}

function isGenericOnlyInterest(interestText) {
    const tokens = expandRoleTokens(tokenizeSearch(interestText));
    if (!tokens.length) return false;
    const { specificTokens } = splitRoleTokens(tokens);
    return specificTokens.length === 0;
}

function isTooBroadPrimaryJobType(value) {
    const interests = splitProfileJobInterests(value);
    if (!interests.length) return false;
    return interests.some((interest) => isGenericOnlyInterest(interest));
}

function isValidPrimaryJobType(value) {
    const safe = normalizeSpace(value);
    if (!safe) return false;
    const normalized = normalizeIntentText(safe);
    if (!/[a-zA-ZÀ-ÿ]/.test(safe)) return false;
    if (/^\d+$/.test(normalized)) return false;
    if (isMoreJobsIntent(normalized) || isHistoricalMoreJobsIntent(normalized)) return false;
    if (/^(sim|ok|confirmar|confirmo|nao|não|editar|pular|cancelar|quero|ver|mostrar|mostre|manda)$/.test(normalized)) return false;
    return true;
}

function hasWholePhraseMatch(phrase, haystacks = []) {
    const normalizedPhrase = normalizeIntentText(phrase);
    if (!normalizedPhrase) return false;
    return haystacks.some((haystack) => normalizeIntentText(haystack).includes(normalizedPhrase));
}

function hasStrongRoleMatch(profile, ctx, roleOverlap, keywordOverlap) {
    const roleText = String(profile?.jobType || '');
    const expandedProfileTokens = expandRoleTokens(tokenizeSearch(roleText));
    const { allTokens, specificTokens } = splitRoleTokens(expandedProfileTokens);
    const overlapSet = new Set(uniqueTokens(roleOverlap));
    const keywordSet = new Set(uniqueTokens(keywordOverlap));

    if (!allTokens.length) {
        return keywordSet.size > 0;
    }

    if (hasWholePhraseMatch(roleText, [
        ctx?.title || '',
        ctx?.role || '',
        ctx?.summary || '',
        ctx?.requirements || '',
        ctx?.text || ''
    ])) {
        return true;
    }

    if (!specificTokens.length) {
        return overlapSet.size > 0 || keywordSet.size > 0;
    }

    const matchedSpecificTokens = specificTokens.filter((token) => overlapSet.has(token) || keywordSet.has(token));
    if (!matchedSpecificTokens.length) return false;

    if (specificTokens.length === 1) {
        return true;
    }

    return matchedSpecificTokens.length >= Math.min(2, specificTokens.length);
}

function getProfileInterestTexts(profile) {
    const secondary = Array.isArray(profile?.secondaryJobTypes)
        ? profile.secondaryJobTypes.map((item) => normalizeSpace(item)).filter(Boolean)
        : [];
    const interests = uniqueTokens([
        ...splitProfileJobInterests(profile?.jobType || ''),
        ...secondary
    ]);
    if (!interests.length) {
        return [String(profile?.jobType || '').trim()].filter(Boolean);
    }

    const hasSpecificInterest = interests.some((interest) => !isGenericOnlyInterest(interest));
    if (!hasSpecificInterest) return interests;

    return interests.filter((interest) => !isGenericOnlyInterest(interest));
}

function buildRoleOverlapForInterest(interestText, ctx) {
    const profileTokens = expandRoleTokens(tokenizeSearch(interestText));
    return {
        all: profileTokens.filter((token) => ctx.titleTokens.includes(token) || ctx.summaryTokens.includes(token)),
        titleOnly: profileTokens.filter((token) => ctx.titleTokens.includes(token))
    };
}

function matchInterestAgainstJob(interestText, profile, ctx, keywordOverlap) {
    const roleOverlap = buildRoleOverlapForInterest(interestText, ctx);
    const interestProfile = { ...profile, jobType: interestText };
    let matched = hasStrongRoleMatch(interestProfile, ctx, roleOverlap.all, keywordOverlap);

    // Interesses amplos como "auxiliar" so devem casar quando o cargo aparece
    // explicitamente no titulo, para evitar vazamento via resumo/descricoes.
    if (matched && isGenericOnlyInterest(interestText)) {
        matched = roleOverlap.titleOnly.length > 0 || hasWholePhraseMatch(interestText, [ctx?.title || '', ctx?.role || '']);
    }

    return {
        interestText,
        roleOverlap: roleOverlap.all,
        matched
    };
}

function normalizeCityForMatch(value) {
    const safe = String(value || '').trim();
    if (!safe) return '';
    const cityOnly = safe.split('/')[0].split(',')[0].split('-')[0].trim();
    return normalizeIntentText(cityOnly);
}

function buildProfileSummary(profile) {
    const keywords = Array.isArray(profile?.keywords) && profile.keywords.length ? profile.keywords.join(', ') : 'nenhuma';
    const secondaryRoles = Array.isArray(profile?.secondaryJobTypes) && profile.secondaryJobTypes.length
        ? profile.secondaryJobTypes.join(', ')
        : 'nenhum';
    return [
        `Nome: ${profile?.name || 'N/D'}`,
        `Cargo principal: ${profile?.jobType || 'N/D'}`,
        `Cargos secundarios: ${secondaryRoles}`,
        `Cidade: ${profile?.city || 'N/D'}`,
        `Estado: ${profile?.state || 'N/D'}`,
        `Modelo de trabalho: ${formatWorkModelsForDisplay(profile?.workModels)}`,
        `Nivel: ${formatSeniority(profile?.seniority)}`,
        `Experiencia: ${formatExperiencePreference(inferExperiencePreferenceFromProfile(profile))}`,
        `Pretensao salarial: ${profile?.salaryExpectation || 'nao informada'}`,
        `Palavras-chave: ${keywords}`,
        `Status: ${profile?.active === false ? 'pausado' : 'ativo'}`
    ].join('\n');
}

function extractJobContext(job) {
    const text = normalizeIntentText([
        job?.title,
        job?.role,
        job?.summary,
        job?.requirements,
        job?.applyInfo,
        job?.company,
        job?.location
    ].join(' '));

    let workModel = 'onsite';
    if (/\bremot|home office|homeoffice\b/.test(text)) workModel = 'remote';
    else if (/\bhibri|hybrid\b/.test(text)) workModel = 'hybrid';

    let experienceLevel = 'any';
    if (/\b(jovem aprendiz|aprendiz|primeiro emprego|estagio|estÃ¡gio)\b/.test(text)) experienceLevel = 'entry';
    else if (/\b(sem experiencia|sem experiÃªncia|nao exige experiencia|nÃ£o exige experiÃªncia|sem exp)\b/.test(text)) experienceLevel = 'no_experience';
    else if (/\b(experiencia|experiÃªncia|experiente|vivencia|vivÃªncia)\b/.test(text)) experienceLevel = 'experienced';

    const cityRaw = normalizeCityForMatch(job?.location || '');

    return {
        title: String(job?.title || ''),
        role: String(job?.role || ''),
        summary: String(job?.summary || ''),
        requirements: String(job?.requirements || ''),
        text,
        workModel,
        experienceLevel,
        city: cityRaw,
        titleTokens: expandRoleTokens(tokenizeSearch(job?.title || job?.role || '')),
        summaryTokens: expandRoleTokens(tokenizeSearch([job?.summary, job?.requirements].join(' ')))
    };
}

function isCompatibleWorkModel(ctx, profile) {
    const desiredModels = Array.isArray(profile?.workModels) && profile.workModels.length
        ? profile.workModels
        : ['remote', 'hybrid', 'onsite'];
    return desiredModels.includes(ctx.workModel);
}

function isCompatibleCity(ctx, profile) {
    const desiredCity = normalizeCityForMatch(profile?.city || '');
    if (!desiredCity) return true;
    if (ctx.workModel === 'remote') return true;
    if (!ctx.city) return false;
    return desiredCity === ctx.city;
}

function isCompatibleExperience(ctx, profile) {
    const desiredExperience = inferExperiencePreferenceFromProfile(profile);
    if (desiredExperience === 'any') return true;

    // Para perfis de inicio de carreira, so aceitamos vagas que deixem
    // claro serem de entrada/sem experiencia.
    if (desiredExperience === 'entry' || desiredExperience === 'no_experience') {
        return ctx.experienceLevel === 'entry' || ctx.experienceLevel === 'no_experience';
    }

    if (ctx.experienceLevel === 'any') return true;
    return desiredExperience === ctx.experienceLevel;
}

function isExplicitEntryLevelJob(job) {
    const text = normalizeIntentText([
        job?.title,
        job?.role,
        job?.summary,
        job?.requirements,
        job?.applyInfo
    ].join(' '));

    return /\b(jovem aprendiz|aprendiz|primeiro emprego|estagio|estágio|trainee)\b/.test(text);
}

function matchJobForProfile(job, profile) {
    if (!profile) return { compatible: false, reason: 'missing_profile' };

    const ctx = extractJobContext(job);
    const keywordTokens = Array.isArray(profile.keywords) ? profile.keywords.flatMap(tokenizeSearch) : [];
    const keywordOverlap = keywordTokens.filter((token) => ctx.text.includes(token));
    const interests = getProfileInterestTexts(profile);
    const interestMatches = interests.map((interestText) => matchInterestAgainstJob(interestText, profile, ctx, keywordOverlap));
    const successfulInterest = interestMatches
        .filter((item) => item.matched)
        .sort((a, b) => b.roleOverlap.length - a.roleOverlap.length || b.interestText.length - a.interestText.length)[0];
    const roleOverlap = successfulInterest?.roleOverlap || [];
    const hasSemanticMatch = Boolean(successfulInterest);

    if (!hasSemanticMatch) {
        return {
            compatible: false,
            reason: 'semantic_mismatch',
            roleOverlap,
            keywordOverlap,
            matchedInterest: null,
            ctx
        };
    }

    if (!isCompatibleWorkModel(ctx, profile)) {
        return {
            compatible: false,
            reason: 'work_model_mismatch',
            roleOverlap,
            keywordOverlap,
            matchedInterest: successfulInterest?.interestText || null,
            ctx
        };
    }

    if (!isCompatibleCity(ctx, profile)) {
        return {
            compatible: false,
            reason: 'city_mismatch',
            roleOverlap,
            keywordOverlap,
            matchedInterest: successfulInterest?.interestText || null,
            ctx
        };
    }

    if (!isCompatibleExperience(ctx, profile)) {
        return {
            compatible: false,
            reason: 'experience_mismatch',
            roleOverlap,
            keywordOverlap,
            matchedInterest: successfulInterest?.interestText || null,
            ctx
        };
    }

    return {
        compatible: true,
        reason: 'matched',
        roleOverlap,
        keywordOverlap,
        matchedInterest: successfulInterest?.interestText || null,
        ctx
    };
}

function filterJobsForProfile(jobs, profile, options = {}) {
    const includeSent = options.includeSent === true;
    const excludeUrls = new Set((options.excludeUrls || []).map((item) => normalizeUrl(item)));
    const logContext = options.logContext && typeof options.logContext === 'object' ? options.logContext : null;

    return (Array.isArray(jobs) ? jobs : [])
        .filter((job) => includeSent || !excludeUrls.has(normalizeUrl(job.url)))
        .map((job) => {
            const result = { job, ...matchJobForProfile(job, profile) };
            if (logContext) {
                logger.debug('private_job_match_decision', {
                    ...logContext,
                    title: job?.title || '',
                    url: job?.url || '',
                    compatible: result.compatible,
                    reason: result.reason || 'unknown',
                    matchedInterest: result.matchedInterest || '',
                    roleOverlap: result.roleOverlap || [],
                    keywordOverlap: result.keywordOverlap || [],
                    workModel: result.ctx?.workModel || '',
                    city: result.ctx?.city || '',
                    experienceLevel: result.ctx?.experienceLevel || ''
                });
            }
            return result;
        })
        .filter((item) => item.compatible)
        .sort((a, b) => {
            const desiredExperience = inferExperiencePreferenceFromProfile(profile);
            if (desiredExperience === 'entry' || desiredExperience === 'no_experience') {
                const aExplicitEntry = isExplicitEntryLevelJob(a.job);
                const bExplicitEntry = isExplicitEntryLevelJob(b.job);
                if (aExplicitEntry !== bExplicitEntry) {
                    return bExplicitEntry ? 1 : -1;
                }
            }
            return (b.job?.publishedAt || 0) - (a.job?.publishedAt || 0);
        })
        .map((item) => item.job);
}

async function rankJobsForProfile(jobs, profile, options = {}) {
    return filterJobsForProfile(jobs, profile, options);
}

function isLegacyApprenticeJob(job) {
    const haystack = normalizeIntentText([
        job?.title,
        job?.role,
        job?.summary,
        job?.requirements,
        job?.applyInfo
    ].join(' '));
    return haystack.includes('aprendiz');
}

async function collectPreparedJobs() {
    return collectPreparedJobsForPublishing();
}

async function collectPreparedLegacyJobs(subscriptionState) {
    return collectPreparedJobsForPublishing({
        filterFn: isLegacyApprenticeJob,
        excludeUrls: getTrackedSentUrls(subscriptionState)
    });
}

async function sendJobsList(sock, jid, jobs, subscriptionState, loggerEvent, options = {}) {
    const sentUrls = [];
    const sentJobs = [];
    const delayMs = Math.max(250, Number(options.delayMs || 1200));
    for (const job of jobs) {
        const sent = await sendSafeMessage(sock, jid, buildJobPayload(job));
        if (sent) {
            sentUrls.push(normalizeUrl(job.url));
            sentJobs.push(serializeJobSnapshot(job));
            logger.info(loggerEvent, {
                jid,
                title: job.title,
                url: job.url
            });
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    if (sentUrls.length) setTrackedSentUrls(subscriptionState, sentUrls);
    if (sentJobs.length) setTrackedSentJobs(subscriptionState, sentJobs);
    subscriptionState.initialized = true;
    subscriptionState.lastRunAt = new Date().toISOString();
    return sentUrls.length;
}

function markCurrentMatchesAsTracked(subscriptionState, urls) {
    setTrackedSentUrls(subscriptionState, Array.isArray(urls) ? urls : []);
    subscriptionState.initialized = true;
    subscriptionState.lastRunAt = new Date().toISOString();
}

function isStartProfileIntent(text) {
    const normalized = normalizeIntentText(text);
    if (!normalized) return false;
    if (/\b(comando|comandos|grupo|grupos|admin|admins|lembrete|ranking|parceiro|parceiros|noticia|noticias|news|shill|lamina|bot)\b/.test(normalized)) {
        return false;
    }
    const hasJobs = /\b(vaga|vagas|emprego|empregos|trabalho|trabalhar|servico|servico|serviço|serviços|oportunidade|oportunidades)\b/.test(normalized);
    if (!hasJobs) return false;

    if (/\b(quero|receber|cadastro|cadastrar|configurar|perfil|procurando|procuro|buscar|busca|preciso|precisando|interesse|interessado|interessada)\b/.test(normalized)) {
        return true;
    }

    if (/\b(tem|tem alguma|tem alguma vaga|ha|existe|consegue|sabe|manda|manda pra mim|envia|me envia|me manda|avisa|me avisa|aparece|aparecer)\b/.test(normalized)) {
        return true;
    }

    if (/\b(to|tô|estou)\s+(procurando|buscando|atras de|atras de um|atrás de|atrás de um)\b/.test(normalized)) {
        return true;
    }

    if (/\b(quero trabalhar|quero um emprego|preciso de um emprego|procuro emprego|procuro trabalho|estou desempregado|estou desempregada)\b/.test(normalized)) {
        return true;
    }

    return false;
}

function isMoreJobsIntent(text) {
    const normalized = normalizeIntentText(text);
    return normalized.includes('mais vagas')
        || normalized.includes('quero ver mais vagas')
        || normalized.includes('mostre mais vagas')
        || normalized.includes('mostrar mais vagas')
        || normalized.includes('quero mais vagas')
        || normalized.includes('vagas atuais')
        || normalized.includes('manda vagas')
        || normalized.includes('manda mais')
        || normalized.includes('ver vagas')
        || normalized.includes('tem vagas')
        || normalized.includes('tem vaga')
        || normalized.includes('me manda vagas')
        || normalized.includes('me envia vagas')
        || normalized.includes('me avisa das vagas')
        || normalized.includes('quais vagas tem')
        || normalized.includes('quais vagas tem hoje')
        || normalized.includes('tem emprego')
        || normalized.includes('tem empregos');
}

function isHistoricalMoreJobsIntent(text) {
    const normalized = normalizeIntentText(text);
    return normalized.includes('mais vagas')
        || normalized.includes('quero ver mais vagas')
        || normalized.includes('mostre mais vagas')
        || normalized.includes('mostrar mais vagas')
        || normalized.includes('quero mais vagas')
        || normalized.includes('manda mais');
}

function normalizePrivateProfileCommand(text) {
    const normalized = normalizeIntentText(text).replace(/^\//, '');
    if (normalized === 'meu perfil') return 'profile_show';
    if (normalized === 'editar perfil') return 'profile_edit';
    if (normalized === 'ver vagas') return 'show_jobs';
    if (normalized === 'ajustar filtros') return 'profile_edit';
    if (normalized === 'pausar') return 'profile_pause';
    if (normalized === 'reativar') return 'profile_resume';
    if (normalized === 'cancelar') return 'cancel';
    return '';
}

function isKeepCurrentIntent(text) {
    return /\b(manter|manter atual|continuar|seguir|mesmo|igual)\b/i.test(normalizeIntentText(text));
}

function parseSingleChoiceNumber(text, choices = {}) {
    const normalized = normalizeIntentText(text).replace(/[^\d]/g, '');
    if (!normalized) return '';
    return choices[normalized] || '';
}

function parseMultiChoiceNumbers(text, choices = {}) {
    const normalized = normalizeIntentText(text);
    const matches = normalized.match(/\d+/g) || [];
    const selected = [];
    for (const match of matches) {
        const mapped = choices[match];
        if (mapped && !selected.includes(mapped)) {
            selected.push(mapped);
        }
    }
    return selected;
}

function parseWorkModelAnswer(text) {
    const quickSelections = parseMultiChoiceNumbers(text, {
        '1': 'presencial',
        '2': 'remoto',
        '3': 'hibrido',
        '4': 'tanto faz'
    });

    if (quickSelections.includes('tanto faz')) {
        return ['remote', 'hybrid', 'onsite'];
    }

    if (quickSelections.length) {
        return normalizeWorkModels(quickSelections.join(', '));
    }

    if (!isRecognizedWorkModelAnswer(text)) {
        return null;
    }

    return normalizeWorkModels(text);
}

function parseSeniorityAnswer(text) {
    const quickSelection = parseSingleChoiceNumber(text, {
        '1': 'estagio',
        '2': 'junior',
        '3': 'pleno',
        '4': 'senior',
        '5': 'qualquer'
    });

    if (quickSelection) {
        return normalizeSeniority(quickSelection);
    }

    if (!isRecognizedSeniorityAnswer(text)) {
        return '';
    }

    return normalizeSeniority(text);
}

function parseExistingProfileAction(text, step = '') {
    const normalized = normalizeIntentText(text);

    if (/\b(editar|quero editar|ajustar filtros)\b/.test(normalized)) return 'edit';
    if (/\b(ver vagas|vagas agora|mostrar vagas|quero vagas)\b/.test(normalized)) {
        return step === 'ASK_REFRESH_TODAY_JOBS' ? 'refresh_jobs' : 'show_jobs';
    }
    if (/\b(nao|nÃ£o)\b/.test(normalized)) return 'no';
    if (step === 'ASK_OLD_JOBS' && /\b(sim|antiga|antigas|ver antigas|mostrar antigas)\b/.test(normalized)) return 'old_jobs';
    if (step === 'ASK_REFRESH_TODAY_JOBS' && /\b(sim|quero|mostrar|ver|atualizar)\b/.test(normalized)) return 'refresh_jobs';

    const quickSelection = parseSingleChoiceNumber(text, {
        '1': step === 'ASK_OLD_JOBS' ? 'old_jobs' : 'edit',
        '2': step === 'ASK_OLD_JOBS' ? 'no' : 'show_jobs',
        '3': 'edit'
    });

    if (step === 'ASK_REFRESH_TODAY_JOBS' && quickSelection === 'edit') return 'refresh_jobs';
    if (step === 'ASK_REFRESH_TODAY_JOBS' && quickSelection === 'show_jobs') return 'no';
    return quickSelection || '';
}

function isRecognizedWorkModelAnswer(text) {
    const normalized = normalizeIntentText(text);
    return /\b(remot|home office|homeoffice|online|hibri|hybrid|presenc|local|todos|tanto faz|qualquer)\b/.test(normalized)
        || /\b[1-4]\b/.test(normalized);
}

function isRecognizedSeniorityAnswer(text) {
    const normalized = normalizeIntentText(text);
    return /\b(primeiro emprego|aprendiz|jovem aprendiz|estagio|junior|jr|pleno|pl|senior|sr|qualquer|tanto faz)\b/.test(normalized)
        || /\b[1-5]\b/.test(normalized);
}

function buildCurrentValueHint(value) {
    const safeValue = String(value || '').trim();
    if (!safeValue) return '';
    return `\nAtual: ${safeValue}\nSe quiser manter, digite MANTER.`;
}

function buildStepPrompt(step, draft = {}) {
    switch (step) {
        case 'ASK_NAME':
            return `Etapa 1 de 8\n\n1. Qual e o seu nome?${buildCurrentValueHint(draft.name)}`;
        case 'ASK_JOB_TYPE':
            return `Etapa 2 de 8\n\n2. Em qual area voce quer trabalhar?\nEx: Desenvolvedor, Auxiliar administrativo, Vendedor...${buildCurrentValueHint(draft.jobType)}`;
        case 'ASK_SECONDARY_JOB_TYPES':
            return `Etapa 3 de 8\n\n3. Voce aceita outros cargos alem do principal? (opcional)\nEx: Estagio, Suporte tecnico, Recepcionista\n\nSe preferir, digite PULAR 👍${buildCurrentValueHint(Array.isArray(draft.secondaryJobTypes) ? draft.secondaryJobTypes.join(', ') : '')}`;
        case 'ASK_CITY':
            return `Etapa 4 de 8\n\n4. Em qual cidade voce quer trabalhar?${buildCurrentValueHint(draft.city)}`;
        case 'ASK_STATE':
            return `Etapa 5 de 8\n\n5. Qual e o seu estado?\nEx: RO, SP, MG${buildCurrentValueHint(draft.state)}`;
        case 'ASK_WORK_MODEL':
            return `Etapa 6 de 8\n\n6. Qual tipo de trabalho voce prefere?\n- Presencial\n- Hibrido\n- Remoto\n- Tanto faz\n\nResponda com uma ou mais opcoes.${buildCurrentValueHint(formatWorkModelsForDisplay(draft.workModels))}`;
        case 'ASK_SENIORITY':
            return `Etapa 7 de 8\n\n7. Qual nivel de experiencia voce esta buscando?\n- Primeiro emprego / Estagio\n- Junior\n- Pleno\n- Senior\n- Qualquer${buildCurrentValueHint(formatSeniority(draft.seniority))}`;
        case 'ASK_SALARY':
            return `Etapa 8 de 8\n\n8. Qual sua pretensao salarial? (opcional)\nSe preferir, pode digitar PULAR 👍${buildCurrentValueHint(draft.salaryExpectation)}`;
        case 'CONFIRM':
            return `Confira seu perfil antes de finalizar:\n\n${buildProfileSummary(draft)}\n\nEsta tudo certo?\nDigite CONFIRMAR para salvar\nOu EDITAR para ajustar.`;
        default:
            return '';
    }
}

function buildWizardStepPrompt(step, draft = {}) {
    switch (step) {
        case 'ASK_NAME':
            return `Etapa 1 de 8\n\n1. Qual e o seu nome?${buildCurrentValueHint(draft.name)}`;
        case 'ASK_JOB_TYPE':
            return `Etapa 2 de 8\n\n2. Em qual area voce quer trabalhar?\nEx: Desenvolvedor, Auxiliar administrativo, Vendedor...${buildCurrentValueHint(draft.jobType)}`;
        case 'ASK_SECONDARY_JOB_TYPES':
            return `Etapa 3 de 8\n\n3. Voce aceita outros cargos alem do principal? (opcional)\nEx: Estagio, Suporte tecnico, Recepcionista\n\nSe preferir, digite PULAR.${buildCurrentValueHint(Array.isArray(draft.secondaryJobTypes) ? draft.secondaryJobTypes.join(', ') : '')}`;
        case 'ASK_CITY':
            return `Etapa 4 de 8\n\n4. Em qual cidade voce quer trabalhar?${buildCurrentValueHint(draft.city)}`;
        case 'ASK_STATE':
            return `Etapa 5 de 8\n\n5. Qual e o seu estado?\nEx: RO, SP, MG${buildCurrentValueHint(draft.state)}`;
        case 'ASK_WORK_MODEL':
            return `Etapa 6 de 8\n\n6. Qual tipo de trabalho voce prefere?\n1. Presencial\n2. Remoto\n3. Hibrido\n4. Tanto faz\n\nVoce pode responder com numeros. Ex: 2 ou 1 e 3.${buildCurrentValueHint(formatWorkModelsForDisplay(draft.workModels))}`;
        case 'ASK_SENIORITY':
            return `Etapa 7 de 8\n\n7. Qual nivel de experiencia voce esta buscando?\n1. Primeiro emprego / Estagio\n2. Junior\n3. Pleno\n4. Senior\n5. Qualquer\n\nPode responder so com o numero.${buildCurrentValueHint(formatSeniority(draft.seniority))}`;
        case 'ASK_SALARY':
            return `Etapa 8 de 8\n\n8. Qual sua pretensao salarial? (opcional)\nSe preferir, pode digitar PULAR.${buildCurrentValueHint(draft.salaryExpectation)}`;
        case 'CONFIRM':
            return `Confira seu perfil antes de finalizar:\n\n${buildProfileSummary(draft)}\n\nEsta tudo certo?\n1. CONFIRMAR\n2. EDITAR`;
        default:
            return '';
    }
}

async function sendExistingProfileActionsPrompt(sock, jid, profile, step = '') {
    const summary = buildProfileSummary(profile);
    if (step === 'ASK_REFRESH_TODAY_JOBS') {
        return sendInteractiveButtonsMessage(sock, jid, {
            text: 'Encontrei vagas novas para hoje.',
            footer: 'Escolha uma opcao',
            buttons: [
                { id: 'ver vagas', text: 'Ver vagas' },
                { id: 'nao', text: 'Depois' }
            ],
            fallbackText: 'Encontrei vagas novas para hoje.\n\n1. VER VAGAS\n2. NAO'
        });
    }

    return sendInteractiveButtonsMessage(sock, jid, {
        text: `Este e o seu perfil atual:\n\n${summary}\n\nQuer atualizar alguma informacao do seu perfil?`,
        footer: 'Escolha uma opcao',
        buttons: [
            { id: 'editar', text: 'Editar' },
            { id: 'ver vagas', text: 'Ver vagas' },
            { id: 'ajustar filtros', text: 'Ajustar filtros' }
        ],
        fallbackText: `Este e o seu perfil atual:\n\n${summary}\n\n1. EDITAR\n2. VER VAGAS\n3. AJUSTAR FILTROS`
    });
}

async function sendWorkModelPrompt(sock, jid, draft) {
    return sendInteractiveListMessage(sock, jid, {
        title: 'Etapa 6 de 8',
        text: 'Qual tipo de trabalho voce prefere?',
        buttonText: 'Escolher modelo',
        footer: buildCurrentValueHint(formatWorkModelsForDisplay(draft.workModels)).replace(/^\n/, '') || 'Escolha uma opcao',
        sections: [
            {
                title: 'Modelos',
                rows: [
                    { id: 'presencial', title: 'Presencial', description: 'Vagas no local da empresa' },
                    { id: 'remoto', title: 'Remoto', description: 'Vagas home office' },
                    { id: 'hibrido', title: 'Hibrido', description: 'Parte presencial e parte remota' },
                    { id: 'tanto faz', title: 'Tanto faz', description: 'Aceito qualquer modelo' }
                ]
            }
        ],
        fallbackText: buildWizardStepPrompt('ASK_WORK_MODEL', draft)
    });
}

async function sendSeniorityPrompt(sock, jid, draft) {
    return sendInteractiveListMessage(sock, jid, {
        title: 'Etapa 7 de 8',
        text: 'Qual nivel de experiencia voce esta buscando?',
        buttonText: 'Escolher nivel',
        footer: buildCurrentValueHint(formatSeniority(draft.seniority)).replace(/^\n/, '') || 'Escolha uma opcao',
        sections: [
            {
                title: 'Niveis',
                rows: [
                    { id: 'estagio', title: 'Primeiro emprego / Estagio' },
                    { id: 'junior', title: 'Junior' },
                    { id: 'pleno', title: 'Pleno' },
                    { id: 'senior', title: 'Senior' },
                    { id: 'qualquer', title: 'Qualquer' }
                ]
            }
        ],
        fallbackText: buildWizardStepPrompt('ASK_SENIORITY', draft)
    });
}

async function sendConfirmProfilePrompt(sock, jid, draft) {
    return sendInteractiveButtonsMessage(sock, jid, {
        text: `Confira seu perfil antes de finalizar:\n\n${buildProfileSummary(draft)}\n\nEsta tudo certo?`,
        footer: 'Escolha uma opcao',
        buttons: [
            { id: 'confirmar', text: 'Confirmar' },
            { id: 'editar', text: 'Editar' }
        ],
        fallbackText: buildWizardStepPrompt('CONFIRM', draft)
    });
}

async function sendWizardPrompt(sock, jid, step, draft = {}) {
    if (step === 'ASK_WORK_MODEL') return sendWorkModelPrompt(sock, jid, draft);
    if (step === 'ASK_SENIORITY') return sendSeniorityPrompt(sock, jid, draft);
    if (step === 'CONFIRM') return sendConfirmProfilePrompt(sock, jid, draft);
    return sendSafeMessage(sock, jid, { text: buildWizardStepPrompt(step, draft) });
}

function getInitialDraftFromProfile(profile = null) {
    return {
        name: profile?.name || '',
        jobType: profile?.jobType || '',
        secondaryJobTypes: Array.isArray(profile?.secondaryJobTypes) ? profile.secondaryJobTypes : [],
        city: profile?.city || '',
        state: profile?.state || '',
        workModels: Array.isArray(profile?.workModels) ? profile.workModels : [],
        seniority: profile?.seniority || '',
        experiencePreference: inferExperiencePreferenceFromProfile(profile),
        salaryExpectation: profile?.salaryExpectation || '',
        keywords: Array.isArray(profile?.keywords) ? profile.keywords : []
    };
}

function formatDraftAsProfile(draft, jid, active = true, createdAt = null) {
    const inferredExperiencePreference = inferExperiencePreferenceFromProfile(draft);

    return {
        jid,
        name: draft.name,
        jobType: draft.jobType,
        secondaryJobTypes: Array.isArray(draft.secondaryJobTypes) ? draft.secondaryJobTypes : [],
        city: draft.city,
        state: draft.state,
        workModels: Array.isArray(draft.workModels) ? draft.workModels : [],
        seniority: draft.seniority || normalizeSeniority(draft.experiencePreference || ''),
        experiencePreference: inferredExperiencePreference,
        salaryExpectation: draft.salaryExpectation || '',
        keywords: Array.isArray(draft.keywords) ? draft.keywords : [],
        active,
        createdAt: createdAt || null
    };
}

function normalizeExternalProfilePayload(input = {}) {
    const payload = input && typeof input === 'object' ? input : {};
    const jid = normalizeExternalJid(
        payload.jid
        || payload.whatsappJid
        || payload.whatsapp_jid
        || payload.phoneJid
        || payload.phone_jid
        || payload.phone
        || payload.telefone
        || payload.whatsapp
        || payload.wa_id
        || payload.userId
        || payload.user_id
    );

    const secondaryJobTypesValue =
        payload.secondaryJobTypes
        ?? payload.secondary_job_types
        ?? payload.secondaryRoles
        ?? payload.secondary_roles
        ?? payload.cargosSecundarios
        ?? payload.cargos_secundarios
        ?? [];

    const workModelsValue =
        payload.workModels
        ?? payload.work_models
        ?? payload.workModel
        ?? payload.work_model
        ?? payload.modalidade
        ?? payload.modalidades
        ?? [];

    const keywordsValue =
        payload.keywords
        ?? payload.palavrasChave
        ?? payload.palavras_chave
        ?? [];

    const secondaryJobTypes = Array.isArray(secondaryJobTypesValue)
        ? secondaryJobTypesValue.map((item) => normalizeSpace(item)).filter(Boolean)
        : splitProfileJobInterests(String(secondaryJobTypesValue || ''));

    const workModels = Array.isArray(workModelsValue)
        ? workModelsValue.map((item) => normalizeIntentText(item)).filter(Boolean)
        : normalizeWorkModels(String(workModelsValue || ''));

    const keywords = Array.isArray(keywordsValue)
        ? keywordsValue.map((item) => normalizeSpace(item)).filter(Boolean)
        : splitProfileJobInterests(String(keywordsValue || ''));

    const draft = {
        name: normalizeSpace(payload.name || payload.nome || ''),
        jobType: normalizeSpace(payload.jobType || payload.job_type || payload.role || payload.cargo || ''),
        secondaryJobTypes,
        city: normalizeSpace(payload.city || payload.cidade || ''),
        state: normalizeStateText(payload.state || payload.uf || payload.estado || ''),
        workModels,
        experiencePreference: normalizeExperiencePreference(
            payload.experiencePreference
            || payload.experience_preference
            || payload.seniority
            || payload.senioridade
            || payload.experience
            || payload.experiencia
            || '4'
        ),
        salaryExpectation: parseOptionalValue(
            payload.salaryExpectation
            || payload.salary_expectation
            || payload.salary
            || payload.pretensaoSalarial
            || payload.pretensao_salarial
            || ''
        ),
        keywords
    };

    return {
        jid,
        active: payload.active !== false,
        createdAt: payload.createdAt || payload.created_at || null,
        draft
    };
}

export async function syncExternalPrivateJobProfile(input = {}) {
    const normalized = normalizeExternalProfilePayload(input);
    if (!normalized.jid) {
        throw new Error('Perfil de vagas sem jid/telefone valido.');
    }

    if (!normalized.draft.jobType) {
        throw new Error('Perfil de vagas sem cargo principal.');
    }

    const state = loadState();
    await hydrateStateForJid(state, normalized.jid);
    const existing = getProfile(state, normalized.jid);
    const nextProfile = formatDraftAsProfile(
        {
            ...getInitialDraftFromProfile(existing),
            ...normalized.draft
        },
        normalized.jid,
        normalized.active,
        existing?.createdAt || normalized.createdAt || null
    );
    nextProfile.updatedAt = new Date().toISOString();

    const savedProfile = await persistProfileState(state, normalized.jid, nextProfile);
    logger.info('private_job_profile_synced_external', {
        jid: normalized.jid,
        active: savedProfile?.active !== false,
        jobType: savedProfile?.jobType || '',
        city: savedProfile?.city || '',
        state: savedProfile?.state || '',
        source: String(input?.source || 'external-sync')
    });

    return savedProfile;
}

async function startProfileWizard(sock, jid, state, profile = null) {
    const draft = getInitialDraftFromProfile(profile);
    await persistConversationState(state, jid, {
        flow: 'profile_wizard',
        step: 'ASK_NAME',
        draft,
        existingCreatedAt: profile?.createdAt || null,
        existingActive: profile?.active !== false
    });
    await sendSafeMessage(sock, jid, {
        text: profile
            ? 'Vamos atualizar seu perfil rapidinho 🚀\nLeva menos de 1 minuto.\n\n' + buildWizardStepPrompt('ASK_NAME', draft)
            : 'Perfeito! Vamos montar seu perfil rapidinho 🚀\nLeva menos de 1 minuto 😉\n\n' + buildWizardStepPrompt('ASK_NAME', draft)
    });
}

async function sendCurrentOrAskOldJobs(sock, jid, state, profile, options = {}) {
    const subscriptionState = await hydrateSubscriptionState(state, jid);
    const preparedJobs = await collectPreparedJobs();
    const freshJobs = await rankJobsForProfile(preparedJobs, profile, {
        excludeUrls: getTrackedSentUrls(subscriptionState),
        logContext: { jid, mode: 'on_demand_fresh' }
    });

    if (freshJobs.length) {
        const jobsToSend = freshJobs.slice(0, options.limit || MAX_PRIVATE_JOBS_PER_RUN);
        const sentCount = await sendJobsList(sock, jid, jobsToSend, subscriptionState, 'private_job_alert_sent_on_demand');
        await persistSubscriptionState(state, jid);
        return { handled: true, sentCount };
    }

    await persistConversationState(state, jid, {
        flow: 'existing_profile_actions',
        step: 'ASK_OLD_JOBS'
    });
    await sendInteractiveButtonsMessage(sock, jid, {
        text: `Seu perfil atual:\n\n${buildProfileSummary(profile)}\n\nNao encontrei vagas novas compativeis agora.\nQuer ver vagas antigas compativeis?`,
        footer: 'Escolha uma opcao',
        buttons: [
            { id: 'sim', text: 'Ver antigas' },
            { id: 'nao', text: 'Agora nao' }
        ],
        fallbackText: `Seu perfil atual:\n\n${buildProfileSummary(profile)}\n\nNao encontrei vagas novas compativeis agora.\nQuer ver vagas antigas compativeis? Responda SIM ou NAO.`
    });
    return { handled: true, sentCount: 0 };
}

async function sendOldMatchingJobs(sock, jid, state, profile, options = {}) {
    const subscriptionState = await hydrateSubscriptionState(state, jid);
    const historicalJobs = getTrackedSentJobs(subscriptionState);
    let oldJobs = [];
    const replayedHistoryUrls = new Set(getHistoricalReplayUrls(subscriptionState));
    const limit = Math.max(1, Number(options.limit || MAX_PRIVATE_JOBS_PER_RUN));

    if (historicalJobs.length) {
        oldJobs = (await rankJobsForProfile(historicalJobs, profile, {
            includeSent: true,
            logContext: { jid, mode: 'on_demand_old_history' }
        }))
            .filter((job) => options.includeReplayed === true || !replayedHistoryUrls.has(normalizeUrl(job.url)))
            .slice(0, limit);
    }

    if (!oldJobs.length) {
        if (historicalJobs.length) {
            await sendInteractiveButtonsMessage(sock, jid, {
                text: 'Perfil ativado com sucesso!\n\nAgora voce vai receber vagas compativeis com seu perfil diariamente.\n\nJa encontrei novas vagas para voce hoje.',
                footer: 'Escolha uma opcao',
                buttons: [
                    { id: 'ver vagas', text: 'Ver vagas' },
                    { id: 'ajustar filtros', text: 'Ajustar filtros' }
                ],
                fallbackText: 'Perfil ativado com sucesso!\n\nAgora voce vai receber vagas compativeis com seu perfil diariamente.\n\nJa encontrei novas vagas para voce hoje.\n\nDigite VER VAGAS para ver agora\nOu AJUSTAR FILTROS para refinar sua busca.'
            });
            await persistConversationState(state, jid, {
                flow: 'existing_profile_actions',
                step: 'ASK_REFRESH_TODAY_JOBS'
            });
            return { handled: true };

            await sendSafeMessage(sock, jid, {
                text: 'Nao encontrei mais vagas antigas compativeis no banco de dados. Quando surgirem vagas novas, eu te aviso aqui.'
            });
            return { handled: true, sentCount: 0 };
        }

        const preparedJobs = await collectPreparedJobs();
        oldJobs = (await rankJobsForProfile(preparedJobs, profile, {
            includeSent: true,
            logContext: { jid, mode: 'on_demand_old' }
        })).slice(0, limit);
    }

    if (!oldJobs.length) {
        await sendExistingProfileActionsPrompt(sock, jid, profile, conversation.step);
        return { handled: true };

        await sendSafeMessage(sock, jid, {
            text: 'Nao encontrei vagas antigas compativeis com seu perfil no momento.'
        });
        return { handled: true, sentCount: 0 };
    }

    const sentCount = await sendJobsList(sock, jid, oldJobs, subscriptionState, 'private_job_alert_sent_old', {
        delayMs: options.delayMs || 1200
    });
    if (historicalJobs.length && sentCount > 0) {
        setHistoricalReplayUrls(subscriptionState, oldJobs.map((job) => normalizeUrl(job.url)));
    }
    await persistSubscriptionState(state, jid);
    return { handled: true, sentCount };
}

async function refreshTodayGeneralJobs(sock, jid, state, limit = 3) {
    const subscriptionState = await hydrateSubscriptionState(state, jid);
    const preparedJobs = await collectPreparedJobs();
    const unseenGeneralJobs = (Array.isArray(preparedJobs) ? preparedJobs : [])
        .filter((job) => !getTrackedSentUrls(subscriptionState).includes(normalizeUrl(job.url)));
    const jobsToSend = unseenGeneralJobs.slice(0, Math.max(1, limit));

    if (!jobsToSend.length) {
        await sendSafeMessage(sock, jid, {
            text: 'Hoje ainda nao encontrei novas vagas gerais para atualizar.'
        });
        return { handled: true, sentCount: 0 };
    }

    const sentCount = await sendJobsList(sock, jid, jobsToSend, subscriptionState, 'private_job_alert_sent_top_general');
    await persistSubscriptionState(state, jid);
    return { handled: true, sentCount };
}

async function handleProfileConversation(sock, jid, text, state) {
    const conversation = getConversation(state, jid);
    if (!conversation) return { handled: false };

    const normalized = normalizeIntentText(text);
    if (normalizePrivateProfileCommand(text) === 'cancel') {
        await clearConversationState(state, jid);
        await sendSafeMessage(sock, jid, { text: 'Fluxo cancelado.' });
        return { handled: true };
    }

    if (conversation.flow === 'profile_refresh_campaign') {
        const existing = getProfile(state, jid);
        if (!existing) {
            await clearConversationState(state, jid);
            return { handled: false };
        }

        if (conversation.step === 'ASK_JOB_TYPE') {
            const normalizedJobType = normalizeSpace(text);
            if (!isValidPrimaryJobType(normalizedJobType) || isTooBroadPrimaryJobType(normalizedJobType)) {
                await sendSafeMessage(sock, jid, {
                    text: 'Para melhorar a precisao das vagas, me responda com um cargo mais especifico. Ex.: auxiliar administrativo, auxiliar de estoque, recepcionista, vendedor, jovem aprendiz ou estagio.'
                });
                return { handled: true };
            }

            const nextProfile = {
                ...existing,
                jobType: normalizedJobType,
                secondaryJobTypes: [],
                updatedAt: new Date().toISOString()
            };
            await persistProfileState(state, jid, nextProfile);
            await persistConversationState(state, jid, {
                flow: 'profile_refresh_campaign',
                step: 'ASK_OLD_JOBS'
            });
            await sendSafeMessage(sock, jid, {
                text: `Perfeito. Atualizei seu cargo preferido para: ${normalizedJobType}.\n\nQuer ver vagas ja registradas no banco de dados e que o bot ja viu antes? Responda SIM ou NAO.`
            });
            return { handled: true };
        }

        if (conversation.step === 'ASK_OLD_JOBS' && /\b(sim|quero|mostrar|ver)\b/.test(normalized)) {
            await clearConversationState(state, jid);
            return sendOldMatchingJobs(sock, jid, state, existing, {
                limit: PROFILE_REFRESH_OLD_JOBS_LIMIT,
                delayMs: 1200
            });
        }

        if (conversation.step === 'ASK_OLD_JOBS' && /\b(nao|não)\b/.test(normalized)) {
            await clearConversationState(state, jid);
            await sendSafeMessage(sock, jid, {
                text: 'Certo. Seu perfil foi atualizado e daqui pra frente eu vou priorizar vagas mais proximas do cargo que voce informou.'
            });
            return { handled: true };
        }

        await sendSafeMessage(sock, jid, {
            text: conversation.step === 'ASK_REFRESH_TODAY_JOBS'
                ? 'Encontrei vagas novas para hoje.\n\n1. VER VAGAS\n2. NAO'
                : `👤 Este e o seu perfil atual:\n\n${buildProfileSummary(profile)}\n\n1. EDITAR\n2. VER VAGAS\n3. AJUSTAR FILTROS`
        });
        return { handled: true };

        await sendSafeMessage(sock, jid, {
            text: conversation.step === 'ASK_OLD_JOBS'
                ? 'Quer ver vagas ja registradas no banco de dados e que o bot ja viu antes? Responda SIM ou NAO.'
                : 'Me responda com apenas 1 cargo que voce prefere receber agora.'
        });
        return { handled: true };
    }

    if (conversation.flow === 'existing_profile_actions') {
        const profile = getProfile(state, jid);
        if (!profile) {
            await clearConversationState(state, jid);
            return { handled: false };
        }

        const existingAction = parseExistingProfileAction(text, conversation.step);

        if (existingAction === 'edit') {
            await clearConversationState(state, jid);
            await startProfileWizard(sock, jid, state, profile);
            return { handled: true };
        }

        if (existingAction === 'show_jobs') {
            await clearConversationState(state, jid);
            return sendCurrentOrAskOldJobs(sock, jid, state, profile);
        }

        if (existingAction === 'old_jobs') {
            await clearConversationState(state, jid);
            return sendOldMatchingJobs(sock, jid, state, profile);
        }

        if (existingAction === 'refresh_jobs' && conversation.step === 'ASK_REFRESH_TODAY_JOBS') {
            await clearConversationState(state, jid);
            return refreshTodayGeneralJobs(sock, jid, state, 3);
        }

        if (existingAction === 'no') {
            await clearConversationState(state, jid);
            await sendSafeMessage(sock, jid, { text: 'Certo. Quando surgirem vagas novas compativeis, eu te aviso aqui.' });
            return { handled: true };
        }

        if (/\b(nao|não)\b/.test(normalized)) {
            await clearConversationState(state, jid);
            await sendSafeMessage(sock, jid, { text: 'Certo. Quando surgirem vagas novas compativeis, eu te aviso aqui.' });
            return { handled: true };
        }

        await sendSafeMessage(sock, jid, {
            text: conversation.step === 'ASK_REFRESH_TODAY_JOBS'
                ? 'Encontrei vagas novas para hoje.\n\nDigite VER VAGAS para ver agora\nOu NAO para deixar para depois.'
                : `👤 Este e o seu perfil atual:\n\n${buildProfileSummary(profile)}\n\n✏️ Digite EDITAR para alterar\n🔎 Ou digite VER VAGAS para ver oportunidades agora`
        });
        return { handled: true };
    }

    if (conversation.flow !== 'profile_wizard') return { handled: false };

    const draft = { ...(conversation.draft || {}) };
    if (conversation.step === 'ASK_NAME') {
        if (!isKeepCurrentIntent(text) || !draft.name) {
            draft.name = normalizeSpace(text);
        }
        conversation.step = 'ASK_JOB_TYPE';
    } else if (conversation.step === 'ASK_JOB_TYPE') {
        if (isKeepCurrentIntent(text) && draft.jobType) {
            conversation.step = 'ASK_SECONDARY_JOB_TYPES';
            conversation.draft = draft;
            await persistConversationState(state, jid, conversation);
            await sendWizardPrompt(sock, jid, conversation.step, draft);
            return { handled: true };
        }
        const normalizedJobType = normalizeSpace(text);
        if (!isValidPrimaryJobType(normalizedJobType) || isTooBroadPrimaryJobType(normalizedJobType)) {
            await sendSafeMessage(sock, jid, {
                text: 'Seu cargo principal ficou amplo demais. Me diga um cargo mais especifico, como: auxiliar administrativo, auxiliar de estoque, vendedor, recepcionista ou jovem aprendiz.'
            });
            await sendWizardPrompt(sock, jid, 'ASK_JOB_TYPE', draft);
            return { handled: true };
        }
        draft.jobType = normalizedJobType;
        conversation.step = 'ASK_SECONDARY_JOB_TYPES';
    } else if (conversation.step === 'ASK_SECONDARY_JOB_TYPES') {
        if (isKeepCurrentIntent(text) && Array.isArray(draft.secondaryJobTypes) && draft.secondaryJobTypes.length) {
            conversation.step = 'ASK_CITY';
            conversation.draft = draft;
            await persistConversationState(state, jid, conversation);
            await sendWizardPrompt(sock, jid, conversation.step, draft);
            return { handled: true };
        }
        draft.secondaryJobTypes = parseOptionalValue(text)
            ? splitProfileJobInterests(text)
            : [];
        conversation.step = 'ASK_CITY';
    } else if (conversation.step === 'ASK_CITY') {
        if (!isKeepCurrentIntent(text) || !draft.city) {
            draft.city = normalizeSpace(text);
        }
        conversation.step = 'ASK_STATE';
    } else if (conversation.step === 'ASK_STATE') {
        if (!isKeepCurrentIntent(text) || !draft.state) {
            draft.state = normalizeStateText(text);
        }
        conversation.step = 'ASK_WORK_MODEL';
    } else if (conversation.step === 'ASK_WORK_MODEL') {
        if (isKeepCurrentIntent(text) && Array.isArray(draft.workModels) && draft.workModels.length) {
            conversation.step = 'ASK_SENIORITY';
            conversation.draft = draft;
            await persistConversationState(state, jid, conversation);
            await sendWizardPrompt(sock, jid, conversation.step, draft);
            return { handled: true };
        }
        const parsedWorkModels = parseWorkModelAnswer(text);
        if (!parsedWorkModels) {
            await sendSafeMessage(sock, jid, {
                text: 'Para eu entender certinho, responda com uma destas opcoes:\n1. Presencial\n2. Remoto\n3. Hibrido\n4. Tanto faz'
            });
            await sendWizardPrompt(sock, jid, 'ASK_WORK_MODEL', draft);
            return { handled: true };
        }
        draft.workModels = parsedWorkModels;
        conversation.step = 'ASK_SENIORITY';
    } else if (conversation.step === 'ASK_SENIORITY') {
        if (isKeepCurrentIntent(text) && draft.seniority) {
            conversation.step = 'ASK_SALARY';
            conversation.draft = draft;
            await persistConversationState(state, jid, conversation);
            await sendWizardPrompt(sock, jid, conversation.step, draft);
            return { handled: true };
        }
        const parsedSeniority = parseSeniorityAnswer(text);
        if (!parsedSeniority) {
            await sendSafeMessage(sock, jid, {
                text: 'Me responda com uma opcao clara:\n1. Primeiro emprego / Estagio\n2. Junior\n3. Pleno\n4. Senior\n5. Qualquer'
            });
            await sendWizardPrompt(sock, jid, 'ASK_SENIORITY', draft);
            return { handled: true };
        }
        draft.seniority = parsedSeniority;
        draft.experiencePreference = normalizeExperiencePreference(parsedSeniority);
        conversation.step = 'ASK_SALARY';
    } else if (conversation.step === 'ASK_SALARY') {
        if (!isKeepCurrentIntent(text) || !draft.salaryExpectation) {
            draft.salaryExpectation = parseOptionalValue(text);
        }
        conversation.step = 'CONFIRM';
    } else if (conversation.step === 'CONFIRM') {
        if (/\b(confirmar|confirmo|sim|ok)\b/.test(normalized) || parseSingleChoiceNumber(text, { '1': 'confirm' }) === 'confirm') {
            const existing = getProfile(state, jid);
            const nextProfile = formatDraftAsProfile(
                draft,
                jid,
                conversation.existingActive !== false,
                existing?.createdAt || conversation.existingCreatedAt || null
            );
            await persistProfileState(state, jid, nextProfile);
            await sendSafeMessage(sock, jid, {
                text: '🎉 Perfil ativado com sucesso!\n\nAgora voce vai receber vagas compativeis com seu perfil diariamente 🚀\n\nJa encontrei novas vagas para voce hoje.\n\nDigite VER VAGAS para ver agora\nOu AJUSTAR FILTROS para refinar sua busca.'
            });
            await persistConversationState(state, jid, {
                flow: 'existing_profile_actions',
                step: 'ASK_REFRESH_TODAY_JOBS'
            });
            return { handled: true };
        }

        if (/\b(editar|nao|não)\b/.test(normalized)) {
            conversation.step = 'ASK_NAME';
            conversation.draft = draft;
            await persistConversationState(state, jid, conversation);
            await sendSafeMessage(sock, jid, {
                text: 'Vamos editar do começo.\n\n' + buildWizardStepPrompt('ASK_NAME')
            });
            return { handled: true };
        }
    }

    conversation.draft = draft;
    await persistConversationState(state, jid, conversation);
    await sendWizardPrompt(sock, jid, conversation.step, draft);
    return { handled: true };
}

export function isFacebookJobLinkRequest(text) {
    const url = extractFacebookUrl(text);
    return looksLikeFacebookPostUrl(url);
}

export async function handleFacebookJobLinkRequest(sock, jid, text) {
    const safeJid = String(jid || '').trim();
    const url = extractFacebookUrl(text);
    if (!safeJid || !looksLikeFacebookPostUrl(url)) return { handled: false };

    try {
        const html = await fetchHtml(url);
        const job = buildFacebookJobFromHtml(html, url);
        if (!job) {
            await sendSafeMessage(sock, safeJid, {
                text: 'Nao consegui extrair uma vaga valida desse link publico do Facebook. Envie o link direto do post publico.'
            });
            return { handled: true, sent: false };
        }

        await sendSafeMessage(sock, safeJid, buildJobPayload(job));
        logger.info('private_facebook_job_link_processed', {
            jid: safeJid,
            url: job.url,
            title: job.title
        });
        return { handled: true, sent: true };
    } catch (error) {
        logger.warn('private_facebook_job_link_failed', {
            jid: safeJid,
            url,
            error: error?.message || String(error)
        });
        await sendSafeMessage(sock, safeJid, {
            text: 'Nao consegui acessar esse link do Facebook agora. Envie o link direto do post publico e tente novamente.'
        });
        return { handled: true, sent: false };
    }
}

export function isManualPrivateJobRequest(text) {
    const normalized = normalizeIntentText(text);
    if (!normalized) return false;
    if (normalizePrivateProfileCommand(text)) return true;
    if (isStartProfileIntent(text)) return true;
    return isMoreJobsIntent(text);
}

export function hasPendingPrivateJobConversation(jid) {
    const state = loadState();
    return Boolean(getConversation(state, jid));
}

export async function sendPrivateJobsOnDemand(sock, jid, options = {}) {
    const safeJid = String(jid || '').trim();
    if (!safeJid) return { handled: false, sentCount: 0 };

    const state = loadState();
    await hydrateActiveProfiles(state);
    await hydrateStateForJid(state, safeJid);
    const profile = getProfile(state, safeJid);
    const conversation = getConversation(state, safeJid);
    const text = String(options.text || '').trim();
    const command = normalizePrivateProfileCommand(text);

    if (conversation) {
        return handleProfileConversation(sock, safeJid, text, state);
    }

    if (command === 'profile_show') {
        if (!profile) {
            await sendSafeMessage(sock, safeJid, { text: 'Voce ainda nao tem perfil salvo. Digite "quero receber vagas" para montar seu perfil.' });
            return { handled: true, sentCount: 0 };
        }
        await sendSafeMessage(sock, safeJid, { text: `👤 Este e o seu perfil atual:\n\n${buildProfileSummary(profile)}` });
        return { handled: true, sentCount: 0 };
    }

    if (command === 'profile_edit') {
        await startProfileWizard(sock, safeJid, state, profile);
        return { handled: true, sentCount: 0 };
    }

    if (command === 'show_jobs' && profile) {
        return sendCurrentOrAskOldJobs(sock, safeJid, state, profile);
    }

    if (command === 'profile_pause') {
        if (!profile) {
            await sendSafeMessage(sock, safeJid, { text: 'Voce ainda nao tem perfil salvo.' });
            return { handled: true, sentCount: 0 };
        }
        await persistProfileState(state, safeJid, { ...profile, active: false });
        await sendSafeMessage(sock, safeJid, { text: 'Envio de vagas pausado para o seu perfil.' });
        return { handled: true, sentCount: 0 };
    }

    if (command === 'profile_resume') {
        if (!profile) {
            await sendSafeMessage(sock, safeJid, { text: 'Voce ainda nao tem perfil salvo. Digite "quero receber vagas" para montar seu perfil.' });
            return { handled: true, sentCount: 0 };
        }
        await persistProfileState(state, safeJid, { ...profile, active: true });
        await sendSafeMessage(sock, safeJid, { text: 'Envio de vagas reativado.' });
        return { handled: true, sentCount: 0 };
    }

    if (isStartProfileIntent(text)) {
        if (profile) {
            await persistConversationState(state, safeJid, {
                flow: 'existing_profile_actions',
                step: 'ASK_OLD_JOBS'
            });
            await sendExistingProfileActionsPrompt(sock, safeJid, profile, 'ASK_OLD_JOBS');
            return { handled: true, sentCount: 0 };

            await sendSafeMessage(sock, safeJid, {
                text: `👤 Este e o seu perfil atual:\n\n${buildProfileSummary(profile)}\n\nQuer atualizar alguma informacao do seu perfil?\n✏️ Digite EDITAR para alterar\n🔎 Ou digite VER VAGAS para ver oportunidades agora`
            });
            return { handled: true, sentCount: 0 };
        }

        await startProfileWizard(sock, safeJid, state, null);
        return { handled: true, sentCount: 0 };
    }

    if (!profile || !isMoreJobsIntent(text)) {
        return { handled: false, sentCount: 0 };
    }

    if (isHistoricalMoreJobsIntent(text)) {
        return sendOldMatchingJobs(sock, safeJid, state, profile, {
            limit: PROFILE_REFRESH_OLD_JOBS_LIMIT,
            delayMs: 1200
        });
    }

    const subscriptionState = await hydrateSubscriptionState(state, safeJid);
    const limit = Math.max(1, Number.parseInt(options.limit || MAX_PRIVATE_JOBS_PER_RUN, 10) || MAX_PRIVATE_JOBS_PER_RUN);
    const preparedJobs = await collectPreparedJobs();
    const matchingJobs = await rankJobsForProfile(preparedJobs, profile, {
        excludeUrls: getTrackedSentUrls(subscriptionState),
        logContext: { jid: safeJid, mode: 'manual_request' }
    });

    if (!matchingJobs.length) {
        await persistConversationState(state, safeJid, {
            flow: 'existing_profile_actions',
            step: 'ASK_OLD_JOBS'
        });
        subscriptionState.lastRunAt = new Date().toISOString();
        await persistSubscriptionState(state, safeJid);
        await sendInteractiveButtonsMessage(sock, safeJid, {
            text: `Este e o seu perfil atual:\n\n${buildProfileSummary(profile)}\n\nNao encontrei vagas novas compativeis agora.`,
            footer: 'Escolha uma opcao',
            buttons: [
                { id: 'sim', text: 'Ver antigas' },
                { id: 'editar', text: 'Editar perfil' }
            ],
            fallbackText: `Este e o seu perfil atual:\n\n${buildProfileSummary(profile)}\n\nNao encontrei vagas novas compativeis agora.\n\nDigite VER VAGAS para procurar oportunidades antigas compativeis\nOu EDITAR para ajustar seu perfil.`
        });
        return { handled: true, sentCount: 0 };

        await sendSafeMessage(sock, safeJid, {
            text: `👤 Este e o seu perfil atual:\n\n${buildProfileSummary(profile)}\n\nNao encontrei vagas novas compativeis agora.\n\nDigite VER VAGAS para procurar oportunidades antigas compativeis\nOu EDITAR para ajustar seu perfil.`
        });
        return { handled: true, sentCount: 0 };
    }

    const jobsToSend = matchingJobs.slice(0, limit);
    const sentCount = await sendJobsList(sock, safeJid, jobsToSend, subscriptionState, 'private_job_alert_sent_on_demand');
    await persistSubscriptionState(state, safeJid);
    return { handled: true, sentCount };
}

export async function sendHistoricalPrivateJobsForJid(sock, jid, options = {}) {
    const safeJid = String(jid || '').trim();
    if (!safeJid) return { handled: false, sentCount: 0 };

    const state = loadState();
    await hydrateStateForJid(state, safeJid);
    const profile = getProfile(state, safeJid);
    if (!profile) {
        return { handled: true, sentCount: 0, missingProfile: true };
    }

    return sendOldMatchingJobs(sock, safeJid, state, profile, {
        limit: options.limit || PROFILE_REFRESH_OLD_JOBS_LIMIT,
        delayMs: options.delayMs || 1200
    });
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

        const state = loadState();
        const legacySubscriptions = getActiveSubscriptions(config);
        const activeProfiles = await hydrateActiveProfiles(state);
        const cycleStats = {
            activeProfiles: activeProfiles.length,
            legacySubscriptions: legacySubscriptions.length,
            preparedJobs: 0,
            matchedProfiles: 0,
            deliveredJobs: 0,
            initializedProfiles: 0,
            reasons: {}
        };

        if (!legacySubscriptions.length && !activeProfiles.length) {
            logger.info('private_job_alerts_no_subscriptions');
            return;
        }

        const preparedJobs = await collectPreparedJobs();
        cycleStats.preparedJobs = preparedJobs.length;

        for (const profile of activeProfiles) {
            const subscriptionState = await hydrateSubscriptionState(state, profile.jid);
            const decisions = (Array.isArray(preparedJobs) ? preparedJobs : []).map((job) => ({ job, ...matchJobForProfile(job, profile) }));
            for (const decision of decisions) {
                cycleStats.reasons[decision.reason] = (cycleStats.reasons[decision.reason] || 0) + 1;
            }
            const matchingJobs = decisions
                .filter((item) => item.compatible)
                .sort((a, b) => {
                    const desiredExperience = inferExperiencePreferenceFromProfile(profile);
                    if (desiredExperience === 'entry' || desiredExperience === 'no_experience') {
                        const aExplicitEntry = isExplicitEntryLevelJob(a.job);
                        const bExplicitEntry = isExplicitEntryLevelJob(b.job);
                        if (aExplicitEntry !== bExplicitEntry) {
                            return bExplicitEntry ? 1 : -1;
                        }
                    }
                    return (b.job?.publishedAt || 0) - (a.job?.publishedAt || 0);
                })
                .map((item) => item.job)
                .filter((job) => !getTrackedSentUrls(subscriptionState).includes(normalizeUrl(job.url)));
            const urlsSnapshot = decisions
                .filter((item) => item.compatible)
                .map((item) => normalizeUrl(item.job.url));

            if (!subscriptionState.initialized) {
                cycleStats.initializedProfiles += 1;
                if (matchingJobs.length) {
                    cycleStats.matchedProfiles += 1;
                    cycleStats.deliveredJobs += await sendJobsList(sock, profile.jid, matchingJobs.slice(0, MAX_PRIVATE_JOBS_PER_RUN), subscriptionState, 'private_job_alert_sent');
                }
                markCurrentMatchesAsTracked(subscriptionState, urlsSnapshot);
                await persistSubscriptionState(state, profile.jid);
                continue;
            }

            if (!matchingJobs.length) {
                subscriptionState.lastRunAt = new Date().toISOString();
                await persistSubscriptionState(state, profile.jid);
                continue;
            }

            cycleStats.matchedProfiles += 1;
            cycleStats.deliveredJobs += await sendJobsList(sock, profile.jid, matchingJobs.slice(0, MAX_PRIVATE_JOBS_PER_RUN), subscriptionState, 'private_job_alert_sent');
            await persistSubscriptionState(state, profile.jid);
        }

        for (const subscription of legacySubscriptions) {
            const subscriptionState = await hydrateSubscriptionState(state, subscription.jid);
            const analyzedJobs = await collectPreparedLegacyJobs(subscriptionState);
            const urlsSnapshot = analyzedJobs.map((job) => normalizeUrl(job.url));

            if (!subscriptionState.initialized) {
                subscriptionState.initialized = true;
                setTrackedSentUrls(subscriptionState, urlsSnapshot);
                subscriptionState.lastRunAt = new Date().toISOString();
                await persistSubscriptionState(state, subscription.jid);
                continue;
            }

            if (!analyzedJobs.length) {
                subscriptionState.lastRunAt = new Date().toISOString();
                await persistSubscriptionState(state, subscription.jid);
                continue;
            }

            cycleStats.deliveredJobs += await sendJobsList(sock, subscription.jid, analyzedJobs.slice(0, MAX_PRIVATE_JOBS_PER_RUN), subscriptionState, 'private_job_alert_sent');
            await persistSubscriptionState(state, subscription.jid);
        }

        logger.info('private_job_alerts_cycle_summary', cycleStats);
    } catch (error) {
        logger.error('private_job_alerts_failed', {
            error: error?.message || String(error)
        });
    } finally {
        pollingInFlight = false;
    }
}

export async function dispatchPrivateJobAlertsForJobs(sock, preparedJobs, options = {}) {
    try {
        const config = loadConfig();
        if (config.enabled === false) {
            logger.info('private_job_alerts_inline_paused');
            return;
        }

        const jobs = Array.isArray(preparedJobs) ? preparedJobs : [];
        if (!jobs.length) return;

        const state = loadState();
        const activeProfiles = await hydrateActiveProfiles(state);
        const cycleStats = {
            mode: options.mode || 'inline_group_delivery',
            candidateJobs: jobs.length,
            activeProfiles: activeProfiles.length,
            matchedProfiles: 0,
            deliveredJobs: 0,
            reasons: {}
        };
        if (!activeProfiles.length) {
            logger.info('private_job_alerts_inline_no_profiles');
            return;
        }

        for (const profile of activeProfiles) {
            const subscriptionState = await hydrateSubscriptionState(state, profile.jid);
            const decisions = (Array.isArray(jobs) ? jobs : []).map((job) => ({ job, ...matchJobForProfile(job, profile) }));
            for (const decision of decisions) {
                cycleStats.reasons[decision.reason] = (cycleStats.reasons[decision.reason] || 0) + 1;
            }
            const matchingJobs = decisions
                .filter((item) => item.compatible)
                .map((item) => item.job)
                .filter((job) => !getTrackedSentUrls(subscriptionState).includes(normalizeUrl(job.url)));

            if (!matchingJobs.length) {
                subscriptionState.lastRunAt = new Date().toISOString();
                await persistSubscriptionState(state, profile.jid);
                continue;
            }

            cycleStats.matchedProfiles += 1;
            cycleStats.deliveredJobs += await sendJobsList(
                sock,
                profile.jid,
                matchingJobs.slice(0, options.limit || MAX_PRIVATE_JOBS_PER_RUN),
                subscriptionState,
                'private_job_alert_sent_inline'
            );
            await persistSubscriptionState(state, profile.jid);
        }
        logger.info('private_job_alerts_inline_summary', cycleStats);
    } catch (error) {
        logger.error('private_job_alerts_inline_failed', {
            error: error?.message || String(error)
        });
    }
}

export async function broadcastPrivateProfileRefresh(sock, options = {}) {
    const safeSock = sock || null;
    if (!safeSock) {
        throw new Error('Socket principal indisponivel.');
    }

    const state = loadState();
    const activeProfiles = await hydrateActiveProfiles(state);
    const recipients = activeProfiles
        .map((profile) => ({
            jid: String(profile?.jid || '').trim(),
            profile
        }))
        .filter((item) => item.jid);

    const batchSize = Math.max(1, Number(options.batchSize || PROFILE_REFRESH_BATCH_SIZE));
    const delayMs = Math.max(1_000, Number(options.delayMs || PROFILE_REFRESH_BATCH_DELAY_MS));
    const force = options.force === true;
    const batches = chunkItems(recipients, batchSize);
    let sent = 0;

    for (const [batchIndex, batch] of batches.entries()) {
        for (const item of batch) {
            const currentConversation = await hydrateConversation(state, item.jid);
            if (!force && currentConversation?.flow === 'profile_refresh_campaign') {
                continue;
            }

            await persistConversationState(state, item.jid, {
                flow: 'profile_refresh_campaign',
                step: 'ASK_JOB_TYPE',
                startedAt: new Date().toISOString()
            });

            const delivered = await sendSafeMessage(safeSock, item.jid, {
                text: buildProfileRefreshBroadcastMessage(item.profile)
            });

            if (delivered) {
                sent += 1;
                logger.info('private_job_profile_refresh_prompt_sent', {
                    jid: item.jid
                });
            }

            await new Promise((resolve) => setTimeout(resolve, 1200));
        }

        if (batchIndex < batches.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    return {
        ok: true,
        profiles: recipients.length,
        sent,
        batchSize,
        delayMs
    };
}

export async function sendPrivateProfileRefreshFollowUp(sock, jids = [], options = {}) {
    const safeSock = sock || null;
    if (!safeSock) {
        throw new Error('Socket principal indisponivel.');
    }

    const state = loadState();
    await hydrateActiveProfiles(state);
    const recipients = Array.from(new Set((Array.isArray(jids) ? jids : []).map((item) => String(item || '').trim()).filter(Boolean)));
    const force = options.force === true;
    let sent = 0;

    for (const jid of recipients) {
        await hydrateStateForJid(state, jid);
        const profile = getProfile(state, jid);
        if (!profile || profile.active === false) continue;

        const currentConversation = getConversation(state, jid);
        if (!force && currentConversation?.flow === 'profile_refresh_campaign' && currentConversation?.step === 'ASK_JOB_TYPE') {
            continue;
        }

        await persistConversationState(state, jid, {
            flow: 'profile_refresh_campaign',
            step: 'ASK_JOB_TYPE',
            startedAt: new Date().toISOString(),
            source: 'follow_up'
        });

        const delivered = await sendSafeMessage(safeSock, jid, {
            text: buildProfileRefreshFollowUpMessage(profile)
        });

        if (delivered) {
            sent += 1;
            logger.info('private_job_profile_refresh_followup_sent', { jid });
        }

        await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    return {
        ok: true,
        sent,
        recipients: recipients.length
    };
}

export async function notifyProfilesMoreJobsAvailable(sock, jids = []) {
    const safeSock = sock || null;
    if (!safeSock) {
        throw new Error('Socket principal indisponivel.');
    }

    const state = loadState();
    await hydrateActiveProfiles(state);
    const recipients = Array.from(new Set((Array.isArray(jids) ? jids : []).map((item) => String(item || '').trim()).filter(Boolean)));
    let sent = 0;

    for (const jid of recipients) {
        await hydrateStateForJid(state, jid);
        const profile = getProfile(state, jid);
        if (!profile || profile.active === false) continue;

        const delivered = await sendSafeMessage(safeSock, jid, {
            text: buildMoreHistoricalJobsNoticeMessage(profile)
        });
        if (delivered) {
            sent += 1;
            logger.info('private_job_more_jobs_notice_sent', { jid });
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    return {
        ok: true,
        sent,
        recipients: recipients.length
    };
}

export async function startPrivateJobAlerts(sock) {
    if (cronTask) return;

    const config = loadConfig();
    const state = loadState();
    const activeProfiles = await hydrateActiveProfiles(state);
    logger.info('private_job_alerts_started', {
        enabled: config.enabled !== false,
        cron: ALERT_CRON,
        timezone: ALERT_TIMEZONE,
        maxJobsPerRun: MAX_PRIVATE_JOBS_PER_RUN,
        targets: (config.subscriptions || []).map((item) => item.jid),
        profiles: activeProfiles.length
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

export function getPrivateJobAlertsStatus() {
    const config = loadConfig();
    const state = loadState();
    const activeProfiles = getActiveProfiles(state);
    const legacySubscriptions = getActiveSubscriptions(config);
    return {
        enabled: config.enabled !== false,
        cron: ALERT_CRON,
        timezone: ALERT_TIMEZONE,
        maxJobsPerRun: MAX_PRIVATE_JOBS_PER_RUN,
        activeProfiles: activeProfiles.length,
        legacySubscriptions: legacySubscriptions.length,
        profiles: activeProfiles.map((profile) => ({
            jid: profile.jid,
            jobType: profile.jobType || '',
            secondaryJobTypes: Array.isArray(profile.secondaryJobTypes) ? profile.secondaryJobTypes : [],
            city: profile.city || '',
            active: profile.active !== false
        })).slice(0, 15),
        lastRunAt: Object.values(state?.subscriptions || {})
            .map((item) => item?.lastRunAt || null)
            .filter(Boolean)
            .sort()
            .slice(-1)[0] || null
    };
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
