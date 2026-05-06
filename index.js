// index.js
import 'dotenv/config';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, WAMessageStubType, downloadMediaMessage } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, URL } from 'url';
import { sendSafeMessage } from './functions/messageHandler.js';
import { attachOutgoingGuard } from './functions/outgoingGuard.js';
import { checkViolation, notifyAdmins, addStrike, getStrikes, applyPunishment } from './functions/antiSpam.js';
import { handleWelcomeEvent } from './functions/welcomeMessage.js';
import { getGroupStatus } from './functions/groupStats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEBUG_MODE = String(process.env.IMAVY_DEBUG || 'false').toLowerCase() === 'true';
const debugLog = (...args) => {
    if (DEBUG_MODE) console.log(...args);
};

import { handleGroupMessages, initGroupResponderSchedulers, initLembretes, resetLembretesRuntime, hasPendingPrivateWizard, flushScheduledAutomationState, flushScheduledAutomationStateWithoutReminders } from './functions/groupResponder.js';
import { isAuthorized, getAllowedGroupPermissions, bindAllowedGroupId } from './functions/adminCommands.js';
import { getNumberFromJid, formatNumberInternational } from './functions/utils.js';
import { scheduleGroupMessages } from './functions/scheduler.js';
import { ensureCoreConfigFiles } from './functions/configBootstrap.js';
import { scheduleBackups } from './functions/backup.js';
import { logger } from './functions/logger.js';
import { startScheduler } from './functions/scheduler2.js';
import { detectClientInterest, sendAttendanceMessage, shouldSendAttendance, sendVerificationMessage, markAsVerified, isVerified, notifyAttendants } from './functions/autoAttendance.js';
import { getAdmins } from './functions/authManager.js';
import { scheduleSupabaseBackup } from './functions/supabaseBackup.js';
import { analyzeMessage, isAIEnabled } from './functions/aiModeration.js';
import { analyzeLeadIntent, isAISalesEnabled } from './functions/aiSales.js';
import { startAutoPromo } from './functions/autoPromo.js';
import { startNewsForwarder, stopNewsForwarder } from './functions/newsForwarder.js';
import { startJobForwarder, stopJobForwarder, collectJobs, buildJobPayload, sendJobToConfiguredTargets } from './functions/jobForwarder.js';
import { matchesConfiguredJobSourceChannel, registerIncomingJobChannelMessage } from './functions/jobChannelSource.js';
import { startPrivateJobAlerts, stopPrivateJobAlerts, broadcastPrivateProfileRefresh, sendPrivateProfileRefreshFollowUp, sendHistoricalPrivateJobsForJid, notifyProfilesMoreJobsAvailable, syncExternalPrivateJobProfile } from './functions/privateJobAlerts.js';
import { startJobTestPublisher, stopJobTestPublisher } from './functions/jobTestPublisher.js';
import { handleConnectionUpdate, resetReconnectAttempts } from './functions/connectionManager.js';
import { startHealthMonitor, startSessionBackup, setConnected, setHealthEscalationHandler, updateHeartbeat, restoreSessionFromBackup, clearSessionBackup } from './keepalive.js';
import { handleDevCommand, isDev, isDevModeActive, handleDevConversation, isJarvisAdmin } from './functions/devCommands.js';
import { handleCap } from './functions/custom/cap.js';
import { handleCurso } from './functions/custom/curso.js';
import { askChatGPT } from './functions/chatgpt.js';
import { isRestrictedGroupName } from './functions/groupPolicy.js';
import { publishRealtimeInteraction } from './functions/realtimeRankingStore.js';
import { startBuyAlertNotifier, stopBuyAlertNotifier, sendBuyAlertPayloadDirect, buildConfig, resolveBuyAlertGroups } from './functions/buyAlertNotifier.js';
import { startCryptoCacheWarmer, stopCryptoCacheWarmer } from './functions/crypto/cacheWarmer.js';
import { removeBrokenSessionFiles, sanitizeAuthStateDir } from './functions/waSessionHygiene.js';
import { createIntelEngine, getIntelEventBuffer, storeIntelEvent } from './src/intelligence/intelEngine.js';
import { createLeadEngine } from './src/intelligence/leadEngine.js';
import { trackGroupMessage, backfillRankingFromCurrentMonth } from './functions/groupRanking.js';
import { captureGroupKnowledge } from './functions/groupKnowledge.js';
import { isGroupBotPaused } from './functions/groupBotState.js';

console.log('[IA] Moderacao:', isAIEnabled() ? 'ATIVA (Groq)' : 'Desabilitada');
console.log('[IA] Vendas:', isAISalesEnabled() ? 'ATIVA (Groq)' : 'Desabilitada');

const DEFAULT_INTEL_GROUPS = [
    "120363394030123512@g.us",
    "120363418891665714@g.us"
];
const DEFAULT_FSX_OFFICIAL_SOURCE_GROUPS = [
    "120363418810171705@g.us"
];
const INTEL_GROUPS = String(process.env.INTEL_GROUPS || DEFAULT_INTEL_GROUPS.join(','))
    .split(',')
    .map((groupId) => groupId.trim())
    .filter(Boolean);
const FSX_OFFICIAL_SOURCE_GROUPS = new Set(
    String(process.env.FSX_OFFICIAL_SOURCE_GROUPS || DEFAULT_FSX_OFFICIAL_SOURCE_GROUPS.join(','))
        .split(',')
        .map((groupId) => groupId.trim())
        .filter(Boolean)
);
const INTEL_GROUP_NAMES = {
    "120363394030123512@g.us": "CriptoNoPix \u00E9 Vellora (1)",
    "120363418891665714@g.us": "CriptoNoPix \u00E9 Vellora (2)"
};
const INTEL_MONITORED_TOKENS = String(process.env.INTEL_MONITORED_TOKENS || 'NIX,SNAP')
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean);
const intelEngine = createIntelEngine({
    groupNames: INTEL_GROUP_NAMES,
    monitoredTokens: INTEL_MONITORED_TOKENS,
    trackedEmojis: ['🚀', '🔥', '💎']
});
const leadEngine = createLeadEngine({
    monitoredTokens: INTEL_MONITORED_TOKENS,
    trackedEmojis: ['🚀', '🔥', '💎']
});
const DASHBOARD_SYNC_SECRET = String(process.env.DASHBOARD_SYNC_SECRET || '').trim();
const DASHBOARD_SYNC_MAX_BODY_BYTES = Math.max(32 * 1024, parseInt(process.env.DASHBOARD_SYNC_MAX_BODY_BYTES || '262144', 10));
const BUY_ALERT_ENABLED = String(process.env.BUY_ALERT_ENABLED || 'false').trim().toLowerCase() === 'true';
const RUNTIME_FEATURE_KEYS = ['commandsEnabled', 'moderationEnabled', 'intelEnabled', 'leadsEnabled'];
const runtimeControlState = {
    features: {
        commandsEnabled: true,
        moderationEnabled: true,
        intelEnabled: true,
        leadsEnabled: true
    },
    updatedAt: Date.now(),
    source: 'default',
    lastEventId: null,
    lastAppliedTypes: []
};
const fsxOfficialRelayDedup = new Map();
const privateMessageDedup = new Map();
const FSX_OFFICIAL_RELAY_BOOT_GRACE_MS = 15_000;
const FSX_OFFICIAL_RELAY_MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;
const PRIVATE_MESSAGE_DEDUP_TTL_MS = 2 * 60 * 1000;

function cleanupPrivateMessageDedup(now = Date.now()) {
    for (const [key, ts] of privateMessageDedup.entries()) {
        if ((now - ts) > PRIVATE_MESSAGE_DEDUP_TTL_MS) {
            privateMessageDedup.delete(key);
        }
    }
}

function buildPrivateMessageDedupKey(message, text = '') {
    const chatId = String(message?.key?.remoteJid || '').trim();
    const senderId = String(resolveSenderIdFromMessage(message) || '').trim();
    const messageId = String(message?.key?.id || '').trim();
    if (chatId && messageId) {
        return `${chatId}:${messageId}`;
    }

    const safeText = String(text || '').trim().toLowerCase().slice(0, 160);
    const timestamp = Number(message?.messageTimestamp || 0);
    return `${chatId}:${senderId}:${timestamp}:${safeText}`;
}

function shouldSkipDuplicatePrivateMessage(message, text = '') {
    const key = buildPrivateMessageDedupKey(message, text);
    if (!key) return false;
    const now = Date.now();
    cleanupPrivateMessageDedup(now);
    if (privateMessageDedup.has(key)) {
        return true;
    }
    privateMessageDedup.set(key, now);
    return false;
}

function cleanupFsxOfficialRelayDedup(now = Date.now()) {
    for (const [key, ts] of fsxOfficialRelayDedup.entries()) {
        if ((now - ts) > 24 * 60 * 60 * 1000) {
            fsxOfficialRelayDedup.delete(key);
        }
    }
}

function looksLikeFsxOfficialPurchaseAlert(text) {
    const safe = String(text || '').trim().toLowerCase();
    if (!safe) return false;
    return safe.includes('fsx global presale')
        && safe.includes('new purchase')
        && safe.includes('token acquired')
        && safe.includes('amount received')
        && safe.includes('tx:');
}

function extractFsxOfficialAlertKey(messageText, message) {
    const safe = String(messageText || '');
    const txMatch = safe.match(/tx:\s*(0x[a-fA-F0-9]{64})/i);
    if (txMatch?.[1]) {
        return `tx:${txMatch[1].toLowerCase()}`;
    }
    return `msg:${String(message?.key?.id || '').trim()}`;
}

function normalizeFsxOfficialRelayText(messageText) {
    const stageText = String(process.env.FSX_PRESALE_STAGE_TEXT || 'Fase 7').trim() || 'Fase 7';
    const stageTextEn = stageText === 'Fase 7' ? 'Phase 7' : stageText;
    let text = String(messageText || '');
    text = text.replace(/Current Stage:[^\n]*/gi, (match) => {
        if (/Phase/i.test(match)) return `Current Stage: ${stageTextEn}`;
        return `Current Stage: ${stageText}`;
    });
    text = text.replace(/\bFase\s*\d+\b/gi, stageText);
    text = text.replace(/\bPhase\s*\d+\b/gi, stageTextEn);
    return text;
}

async function maybeRelayFsxOfficialPurchase(sock, message, unwrappedContent, messageText, options = {}) {
    const upsertType = String(options.upsertType || '').trim().toLowerCase();
    if (upsertType && upsertType !== 'notify') return false;
    if (Date.now() - botStartTime < FSX_OFFICIAL_RELAY_BOOT_GRACE_MS) return false;

    const chatId = String(message?.key?.remoteJid || '').trim();
    if (!FSX_OFFICIAL_SOURCE_GROUPS.has(chatId)) return false;
    if (!looksLikeFsxOfficialPurchaseAlert(messageText)) return false;

    const messageTimestampMs = Number(message?.messageTimestamp || 0) * 1000;
    if (Number.isFinite(messageTimestampMs) && messageTimestampMs > 0) {
        const ageMs = Date.now() - messageTimestampMs;
        if (ageMs > FSX_OFFICIAL_RELAY_MAX_MESSAGE_AGE_MS) {
            logger.info('FSX official relay ignorado por mensagem antiga.', {
                chatId,
                ageMinutes: Number((ageMs / 60_000).toFixed(3)),
                maxAgeMinutes: Number((FSX_OFFICIAL_RELAY_MAX_MESSAGE_AGE_MS / 60_000).toFixed(3))
            });
            return false;
        }
    }

    const dedupKey = extractFsxOfficialAlertKey(messageText, message);
    const now = Date.now();
    cleanupFsxOfficialRelayDedup(now);
    if (fsxOfficialRelayDedup.has(dedupKey)) {
        return true;
    }

    const normalizedRelayText = normalizeFsxOfficialRelayText(messageText).trim();
    let payload = { text: normalizedRelayText };
    const hasMedia = Boolean(unwrappedContent?.imageMessage || unwrappedContent?.videoMessage);

    if (hasMedia) {
        try {
            const media = typeof sock.downloadMediaMessage === 'function'
                ? await sock.downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage })
                : await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
            if (media && Buffer.isBuffer(media) && media.length > 0) {
                payload = {
                    image: media,
                    caption: normalizedRelayText
                };
            }
        } catch (error) {
            logger.warn('FSX official relay sem midia; fallback para texto.', {
                chatId,
                error: error?.message || String(error)
            });
        }
    }

    await sendBuyAlertPayloadDirect(sock, payload);
    fsxOfficialRelayDedup.set(dedupKey, now);
    logger.info('FSX official purchase relayed to buy alert groups', {
        chatId,
        dedupKey,
        withMedia: Boolean(payload?.image)
    });
    return true;
}

