// index.js
console.log('[DEBUG] Carregando index.js...');
import 'dotenv/config';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
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

import { handleGroupMessages, initLembretes, hasPendingPrivateWizard } from './functions/groupResponder.js';
import { isAuthorized, getAllowedGroupPermissions } from './functions/adminCommands.js';
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
import { handleConnectionUpdate, resetReconnectAttempts } from './functions/connectionManager.js';
import { startHealthMonitor, startSessionBackup, setConnected, updateHeartbeat, restoreSessionFromBackup, clearSessionBackup } from './keepalive.js';
import { handleDevCommand, isDev, isDevModeActive, handleDevConversation } from './functions/devCommands.js';
import { isRestrictedGroupName } from './functions/groupPolicy.js';
import { publishRealtimeInteraction } from './functions/realtimeRankingStore.js';
import { startBuyAlertNotifier, stopBuyAlertNotifier } from './functions/buyAlertNotifier.js';
import { createIntelEngine, getIntelEventBuffer, storeIntelEvent } from './src/intelligence/intelEngine.js';
import { createLeadEngine } from './src/intelligence/leadEngine.js';

console.log('[IA] Moderacao:', isAIEnabled() ? 'ATIVA (Groq)' : 'Desabilitada');
console.log('[IA] Vendas:', isAISalesEnabled() ? 'ATIVA (Groq)' : 'Desabilitada');

const DEFAULT_INTEL_GROUPS = [
    "120363394030123512@g.us",
    "120363418891665714@g.us"
];
const INTEL_GROUPS = String(process.env.INTEL_GROUPS || DEFAULT_INTEL_GROUPS.join(','))
    .split(',')
    .map((groupId) => groupId.trim())
    .filter(Boolean);
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

async function readJsonBody(req, maxBytes = 64 * 1024) {
    let body = '';
    for await (const chunk of req) {
        body += chunk;
        if (body.length > maxBytes) {
            throw new Error('Payload muito grande para /intel-event');
        }
    }

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

// Timestamp de inicializacao do bot para ignorar mensagens antigas
const botStartTime = Date.now();
const unauthorizedGroupNoticeCooldown = new Map();
const UNAUTHORIZED_GROUP_NOTICE_MS = parseInt(process.env.UNAUTHORIZED_GROUP_NOTICE_MS || '180000', 10);
const ALLOWED_GROUPS_CACHE_TTL_MS = Math.max(5_000, parseInt(process.env.ALLOWED_GROUPS_CACHE_TTL_MS || '15000', 10));
const featureDisabledNoticeCooldown = new Map();
const FEATURE_DISABLED_NOTICE_MS = Math.max(30_000, parseInt(process.env.FEATURE_DISABLED_NOTICE_MS || '120000', 10));

const allowedGroupsState = {
    normalizedNames: new Set(),
    groupIds: new Set(),
    loadedAt: 0,
    loadingPromise: null,
    source: 'file'
};

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

    const conversation = sanitizeIncomingText(content.conversation);
    if (conversation) return conversation;

    const extendedText = sanitizeIncomingText(content?.extendedTextMessage?.text);
    if (extendedText) return extendedText;

    return '';
}

function loadAllowedGroupNames() {
    const allowed = new Set();
    try {
        const allowedPath = path.join(__dirname, 'allowed_groups.json');
        if (!fs.existsSync(allowedPath)) {
            return allowed;
        }
        const parsed = JSON.parse(fs.readFileSync(allowedPath, 'utf8'));
        if (Array.isArray(parsed)) {
            parsed
                .map((entry) => {
                    if (typeof entry === 'string') return entry;
                    if (entry && typeof entry === 'object' && typeof entry.name === 'string') return entry.name;
                    return '';
                })
                .map(normalizeGroupName)
                .filter(Boolean)
                .forEach((name) => allowed.add(name));
        }
    } catch (e) {
        console.warn('Falha ao ler allowed_groups.json:', e.message);
    }
    return allowed;
}

