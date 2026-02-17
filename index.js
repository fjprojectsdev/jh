// index.js
console.log('Ã°Å¸â€Â¥ [DEBUG] Carregando index.js...');
import 'dotenv/config';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, getContentType } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendSafeMessage } from './functions/messageHandler.js';
import { attachOutgoingGuard } from './functions/outgoingGuard.js';
import { checkViolation, getText, notifyAdmins, addStrike, getStrikes, applyPunishment } from './functions/antiSpam.js';
import { handleWelcomeEvent } from './functions/welcomeMessage.js';
import { getGroupStatus } from './functions/groupStats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { handleGroupMessages, initLembretes } from './functions/groupResponder.js';
import { isAuthorized } from './functions/adminCommands.js';
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

console.log('Ã°Å¸Â¤â€“ IA de ModeraÃƒÂ§ÃƒÂ£o:', isAIEnabled() ? 'Ã¢Å“â€¦ ATIVA (Groq)' : 'Ã¢ÂÅ’ Desabilitada');
console.log('Ã°Å¸â€™Â¼ IA de Vendas:', isAISalesEnabled() ? 'Ã¢Å“â€¦ ATIVA (Groq)' : 'Ã¢ÂÅ’ Desabilitada');

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

function hasDashboardWebhookConfigured() {
    return String(process.env.DASHBOARD_WEBHOOK_URL || '').trim() !== '';
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

    if (!hasDashboardWebhookConfigured() && requestUrl.startsWith('/intel-event')) {
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

    if (requestUrl === '/qr' && qrCodeData) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#000"><img src="${qrCodeData}" style="max-width:90%;max-height:90%"></body></html>`);
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Bot WhatsApp iMavyAgent - Online\n\nAcesse /qr para ver o QR Code');
    }
}).listen(PORT, () => {
    console.log(`Ã°Å¸Å’Â Servidor HTTP rodando na porta ${PORT}`);
});

// VariÃƒÂ¡vel para armazenar o servidor HTTP temporÃƒÂ¡rio
let qrServer = null;
let qrCodeData = null;

// Timestamp de inicializaÃƒÂ§ÃƒÂ£o do bot para ignorar mensagens antigas
const botStartTime = Date.now();
const unauthorizedGroupNoticeCooldown = new Map();
const UNAUTHORIZED_GROUP_NOTICE_MS = parseInt(process.env.UNAUTHORIZED_GROUP_NOTICE_MS || '180000', 10);

function normalizeGroupName(name) {
    return String(name || '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
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
        console.warn('Ã¢Å¡Â Ã¯Â¸Â Falha ao publicar interaÃƒÂ§ÃƒÂ£o em tempo real:', error.message);
    });
}