function hasDashboardWebhookConfigured() {
    return String(process.env.DASHBOARD_WEBHOOK_URL || '').trim() !== '';
}

function parseOptionalBoolean(value) {
    if (value === true || value === false) {
        return value;
    }

    if (typeof value === 'string') {
        const safe = value.trim().toLowerCase();
        if (safe === 'true') return true;
        if (safe === 'false') return false;
    }

    return undefined;
}

function getRuntimeFeaturesSnapshot() {
    return {
        commandsEnabled: runtimeControlState.features.commandsEnabled,
        moderationEnabled: runtimeControlState.features.moderationEnabled,
        intelEnabled: runtimeControlState.features.intelEnabled,
        leadsEnabled: runtimeControlState.features.leadsEnabled
    };
}

function applyRuntimeFeatureFlagsPatch(patch, source = 'dashboard-sync', eventId = null) {
    const safePatch = patch && typeof patch === 'object' ? patch : {};
    const updated = [];

    for (const key of RUNTIME_FEATURE_KEYS) {
        const parsed = parseOptionalBoolean(safePatch[key]);
        if (parsed === undefined) continue;
        if (runtimeControlState.features[key] !== parsed) {
            runtimeControlState.features[key] = parsed;
            updated.push(key);
        }
    }

    runtimeControlState.updatedAt = Date.now();
    runtimeControlState.source = source;
    runtimeControlState.lastEventId = eventId || runtimeControlState.lastEventId;

    return {
        updated,
        features: getRuntimeFeaturesSnapshot()
    };
}

function isDashboardSyncAuthorized(req) {
    const headerSecret = String(req.headers['x-dashboard-sync-key'] || '').trim();
    const authHeader = String(req.headers.authorization || '').trim();
    const bearerSecret = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : '';

    if (!DASHBOARD_SYNC_SECRET) {
        return false;
    }

    return headerSecret === DASHBOARD_SYNC_SECRET || bearerSecret === DASHBOARD_SYNC_SECRET;
}

function getPrivateJobProfileSyncSecret() {
    return String(process.env.PRIVATE_JOB_PROFILE_SYNC_SECRET || DASHBOARD_SYNC_SECRET || '').trim();
}

function isPrivateJobProfileSyncAuthorized(req) {
    const syncSecret = getPrivateJobProfileSyncSecret();
    if (!syncSecret) {
        return false;
    }

    const headerSecret = String(
        req.headers['x-private-job-sync-key']
        || req.headers['x-dashboard-sync-key']
        || ''
    ).trim();
    const authHeader = String(req.headers.authorization || '').trim();
    const bearerSecret = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : '';

    return headerSecret === syncSecret || bearerSecret === syncSecret;
}

async function startBootService(name, starter) {
    try {
        await starter();
        logger.info(`[BOOT] ${name} iniciado.`);
        return true;
    } catch (error) {
        const message = error?.message || String(error);
        console.error(`[BOOT] Falha ao iniciar ${name}:`, message);
        return false;
    }
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of req) {
        const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += bufferChunk.length;
        if (totalBytes > maxBytes) {
            throw new Error('Payload muito grande para /intel-event');
        }
        chunks.push(bufferChunk);
    }

    const body = Buffer.concat(chunks).toString('utf8');
    if (!body.trim()) {
        return {};
    }

    return JSON.parse(body);
}

// Servidor HTTP para Railway/Render
const PORT = process.env.PORT || 3000;
http.createServer(async (req, res) => {
    const requestUrl = req.url || '/';
    const parsedRequestUrl = new URL(requestUrl, `http://${req.headers.host || 'localhost'}`);
    const requestPath = parsedRequestUrl.pathname;

    if (requestPath === '/dashboard-sync') {
        await handleDashboardSyncEndpoint(req, res);
        return;
    }

    if (requestPath === '/private-job-profile-sync') {
        await handlePrivateJobProfileSyncEndpoint(req, res);
        return;
    }

    if (requestPath === '/internal/test-buy-alerts') {
        const remoteAddress = String(req.socket?.remoteAddress || '');
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Acesso permitido apenas localmente.' }));
            return;
        }

        try {
            const groupId = String(parsedRequestUrl.searchParams.get('groupId') || '').trim();
            const startIndex = Number(parsedRequestUrl.searchParams.get('start') || '0');
            const count = Number(parsedRequestUrl.searchParams.get('count') || '10');
            const delayMs = Number(parsedRequestUrl.searchParams.get('delayMs') || '2200');

            if (!groupId) {
                throw new Error('groupId obrigatorio.');
            }

            const result = await sendInternalTestBuyAlerts(groupId, { startIndex, count, delayMs });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: error.message || String(error) }));
        }
        return;
    }

    if (requestPath === '/internal/send-news-preview') {
        const remoteAddress = String(req.socket?.remoteAddress || '');
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Acesso permitido apenas localmente.' }));
            return;
        }

        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Metodo nao permitido.' }));
            return;
        }

        try {
            const payload = await readJsonBody(req, 256 * 1024);
            const groupId = String(payload?.groupId || '').trim();
            const delayMs = Number(payload?.delayMs || 3500);
            const items = Array.isArray(payload?.items) ? payload.items : [];

            if (!groupId) {
                throw new Error('groupId obrigatorio.');
            }

            const result = await sendInternalNewsPreview(groupId, items, { delayMs });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: error.message || String(error) }));
        }
        return;
    }

    if (requestPath === '/internal/test-fsx-cnp-alert') {
        const remoteAddress = String(req.socket?.remoteAddress || '');
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Acesso permitido apenas localmente.' }));
            return;
        }

        try {
            const groupId = String(parsedRequestUrl.searchParams.get('groupId') || '').trim();
            if (!groupId) {
                throw new Error('groupId obrigatorio.');
            }

            const symbol = String(parsedRequestUrl.searchParams.get('symbol') || 'SNAP').trim();
            const result = await sendInternalCriptoNoPixPreview(groupId, symbol);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: error.message || String(error) }));
        }
        return;
    }

if (requestPath === '/internal/broadcast-private-profile-refresh') {
        const remoteAddress = String(req.socket?.remoteAddress || '');
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Acesso permitido apenas localmente.' }));
            return;
        }
    }

    if (requestPath === '/api/cnp-purchase-alert') {
        const remoteAddress = String(req.socket?.remoteAddress || '');
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.0', '172.16.0.0', '192.168.0.0'].includes(remoteAddress) && !remoteAddress.startsWith('10.') && !remoteAddress.startsWith('172.') && !remoteAddress.startsWith('192.168')) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Acesso negado.' }));
            return;
        }

        try {
            const body = [];
            for await (const chunk of req) {
                body.push(chunk);
            }
            const payload = JSON.parse(Buffer.concat(body).toString());
            const result = await sendCnpSitePurchaseAlert(activeSock, payload);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: error.message || String(error) }));
        }
        return;
    }

    if (requestPath === '/internal/test-cnp-site-alert') {
        const remoteAddress = String(req.socket?.remoteAddress || '');
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Acesso permitido apenas localmente.' }));
            return;
        }

        try {
            const batchSize = Number(parsedRequestUrl.searchParams.get('batchSize') || '10');
            const delayMs = Number(parsedRequestUrl.searchParams.get('delayMs') || '30000');
            const force = String(parsedRequestUrl.searchParams.get('force') || '').trim().toLowerCase() === 'true';
            const result = await broadcastPrivateProfileRefresh(activeSock, { batchSize, delayMs, force });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: error.message || String(error) }));
        }
        return;
    }

    if (requestPath === '/internal/private-profile-refresh-followup') {
        const remoteAddress = String(req.socket?.remoteAddress || '');
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Acesso permitido apenas localmente.' }));
            return;
        }

        try {
            const jids = String(parsedRequestUrl.searchParams.get('jids') || '')
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean);
            const force = String(parsedRequestUrl.searchParams.get('force') || '').trim().toLowerCase() === 'true';
            const result = await sendPrivateProfileRefreshFollowUp(activeSock, jids, { force });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: error.message || String(error) }));
        }
        return;
    }

    if (requestPath === '/internal/private-old-jobs') {
        const remoteAddress = String(req.socket?.remoteAddress || '');
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Acesso permitido apenas localmente.' }));
            return;
        }

        try {
            const jid = String(parsedRequestUrl.searchParams.get('jid') || '').trim();
            const limit = Number(parsedRequestUrl.searchParams.get('limit') || '10');
            if (!jid) {
                throw new Error('jid obrigatorio.');
            }
            const result = await sendHistoricalPrivateJobsForJid(activeSock, jid, { limit, delayMs: 1200 });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, jid, ...result }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: error.message || String(error) }));
        }
        return;
    }

    if (requestPath === '/internal/private-more-jobs-notice') {
        const remoteAddress = String(req.socket?.remoteAddress || '');
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Acesso permitido apenas localmente.' }));
            return;
        }

        try {
            const jids = String(parsedRequestUrl.searchParams.get('jids') || '')
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean);
            const result = await notifyProfilesMoreJobsAvailable(activeSock, jids);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: error.message || String(error) }));
        }
        return;
    }

    if (requestPath === '/internal/backfill-march-jobs') {
        const remoteAddress = String(req.socket?.remoteAddress || '');
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Acesso permitido apenas localmente.' }));
            return;
        }

        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Metodo nao permitido.' }));
            return;
        }

        try {
            const payload = await readJsonBody(req, 32 * 1024);
            const delayMs = Number(payload?.delayMs || '180000');
            const includeUndated = payload?.includeUndated !== false;
            const result = await startMarchJobsBackfill({ delayMs, includeUndated });
            res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: error.message || String(error) }));
        }
        return;
    }

    if (requestPath === '/internal/backfill-march-jobs-status') {
        const remoteAddress = String(req.socket?.remoteAddress || '');
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Acesso permitido apenas localmente.' }));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...marchJobsBackfillStatus }));
        return;
    }

    if (requestPath === '/internal/resend-job-to-targets') {
        const remoteAddress = String(req.socket?.remoteAddress || '');
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Acesso permitido apenas localmente.' }));
            return;
        }

        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Metodo nao permitido.' }));
            return;
        }

        try {
            if (!activeSock) {
                throw new Error('Sessao principal do WhatsApp indisponivel no momento.');
            }

            const payload = await readJsonBody(req, 128 * 1024);
            const job = payload?.job && typeof payload.job === 'object' ? payload.job : null;
            const includeGroups = payload?.includeGroups !== false;
            const delayMs = Math.max(500, Number(payload?.delayMs || '1200'));

            if (!job?.title || !job?.url) {
                throw new Error('job.title e job.url sao obrigatorios.');
            }

            const result = await sendJobToConfiguredTargets(activeSock, job, { includeGroups, delayMs });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, result }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: error.message || String(error) }));
        }
        return;
    }

    if (!hasDashboardWebhookConfigured() && requestPath.startsWith('/intel-event')) {
        if (req.method === 'GET') {
            const payload = JSON.stringify({
                ok: true,
                bufferedEvents: getIntelEventBuffer()
            });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(payload);
            return;
        }

        if (req.method === 'POST') {
            try {
                const payload = await readJsonBody(req);
                const enriched = {
                    ...payload,
                    receivedAt: Date.now(),
                    source: payload.source || 'internal-intel-endpoint'
                };
                storeIntelEvent(enriched);
                console.log('INTEL EVENT RECEIVED (/intel-event):', enriched);
                res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: true }));
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: error.message }));
            }
            return;
        }

        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Metodo nao permitido.' }));
        return;
    }

    if (requestPath === '/qr' && qrCodeData) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#000"><img src="${qrCodeData}" style="max-width:90%;max-height:90%"></body></html>`);
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Bot WhatsApp iMavyAgent - Online\n\nAcesse /qr para ver o QR Code');
    }
}).listen(PORT, () => {
    console.log(`Servidor HTTP rodando na porta ${PORT}`);
});

