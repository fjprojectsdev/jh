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
import { fileURLToPath } from 'url';
import { sendSafeMessage } from './functions/messageHandler.js';
import { attachOutgoingGuard } from './functions/outgoingGuard.js';
import { checkViolation, notifyAdmins, addStrike, getStrikes, applyPunishment } from './functions/antiSpam.js';
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
    console.log(`Servidor HTTP rodando na porta ${PORT}`);
});

// Variavel para armazenar o servidor HTTP temporario
let qrServer = null;
let qrCodeData = null;

// Timestamp de inicializacao do bot para ignorar mensagens antigas
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

function sanitizeIncomingText(value) {
    if (typeof value !== 'string') return '';
    return value
        .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
        .replace(/\r/g, '')
        .trim();
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
            parsed.map(normalizeGroupName).filter(Boolean).forEach((name) => allowed.add(name));
        }
    } catch (e) {
        console.warn('Falha ao ler allowed_groups.json:', e.message);
    }
    return allowed;
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

            // Intelligence mode: analisar todas as conversas sem bloquear o loop principal.
            intelEngine.processMessage(message, chatId, messageTimestamp, {
                text: messageText,
                senderId,
                isGroup,
                timestamp: messageTimestamp
            }).catch((error) => {
                console.warn('[INTEL] Falha ao processar mensagem:', error.message || String(error));
            });

            // ========== 3. FLUXO PRIVADO (VENDAS) - DESABILITADO ==========
            if (!isGroup) {
                const privateText = String(messageText || '').trim().toLowerCase();
                const privateCommandToken = privateText.split(/\s+/)[0] || '';

                if (messageText.toLowerCase().startsWith('/leads')) {
                    await leadEngine.handleLeadsCommand(sock, chatId);
                    continue;
                }
                if (messageText.toLowerCase().startsWith('/engajamento')) {
                    const allowedGroups = loadAllowedGroupNames();
                    await leadEngine.handleEngagementCommand(sock, chatId, {
                        allowedGroupNames: Array.from(allowedGroups)
                    });
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

                // Encaminhar qualquer slash-command no PV para o handler dedicado de comandos.
                if (privateCommandToken.startsWith('/')) {
                    await handleGroupMessages(sock, message, { isPrivate: true });
                    continue;
                }

                // Ignorar mensagens privadas (atendimento desabilitado)
                continue;
            }

            // ========== 4. FLUXO DE GRUPO ==========
            // Mover leitura de arquivo para fora do loop de mensagens ou usar cache?
            // Vamos logar tudo para debug agora.

            console.log(`[DEBUG] Processando msg de ${senderId} no grupo ${chatId}`);

            // Carregar allowed_groups (ideal: mover para memoria global recarregavel)
            const ALLOWED_GROUP_NAMES = loadAllowedGroupNames();

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
            try {
                leadEngine.processMessage(message, chatId, groupSubject || chatId);
            } catch (e) {
                console.warn('[LEADS] Falha ao capturar mensagem de grupo:', e.message || String(e));
            }

            const normalizedGroupSubject = normalizeGroupName(groupSubject);
            if (!groupSubject || !ALLOWED_GROUP_NAMES.has(normalizedGroupSubject)) {
                console.log(`Ignorado: Grupo "${groupSubject}" nao esta na lista permitida.`);
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

            // Salva toda mensagem de texto de grupos autorizados (incluindo comandos).
            publishInteractionForDashboard(message, senderId, groupSubject, chatId, messageTimestamp, messageText);

            // 4.1. COMANDOS (prioridade maxima - moderacao sempre roda)
            const isCommand = String(messageText || '').trimStart().startsWith('/');
            console.log(`[DEBUG] isCommand? ${isCommand} | Texto: ${messageText.substring(0, 20)}`);

            if (isCommand) {
                console.log('COMANDO detectado:', messageText.split(' ')[0]);

                if (messageText.toLowerCase().startsWith('/leads')) {
                    await leadEngine.handleLeadsCommand(sock, chatId);
                    continue;
                }
                if (messageText.toLowerCase().startsWith('/engajamento')) {
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



            // Se foi comando e nao violou, ja foi processado
            if (isCommand) {
                continue;
            }

            // Mensagens nao-comando podem acionar o IMAVY via mencao explicita.
            await handleGroupMessages(sock, message, { groupSubject, isRestrictedGroup });
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