async function startBot() {
    console.log("===============================================");
    console.log("Ã°Å¸Å¡â‚¬ Iniciando iMavyAgent - Respostas PrÃƒÂ©-Definidas");
    console.log("===============================================");

    console.log('Ã¢ÂÂ³ [DEBUG] ensureCoreConfigFiles...');
    await ensureCoreConfigFiles();

    console.log('Ã¢ÂÂ³ [DEBUG] restoreSessionFromBackup...');
    // Tentar restaurar sessÃƒÂ£o do backup se necessÃƒÂ¡rio
    restoreSessionFromBackup();

    console.log('Ã¢ÂÂ³ [DEBUG] useMultiFileAuthState...');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    console.log('Ã¢ÂÂ³ [DEBUG] fetchLatestBaileysVersion...');
    const { version } = await fetchLatestBaileysVersion();

    console.log('Ã¢ÂÂ³ [DEBUG] Criando socket...');

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
            return { conversation: '' };
        }
    });

    // Anexar guarda de saÃƒÂ­da (Monkey Patch)
    attachOutgoingGuard(sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && connection !== 'open') {
            console.log("\nÃ¢â€¢â€Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢â€”");
            console.log("Ã¢â€¢â€˜           Ã°Å¸â€Â AUTENTICAÃƒâ€¡ÃƒÆ’O WHATSAPP REQUERIDA Ã°Å¸â€Â              Ã¢â€¢â€˜");
            console.log("Ã¢â€¢Â Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â£");
            console.log("Ã¢â€¢â€˜ Escaneie este QR code no WhatsApp Web                      Ã¢â€¢â€˜");
            console.log("Ã¢â€¢Å¡Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â\n");

            qrcode.generate(qr, { small: true });

            try {
                qrCodeData = await QRCode.toDataURL(qr, { width: 600 });
                console.log("\nÃ°Å¸â€â€” QR CODE DISPONÃƒÂVEL EM:");
                console.log(`http://localhost:${PORT}/qr`);
                console.log("\nÃ¢Å¡Â Ã¯Â¸Â O QR code fica disponÃƒÂ­vel por 60 segundos\n");
            } catch (e) {
                console.log("Erro ao gerar link QR:", e.message);
            }

            // Detectar se estÃƒÂ¡ no Railway ou produÃƒÂ§ÃƒÂ£o
            const isProduction = process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';

            if (isProduction) {
                // Em produÃƒÂ§ÃƒÂ£o (Railway), mostrar QR code compacto + base64
                qrcode.generate(qr, { small: true });

                try {
                    // Gerar base64 do QR code para copiar/colar
                    const qrImageDataUrl = await QRCode.toDataURL(qr, {
                        width: 400,
                        margin: 2
                    });

                    console.log("\nÃ°Å¸â€â€” LINK BASE64 DO QR CODE (copie e cole no navegador):");
                    console.log(qrImageDataUrl);
                    console.log("\nÃ°Å¸â€™Â¡ Copie o link acima, cole na barra de endereÃƒÂ§os do navegador e escaneie\n");
                } catch (error) {
                    console.log("\nÃ°Å¸â€™Â¡ Escaneie o QR code acima com o WhatsApp Web\n");
                }
            } else {
                // Local, mostrar QR code maior + servidor HTTP
                qrcode.generate(qr, { small: false });

                try {
                    // Gerar imagem do QR code em base64 (tamanho maior)
                    const qrImageDataUrl = await QRCode.toDataURL(qr, {
                        width: 800,
                        margin: 4,
                        color: {
                            dark: '#000000',
                            light: '#FFFFFF'
                        }
                    });

                    // Extrair apenas os dados base64 (remover o prefixo data:image/png;base64,)
                    const qrImageBase64 = qrImageDataUrl.split(',')[1];
                    const qrImageBuffer = Buffer.from(qrImageBase64, 'base64');

                    // Fechar servidor anterior se existir
                    if (qrServer) {
                        qrServer.close(() => {
                            console.log('Ã°Å¸â€â€ž Servidor QR anterior fechado');
                        });
                        qrServer = null;
                    }

                    // Criar servidor HTTP temporÃƒÂ¡rio
                    const port = process.env.QR_SERVER_PORT || 3001;

                    qrServer = http.createServer((req, res) => {
                        if (req.url === '/qr' || req.url === '/qr.png' || req.url === '/') {
                            res.writeHead(200, {
                                'Content-Type': 'image/png',
                                'Content-Length': qrImageBuffer.length,
                                'Cache-Control': 'no-cache',
                                'Access-Control-Allow-Origin': '*'
                            });
                            res.end(qrImageBuffer);
                        } else {
                            res.writeHead(404, { 'Content-Type': 'text/plain' });
                            res.end('Not Found');
                        }
                    });

                    qrServer.on('error', (err) => {
                        if (err.code === 'EADDRINUSE') {
                            console.error(`Ã¢ÂÅ’ Porta ${port} jÃƒÂ¡ estÃƒÂ¡ em uso. Tente usar outra porta.`);
                        } else {
                            console.error('Ã¢ÂÅ’ Erro no servidor QR code:', err);
                        }
                    });

                    qrServer.listen(port, '0.0.0.0', () => {
                        const localUrl = `http://localhost:${port}/qr.png`;

                        // Obter IP da rede local
                        const networkInterfaces = os.networkInterfaces();
                        let networkIp = null;
                        for (const interfaceName of Object.keys(networkInterfaces)) {
                            for (const iface of networkInterfaces[interfaceName]) {
                                if (iface.family === 'IPv4' && !iface.internal) {
                                    networkIp = iface.address;
                                    break;
                                }
                            }
                            if (networkIp) break;
                        }

                        const networkUrl = networkIp ? `http://${networkIp}:${port}/qr.png` : null;

                        console.log("\nÃ¢â€¢â€Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢â€”");
                        console.log("Ã¢â€¢â€˜                    Ã°Å¸â€â€” LINK DE ACESSO Ã°Å¸â€â€”                     Ã¢â€¢â€˜");
                        console.log("Ã¢â€¢Â Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â£");
                        console.log("Ã¢â€¢â€˜ OpÃƒÂ§ÃƒÂ£o 1: Escaneie o QR code acima no WhatsApp             Ã¢â€¢â€˜");
                        console.log("Ã¢â€¢â€˜                                                             Ã¢â€¢â€˜");
                        console.log("Ã¢â€¢â€˜ OpÃƒÂ§ÃƒÂ£o 2: Acesse o link abaixo para ver a imagem do QR:    Ã¢â€¢â€˜");
                        console.log("Ã¢â€¢â€˜                                                             Ã¢â€¢â€˜");
                        console.log(`Ã¢â€¢â€˜ ${localUrl}`);
                        if (networkUrl) {
                            console.log("Ã¢â€¢â€˜                                                             Ã¢â€¢â€˜");
                            console.log("Ã¢â€¢â€˜ Link alternativo (rede local):                             Ã¢â€¢â€˜");
                            console.log(`Ã¢â€¢â€˜ ${networkUrl}`);
                        }
                        console.log("Ã¢â€¢â€˜                                                             Ã¢â€¢â€˜");
                        console.log("Ã¢â€¢Å¡Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â\n");
                        console.log("Ã°Å¸â€™Â¡ Dica: Abra o link no navegador para ver a imagem do QR code");
                        console.log("   e escaneie com o WhatsApp Web.\n");
                    });

                } catch (error) {
                    console.error('Ã¢ÂÅ’ Erro ao criar servidor QR code:', error);
                    console.log("\nÃ¢â€¢â€Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢â€”");
                    console.log("Ã¢â€¢â€˜                    Ã¢Å¡Â Ã¯Â¸Â  INFORMAÃƒâ€¡ÃƒÆ’O Ã¢Å¡Â Ã¯Â¸Â                        Ã¢â€¢â€˜");
                    console.log("Ã¢â€¢Â Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â£");
                    console.log("Ã¢â€¢â€˜ Por favor, escaneie o QR code acima no WhatsApp Web        Ã¢â€¢â€˜");
                    console.log("Ã¢â€¢â€˜ O QR code contÃƒÂ©m dados de autenticaÃƒÂ§ÃƒÂ£o que precisam ser   Ã¢â€¢â€˜");
                    console.log("Ã¢â€¢â€˜ escaneados diretamente pelo aplicativo WhatsApp.         Ã¢â€¢â€˜");
                    console.log("Ã¢â€¢Å¡Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â\n");
                }
            }
        }

        // Fechar servidor quando conectar
        if (connection === 'open' && qrServer) {
            console.log('Ã°Å¸â€â€™ Fechando servidor QR code temporÃƒÂ¡rio...');
            qrServer.close();
            qrServer = null;
        }

        console.log('Ã°Å¸â€œÂ¡ Status da conexÃƒÂ£o:', connection);

        if (connection === 'open') {
            logger.info('Conectado ao WhatsApp');
            resetReconnectAttempts();
            setConnected(true);

            // Iniciar serviÃƒÂ§os apenas uma vez apÃƒÂ³s conexÃƒÂ£o bem-sucedida
            try {
                scheduleGroupMessages(sock);
                scheduleBackups();
                startScheduler(sock);
                // Iniciar sistema de lembretes com socket vÃƒÂ¡lido
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
                console.log('Ã¢Å“â€¦ Todos os serviÃƒÂ§os iniciados com sucesso');
            } catch (e) {
                console.error('Ã¢ÂÅ’ Erro ao iniciar serviÃƒÂ§os:', e.message);
            }
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            setConnected(false);
            await stopBuyAlertNotifier();

            if (reason === DisconnectReason.loggedOut) {
                console.log('Ã¢Å¡Â Ã¯Â¸Â SessÃƒÂ£o desconectada manualmente. Deletando credenciais antigas...');
                try {
                    const authPath = path.join(__dirname, 'auth_info');
                    if (fs.existsSync(authPath)) {
                        fs.rmSync(authPath, { recursive: true, force: true });
                        console.log('Ã°Å¸â€”â€˜Ã¯Â¸Â Credenciais antigas removidas');
                    }
                    // TambÃƒÂ©m limpar o backup para evitar loop de restauraÃƒÂ§ÃƒÂ£o
                    clearSessionBackup();
                } catch (e) {
                    console.error('Erro ao remover credenciais:', e.message);
                }
                console.log('Ã°Å¸â€â€ž Reiniciando para gerar novo QR code...');
                setTimeout(() => startBot(), 3000);
            } else {
                // Usar gerenciador de conexÃƒÂ£o para reconexÃƒÂµes automÃƒÂ¡ticas
                handleConnectionUpdate(update, startBot);
            }
        }
    });

    // Evento de mensagens recebidas
    sock.ev.on('messages.upsert', async (msgUpsert) => {
        const messages = msgUpsert.messages;

        // Atualizar heartbeat a cada mensagem processada
        updateHeartbeat();

        for (const message of messages) {
            // ========== 1. FILTROS INICIAIS (Fast Return) ==========
            if (!message.message) continue;
            if (message.key.fromMe) continue;

            const messageTimestamp = message.messageTimestamp ? parseInt(message.messageTimestamp) * 1000 : Date.now();
            if (messageTimestamp < botStartTime) continue;

            // ========== 2. SEPARAÃƒâ€¡ÃƒÆ’O DE CONTEXTO ==========
            const isGroup = message.key.remoteJid?.endsWith('@g.us');
            const senderId = message.key.participant || message.key.remoteJid;
            const chatId = message.key.remoteJid;

            if (isGroup && INTEL_GROUPS.includes(chatId)) {
                try {
                    await intelEngine.processMessage(message, chatId);
                } catch (error) {
                    console.warn('[INTEL] Falha ao processar mensagem social:', error.message || String(error));
                }
            }

            // Extrair texto usando getText()
            const messageText = getText(message);
            if (!messageText) continue;

            // ========== 3. FLUXO PRIVADO (VENDAS) - DESABILITADO ==========
            if (!isGroup) {
                if (messageText.toLowerCase().startsWith('/leads')) {
                    await leadEngine.handleLeadsCommand(sock, chatId);
                    continue;
                }

                // Comando /dev (ativar modo desenvolvedor)
                if (messageText.startsWith('/dev')) {
                    await handleDevCommand(sock, message, messageText);
                    continue;
                }

                // Modo desenvolvedor ativo
                if (isDevModeActive(senderId)) {
                    await handleDevConversation(sock, senderId, messageText);
                    continue;
                }

                // Ignorar mensagens privadas (atendimento desabilitado)
                continue;
            }

            // ========== 4. FLUXO DE GRUPO ==========
            // Mover leitura de arquivo para fora do loop de mensagens ou usar cache?
            // Vamos logar tudo para debug agora.

            console.log(`Ã°Å¸â€Â DEBUG: Processando msg de ${senderId} no grupo ${chatId}`);

            // Carregar allowed_groups (Ideal: mover par memÃƒÂ³ria global recarregÃƒÂ¡vel)
            let ALLOWED_GROUP_NAMES = new Set();
            try {
                const allowedPath = path.join(__dirname, 'allowed_groups.json');
                if (fs.existsSync(allowedPath)) {
                    const parsed = JSON.parse(fs.readFileSync(allowedPath, 'utf8'));
                    if (Array.isArray(parsed)) {
                        ALLOWED_GROUP_NAMES = new Set(parsed.map(normalizeGroupName).filter(Boolean));
                    }
                }
            } catch (e) {
                console.warn('Ã¢Å¡Â Ã¯Â¸Â Falha ao ler allowed_groups.json:', e.message);
            }

            let groupSubject = null;
            let groupDescription = '';
            let groupMetadata = null;
            try {
                groupMetadata = await sock.groupMetadata(chatId);
                groupSubject = groupMetadata.subject || '';
                groupDescription = String(groupMetadata.desc || '').trim();
                console.log(`Ã°Å¸â€Â DEBUG: Nome do grupo obtido: "${groupSubject}"`);
            } catch (e) {
                console.warn('Ã¢Å¡Â Ã¯Â¸Â Falha ao obter metadata do grupo:', e.message);
            }

            // Captura dados de lead para qualquer grupo (permitido ou nao permitido)
            try {
                leadEngine.processMessage(message, chatId, groupSubject || chatId);
            } catch (e) {
                console.warn('[LEADS] Falha ao capturar mensagem de grupo:', e.message || String(e));
            }

            const normalizedGroupSubject = normalizeGroupName(groupSubject);
            if (!groupSubject || !ALLOWED_GROUP_NAMES.has(normalizedGroupSubject)) {
                console.log(`Ã¢ÂÂ­Ã¯Â¸Â Ignorado: Grupo "${groupSubject}" nÃƒÂ£o estÃƒÂ¡ na lista permitida.`);
                // DEBUG: Listar permitidos se falhar
                // console.log('Permitidos:', Array.from(ALLOWED_GROUP_NAMES));

                const normalizedTextForGate = String(messageText || '').trimStart();
                if (normalizedTextForGate.toLowerCase().startsWith('/leads')) {
                    await leadEngine.handleLeadsCommand(sock, chatId);
                    continue;
                }
                if (normalizedTextForGate.startsWith('/')) {
                    const lastNoticeTs = unauthorizedGroupNoticeCooldown.get(chatId) || 0;
                    const nowTs = Date.now();
                    if (nowTs - lastNoticeTs >= UNAUTHORIZED_GROUP_NOTICE_MS) {
                        unauthorizedGroupNoticeCooldown.set(chatId, nowTs);
                        await sendSafeMessage(sock, chatId, {
                            text: 'Ã¢Å¡Â Ã¯Â¸Â Este grupo nÃƒÂ£o estÃƒÂ¡ autorizado para comandos.\n\nPeÃƒÂ§a a um admin para adicionar o grupo na lista permitida.'
                        });
                    }
                }
                continue;
            }

            console.log('Ã¢Å“â€¦ Grupo autorizado:', groupSubject);
            const isRestrictedGroup = isRestrictedGroupName(groupSubject);
            if (isRestrictedGroup) {
                console.log(`Ã°Å¸â€â€™ Modo restrito ativo para o grupo: "${groupSubject}"`);
            }

            // Salva toda mensagem de texto de grupos autorizados (incluindo comandos).
            publishInteractionForDashboard(message, senderId, groupSubject, chatId, messageTimestamp, messageText);

            // 4.1. COMANDOS (prioridade mÃƒÂ¡xima - mas moderaÃƒÂ§ÃƒÂ£o SEMPRE roda)
            const isCommand = String(messageText || '').trimStart().startsWith('/');
            console.log(`Ã°Å¸â€Â DEBUG: isCommand? ${isCommand} | Texto: ${messageText.substring(0, 20)}`);

            if (isCommand) {
                console.log('Ã¢Å¡Â¡ COMANDO detectado:', messageText.split(' ')[0]);

                if (messageText.toLowerCase().startsWith('/leads')) {
                    await leadEngine.handleLeadsCommand(sock, chatId);
                    continue;
                }

                // Comando DEV (funciona em grupo e privado)
                if (!isRestrictedGroup && messageText.toLowerCase().startsWith('/dev')) {
                    await handleDevCommand(sock, message, messageText);
                    continue;
                }

                // Processar comando
                await handleGroupMessages(sock, message, { groupSubject, isRestrictedGroup });
                // NÃƒÆ’O continue aqui - deixar moderaÃƒÂ§ÃƒÂ£o rodar
            }

            if (isRestrictedGroup) {
                // Neste grupo, o bot sÃƒÂ³ atende funÃƒÂ§ÃƒÂµes especÃƒÂ­ficas tratadas no groupResponder.
                // Inclui comandos cripto e menÃƒÂ§ÃƒÂ£o explÃƒÂ­cita ao @IMAVY.
                if (!isCommand) {
                    await handleGroupMessages(sock, message, { groupSubject, isRestrictedGroup });
                }
                continue;
            }

            // 4.2. MODERAÃƒâ€¡ÃƒÆ’O MINIMALISTA (2 regras: REPEAT + LINK)
            // Verificar se ÃƒÂ© admin do bot ou do grupo
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
                console.log(`Ã°Å¸Å¡Â¨ VIOLAÃƒâ€¡ÃƒÆ’O: ${violation.rule} - User: ${senderId}`);

                // Deletar mensagem
                let deleteError = null;
                try {
                    await sendSafeMessage(sock, chatId, { delete: message.key });
                    console.log('Ã¢Å“â€¦ Mensagem deletada');
                } catch (e) {
                    deleteError = `NÃƒÂ£o consegui apagar a mensagem (sem permissÃƒÂ£o).`;
                    console.error('Ã¢ÂÅ’ Erro ao deletar:', e.message);
                }

                // Adicionar strike
                const strikeCount = addStrike(chatId, senderId, violation.rule, messageText);
                console.log(`Ã¢Å¡Â Ã¯Â¸Â Strike aplicado: ${strikeCount}/3`);

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
                    console.error('Ã¢ÂÅ’ Erro ao enviar aviso:', e.message);
                }

                // Notificar admins
                await notifyAdmins(sock, chatId, senderId, violation.rule, strikeCount, messageText, deleteError);

                // Aplicar puniÃƒÂ§ÃƒÂ£o se 3/3
                if (strikeCount >= 3) {
                    await applyPunishment(sock, chatId, senderId, strikeCount);
                }

                // Bloquear processamento de comandos
                continue;
            }



            // Se foi comando e nÃƒÂ£o violou, jÃƒÂ¡ foi processado
            if (isCommand) {
                continue;
            }

            // Mensagens nÃƒÂ£o-comando podem acionar o IMAVY via menÃƒÂ§ÃƒÂ£o explÃƒÂ­cita.
            await handleGroupMessages(sock, message, { groupSubject, isRestrictedGroup });
        }
    });

    // Evento para detectar novos membros no grupo
    // PerÃƒÂ­odo de tolerÃƒÂ¢ncia de inicializaÃƒÂ§ÃƒÂ£o (10s) para evitar processar histÃƒÂ³rico
    const BOOT_GRACE_PERIOD = Date.now() + 10000;

    sock.ev.on('group-participants.update', async (update) => {
        try {
            // Ignorar eventos antigas ou durante inicializaÃƒÂ§ÃƒÂ£o
            if (Date.now() < BOOT_GRACE_PERIOD) {
                console.log('Ã¢ÂÂ³ Ignorando evento de participantes durante inicializaÃƒÂ§ÃƒÂ£o...');
                return;
            }

            console.log('Ã°Å¸â€œâ€¹ AtualizaÃƒÂ§ÃƒÂ£o de participantes:', JSON.stringify(update, null, 2));
            const { id: groupId, participants, action } = update;

            // Delegar para o handler inteligente com batch
            if (action === 'add') {
                let groupSubject = '';
                try {
                    const groupMetadata = await sock.groupMetadata(groupId);
                    groupSubject = groupMetadata?.subject || '';
                } catch (e) {
                    console.warn('Ã¢Å¡Â Ã¯Â¸Â NÃƒÂ£o foi possÃƒÂ­vel obter nome do grupo para filtro de boas-vindas:', e.message);
                }

                if (isRestrictedGroupName(groupSubject)) {
                    console.log(`Ã¢ÂÂ­Ã¯Â¸Â Boas-vindas desativadas no grupo restrito: "${groupSubject}"`);
                    return;
                }

                handleWelcomeEvent(sock, groupId, participants);
            }
        } catch (error) {
            console.error('Ã¢ÂÅ’ Erro no evento de participantes:', error);
        }
    });

    // Evento alternativo para capturar mudanÃƒÂ§as no grupo
    sock.ev.on('groups.update', async (updates) => {
        console.log('Ã°Å¸â€â€ž AtualizaÃƒÂ§ÃƒÂ£o de grupos:', JSON.stringify(updates, null, 2));
    });
}

startBot();