// Variavel para armazenar o servidor HTTP temporario
let qrServer = null;
let qrCodeData = null;
let activeSock = null;
let startBotInFlight = false;
let pendingFullRestartTimer = null;
let marchJobsBackfillStatus = {
    running: false,
    startedAt: null,
    finishedAt: null,
    targetId: '',
    targetName: '',
    delayMs: 0,
    total: 0,
    sent: 0,
    failed: 0,
    includeUndated: true,
    errors: []
};

// Timestamp de inicializacao do bot para ignorar mensagens antigas
const botStartTime = Date.now();
const unauthorizedGroupNoticeCooldown = new Map();
const UNAUTHORIZED_GROUP_NOTICE_MS = parseInt(process.env.UNAUTHORIZED_GROUP_NOTICE_MS || '180000', 10);
const ALLOWED_GROUPS_CACHE_TTL_MS = Math.max(5_000, parseInt(process.env.ALLOWED_GROUPS_CACHE_TTL_MS || '15000', 10));
const featureDisabledNoticeCooldown = new Map();
const FEATURE_DISABLED_NOTICE_MS = Math.max(30_000, parseInt(process.env.FEATURE_DISABLED_NOTICE_MS || '120000', 10));

function buildTestBuyAlertsPayloads() {
    return [
        { title: '\uD83D\uDC0B WHALE ALERT | NIX', usd: '842.50', tokens: '132,845.10', wallet: '0xA1b2...9F01', count: 7, holderSince: '12/02/2026', tx: '0x1111111111111111111111111111111111111111111111111111111111111111', token: '0xbe96fcf736ad906b1821ef74a0e4e346c74e6221', chart: '0x7f01f344b1950a3c5ea3b9db7017f93ab0c8f88e' },
        { title: '\uD83C\uDD95 NOVO HOLDER | NIX', usd: '63.20', tokens: '9,874.44', wallet: '0xB2c3...8A12', count: 1, holderSince: '22/03/2026', tx: '0x2222222222222222222222222222222222222222222222222222222222222222', chart: '0x7f01f344b1950a3c5ea3b9db7017f93ab0c8f88e' },
        { title: '\uD83D\uDD01 COMPRANDO NOVAMENTE | SNAP', usd: '118.90', tokens: '24,115.77', wallet: '0xC3d4...7B23', count: 2, holderSince: '18/03/2026', tx: '0x3333333333333333333333333333333333333333333333333333333333333333', token: '0x3a9e15b28e099708d0812e0843a9ed70c508fb4b', chart: '0x7646c457a2c4d260f678f3126fa41e20bfdd1f95' },
        { title: '\uD83C\uDFE6 HOLDER ANTIGO | NIX', usd: '91.35', tokens: '14,901.08', wallet: '0xD4e5...6C34', count: 5, holderSince: '03/03/2026', tx: '0x4444444444444444444444444444444444444444444444444444444444444444', chart: '0x7f01f344b1950a3c5ea3b9db7017f93ab0c8f88e' },
        { title: '\uD83D\uDC0B BALEIA COMPRANDO NOVAMENTE | SNAP', usd: '1,204.11', tokens: '231,440.55', wallet: '0xE5f6...5D45', count: 9, holderSince: '27/01/2026', tx: '0x5555555555555555555555555555555555555555555555555555555555555555', chart: '0x7646c457a2c4d260f678f3126fa41e20bfdd1f95' },
        { title: '\uD83C\uDD95 NOVO HOLDER | SNAP', usd: '54.78', tokens: '10,322.10', wallet: '0xF607...4E56', count: 1, holderSince: '22/03/2026', tx: '0x6666666666666666666666666666666666666666666666666666666666666666', chart: '0x7646c457a2c4d260f678f3126fa41e20bfdd1f95' },
        { title: '\uD83D\uDD01 COMPRANDO NOVAMENTE | NIX', usd: '75.44', tokens: '11,880.90', wallet: '0x0A17...3F67', count: 2, holderSince: '20/03/2026', tx: '0x7777777777777777777777777777777777777777777777777777777777777777', chart: '0x7f01f344b1950a3c5ea3b9db7017f93ab0c8f88e' },
        { title: '\uD83C\uDFE6 HOLDER ANTIGO | SNAP', usd: '140.07', tokens: '27,901.31', wallet: '0x1B28...2A78', count: 4, holderSince: '11/03/2026', tx: '0x8888888888888888888888888888888888888888888888888888888888888888', chart: '0x7646c457a2c4d260f678f3126fa41e20bfdd1f95' },
        { title: '\uD83D\uDC0B WHALE ALERT | SNAP', usd: '690.33', tokens: '129,440.00', wallet: '0x2C39...1B89', count: 1, holderSince: '22/03/2026', tx: '0x9999999999999999999999999999999999999999999999999999999999999999', chart: '0x7646c457a2c4d260f678f3126fa41e20bfdd1f95' },
        { title: '\uD83C\uDFE6 HOLDER ANTIGO | NIX', usd: '88.12', tokens: '13,706.54', wallet: '0x3D4A...0C90', count: 6, holderSince: '09/02/2026', tx: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chart: '0x7f01f344b1950a3c5ea3b9db7017f93ab0c8f88e' }
    ];
}