function getAllowedGroupsSnapshot() {
    if (allowedGroupsState.loadedAt <= 0 || allowedGroupsState.normalizedNames.size === 0) {
        const local = loadAllowedGroupNames();
        allowedGroupsState.normalizedNames = local;
        allowedGroupsState.groupIds = new Set();
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
        const localNames = loadAllowedGroupNames();
        const normalizedNames = new Set(localNames);
        const groupIds = new Set();
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

async function startBot() {
    console.log("===============================================");
    console.log('Iniciando iMavyAgent - Respostas Pre-Definidas');
    console.log("===============================================");

    console.log('[DEBUG] ensureCoreConfigFiles...');
    await ensureCoreConfigFiles();
    await refreshAllowedGroupsCache(true);

    console.log('[DEBUG] restoreSessionFromBackup...');
    // Tentar restaurar sessao do backup se necessario
    restoreSessionFromBackup();

    console.log('[DEBUG] useMultiFileAuthState...');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    console.log('[DEBUG] fetchLatestBaileysVersion...');
    const { version } = await fetchLatestBaileysVersion();

    console.log('[DEBUG] Criando socket...');

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
            // Best practice: never fabricate an empty text message as fallback.
            // Returning undefined avoids phantom blank payloads during retry flows.
            return undefined;
        }
    });

    // Anexar guarda de saida (Monkey Patch)
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
            logger.info('Conectado ao WhatsApp');
            resetReconnectAttempts();
            setConnected(true);

            // Iniciar servicos apenas uma vez apos conexao bem-sucedida
            try {
                scheduleGroupMessages(sock);
                scheduleBackups();
                startScheduler(sock);
                // Iniciar sistema de lembretes com socket valido
                initLembretes(sock);
                scheduleSupabaseBackup();
                startAutoPromo(sock);
                startHealthMonitor();
                startSessionBackup();
                await startBuyAlertNotifier(sock, {
                    onBuyProcessed: async (buyEvent) => {
                        await intelEngine.registerOnchainBuy(buyEvent);
                    }
                });
                console.log('Todos os servicos iniciados com sucesso');
            } catch (e) {
                console.error('Erro ao iniciar servicos:', e.message);
            }
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            setConnected(false);
            await stopBuyAlertNotifier();

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

    // Evento de mensagens recebidas
    sock.ev.on('messages.upsert', async (msgUpsert) => {
        if (msgUpsert?.type && msgUpsert.type !== 'notify') {
            return;
        }

        const messages = Array.isArray(msgUpsert?.messages) ? msgUpsert.messages : [];

        // Atualizar heartbeat a cada mensagem processada
        updateHeartbeat();

        for (const message of messages) {
            // ========== 1. FILTROS INICIAIS (Fast Return) ==========
            if (!message.message) continue;
            if (message.key.fromMe) continue;
            if (!message.key.remoteJid) continue;
            if (message.key.remoteJid === 'status@broadcast') continue;
            if (message.key.remoteJid.endsWith('@broadcast')) continue;
            if (message.messageStubType !== undefined && message.messageStubType !== null) continue;

            const unwrappedContent = unwrapIncomingMessageContent(message.message);
            if (!unwrappedContent) continue;
            if (unwrappedContent.protocolMessage) continue;
            if (unwrappedContent.senderKeyDistributionMessage) continue;

            const messageTimestamp = message.messageTimestamp ? parseInt(message.messageTimestamp) * 1000 : Date.now();
            if (messageTimestamp < botStartTime) continue;

            // ========== 2. SEPARACAO DE CONTEXTO ==========
            const isGroup = message.key.remoteJid?.endsWith('@g.us');
            const senderId = message.key.participant || message.key.remoteJid;
            const chatId = message.key.remoteJid;

            // Extrair texto apenas de conversation/extendedTextMessage.text
            const messageText = extractProcessableIncomingText(message);
            if (!messageText) continue;

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
                    const privateText = String(messageText || '').trim().toLowerCase();
                    const privateCommandToken = privateText.split(/\s+/)[0] || '';

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

                    // Comando /dev (ativar modo desenvolvedor)
                    if (messageText.startsWith('/dev')) {
                        if (!runtimeControlState.features.commandsEnabled) {
                            await sendFeatureDisabledNotice(sock, chatId, 'commands', 'Comandos estao temporariamente desativados pelo dashboard.');
                            continue;
                        }
                        await handleDevCommand(sock, message, messageText);
                        continue;
                    }

                    // Modo desenvolvedor ativo
                    if (isDevModeActive(senderId)) {
                        await handleDevConversation(sock, senderId, messageText);
                        continue;
                    }

                    // Encaminhar qualquer slash-command no PV para o handler dedicado de comandos.
                    if (privateCommandToken.startsWith('/')) {
                        if (!runtimeControlState.features.commandsEnabled) {
                            await sendFeatureDisabledNotice(sock, chatId, 'commands', 'Comandos estao temporariamente desativados pelo dashboard.');
                            continue;
                        }
                        await handleGroupMessages(sock, message, { isPrivate: true });
                        continue;
                    }

                    // Encaminhar respostas de fluxos guiados ativos (ex.: /lamina, /adicionargrupo) no PV.
                    if (hasPendingPrivateWizard(senderId)) {
                        if (!runtimeControlState.features.commandsEnabled) {
                            await sendFeatureDisabledNotice(sock, chatId, 'commands', 'Comandos estao temporariamente desativados pelo dashboard.');
                            continue;
                        }
                        await handleGroupMessages(sock, message, { isPrivate: true });
                        continue;
                    }

                    // Ignorar mensagens privadas (atendimento desabilitado)
                    continue;
                }

                // ========== 4. FLUXO DE GRUPO ==========
                // Mover leitura de arquivo para fora do loop de mensagens ou usar cache?
                // Vamos logar tudo para debug agora.

                processingStage = 'group';
                console.log(`[DEBUG] Processando msg de ${senderId} no grupo ${chatId}`);

                // Carregar allowed_groups (ideal: mover para memoria global recarregavel)
                const allowedGroupsSnapshot = await refreshAllowedGroupsCache();
                const ALLOWED_GROUP_NAMES = allowedGroupsSnapshot.normalizedNames;
                const ALLOWED_GROUP_IDS = allowedGroupsSnapshot.groupIds;

                let groupSubject = null;
                let groupDescription = '';
                let groupMetadata = null;
                try {
                    groupMetadata = await sock.groupMetadata(chatId);
                    groupSubject = groupMetadata.subject || '';
                    groupDescription = String(groupMetadata.desc || '').trim();
                    console.log(`[DEBUG] Nome do grupo obtido: "${groupSubject}"`);
                } catch (e) {
                    console.warn('Falha ao obter metadata do grupo:', e.message);
                }

                // Captura dados de lead para qualquer grupo (permitido ou nao permitido)
                if (runtimeControlState.features.leadsEnabled) {
                    try {
                        leadEngine.processMessage(message, chatId, groupSubject || chatId);
                    } catch (e) {
                        console.warn('[LEADS] Falha ao capturar mensagem de grupo:', e.message || String(e));
                    }
                }

                const normalizedGroupSubject = normalizeGroupName(groupSubject);
                const isAllowedByName = Boolean(groupSubject) && ALLOWED_GROUP_NAMES.has(normalizedGroupSubject);
                const isAllowedById = ALLOWED_GROUP_IDS.has(chatId);
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

                console.log('Grupo autorizado:', groupSubject);
                const isRestrictedGroup = isRestrictedGroupName(groupSubject);
                if (isRestrictedGroup) {
                    console.log(`Modo restrito ativo para o grupo: "${groupSubject}"`);
                }
                const groupPermissions = await getAllowedGroupPermissions(groupSubject);

                // Salva toda mensagem de texto de grupos autorizados (incluindo comandos).
                publishInteractionForDashboard(message, senderId, groupSubject, chatId, messageTimestamp, messageText);

                // 4.1. COMANDOS (prioridade maxima - moderacao sempre roda)
                const isCommand = String(messageText || '').trimStart().startsWith('/');
                console.log(`[DEBUG] isCommand? ${isCommand} | Texto: ${messageText.substring(0, 20)}`);

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
                        await leadEngine.handleLeadsCommand(sock, chatId);
                        continue;
                    }
                    if (messageText.toLowerCase().startsWith('/engajamento')) {
                        if (!runtimeControlState.features.leadsEnabled) {
                            await sendFeatureDisabledNotice(sock, chatId, 'leads', 'Comandos de leads estao temporariamente desativados pelo dashboard.');
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
                    // 4.2. MODERACAO MINIMALISTA (2 regras: REPEAT + LINK)
                    // Verificar se e admin do bot ou do grupo
                    let isUserAdmin = false;
                    try {
                        const isBotAdmin = await isAuthorized(senderId);
                        const metadataForAdmin = groupMetadata || await sock.groupMetadata(chatId);
                        const participant = metadataForAdmin.participants.find(p => p.id === senderId);
                        const isGroupAdmin = participant?.admin === 'admin' || participant?.admin === 'superadmin';
                        isUserAdmin = isBotAdmin || isGroupAdmin;
                    } catch (e) {
                        console.error('Erro ao verificar admin:', e.message);
                    }

                    // Aplicar anti-spam
                    const violation = checkViolation(messageText, chatId, senderId, isUserAdmin);

                    if (violation.violated) {
                        console.log(`VIOLACAO: ${violation.rule} - User: ${senderId}`);

                        // Deletar mensagem
                        let deleteError = null;
                        try {
                            await sendSafeMessage(sock, chatId, { delete: message.key });
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
            if (action === 'add') {
                let groupSubject = '';
                try {
                    const groupMetadata = await sock.groupMetadata(groupId);
                    groupSubject = groupMetadata?.subject || '';
                } catch (e) {
                    console.warn('Nao foi possivel obter nome do grupo para filtro de boas-vindas:', e.message);
                }

                if (isRestrictedGroupName(groupSubject)) {
                    console.log(`Boas-vindas desativadas no grupo restrito: "${groupSubject}"`);
                    return;
                }

                handleWelcomeEvent(sock, groupId, participants);
            }
        } catch (error) {
            console.error('Erro no evento de participantes:', error);
        }
    });

    // Evento alternativo para capturar mudancas no grupo
    sock.ev.on('groups.update', async (updates) => {
        console.log('Atualizacao de grupos:', JSON.stringify(updates, null, 2));
    });
}

startBot();