async function sendInternalTestBuyAlerts(groupId, options = {}) {
    if (!activeSock) {
        throw new Error('Socket principal indisponivel.');
    }

    const alerts = buildTestBuyAlertsPayloads();
    const startIndex = Math.max(0, Number(options.startIndex || 0));
    const count = Math.max(1, Number(options.count || alerts.length));
    const delayMs = Math.max(500, Number(options.delayMs || 2200));
    const selected = alerts.slice(startIndex, startIndex + count);
    const imagePath = path.join(__dirname, 'assets', 'buy-alert-vellora.png');
    const imageBuffer = fs.readFileSync(imagePath);

    for (const [index, item] of selected.entries()) {
        const caption = [
            item.title,
            '',
            `\uD83D\uDCB0 USD: $${item.usd}`,
            `\uD83E\uDE99 Tokens: ${item.tokens}`,
            `\uD83D\uDC64 Wallet: ${item.wallet}`,
            `\uD83D\uDCDA Compras on-chain dessa wallet: ${item.count}`,
            `\uD83D\uDDD3\uFE0F Holder desde: ${item.holderSince}`,
            '\uD83C\uDFF7\uFE0F Origem: DEX',
            `\uD83D\uDD17 Tx: https://bscscan.com/tx/${item.tx}`,
            `\uD83D\uDCCA Chart: https://dexscreener.com/bsc/${item.chart}`,
            '\uD83C\uDF10 BSC'
        ].join('\n');

        const sent = await sendSafeMessage(activeSock, groupId, {
            image: imageBuffer,
            caption
        });

        if (!sent) {
            throw new Error(`Falha ao enviar alerta de teste ${startIndex + index + 1}.`);
        }

        if (index < selected.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    return {
        ok: true,
        sent: selected.length,
        startIndex,
        count: selected.length,
        groupId
    };
}

async function fetchImageBuffer(imageUrl) {
    const safeUrl = String(imageUrl || '').trim();
    if (!safeUrl) return null;

    try {
        const response = await fetch(safeUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 iMavyBot/1.0'
            }
        });

        if (!response.ok) {
            throw new Error(`Falha HTTP ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (error) {
        logger.warn('internal_news_preview_image_failed', {
            imageUrl: safeUrl,
            error: error?.message || String(error)
        });
        return null;
    }
}

async function sendInternalNewsPreview(groupId, items = [], options = {}) {
    if (!activeSock) {
        throw new Error('Socket principal indisponivel.');
    }

    const safeItems = Array.isArray(items)
        ? items
            .map((item) => (item && typeof item === 'object' ? item : null))
            .filter(Boolean)
            .slice(0, 10)
        : [];

    if (!safeItems.length) {
        throw new Error('Nenhuma noticia enviada.');
    }

    const delayMs = Math.max(1000, Number(options.delayMs || 3500));
    let sentCount = 0;

    for (const [index, item] of safeItems.entries()) {
        const title = String(item.title || '').trim();
        const summary = String(item.summary || item.description || '').trim();
        const link = String(item.link || item.url || '').trim();
        const source = String(item.source || 'CriptoJornal').trim();
        const imageUrl = String(item.imageUrl || item.image || '').trim();

        if (!title || !link) {
            throw new Error(`Noticia ${index + 1} sem titulo ou link.`);
        }

        const caption = [
            '\uD83D\uDCF0 *CriptoJornal*',
            '',
            `*${title}*`,
            '',
            summary,
            '',
            `\uD83D\uDD17 ${link}`,
            `\uD83C\uDFF7\uFE0F Fonte: ${source}`
        ].join('\n');

        const imageBuffer = await fetchImageBuffer(imageUrl);
        const payload = imageBuffer
            ? { image: imageBuffer, caption }
            : { text: caption };

        const sent = await sendSafeMessage(activeSock, groupId, payload);
        if (!sent) {
            throw new Error(`Falha ao enviar noticia ${index + 1}.`);
        }

        sentCount += 1;
        if (index < safeItems.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    return {
        ok: true,
        sent: sentCount,
        groupId
    };
}

async function sendInternalCriptoNoPixPreview(groupId, symbol = 'SNAP') {
    if (!activeSock) {
        throw new Error('Socket principal indisponivel.');
    }

    const imagePath = path.join(__dirname, 'assets', 'buy-alert-vellora.png');
    const imageBuffer = fs.readFileSync(imagePath);
    const safeSymbol = String(symbol || 'SNAP').trim().toUpperCase();
    const previewMap = {
        SNAP: {
            tokenName: 'Snappy',
            symbol: 'SNAP',
            brl: '1.000,00',
            cashback: '122,6181',
            ref: '122,6181',
            burn: '27,2485',
            tx: '0x79e2e7390000000000000000000000000000000000000000000000007ed9cc89',
            chart: '0x7646c457a2c4d260f678f3126fa41e20bfdd1f95'
        },
        NIX: {
            tokenName: 'NIX',
            symbol: 'NIX',
            brl: '9.575,261',
            cashback: '',
            ref: '',
            burn: '',
            tx: '0x618aaa42fd1805d37ae45dcf66355003fc8013e974ce0561f547812e2a28e9cc',
            chart: '0x7f01f344b1950a3c5ea3b9db7017f93ab0c8f88e'
        },
        FSX: {
            tokenName: 'ForeSight',
            symbol: 'FSX',
            brl: '33,39',
            cashback: '4,6063',
            ref: '4,6063',
            burn: '1,0236',
            tx: '0xb13a96cc70f174d998a3a3451424789ff24853ec4615f085e21b69df8df1a7c0',
            chart: '0xcD4fA13B6f5Cad65534DC244668C5270EC7e961a'
        }
    };
    const selected = previewMap[safeSymbol] || previewMap.SNAP;
    const caption = safeSymbol === 'FSX'
        ? [
            '\u{1F525} FSX GLOBAL Presale - New Purchase!',
            '',
            `\u{1F4B8} Payment: $6.360 in USDT`,
            `\u{1FA99} Token acquired: FSX`,
            `\u{1F4E6} Amount received: 205.75885 FSX`,
            `\u{1F3C1} Current Stage: Fase 7`,
            `\u{1F464} Wallet used: 0xe241...AC8f`,
            `\u{1F517} TX: https://bscscan.com/tx/${selected.tx}`
        ].join('\n')
        : [
            '---------------------------',
            'COMPRA NO PIX',
            '---------------------------',
            `\u{1F4B0} Valor: R$${selected.brl} via PIX!`,
            `\u{1FA99} Token: ${selected.tokenName} (${selected.symbol})`,
            '\u{1F3F7}\uFE0F Origem: Via Pix',
            `\u{1F310} Tx: https://bscscan.com/tx/${selected.tx}`,
            `\u{1F4CA} Dexscreener: https://dexscreener.com/bsc/${selected.chart}`,
            '\u26D3\uFE0F Chain: BSC',
            '',
            '\u{1F48E} Compre voc\u00ea tamb\u00e9m!',
            '\u{1F310} Site: criptonopix.app.br'
        ].join('\n');

    const sent = await sendSafeMessage(activeSock, groupId, {
        image: imageBuffer,
        caption
    });

    if (!sent) {
        throw new Error('Falha ao enviar preview Cripto no Pix.');
    }

    return {
        ok: true,
        sent: 1,
        groupId,
        symbol: selected.symbol
    };
}

async function sendCnpSitePurchaseAlert(sock, payload = {}) {
    if (!sock) {
        throw new Error('Socket indisponivel.');
    }

    const {
        brlValue = 0,
        symbol = 'NIX',
        cashback = 0,
        ref = 0,
        burn = 0,
        txHash = '',
        walletAddress = ''
    } = payload;

    const brl = Number(brlValue) || 0;
    if (brl < 1) {
        throw new Error('Valor minimo e R$1,00.');
    }

    const safeSymbol = String(symbol || 'NIX').trim().toUpperCase();
    const cashbackVal = Number(cashback) || 0;
    const refVal = Number(ref) || 0;
    const burnVal = Number(burn) || 0;
    const tokenNames = { NIX: 'NIX', SNAP: 'Snappy', FSX: 'ForeSight' };
    const tokenName = tokenNames[safeSymbol] || safeSymbol;

    const parts = [];
    parts.push('---------------------------');
    parts.push('COMPRA NO PIX');
    parts.push('---------------------------');
    parts.push(`\u{1F4B0} Valor: R$${brl.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} via PIX!`);
    parts.push(`\u{1FA99} Token: ${tokenName} (${safeSymbol})`);
    if (cashbackVal > 0) parts.push(`\u{1F3F7}\uFE0F Cashback: ${cashbackVal.toLocaleString('pt-BR', { minimumFractionDigits: 4 })} ${safeSymbol}`);
    if (refVal > 0) parts.push(`\u{1F517} Ref: ${refVal.toLocaleString('pt-BR', { minimumFractionDigits: 4 })} ${safeSymbol}`);
    if (burnVal > 0) parts.push(`\u{1F525} Burn: ${burnVal.toLocaleString('pt-BR', { minimumFractionDigits: 4 })} ${safeSymbol}`);
    if (txHash) parts.push(`\u{1F310} Tx: https://bscscan.com/tx/${txHash}`);
    parts.push('\u{1F4CA} Chart: https://dexscreener.com/bsc/nix');
    parts.push('\u26D3\uFE0F Chain: BSC');
    parts.push('');
    parts.push('\u{1F48E} Compre voce tambem!');
    parts.push('\u{1F310} Site: criptonopix.app.br');
    parts.push('\u{1F4F4} Grupo: @comprecriptonopixchat');

    const messageText = parts.join('\n');

    const config = buildConfig();
    const groups = resolveBuyAlertGroups();

    const delivery = { delivered: [], failed: [] };
    for (const groupId of groups) {
        const sent = await sendSafeMessage(sock, groupId, { text: messageText });
        if (sent) {
            delivery.delivered.push(groupId);
        } else {
            delivery.failed.push(groupId);
        }
    }

    return {
        ok: delivery.delivered.length > 0,
        delivered: delivery.delivered.length,
        failed: delivery.failed.length,
        groups
    };
}

const allowedGroupsState = {
    normalizedNames: new Set(),
    groupIds: new Set(),
    loadedAt: 0,
    loadingPromise: null,
    source: 'file'
};
const groupMetadataCache = new Map();
const GROUP_METADATA_CACHE_TTL_MS = Math.max(15_000, parseInt(process.env.GROUP_METADATA_CACHE_TTL_MS || '180000', 10));

async function getGroupMetadataCached(sock, chatId, options = {}) {
    const force = options.force === true;
    const key = String(chatId || '').trim();
    if (!key) return null;

    const now = Date.now();
    const cached = groupMetadataCache.get(key);
    if (!force && cached?.value && (now - cached.ts) < GROUP_METADATA_CACHE_TTL_MS) {
        return cached.value;
    }

    if (!force && cached?.promise) {
        return cached.promise;
    }

    const promise = sock.groupMetadata(key)
        .then((metadata) => {
            groupMetadataCache.set(key, {
                value: metadata,
                ts: Date.now(),
                promise: null
            });
            return metadata;
        })
        .catch((error) => {
            if (cached?.value) {
                return cached.value;
            }
            throw error;
        })
        .finally(() => {
            const latest = groupMetadataCache.get(key);
            if (latest?.promise) {
                groupMetadataCache.set(key, {
                    value: latest.value || null,
                    ts: latest.ts || now,
                    promise: null
                });
            }
        });

    groupMetadataCache.set(key, {
        value: cached?.value || null,
        ts: cached?.ts || 0,
        promise
    });

    return promise;
}

function resolveParticipantBySender(metadata, senderId) {
    const senderDigits = getNumberFromJid(senderId);
    return (metadata?.participants || []).find((participant) => {
        const candidates = [participant?.id, participant?.jid, participant?.lid].filter(Boolean);
        return candidates.some((candidate) => {
            if (candidate === senderId) return true;
            const candidateDigits = getNumberFromJid(candidate);
            return Boolean(senderDigits && candidateDigits && senderDigits === candidateDigits);
        });
    }) || null;
}

async function isSenderGroupAdmin(sock, chatId, senderId, metadataHint = null) {
    const firstMetadata = metadataHint || await getGroupMetadataCached(sock, chatId);
    let participant = resolveParticipantBySender(firstMetadata, senderId);

    if (!participant) {
        const freshMetadata = await getGroupMetadataCached(sock, chatId, { force: true });
        participant = resolveParticipantBySender(freshMetadata, senderId);
    }

    return participant?.admin === 'admin' || participant?.admin === 'superadmin';
}

function resolveSenderIdFromMessage(message) {
    const keyParticipant = String(message?.key?.participant || '').trim();
    if (keyParticipant) return keyParticipant;

    const messageParticipant = String(message?.participant || '').trim();
    if (messageParticipant) return messageParticipant;

    const contextParticipant = String(
        message?.message?.extendedTextMessage?.contextInfo?.participant
        || message?.message?.imageMessage?.contextInfo?.participant
        || message?.message?.videoMessage?.contextInfo?.participant
        || ''
    ).trim();
    if (contextParticipant) return contextParticipant;

    return String(message?.key?.remoteJid || '').trim();
}

async function sendFeatureDisabledNotice(sock, chatId, featureKey, text) {
    const key = `${String(chatId || '').trim()}:${String(featureKey || '').trim()}`;
    const now = Date.now();
    const last = featureDisabledNoticeCooldown.get(key) || 0;
    if (now - last < FEATURE_DISABLED_NOTICE_MS) {
        return;
    }

    featureDisabledNoticeCooldown.set(key, now);
    await sendSafeMessage(sock, chatId, { text });
}

function normalizeGroupName(name) {
    return String(name || '')
        .normalize('NFKC')
        .replace(/[\u200D\uFE0E\uFE0F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function sanitizeIncomingText(value) {
    if (typeof value !== 'string') return '';
    return value
        .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
        .replace(/\r/g, '')
        .trim();
}

function getSupabaseRestConfig() {
    const url = String(process.env.IMAVY_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
    const key = String(
        process.env.IMAVY_SUPABASE_SERVICE_KEY ||
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.IMAVY_SUPABASE_ANON_KEY ||
        process.env.SUPABASE_ANON_KEY ||
        process.env.IMAVY_SUPABASE_PUBLISHABLE_KEY ||
        process.env.SUPABASE_PUBLISHABLE_KEY ||
        process.env.SUPABASE_KEY ||
        ''
    ).trim();
    const allowedGroupsTable = String(process.env.IMAVY_ALLOWED_GROUPS_TABLE || 'allowed_groups').trim();
    const gruposTable = String(process.env.IMAVY_GRUPOS_TABLE || 'grupos').trim();
    return { url, key, allowedGroupsTable, gruposTable };
}

function dedupeStrings(values = []) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        const text = String(value || '').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
    }
    return out;
}

async function fetchAllowedGroupsFromSupabase() {
    const config = getSupabaseRestConfig();
    if (!config.url || !config.key) {
        return { names: [], ids: [] };
    }

    const headers = {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`
    };
    const names = [];
    const ids = [];

    try {
        const allowedUrl = `${config.url}/rest/v1/${encodeURIComponent(config.allowedGroupsTable)}?select=name,nome&limit=10000`;
        const allowedResponse = await fetch(allowedUrl, { method: 'GET', headers });
        if (allowedResponse.ok) {
            const rows = await allowedResponse.json();
            for (const row of Array.isArray(rows) ? rows : []) {
                const name = String(row?.name || row?.nome || '').trim();
                if (name) names.push(name);
            }
        }
    } catch (_) {}

    try {
        const gruposUrl = `${config.url}/rest/v1/${encodeURIComponent(config.gruposTable)}?select=id,nome&limit=10000`;
        const gruposResponse = await fetch(gruposUrl, { method: 'GET', headers });
        if (gruposResponse.ok) {
            const rows = await gruposResponse.json();
            for (const row of Array.isArray(rows) ? rows : []) {
                const id = String(row?.id || '').trim();
                const nome = String(row?.nome || '').trim();
                if (id) ids.push(id);
                if (nome) names.push(nome);
            }
        }
    } catch (_) {}

    return {
        names: dedupeStrings(names),
        ids: dedupeStrings(ids)
    };
}

function unwrapIncomingMessageContent(content, depth = 0) {
    if (!content || typeof content !== 'object' || depth > 6) {
        return null;
    }

    const wrappedNodes = [
        content.ephemeralMessage?.message,
        content.viewOnceMessage?.message,
        content.viewOnceMessageV2?.message,
        content.viewOnceMessageV2Extension?.message,
        content.editedMessage?.message
    ];

    for (const nested of wrappedNodes) {
        if (!nested) continue;
        const unwrapped = unwrapIncomingMessageContent(nested, depth + 1);
        if (unwrapped) {
            return unwrapped;
        }
    }

    return content;
}

function extractProcessableIncomingText(message) {
    const content = unwrapIncomingMessageContent(message?.message);
    if (!content) return '';

    const buttonReplyId = sanitizeIncomingText(content?.buttonsResponseMessage?.selectedButtonId);
    if (buttonReplyId) return buttonReplyId;

    const buttonReplyText = sanitizeIncomingText(content?.buttonsResponseMessage?.selectedDisplayText);
    if (buttonReplyText) return buttonReplyText;

    const listReplyId = sanitizeIncomingText(content?.listResponseMessage?.singleSelectReply?.selectedRowId);
    if (listReplyId) return listReplyId;

    const listReplyTitle = sanitizeIncomingText(content?.listResponseMessage?.title);
    if (listReplyTitle) return listReplyTitle;

    const conversation = sanitizeIncomingText(content.conversation);
    if (conversation) return conversation;

    const extendedText = sanitizeIncomingText(content?.extendedTextMessage?.text);
    if (extendedText) return extendedText;

    const imageCaption = sanitizeIncomingText(content?.imageMessage?.caption);
    if (imageCaption) return imageCaption;

    const videoCaption = sanitizeIncomingText(content?.videoMessage?.caption);
    if (videoCaption) return videoCaption;

    return '';
}

function isReminderPrivateCommandToken(commandToken) {
    const token = String(commandToken || '').trim().toLowerCase();
    if (!token) return false;
    const normalized = token.startsWith('/') ? token : `/${token}`;
    return normalized === '/lembrete'
        || normalized === '/lembretes'
        || normalized === '/lembretefixo'
        || normalized === '/stoplembrete'
        || normalized === '/stoplembretes'
        || normalized === '/stoplembretefixo'
        || normalized === '/stoplembretesfixos'
        || normalized === '/testelembrete'
        || normalized === '/testelembretes'
        || normalized === '/editarlembrete'
        || normalized === '/apagarlembrete'
        || normalized === '/agendar';
}

function parseNewsletterInviteCode(value) {
    const safe = String(value || '').trim();
    if (!safe) return '';
    try {
        const parsed = new URL(safe);
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts.length >= 2 && parts[0].toLowerCase() === 'channel') {
            return String(parts[1] || '').trim();
        }
        return safe;
    } catch (_) {
        return safe.replace(/^\/+|\/+$/g, '');
    }
}

async function resolveConfiguredJobChannelTarget(sock) {
    const explicitJid = String(process.env.IMAVY_JOB_CHANNEL_JID || process.env.IMAVY_JOB_CHANNEL_JIDS || '').split(',').map((item) => item.trim()).find(Boolean) || '';
    if (explicitJid) {
        return { id: explicitJid, name: explicitJid };
    }

    const inviteCodeRaw = String(process.env.IMAVY_JOB_CHANNEL_INVITE_CODE || process.env.IMAVY_JOB_CHANNEL_INVITE_CODES || '').split(',').map((item) => item.trim()).find(Boolean) || '';
    const inviteCode = parseNewsletterInviteCode(inviteCodeRaw);
    if (!inviteCode) {
        throw new Error('Canal de vagas nao configurado em IMAVY_JOB_CHANNEL_INVITE_CODE/IMAVY_JOB_CHANNEL_JID.');
    }

    if (typeof sock?.newsletterMetadata !== 'function') {
        throw new Error('Socket atual nao suporta resolucao de canal/newsletter.');
    }

    const metadata = await sock.newsletterMetadata('invite', inviteCode);
    if (!metadata?.id) {
        throw new Error('Nao foi possivel resolver o canal configurado.');
    }

    return {
        id: String(metadata.id).trim(),
        name: String(metadata.name || metadata.id).trim() || String(metadata.id).trim()
    };
}

function isMarch2026Job(job, includeUndated = true) {
    const publishedAt = Number(job?.publishedAt || 0);
    if (!Number.isFinite(publishedAt) || publishedAt <= 0) {
        return includeUndated;
    }

    const date = new Date(publishedAt);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    return year === 2026 && month === 2;
}

async function startMarchJobsBackfill(options = {}) {
    if (marchJobsBackfillStatus.running) {
        throw new Error('Ja existe um backfill de vagas de marco em andamento.');
    }

    if (!activeSock) {
        throw new Error('Socket principal indisponivel.');
    }

    const delayMs = Math.max(120000, Number(options.delayMs || 180000));
    const includeUndated = options.includeUndated !== false;
    const target = await resolveConfiguredJobChannelTarget(activeSock);
    const jobs = await collectJobs();
    const marchJobs = jobs
        .filter((job) => isMarch2026Job(job, includeUndated))
        .sort((a, b) => {
            const aTs = Number(a?.publishedAt || 0);
            const bTs = Number(b?.publishedAt || 0);
            if (!aTs && !bTs) return String(a?.title || '').localeCompare(String(b?.title || ''));
            if (!aTs) return -1;
            if (!bTs) return 1;
            return aTs - bTs;
        });

    marchJobsBackfillStatus = {
        running: true,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        targetId: target.id,
        targetName: target.name,
        delayMs,
        total: marchJobs.length,
        sent: 0,
        failed: 0,
        includeUndated,
        errors: []
    };

    logger.info('job_march_backfill_started', {
        targetId: target.id,
        targetName: target.name,
        delayMs,
        total: marchJobs.length,
        includeUndated
    });

    (async () => {
        try {
            for (let index = 0; index < marchJobs.length; index += 1) {
                const job = marchJobs[index];
                const sent = await sendSafeMessage(activeSock, target.id, buildJobPayload(job, { targetType: target.targetType || 'newsletter' }));
                if (!sent) {
                    marchJobsBackfillStatus.failed += 1;
                    marchJobsBackfillStatus.errors.push(`Falha ao enviar: ${job?.title || 'vaga sem titulo'}`);
                } else {
                    marchJobsBackfillStatus.sent += 1;
                    logger.info('job_march_backfill_sent', {
                        index: index + 1,
                        total: marchJobs.length,
                        title: job?.title || '',
                        url: job?.url || '',
                        targetId: target.id
                    });
                }

                if (index < marchJobs.length - 1) {
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                }
            }
        } catch (error) {
            marchJobsBackfillStatus.errors.push(error?.message || String(error));
            logger.error('job_march_backfill_failed', {
                error: error?.message || String(error)
            });
        } finally {
            marchJobsBackfillStatus.running = false;
            marchJobsBackfillStatus.finishedAt = new Date().toISOString();
            logger.info('job_march_backfill_finished', marchJobsBackfillStatus);
        }
    })().catch((error) => {
        marchJobsBackfillStatus.running = false;
        marchJobsBackfillStatus.finishedAt = new Date().toISOString();
        marchJobsBackfillStatus.errors.push(error?.message || String(error));
        logger.error('job_march_backfill_failed', {
            error: error?.message || String(error)
        });
    });

    return {
        ok: true,
        started: true,
        targetId: target.id,
        targetName: target.name,
        delayMs,
        total: marchJobs.length,
        includeUndated
    };
}

async function resolveNewsletterName(sock, jid) {
    const safeJid = String(jid || '').trim();
    if (!safeJid.endsWith('@newsletter') || typeof sock?.newsletterMetadata !== 'function') {
        return '';
    }

    try {
        const metadata = await sock.newsletterMetadata('jid', safeJid);
        return String(metadata?.name || '').trim();
    } catch (_) {
        return '';
    }
}

async function maybeHandleWelcomeParticipants(sock, groupId, participants) {
    const safeGroupId = String(groupId || '').trim();
    if (!safeGroupId || !safeGroupId.endsWith('@g.us')) {
        return;
    }

    const safeParticipants = (Array.isArray(participants) ? participants : [participants])
        .map((participant) => {
            if (!participant) return '';
            if (typeof participant === 'string') return participant.trim();
            if (typeof participant === 'object' && typeof participant.id === 'string') return participant.id.trim();
            if (typeof participant === 'object' && typeof participant.jid === 'string') return participant.jid.trim();
            if (typeof participant === 'object' && typeof participant.participant === 'string') return participant.participant.trim();
            return '';
        })
        .filter(Boolean);

    if (safeParticipants.length === 0) {
        return;
    }

    let groupSubject = '';
    try {
        const groupMetadata = await getGroupMetadataCached(sock, safeGroupId);
        groupSubject = groupMetadata?.subject || '';
    } catch (e) {
        console.warn('Nao foi possivel obter nome do grupo para filtro de boas-vindas:', e.message);
    }

    if (isRestrictedGroupName(groupSubject)) {
        console.log(`Boas-vindas desativadas no grupo restrito: "${groupSubject}"`);
        return;
    }

    const groupPermissions = await getAllowedGroupPermissions(groupSubject);
    if (!groupPermissions?.welcome) {
        console.log(`Boas-vindas desativadas por permissao no grupo: "${groupSubject}"`);
        return;
    }

    await handleWelcomeEvent(sock, safeGroupId, safeParticipants);
}

function loadAllowedGroupNames() {
    const allowed = new Set();
    const groupIds = new Set();
    try {
        const allowedPath = path.join(__dirname, 'allowed_groups.json');
        if (!fs.existsSync(allowedPath)) {
            return { names: allowed, ids: groupIds };
        }
        const parsed = JSON.parse(fs.readFileSync(allowedPath, 'utf8'));
        if (Array.isArray(parsed)) {
            parsed.forEach((entry) => {
                let name = '';
                if (typeof entry === 'string') {
                    name = entry;
                } else if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
                    name = entry.name;
                    const groupId = String(entry.groupId || '').trim();
                    if (groupId) groupIds.add(groupId);
                }
                const normalized = normalizeGroupName(name);
                if (normalized) allowed.add(normalized);
            });
        }
    } catch (e) {
        console.warn('Falha ao ler allowed_groups.json:', e.message);
    }
    return { names: allowed, ids: groupIds };
}

function getAllowedGroupsSnapshot() {
    if (allowedGroupsState.loadedAt <= 0 || allowedGroupsState.normalizedNames.size === 0) {
        const local = loadAllowedGroupNames();
        allowedGroupsState.normalizedNames = local.names;
        allowedGroupsState.groupIds = local.ids;
        allowedGroupsState.loadedAt = Date.now();
        allowedGroupsState.source = 'file';
    }

    return {
        normalizedNames: allowedGroupsState.normalizedNames,
        groupIds: allowedGroupsState.groupIds,
        source: allowedGroupsState.source
    };
}

async function refreshAllowedGroupsCache(force = false) {
    const now = Date.now();
    if (!force && allowedGroupsState.loadedAt > 0 && (now - allowedGroupsState.loadedAt) < ALLOWED_GROUPS_CACHE_TTL_MS) {
        return getAllowedGroupsSnapshot();
    }

    if (allowedGroupsState.loadingPromise) {
        await allowedGroupsState.loadingPromise;
        return getAllowedGroupsSnapshot();
    }

    allowedGroupsState.loadingPromise = (async () => {
        const local = loadAllowedGroupNames();
        const normalizedNames = new Set(local.names);
        const groupIds = new Set(local.ids);
        let source = 'file';

        const remote = await fetchAllowedGroupsFromSupabase();
        for (const name of remote.names) {
            const normalized = normalizeGroupName(name);
            if (normalized) normalizedNames.add(normalized);
        }
        for (const id of remote.ids) {
            const groupId = String(id || '').trim();
            if (groupId) groupIds.add(groupId);
        }

        if (remote.names.length > 0 || remote.ids.length > 0) {
            source = 'file+supabase';
        }

        allowedGroupsState.normalizedNames = normalizedNames;
        allowedGroupsState.groupIds = groupIds;
        allowedGroupsState.loadedAt = Date.now();
        allowedGroupsState.source = source;
    })().finally(() => {
        allowedGroupsState.loadingPromise = null;
    });

    await allowedGroupsState.loadingPromise;
    return getAllowedGroupsSnapshot();
}

function getAllowedGroupsCacheMeta() {
    return {
        namesCount: allowedGroupsState.normalizedNames.size,
        idsCount: allowedGroupsState.groupIds.size,
        loadedAt: allowedGroupsState.loadedAt || null,
        source: allowedGroupsState.source
    };
}

async function applyDashboardSyncPayload(payload) {
    const rawPayload = payload && typeof payload === 'object' ? payload : {};
    const events = Array.isArray(rawPayload.events) ? rawPayload.events : [rawPayload];
    const appliedTypes = [];
    let refreshedGroups = false;
    let runtimePatchResult = null;

    for (const rawEvent of events) {
        const event = rawEvent && typeof rawEvent === 'object' ? rawEvent : {};
        const type = String(event.type || '').trim().toUpperCase();
        if (type) {
            appliedTypes.push(type);
        }

        const wantsGroupRefresh = (
            type === 'GROUPS_UPDATED' ||
            type === 'DASHBOARD_ACCESS_UPDATED' ||
            type === 'REFRESH_ALLOWED_GROUPS' ||
            event.refreshAllowedGroups === true
        );
        if (wantsGroupRefresh) {
            await refreshAllowedGroupsCache(true);
            refreshedGroups = true;
        }

        const patchSource = String(event.source || rawPayload.source || 'dashboard-sync').trim() || 'dashboard-sync';
        const patchPayload = event.runtimeFeatureFlags || event.patch || rawPayload.runtimeFeatureFlags || rawPayload.patch;
        const isPatchType = type === 'RUNTIME_FEATURE_FLAGS_PATCH' || type === 'RUNTIME_CONFIG_PATCH';
        if (isPatchType || (patchPayload && typeof patchPayload === 'object')) {
            runtimePatchResult = applyRuntimeFeatureFlagsPatch(
                patchPayload,
                patchSource,
                String(event.eventId || rawPayload.eventId || '').trim() || null
            );
        }
    }

    runtimeControlState.lastAppliedTypes = appliedTypes.slice(-20);

    return {
        appliedTypes,
        refreshedGroups,
        runtimePatch: runtimePatchResult,
        runtimeFeatures: getRuntimeFeaturesSnapshot(),
        allowedGroupsCache: getAllowedGroupsCacheMeta()
    };
}

async function handleDashboardSyncEndpoint(req, res) {
    if (!DASHBOARD_SYNC_SECRET) {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            ok: false,
            error: 'DASHBOARD_SYNC_SECRET nao configurado no bot.'
        }));
        return;
    }

    if (!isDashboardSyncAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            ok: false,
            error: 'Nao autorizado para sincronizacao dashboard->bot.'
        }));
        return;
    }

    if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            ok: true,
            runtimeFeatures: getRuntimeFeaturesSnapshot(),
            allowedGroupsCache: getAllowedGroupsCacheMeta(),
            lastAppliedTypes: runtimeControlState.lastAppliedTypes,
            updatedAt: runtimeControlState.updatedAt,
            source: runtimeControlState.source,
            lastEventId: runtimeControlState.lastEventId
        }));
        return;
    }

    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Metodo nao permitido.' }));
        return;
    }

    try {
        const payload = await readJsonBody(req, DASHBOARD_SYNC_MAX_BODY_BYTES);
        const result = await applyDashboardSyncPayload(payload);
        console.log('[SYNC] Dashboard->Bot payload aplicado:', {
            appliedTypes: result.appliedTypes,
            refreshedGroups: result.refreshedGroups,
            runtimeFeatures: result.runtimeFeatures
        });

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            ok: false,
            error: error.message || 'Falha ao aplicar payload de sincronizacao.'
        }));
    }
}

async function handlePrivateJobProfileSyncEndpoint(req, res) {
    const syncSecret = getPrivateJobProfileSyncSecret();
    if (!syncSecret) {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            ok: false,
            error: 'PRIVATE_JOB_PROFILE_SYNC_SECRET nao configurado no bot.'
        }));
        return;
    }

    if (!isPrivateJobProfileSyncAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            ok: false,
            error: 'Nao autorizado para sincronizacao de perfis de vagas.'
        }));
        return;
    }

    if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            ok: true,
            endpoint: 'private-job-profile-sync',
            hasActiveSocket: Boolean(activeSock)
        }));
        return;
    }

    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Metodo nao permitido.' }));
        return;
    }

    try {
        const payload = await readJsonBody(req, 256 * 1024);
        const rawProfiles = Array.isArray(payload?.profiles)
            ? payload.profiles
            : Array.isArray(payload?.events)
                ? payload.events
                : [payload?.profile || payload];
        const profiles = rawProfiles.filter((item) => item && typeof item === 'object');
        const notify = payload?.notify === true;
        const results = [];

        for (const profilePayload of profiles) {
            const saved = await syncExternalPrivateJobProfile({
                ...profilePayload,
                source: profilePayload?.source || payload?.source || 'site-sync'
            });
            results.push({
                jid: saved?.jid || '',
                active: saved?.active !== false,
                jobType: saved?.jobType || '',
                city: saved?.city || '',
                state: saved?.state || ''
            });

            if (notify && activeSock && saved?.jid) {
                await sendSafeMessage(activeSock, saved.jid, {
                    text: 'Seu cadastro de vagas foi sincronizado com sucesso. A partir de agora vou considerar seu perfil nas proximas vagas compativeis.'
                });
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            ok: true,
            synced: results.length,
            notify: notify && Boolean(activeSock),
            results
        }));
    } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            ok: false,
            error: error.message || 'Falha ao sincronizar perfil de vagas.'
        }));
    }
}

function resolveParticipantName(message, senderId) {
    const pushName = String(message?.pushName || '').trim();
    if (pushName) {
        return pushName;
    }

    const phone = getNumberFromJid(senderId);
    const formatted = formatNumberInternational(phone);
    return formatted || senderId;
}

function publishInteractionForDashboard(message, senderId, groupSubject, chatId, messageTimestamp, messageText) {
    const nome = resolveParticipantName(message, senderId);
    const dataIso = new Date(messageTimestamp).toISOString();

    publishRealtimeInteraction({
        messageId: message?.key?.id,
        nome,
        grupo: groupSubject,
        grupoId: chatId,
        senderId,
        dataIso,
        texto: messageText
    }).catch((error) => {
        console.warn('Falha ao publicar interacao em tempo real:', error.message);
    });
}

function scheduleFullProcessRestart(reason = 'unknown', delayMs = 5000) {
    if (pendingFullRestartTimer) {
        return;
    }
    console.warn(`[WA] Reinicio completo agendado em ${Math.round(delayMs / 1000)}s. Motivo: ${reason}`);
    pendingFullRestartTimer = setTimeout(() => {
        process.exit(1);
    }, Math.max(1000, delayMs));
}

async function startBot(options = {}) {
    if (startBotInFlight) {
        console.log('[WA] startBot ignorado: inicializacao ja em andamento.');
        return;
    }
    startBotInFlight = true;
    console.log("===============================================");
    console.log('Iniciando iMavyAgent - Respostas Pre-Definidas');
    console.log("===============================================");

    try {
        if (options?.forceFullRestart) {
            console.warn('[WA] Start solicitado com reinicio completo da sessao/socket.');
        }

        debugLog('[DEBUG] ensureCoreConfigFiles...');
        await ensureCoreConfigFiles();
        await refreshAllowedGroupsCache(true);
        try {
            const backfill = await backfillRankingFromCurrentMonth({ maxRows: 50000 });
            console.log('[RANKING] Backfill mensal:', backfill);
        } catch (error) {
            console.warn('[RANKING] Falha no backfill mensal:', error.message || String(error));
        }

        debugLog('[DEBUG] restoreSessionFromBackup...');
        restoreSessionFromBackup();

        const authPath = path.join(__dirname, 'auth_info');
        const brokenSessions = String(process.env.WA_BROKEN_SESSION_IDS || '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
        if (brokenSessions.length > 0) {
            const removed = removeBrokenSessionFiles(authPath, brokenSessions);
            console.log('[WA] Sessoes quebradas removidas:', removed);
        }
        const sessionHygiene = sanitizeAuthStateDir(authPath);
        console.log('[WA] Higienizacao da sessao:', sessionHygiene);

        debugLog('[DEBUG] useMultiFileAuthState...');
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');

        debugLog('[DEBUG] fetchLatestBaileysVersion...');
        const { version } = await fetchLatestBaileysVersion();

        debugLog('[DEBUG] Criando socket...');

        const sock = makeWASocket({
            auth: state,
            version,
            printQRInTerminal: false,
            syncFullHistory: false,
            markOnlineOnConnect: true,
            browser: ['iMavyAgent', 'Chrome', '10.0'],
            defaultQueryTimeoutMs: undefined,
            keepAliveIntervalMs: 30000,
            connectTimeoutMs: 60000,
            qrTimeout: 60000,
            retryRequestDelayMs: 250,
            maxMsgRetryCount: 5,
            getMessage: async (key) => {
                return undefined;
            }
        });

        attachOutgoingGuard(sock);

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && connection !== 'open') {
            console.log('\n----------------------------------------');
            console.log('AUTENTICACAO WHATSAPP REQUERIDA');
            console.log('Escaneie o QR code no WhatsApp Web');
            console.log('----------------------------------------\n');

            qrcode.generate(qr, { small: true });

            try {
                qrCodeData = await QRCode.toDataURL(qr, { width: 600 });
                console.log('QR CODE DISPONIVEL EM:');
                console.log(`http://localhost:${PORT}/qr`);
                console.log('O QR code fica disponivel por 60 segundos.');
            } catch (e) {
                console.log('Erro ao gerar link QR:', e.message);
            }
        }

        // Fechar servidor quando conectar
        if (connection === 'open' && qrServer) {
            console.log('Fechando servidor QR code temporario...');
            qrServer.close();
            qrServer = null;
        }

        console.log('Status da conexao:', connection);

        if (connection === 'open') {
            activeSock = sock;
            logger.info('Conectado ao WhatsApp');
            if (pendingFullRestartTimer) {
                clearTimeout(pendingFullRestartTimer);
                pendingFullRestartTimer = null;
            }
            resetReconnectAttempts();
            setConnected(true);
            setHealthEscalationHandler(({ reason }) => {
                scheduleFullProcessRestart(`health_monitor:${reason}`, 5000);
            });

            // Iniciar servicos apenas uma vez apos conexao bem-sucedida
            try {
                scheduleGroupMessages(sock);
                scheduleBackups();
                startScheduler(sock);
                initGroupResponderSchedulers(sock);

                // Iniciar sistema de lembretes apenas uma vez por ciclo de conexao
                if (!global.__imavyLembretesInitialized) {
                    initLembretes(sock);
                    global.__imavyLembretesInitialized = true;
                }

                scheduleSupabaseBackup();
                startAutoPromo(sock);
                startHealthMonitor();
                startSessionBackup();
                startCryptoCacheWarmer();

                if (BUY_ALERT_ENABLED) {
                    await startBootService('BUY ALERT', async () => {
                        await startBuyAlertNotifier(sock, {
                            onBuyProcessed: async (buyEvent) => {
                                await intelEngine.registerOnchainBuy(buyEvent);
                            }
                        });
                    });
                } else {
                    logger.info('BUY ALERT desabilitado por configuracao (BUY_ALERT_ENABLED=false).');
                }

                await startBootService('news forwarder', async () => {
                    await startNewsForwarder(sock);
                });
                await startBootService('job forwarder', async () => {
                    await startJobForwarder(sock);
                });
                await startBootService('private job alerts', async () => {
                    await startPrivateJobAlerts(sock);
                });
                await startBootService('job test publisher', async () => {
                    await startJobTestPublisher(sock);
                });

                console.log('Boot principal concluido');
            } catch (e) {
                console.error('Erro ao iniciar servicos principais:', e.message);
            }
        }

        if (connection === 'close') {
            const wasActiveSock = activeSock === sock;
            if (activeSock === sock) {
                activeSock = null;
            }
            try {
                flushScheduledAutomationStateWithoutReminders('whatsapp_connection_closed');
            } catch (error) {
                logger.warn('scheduled_automation_flush_failed', {
                    error: error?.message || String(error)
                });
            }
            const reason = lastDisconnect?.error?.output?.statusCode;
            const reasonName = (() => {
                const map = {
                    [DisconnectReason.badSession]: 'Sessao invalida',
                    [DisconnectReason.connectionClosed]: 'Conexao fechada',
                    [DisconnectReason.connectionLost]: 'Conexao perdida',
                    [DisconnectReason.connectionReplaced]: 'Conexao substituida',
                    [DisconnectReason.loggedOut]: 'Logout manual',
                    [DisconnectReason.restartRequired]: 'Reinicio necessario',
                    [DisconnectReason.timedOut]: 'Timeout',
                    [DisconnectReason.unavailableService]: 'Servico indisponivel'
                };
                return map[reason] || `Desconhecido (${reason ?? 'sem_codigo'})`;
            })();
            setConnected(false);
            logger.warn('whatsapp_connection_closed', {
                reason,
                reasonName,
                hadActiveSock: wasActiveSock
            });
            global.__imavyLembretesInitialized = false;
            resetLembretesRuntime();
            stopNewsForwarder();
            stopJobForwarder();
            stopPrivateJobAlerts();
            stopJobTestPublisher();
            await stopBuyAlertNotifier();
            stopCryptoCacheWarmer();

            if (reason === DisconnectReason.loggedOut) {
                console.log('Sessao desconectada manualmente. Deletando credenciais antigas...');
                try {
                    const authPath = path.join(__dirname, 'auth_info');
                    if (fs.existsSync(authPath)) {
                        fs.rmSync(authPath, { recursive: true, force: true });
                        console.log('Credenciais antigas removidas');
                    }
                    // Tambem limpar o backup para evitar loop de restauracao
                    clearSessionBackup();
                } catch (e) {
                    console.error('Erro ao remover credenciais:', e.message);
                }
                console.log('Reiniciando para gerar novo QR code...');
                setTimeout(() => startBot(), 3000);
            } else {
                // Usar gerenciador de conexao para reconexoes automaticas
                handleConnectionUpdate(update, startBot);
            }
        }
        });

        sock.ev.on('messages.upsert', async (msgUpsert) => {
        const upsertType = String(msgUpsert?.type || '').toLowerCase();
        if (upsertType && upsertType !== 'notify' && upsertType !== 'append') {
            return;
        }

        const messages = Array.isArray(msgUpsert?.messages) ? msgUpsert.messages : [];

        // Atualizar heartbeat a cada mensagem processada
        updateHeartbeat();

        for (const message of messages) {
            // ========== 1. FILTROS INICIAIS (Fast Return) ==========
            if (message.key.fromMe) continue;
            if (!message.key.remoteJid) continue;
            if (message.key.remoteJid === 'status@broadcast') continue;
            if (message.key.remoteJid.endsWith('@broadcast')) continue;

            if (message.key.remoteJid.endsWith('@g.us')) {
                const stubType = message.messageStubType;
                if (
                    stubType === WAMessageStubType.GROUP_PARTICIPANT_ADD
                    || stubType === WAMessageStubType.GROUP_PARTICIPANT_INVITE
                    || stubType === WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN
                ) {
                    const addedParticipants = Array.isArray(message.messageStubParameters)
                        ? message.messageStubParameters
                        : (message.key.participant ? [message.key.participant] : []);

                    try {
                        await maybeHandleWelcomeParticipants(sock, message.key.remoteJid, addedParticipants);
                    } catch (error) {
                        console.error('Erro ao processar boas-vindas via messageStubType:', error);
                    }
                    continue;
                }
            }

            if (!message.message) continue;
            if (message.messageStubType !== undefined && message.messageStubType !== null) continue;

            const unwrappedContent = unwrapIncomingMessageContent(message.message);
            if (!unwrappedContent) continue;
            if (unwrappedContent.protocolMessage) continue;
            if (unwrappedContent.senderKeyDistributionMessage) continue;

            const isGroup = message.key.remoteJid?.endsWith('@g.us');
            const messageTimestamp = message.messageTimestamp ? parseInt(message.messageTimestamp) * 1000 : Date.now();
            if (isGroup && messageTimestamp < botStartTime) continue;

            // ========== 2. SEPARACAO DE CONTEXTO ==========
            const senderId = resolveSenderIdFromMessage(message);
            const chatId = message.key.remoteJid;

            // Extrair texto apenas de conversation/extendedTextMessage.text
            const messageText = extractProcessableIncomingText(message) || '';
            const hasText = messageText.trim().length > 0;
            if (!hasText && (isGroup || !hasPendingPrivateWizard(senderId))) continue;

            const processingStart = Date.now();
            const messageId = message?.key?.id || null;
            let processingStage = 'start';

            try {
                logger.debug('msg_received', {
                    chatId,
                    messageId,
                    isGroup,
                    textLen: messageText.length
                });

                if (chatId?.endsWith('@newsletter')) {
                    const channelName = await resolveNewsletterName(sock, chatId);
                    logger.info('newsletter_seen', {
                        chatId,
                        channelName,
                        textLen: messageText.length
                    });
                    if (matchesConfiguredJobSourceChannel({ chatId, channelName })) {
                        const parsedJob = registerIncomingJobChannelMessage({
                            chatId,
                            channelName,
                            text: messageText,
                            messageId,
                            receivedAt: messageTimestamp
                        });

                        if (parsedJob) {
                            const relayResult = await sendJobToConfiguredTargets(sock, parsedJob, {
                                includeGroups: true,
                                delayMs: 1200
                            });
                            logger.info('job_channel_source_relayed', {
                                chatId,
                                channelName,
                                title: parsedJob.title,
                                sent: relayResult.sent,
                                failed: relayResult.failed,
                                targets: relayResult.targets.map((item) => `${item.targetType}:${item.subject}`)
                            });
                        }
                    }
                    continue;
                }

                if (isGroup) {
                    const relayedFsxOfficialPurchase = await maybeRelayFsxOfficialPurchase(sock, message, unwrappedContent, messageText, {
                        upsertType
                    });
                    if (relayedFsxOfficialPurchase) {
                        continue;
                    }
                }

                // Intelligence mode: analisar todas as conversas sem bloquear o loop principal.
                if (runtimeControlState.features.intelEnabled) {
                    intelEngine.processMessage(message, chatId, messageTimestamp, {
                        text: messageText,
                        senderId,
                        isGroup,
                        timestamp: messageTimestamp
                    }).catch((error) => {
                        console.warn('[INTEL] Falha ao processar mensagem:', error.message || String(error));
                    });
                }

                // ========== 3. FLUXO PRIVADO (VENDAS) - DESABILITADO ==========
                if (!isGroup) {
                    processingStage = 'private';

                    // ========== 3.1. AUTO ATENDIMENTO (VENDAS) ==========
                    const privateText = String(messageText || '').trim().toLowerCase();
                    const isValoresCommand = privateText.startsWith('/valores');
                    const interestDetected = hasText && detectClientInterest(messageText);
                    
                    if (isValoresCommand || interestDetected) {
                        if (shouldSendAttendance(senderId)) {
                            logger.info('auto_attendance_triggered', { chatId, senderId, isCommand: isValoresCommand });
                            await sendAttendanceMessage(sock, chatId);
                            const clientNumber = getNumberFromJid(senderId) || senderId;
                            await notifyAttendants(sock, senderId, clientNumber, getAdmins, messageText);
                            continue; 
                        }
                    }
                    if (shouldSkipDuplicatePrivateMessage(message, messageText)) {
                        logger.info('private_message_duplicate_skipped', {
                            chatId,
                            senderId,
                            messageId
                        });
                        continue;
                    }
                    const privateCommandToken = privateText.split(/\s+/)[0] || '';
                    const isReminderPvCommand = isReminderPrivateCommandToken(privateCommandToken);
                    const hasPrivateWizard = hasPendingPrivateWizard(senderId);

                    if (messageText.toLowerCase().startsWith('/leads')) {
                        if (!runtimeControlState.features.commandsEnabled || !runtimeControlState.features.leadsEnabled) {
                            await sendFeatureDisabledNotice(sock, chatId, 'leads', 'Comandos de leads estao temporariamente desativados pelo dashboard.');
                            continue;
                        }
                        await leadEngine.handleLeadsCommand(sock, chatId);
                        continue;
                    }
                    if (messageText.toLowerCase().startsWith('/engajamento')) {
                        if (!runtimeControlState.features.commandsEnabled || !runtimeControlState.features.leadsEnabled) {
                            await sendFeatureDisabledNotice(sock, chatId, 'leads', 'Comandos de leads estao temporariamente desativados pelo dashboard.');
                            continue;
                        }
                        const allowedGroups = getAllowedGroupsSnapshot().normalizedNames;
                        await leadEngine.handleEngagementCommand(sock, chatId, {
                            allowedGroupNames: Array.from(allowedGroups)
                        });
                        continue;
                    }

                    if (messageText.toLowerCase().startsWith('/cap')) {
                        if (!runtimeControlState.features.commandsEnabled) {
                            await sendFeatureDisabledNotice(sock, chatId, 'commands', 'Comandos estao temporariamente desativados pelo dashboard.');
                            continue;
                        }
                        await handleCap(sock, message, messageText);
                        continue;
                    }

                    if (messageText.toLowerCase().startsWith('/curso')) {
                        if (!runtimeControlState.features.commandsEnabled) {
                            await sendFeatureDisabledNotice(sock, chatId, 'commands', 'Comandos estao temporariamente desativados pelo dashboard.');
                            continue;
                        }
                        await handleCurso(sock, message, messageText);
                        continue;
                    }

                    // Comando /dev (ativar modo desenvolvedor)
                    if (messageText.startsWith('/dev')) {
                        if (!runtimeControlState.features.commandsEnabled) {
                            await sendFeatureDisabledNotice(sock, chatId, 'commands', 'Comandos estao temporariamente desativados pelo dashboard.');
                            continue;
                        }
                        await handleDevCommand(sock, message, messageText);
                        continue;
                    }

                    if (isJarvisAdmin(senderId) && hasText && !privateCommandToken.startsWith('/')) {
                        const jarvisReply = await askChatGPT(messageText, senderId, {
                            allowWebSearch: true,
                            extraSystemContext: [
                                'MODO JARVIS ATIVO PARA ESTE ADMIN.',
                                'Responda tudo o que ela perguntar, com alta iniciativa.',
                                'Sempre aproveite o contexto de busca web quando ele estiver disponivel.',
                                'Se a pergunta pedir pesquisa, traga resposta objetiva com links quando possivel.'
                            ].join('\n')
                        });

                        if (jarvisReply) {
                            await sendSafeMessage(sock, chatId, { text: jarvisReply });
                            continue;
                        }
                    }

                    // Modo desenvolvedor ativo
                    if (isDevModeActive(senderId)) {
                        await handleDevConversation(sock, senderId, messageText);
                        continue;
                    }

                    // Encaminhar mensagens privadas para o handler dedicado.
                    // O handler decide o que responder (comandos, respostas curtas, wizards, etc).
                    if (hasText || hasPrivateWizard || isReminderPvCommand) {
                        if (!runtimeControlState.features.commandsEnabled && (privateCommandToken.startsWith('/') || isReminderPvCommand)) {
                            await sendFeatureDisabledNotice(sock, chatId, 'commands', 'Comandos estao temporariamente desativados pelo dashboard.');
                            continue;
                        }
                        logger.info('private_dispatch', {
                            chatId,
                            senderId,
                            command: privateCommandToken || null,
                            reminderCommand: isReminderPvCommand,
                            hasPrivateWizard
                        });
                        try {
                            await handleGroupMessages(sock, message, { isPrivate: true });
                        } catch (error) {
                            console.error('[PV] Falha ao processar mensagem privada:', error?.stack || error?.message || String(error));
                            await sendSafeMessage(sock, chatId, { text: 'Erro interno ao processar mensagem no PV. Tente novamente.' });
                        }
                        continue;
                    }

                    continue;
                }

                // ========== 4. FLUXO DE GRUPO ==========
                // Mover leitura de arquivo para fora do loop de mensagens ou usar cache?
                // Vamos logar tudo para debug agora.

                processingStage = 'group';
                debugLog(`[DEBUG] Processando msg de ${senderId} no grupo ${chatId}`);

                // Carregar allowed_groups (ideal: mover para memoria global recarregavel)
                const allowedGroupsSnapshot = await refreshAllowedGroupsCache();
                const ALLOWED_GROUP_NAMES = allowedGroupsSnapshot.normalizedNames;
                const ALLOWED_GROUP_IDS = allowedGroupsSnapshot.groupIds;

                let groupSubject = null;
                let groupDescription = '';
                let groupMetadata = null;
                try {
                    groupMetadata = await getGroupMetadataCached(sock, chatId);
                    groupSubject = groupMetadata.subject || '';
                    groupDescription = String(groupMetadata.desc || '').trim();
                    debugLog(`[DEBUG] Nome do grupo obtido: "${groupSubject}"`);
                } catch (e) {
                    console.warn('Falha ao obter metadata do grupo:', e.message);
                }

                const normalizedGroupSubject = normalizeGroupName(groupSubject);
                const isAllowedByName = Boolean(groupSubject) && ALLOWED_GROUP_NAMES.has(normalizedGroupSubject);
                const isDefaultAllowedId = DEFAULT_INTEL_GROUPS.includes(chatId);
                const isAllowedById = ALLOWED_GROUP_IDS.has(chatId) || isDefaultAllowedId;
                if (!isAllowedByName && !isAllowedById) {
                    console.log(`Ignorado: Grupo "${groupSubject}" nao esta na lista permitida.`);
                    // DEBUG: Listar permitidos se falhar
                    // console.log('Permitidos:', Array.from(ALLOWED_GROUP_NAMES));

                    const normalizedTextForGate = String(messageText || '').trimStart();
                    if (normalizedTextForGate.toLowerCase().startsWith('/leads')) {
                        if (!runtimeControlState.features.commandsEnabled || !runtimeControlState.features.leadsEnabled) {
                            await sendFeatureDisabledNotice(sock, chatId, 'leads', 'Comandos de leads estao temporariamente desativados pelo dashboard.');
                            continue;
                        }
                        await leadEngine.handleLeadsCommand(sock, chatId);
                        continue;
                    }
                    if (normalizedTextForGate.startsWith('/')) {
                        const lastNoticeTs = unauthorizedGroupNoticeCooldown.get(chatId) || 0;
                        const nowTs = Date.now();
                        if (nowTs - lastNoticeTs >= UNAUTHORIZED_GROUP_NOTICE_MS) {
                            unauthorizedGroupNoticeCooldown.set(chatId, nowTs);
                            await sendSafeMessage(sock, chatId, {
                                text: 'Este grupo nao esta autorizado para comandos.\n\nPeca a um admin para adicionar o grupo na lista permitida.'
                            });
                        }
                    }
                    continue;
                }

                if (isAllowedByName && !ALLOWED_GROUP_IDS.has(chatId) && !isDefaultAllowedId) {
                    try {
                        const bindResult = await bindAllowedGroupId(groupSubject, chatId);
                        if (bindResult?.updated) {
                            await refreshAllowedGroupsCache(true);
                            console.log(`Grupo autorizado vinculado ao ID: "${groupSubject}" -> ${chatId}`);
                        }
                    } catch (error) {
                        console.warn('Falha ao vincular groupId ao grupo autorizado:', error?.message || String(error));
                    }
                }

                console.log('Grupo autorizado:', groupSubject);
                if (isGroupBotPaused(chatId)) {
                    continue;
                }
                const isRestrictedGroup = isRestrictedGroupName(groupSubject);
                if (isRestrictedGroup) {
                    console.log(`Modo restrito ativo para o grupo: "${groupSubject}"`);
                }
                const groupPermissions = await getAllowedGroupPermissions(groupSubject, chatId);
                const canReadForLeads = Boolean(groupPermissions?.leadsRead);
                const canReadForEngagement = Boolean(groupPermissions?.engagement);

                // Captura para engine de leads/engajamento somente com autorizacao por grupo.
                if (runtimeControlState.features.leadsEnabled && (canReadForLeads || canReadForEngagement)) {
                    try {
                        leadEngine.processMessage(message, chatId, groupSubject || chatId);
                    } catch (e) {
                        console.warn('[LEADS] Falha ao capturar mensagem de grupo:', e.message || String(e));
                    }
                }

                // Salva toda mensagem de texto de grupos autorizados (incluindo comandos).
                publishInteractionForDashboard(message, senderId, groupSubject, chatId, messageTimestamp, messageText);
                const trimmedText = String(messageText || '').trimStart();
                if (trimmedText && !trimmedText.startsWith('/')) {
                    captureGroupKnowledge({
                        groupId: chatId,
                        groupName: groupSubject || chatId,
                        senderId,
                        senderName: resolveParticipantName(message, senderId),
                        timestamp: messageTimestamp,
                        messageId,
                        text: messageText
                    });

                    trackGroupMessage({
                        groupId: chatId,
                        groupName: groupSubject || chatId,
                        senderId,
                        senderName: resolveParticipantName(message, senderId),
                        timestamp: messageTimestamp,
                        messageId
                    });
                }

                // 4.1. COMANDOS (prioridade maxima - moderacao sempre roda)
                const isCommand = trimmedText.startsWith('/');
                debugLog(`[DEBUG] isCommand? ${isCommand} | Texto: ${messageText.substring(0, 20)}`);

                if (isCommand) {
                    if (!runtimeControlState.features.commandsEnabled) {
                        await sendFeatureDisabledNotice(sock, chatId, 'commands', 'Comandos estao temporariamente desativados pelo dashboard.');
                        continue;
                    }
                    console.log('COMANDO detectado:', messageText.split(' ')[0]);

                    if (messageText.toLowerCase().startsWith('/leads')) {
                        if (!runtimeControlState.features.leadsEnabled) {
                            await sendFeatureDisabledNotice(sock, chatId, 'leads', 'Comandos de leads estao temporariamente desativados pelo dashboard.');
                            continue;
                        }
                        if (!canReadForLeads) {
                            await sendSafeMessage(sock, chatId, { text: 'Este grupo esta sem permissao para leitura de leads.' });
                            continue;
                        }
                        await leadEngine.handleLeadsCommand(sock, chatId);
                        continue;
                    }
                    if (messageText.toLowerCase().startsWith('/engajamento')) {
                        if (!runtimeControlState.features.leadsEnabled) {
                            await sendFeatureDisabledNotice(sock, chatId, 'leads', 'Comandos de leads estao temporariamente desativados pelo dashboard.');
                            continue;
                        }
                        if (!canReadForEngagement) {
                            await sendSafeMessage(sock, chatId, { text: 'Este grupo esta sem permissao para leitura de engajamento.' });
                            continue;
                        }
                        await leadEngine.handleEngagementCommand(sock, chatId, {
                            allowedGroupNames: Array.from(ALLOWED_GROUP_NAMES)
                        });
                        continue;
                    }

                    // Comando DEV (funciona em grupo e privado)
                    if (!isRestrictedGroup && messageText.toLowerCase().startsWith('/dev')) {
                        await handleDevCommand(sock, message, messageText);
                        continue;
                    }

                    // Processar comando
                    await handleGroupMessages(sock, message, { groupSubject, isRestrictedGroup });
                    // Nao continue aqui - deixar moderacao rodar
                }

                if (isRestrictedGroup) {
                    // Neste grupo, o bot so atende funcoes especificas tratadas no groupResponder.
                    // Inclui comandos cripto e mencao explicita ao @IMAVY.
                    if (!isCommand) {
                        await handleGroupMessages(sock, message, { groupSubject, isRestrictedGroup });
                    }
                    continue;
                }

                if (runtimeControlState.features.moderationEnabled && groupPermissions.spam) {
                    if (!senderId || senderId === chatId) {
                        logger.warn('moderation_sender_unresolved', {
                            chatId,
                            messageId,
                            senderId
                        });
                        continue;
                    }
                    // 4.2. MODERACAO MINIMALISTA (2 regras: REPEAT + LINK)
                    // Verificar se e admin do bot ou do grupo
                    let isUserAdmin = false;
                    try {
                        const isBotAdmin = await isAuthorized(senderId);
                        const isGroupAdmin = await isSenderGroupAdmin(sock, chatId, senderId, groupMetadata);
                        isUserAdmin = isBotAdmin || isGroupAdmin;
                    } catch (e) {
                        console.error('Erro ao verificar admin:', e.message);
                    }

                    // Aplicar anti-spam
                    const violation = await checkViolation(messageText, chatId, senderId, isUserAdmin);

                    if (violation.violated) {
                        console.log(`VIOLACAO: ${violation.rule} - User: ${senderId}`);

                        // Deletar mensagem
                        let deleteError = null;
                        try {
                            const deleted = await sendSafeMessage(sock, chatId, { delete: message.key });
                            if (!deleted) {
                                throw new Error('delete retornou vazio');
                            }
                            console.log('Mensagem deletada');
                        } catch (e) {
                            deleteError = 'Nao consegui apagar a mensagem (sem permissao).';
                            console.error('Erro ao deletar:', e.message);
                        }

                        // Adicionar strike
                        const strikeCount = addStrike(chatId, senderId, violation.rule, messageText);
                        console.log(`Strike aplicado: ${strikeCount}/3`);

                        // Aviso no grupo
                        let warning = `⚠️ Violacao das regras do grupo. (Strike ${strikeCount}/3)`;
                        if (violation.rule === 'LINK') {
                            warning = `🚫 Links nao sao permitidos. (Strike ${strikeCount}/3)`;
                        } else if (violation.rule === 'FLOOD_REPEAT') {
                            warning = `⚠️ Flood detectado: 3 mensagens iguais em menos de 1 minuto. (Strike ${strikeCount}/3)`;
                        } else if (violation.rule === 'FLOOD_VOLUME') {
                            warning = `⚠️ Flood detectado: 10 mensagens em menos de 1 minuto. (Strike ${strikeCount}/3)`;
                        } else if (violation.rule?.startsWith('DESC_')) {
                            warning = `⚠️ Mensagem viola regras da descricao deste grupo. (Strike ${strikeCount}/3)`;
                        }

                        try {
                            await sendSafeMessage(sock, chatId, { text: warning });
                        } catch (e) {
                            console.error('Erro ao enviar aviso:', e.message);
                        }

                        // Notificar admins
                        await notifyAdmins(sock, chatId, senderId, violation.rule, strikeCount, messageText, deleteError);

                        // Aplicar punicao se 3/3
                        if (strikeCount >= 3) {
                            await applyPunishment(sock, chatId, senderId, strikeCount);
                        }

                        // Bloquear processamento de comandos
                        continue;
                    }
                }



                // Se foi comando e nao violou, ja foi processado
                if (isCommand) {
                    continue;
                }

                // Mensagens nao-comando podem acionar o IMAVY via mencao explicita.
                await handleGroupMessages(sock, message, { groupSubject, isRestrictedGroup });
            } finally {
                logger.debug('msg_processed', {
                    chatId,
                    messageId,
                    isGroup,
                    ms: Date.now() - processingStart,
                    stage: processingStage
                });
            }
        }
    });

    // Evento para detectar novos membros no grupo
    // Periodo de tolerancia de inicializacao (10s) para evitar processar historico
    const BOOT_GRACE_PERIOD = Date.now() + 10000;

    sock.ev.on('group-participants.update', async (update) => {
        try {
            // Ignorar eventos antigos ou durante inicializacao
            if (Date.now() < BOOT_GRACE_PERIOD) {
                console.log('Ignorando evento de participantes durante inicializacao...');
                return;
            }

            console.log('Atualizacao de participantes:', JSON.stringify(update, null, 2));
            const { id: groupId, participants, action } = update;

            // Delegar para o handler inteligente com batch
            if (action === 'add' || action === 'invite' || action === 'join') {
                await maybeHandleWelcomeParticipants(sock, groupId, participants);
            }
        } catch (error) {
            console.error('Erro no evento de participantes:', error);
        }
    });

    // Evento alternativo para capturar mudancas no grupo
    sock.ev.on('groups.update', async (updates) => {
        console.log('Atualizacao de grupos:', JSON.stringify(updates, null, 2));
        });
    } finally {
        startBotInFlight = false;
    }
}

startBot();
