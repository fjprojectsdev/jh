// groupResponder.js
import { getGroupStatus } from './groupStats.js';

import {
    addAllowedGroup,
    listAllowedGroups,
    removeAllowedGroup,
    getAllowedGroupPermissions,
    addGroupPartner,
    removeGroupPartner,
    listGroupPartners
} from './adminCommands.js';
import { addAdmin, removeAdmin, listAdmins, getAdminStats, isAuthorized, checkAuth, getAdmins } from './authManager.js';
import { addBannedWord, removeBannedWord, listBannedWords } from './antiSpam.js';
import { analyzeLeadIntent, getLeads, getInstantSalesReply, registerSalesTurn } from './aiSales.js';
import { analyzeMessage } from './aiModeration.js';
import { checkRateLimit } from './rateLimiter.js';
import { logger } from './logger.js';
import {
    upsertMultipleNewsSubscriptions,
    upsertNewsPresetSubscriptions,
    removeNewsSubscription,
    removeNewsPresetSubscriptions
} from './newsForwarder.js';
import { stopJobPublishing, startJobPublishing, isJobPublishingEnabled, getJobForwarderStatus } from './jobForwarder.js';
import {
    isManualPrivateJobRequest,
    sendPrivateJobsOnDemand,
    hasPendingPrivateJobConversation,
    isFacebookJobLinkRequest,
    handleFacebookJobLinkRequest,
    getPrivateJobAlertsStatus
} from './privateJobAlerts.js';
import { formatStats } from './stats.js';
import { enableMaintenance, disableMaintenance, isMaintenanceMode } from './maintenance.js';
import { scheduleMessage } from './scheduler2.js';
import { handleSorteio } from './custom/sorteio.js';
import { handleCap } from './custom/cap.js';
import { handleCurso } from './custom/curso.js';
import { sendSafeMessage, sendPlainText } from './messageHandler.js';
import { resolveDexTarget, fetchDexPairSnapshot } from './crypto/dexscreener.js';
import { pushPoint, getSeries } from './crypto/timeseries.js';
import { renderSparklinePng } from './crypto/chart.js';
import { getAlias, listAliases as listCryptoAliases, addAlias as addCryptoAlias, removeAlias as removeCryptoAlias } from './crypto/aliasStore.js';
import { startWatch, stopWatch, stopAllWatches, listWatches, parseIntervalMs } from './crypto/watchManager.js';
import { isMarketPriceCommand, getMarketQuote } from './crypto/marketPrices.js';
import { PROJECT_TOKENS } from './crypto/projectTokens.js';
import { generateImavyCryptoReply } from './crypto/imavyAnalyst.js';
import { askChatGPT } from './chatgpt.js';
import { isRestrictedGroupName } from './groupPolicy.js';
import { registrarComandoAceito } from './commandMetrics.js';
import { getGroupTopRanking } from './groupRanking.js';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getNumberFromJid } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEMBRETES_FILE = path.join(__dirname, '..', 'lembretes.json');
const BOT_LOG_FILE = path.join(__dirname, '..', 'bot.log');
const LAMINAS_FILE = path.join(__dirname, '..', 'laminas.json');
const LAMINA_SCHEDULES_FILE = path.join(__dirname, '..', 'lamina_schedules.json');
const LAMINA_CONVERSATIONS_FILE = path.join(__dirname, '..', 'lamina_conversations.json');
const SHILL_TEMPLATES_FILE = path.join(__dirname, '..', 'laminas_shill.json');
const SHILL_SCHEDULES_FILE = path.join(__dirname, '..', 'shill_schedules.json');
const SCHEDULED_RUNTIME_STATE_FILE = path.join(__dirname, '..', 'scheduled_runtime_state.json');
const PRIVATE_JOB_INTENT_AUDIT_FILE = path.join(__dirname, '..', 'private_job_intent_audit.json');
const MAX_PRIVATE_JOB_INTENT_AUDIT_ENTRIES = 100;
const PRIVATE_WIZARDS_FILE = path.join(__dirname, '..', 'private_wizards_state.json');
const CRIPTOJORNAL_PAYLOAD_FILE = path.join(__dirname, '..', 'tmp_criptojornal_payload.json');
const BOT_TRIGGER = 'bot';
const PRIVATE_AI_AUTO_REPLY_ENABLED = String(process.env.IMAVY_PRIVATE_AI_AUTO_REPLY || 'true').trim().toLowerCase() !== 'false';
const PRIVATE_AI_LEAD_NOTIFY_ENABLED = String(process.env.IMAVY_PRIVATE_AI_LEAD_NOTIFY || 'true').trim().toLowerCase() !== 'false';
const PRIVATE_AI_LEAD_NOTIFY_COOLDOWN_MS = Math.max(5 * 60 * 1000, parseInt(process.env.IMAVY_PRIVATE_AI_LEAD_NOTIFY_COOLDOWN_MS || String(60 * 60 * 1000), 10));
const REMINDER_TIMEZONE = String(process.env.IMAVY_REMINDER_TIMEZONE || 'America/Sao_Paulo').trim();
const PROJECT_TOKEN_PAIR_CACHE_TTL_MS = 10 * 60 * 1000;
const PROJECT_TOKEN_RESOLVE_TIMEOUT_MS = 2500;
const CRYPTO_COMMAND_CACHE_TTL_MS = Math.max(30_000, parseInt(process.env.CRYPTO_COMMAND_CACHE_TTL_MS || String(5 * 60 * 1000), 10));
const CRYPTO_COMMAND_STALE_MAX_AGE_MS = Math.max(CRYPTO_COMMAND_CACHE_TTL_MS, parseInt(process.env.CRYPTO_COMMAND_STALE_MAX_AGE_MS || String(20 * 60 * 1000), 10));
const CRYPTO_COMMAND_TIMEOUT_MS = Math.max(800, parseInt(process.env.CRYPTO_COMMAND_TIMEOUT_MS || '1500', 10));
const addGroupWizardState = new Map();
const laminaWizardState = new Map();
const stopLaminaWizardState = new Map();
const rankingWizardState = new Map();
const laminaShillWizardState = new Map();
const shillWizardState = new Map();
const newsWizardState = new Map();
const partnerWizardState = new Map();
const reminderWizardState = new Map();
let laminaSchedulerTimer = null;
let shillSchedulerTimer = null;
let scheduledStateFlushTimer = null;
let scheduledStateHooksRegistered = false;
const projectTokenPairCache = new Map();
const privateLeadNotificationCache = new Map();

function getBackupFilePath(filePath) {
    return `${filePath}.bak`;
}

function writeJsonAtomic(filePath, value) {
    const tmpPath = `${filePath}.tmp`;
    const serialized = JSON.stringify(value, null, 2);
    fs.writeFileSync(tmpPath, serialized, 'utf8');
    let renamed = false;
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            fs.renameSync(tmpPath, filePath);
            renamed = true;
            break;
        } catch (error) {
            lastError = error;
            if (attempt < 2 && error && (error.code === 'EPERM' || error.code === 'EBUSY')) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
                continue;
            }
            break;
        }
    }
    if (!renamed) {
        try {
            fs.copyFileSync(tmpPath, filePath);
            fs.unlinkSync(tmpPath);
            renamed = true;
        } catch (copyError) {
            try { fs.unlinkSync(tmpPath); } catch (_) { }
            throw (copyError || lastError);
        }
    }
    fs.writeFileSync(getBackupFilePath(filePath), serialized, 'utf8');
}

function readJsonWithRecovery(filePath, fallbackValue) {
    const backupPath = getBackupFilePath(filePath);
    const tryRead = (targetPath) => {
        if (!fs.existsSync(targetPath)) return null;
        try {
            return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
        } catch {
            return null;
        }
    };

    const primary = tryRead(filePath);
    if (primary !== null) return primary;

    const backup = tryRead(backupPath);
    if (backup !== null) {
        writeJsonAtomic(filePath, backup);
        console.warn(`[LAMINA] Arquivo restaurado do backup: ${path.basename(filePath)}`);
        return backup;
    }

    writeJsonAtomic(filePath, fallbackValue);
    return fallbackValue;
}

function buildRecoveredCriptoJornalLamina() {
    try {
        if (!fs.existsSync(CRIPTOJORNAL_PAYLOAD_FILE)) return null;
        const parsed = JSON.parse(fs.readFileSync(CRIPTOJORNAL_PAYLOAD_FILE, 'utf8'));
        const groupId = String(parsed?.groupId || '').trim();
        const items = Array.isArray(parsed?.items) ? parsed.items.filter(Boolean).slice(0, 5) : [];
        if (!groupId || !items.length) return null;

        const textBody = items.map((item, index) => {
            const title = String(item?.title || '').trim();
            const summary = String(item?.summary || '').trim();
            const link = String(item?.link || '').trim();
            return [
                `${index + 1}. ${title}`,
                summary,
                link
            ].filter(Boolean).join('\n');
        }).join('\n\n');

        return {
            title: 'Cripto Jornal Recuperada',
            textBody: `📰 CriptoJornal\n\n${textBody}`,
            imageSource: String(items[0]?.imageUrl || '').trim(),
            imageBase64: '',
            groups: [{ id: groupId, subject: 'TESTE IMAVY' }],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            createdBy: 'system_recovery'
        };
    } catch (error) {
        console.warn('[LAMINA] Falha ao reconstruir payload do CriptoJornal:', error.message || String(error));
        return null;
    }
}

function ensureLaminaStorageFiles() {
    const recoveredLamina = buildRecoveredCriptoJornalLamina();
    const laminas = readJsonWithRecovery(LAMINAS_FILE, recoveredLamina ? [recoveredLamina] : []);
    if (recoveredLamina) {
        const exists = Array.isArray(laminas) && laminas.some((item) => String(item?.title || '').toLowerCase() === recoveredLamina.title.toLowerCase());
        if (!exists) {
            laminas.push(recoveredLamina);
            writeJsonAtomic(LAMINAS_FILE, laminas);
            console.log('[LAMINA] Lamina do CriptoJornal recuperada no bootstrap.');
        }
    }

    readJsonWithRecovery(LAMINA_SCHEDULES_FILE, []);
    readJsonWithRecovery(LAMINA_CONVERSATIONS_FILE, {});
    readJsonWithRecovery(SHILL_TEMPLATES_FILE, []);
    readJsonWithRecovery(SHILL_SCHEDULES_FILE, []);
    readJsonWithRecovery(SCHEDULED_RUNTIME_STATE_FILE, {
        savedAt: null,
        reason: 'bootstrap',
        reminders: { intervalGroups: 0, dailyGroups: 0 },
        laminas: { total: 0, active: 0 },
        shill: { total: 0, active: 0 }
    });
    readJsonWithRecovery(PRIVATE_JOB_INTENT_AUDIT_FILE, []);
}

function isLikelySalesInquiry(text) {
    const normalized = String(text || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    return /\b(preco|precos|valor|valores|quanto custa|quanto fica|plano|planos|assinatura|assinar|contratar|orcamento|orçamento|bot|automatizacao|automacao|ia)\b/.test(normalized);
}

function shouldNotifyPrivateLead(senderId, result) {
    if (!PRIVATE_AI_LEAD_NOTIFY_ENABLED) return false;
    if (!senderId || !result || !result.needsHuman) return false;
    const confidence = Number(result.confidence || 0);
    if (!Number.isFinite(confidence) || confidence < 70) return false;

    const cacheKey = String(senderId);
    const lastNotifiedAt = privateLeadNotificationCache.get(cacheKey) || 0;
    const now = Date.now();
    if (now - lastNotifiedAt < PRIVATE_AI_LEAD_NOTIFY_COOLDOWN_MS) {
        return false;
    }

    privateLeadNotificationCache.set(cacheKey, now);
    return true;
}

async function notifyAdminsAboutPrivateLead(sock, senderId, text, result) {
    if (!shouldNotifyPrivateLead(senderId, result)) return;

    try {
        const admins = await getAdmins();
        if (!Array.isArray(admins) || !admins.length) return;

        const clientNumber = getNumberFromJid(senderId) || senderId;
        const summary = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 280);
        const notificationText = [
            'NOVO LEAD QUENTE NO PV',
            '',
            `Cliente: ${clientNumber}`,
            `JID: ${senderId}`,
            `Intent: ${result.intent || 'interested'}`,
            `Confianca: ${Number(result.confidence || 0)}%`,
            '',
            `Mensagem: ${summary || '(sem texto)'}`,
            '',
            'A IA sinalizou interesse forte e recomendou atendimento humano.'
        ].join('\n');

        for (const admin of admins) {
            const adminJidRaw = String(admin?.id || admin?.user_id || '').trim();
            if (!adminJidRaw) continue;
            const adminJid = adminJidRaw.includes('@') ? adminJidRaw : `${adminJidRaw}@s.whatsapp.net`;
            if (adminJid === senderId) continue;
            await sendSafeMessage(sock, adminJid, { text: notificationText });
        }
    } catch (error) {
        logger.warn('private_lead_admin_notify_failed', {
            senderId,
            error: error?.message || String(error)
        });
    }
}

function persistScheduledAutomationState(reason = 'manual', options = {}) {
    const saveReminders = options.saveReminders !== false;
    try {
        if (saveReminders) {
            saveLembretes();
        }

        const laminaSchedules = readLaminaSchedules();
        const shillSchedules = readShillSchedules();

        writeJsonAtomic(SCHEDULED_RUNTIME_STATE_FILE, {
            savedAt: new Date().toISOString(),
            reason,
            reminders: {
                intervalGroups: Object.keys(lembretesAtivos || {}).length,
                dailyGroups: Object.keys(lembretesFixosAtivos || {}).length
            },
            laminas: {
                total: laminaSchedules.length,
                active: laminaSchedules.filter((item) => item?.active !== false).length
            },
            shill: {
                total: shillSchedules.length,
                active: shillSchedules.filter((item) => item?.active !== false).length
            }
        });
    } catch (error) {
        console.error('Erro ao persistir estado de lembretes/agendamentos:', error);
    }
}

function ensureScheduledStatePersistence() {
    if (!scheduledStateFlushTimer) {
        scheduledStateFlushTimer = setInterval(() => {
            persistScheduledAutomationState('periodic_flush');
        }, 60000);
    }

    if (scheduledStateHooksRegistered) return;
    scheduledStateHooksRegistered = true;

    const flushOnSignal = (reason) => {
        try {
            persistScheduledAutomationState(reason);
        } catch (_) { }
    };

    process.on('SIGINT', () => flushOnSignal('sigint'));
    process.on('SIGTERM', () => flushOnSignal('sigterm'));
    process.on('beforeExit', () => flushOnSignal('before_exit'));
    process.on('uncaughtException', () => flushOnSignal('uncaught_exception'));
    process.on('unhandledRejection', () => flushOnSignal('unhandled_rejection'));
}

function appendPrivateJobIntentAudit(entry) {
    try {
        const current = readJsonWithRecovery(PRIVATE_JOB_INTENT_AUDIT_FILE, []);
        const list = Array.isArray(current) ? current : [];
        list.push({
            at: new Date().toISOString(),
            ...entry
        });
        const trimmed = list.slice(-MAX_PRIVATE_JOB_INTENT_AUDIT_ENTRIES);
        writeJsonAtomic(PRIVATE_JOB_INTENT_AUDIT_FILE, trimmed);
    } catch (error) {
        logger.warn('private_job_intent_audit_failed', {
            error: error?.message || String(error)
        });
    }
}

const DIRECT_PAIR_COMMANDS = {
    '/vkinha': { chain: 'bsc', pair: '0x530f75e77eb4f15b124add2a6c8e23b603d9ad64', label: 'VKINHA' }
};
const VALYRAFI_MESSAGE = `🚀 A ValyraFi está só começando — e você pode fazer parte desde o início.
Estamos construindo um ecossistema DeFi com múltiplos apps de apelo global, geração de receita real e um modelo sustentável onde 50% das receitas dos aplicativos retornam ao token através de compra e queima.

📲 Vamos iniciar com apps e plataformas para setor automotivo, saúde, viagem, jurídico e muito mais…

🔔 Atenção: a Fase 1 da pré-venda será exclusiva para a comunidade Vellora e acontece em breve. Quem estiver dentro da comunidade sai na frente.

👉 Entre agora e acompanhe de perto todas as novidades:

🌐 Site: ValyraFi.com
❌ X (Twitter): https://x.com/ValyraFi
💬 Telegram: https://t.me/ValyraFiEcosystem
📸 Instagram: https://Instagram.com/ValyraFiEcosystem

O ecossistema está sendo construído agora.

Os primeiros sempre têm mais vantagens. 🔥`;

const COMMANDS_MENU = `🤖 *MENU DE COMANDOS — iMavyAgent*

📌 *Basicos*
• \`/status\`
• \`/regras\`
• \`/link\`
• \`/hora\`
• \`/comandos\`
• \`/comandos2\`
• \`/valyrafi\`
• \`@imavy pergunta\`

👮 *Grupo e Moderacao*
• \`/fechar\` • \`/abrir\`
• \`/fixar mensagem\`
• \`/aviso mensagem\`
• \`/todos mensagem\`
• \`/banir @membro\`
• \`/promover @usuario\`
• \`/rebaixar @usuario\`
• \`/adicionartermo palavra\`
• \`/removertermo palavra\`
• \`/listartermos\`

⏰ *Lembretes*
• \`/lembrete + mensagem 1h 24h\`
• \`/lembretefixo + mensagem 08:00 21:00\`
• \`/lembretes\`
• \`/editarlembrete\`
• \`/stoplembrete\`
• \`/stoplembretefixo\`
• \`/testelembrete [mensagem]\`

📰 *Noticias e Monitor*
• \`/noticias\`
• \`/stopnoticias\`
• \`/monitor24h\`
• \`/stopmonitor24h\`
• \`/startvagas\`
• \`/stopvagas\`
• \`/statusvagas\`

📊 *Gestao e Analise*
• \`/ranking\`
• \`/stats\`
• \`/logs [linhas]\`
• \`/leads\`
• \`/engajamento\`
• \`/testia [mensagem]\`

🖼️ *Laminas e Shill* _(use no PV)_
• \`/lamina\`
• \`/editarlamina\`
• \`/listarlaminas\`
• \`/textolamina <titulo>\`
• \`/laminasativas\`
• \`/laminasdisparadas\`
• \`/usarlamina <titulo>\`
• \`/stoplamina\`
• \`/laminashill\`
• \`/shill\`

💹 *Mercado*
• \`/btc\` • \`/eth\` • \`/bnb\`
• \`/sol\` • \`/xrp\` • \`/usdt\`
• \`/ouro\` • \`/paxg\`
• \`/ca <contrato>\`
• \`/grafico <token>\`

🪙 *Projetos e Atalhos*
• \`/snappy\` • \`/nix\` • \`/coffee\`
• \`/lux\` • \`/kenesis\` • \`/dcar\`
• \`/fsx\` • \`/nlc\` • \`/masaka\`
• \`/vkinha\`
• \`/p<alias>\` ex: \`/pnix\`

🤝 *Parceiros*
• \`/adicionarparceiro @usuario\`
• \`/removerparceiro @usuario\`
• \`/listarparceiros\`

⚙️ *Admins*
• \`/adicionargrupo\`
• \`/removergrupo\`
• \`/listargrupos\`
• \`/adicionaradmin @usuario\`
• \`/removeradmin @usuario\`
• \`/listaradmins\`

💡 Para ver utilitarios extras e diagnosticos: \`/comandos2\`

🤖 *iMavyAgent* 24/7`;

const HIDDEN_COMMANDS_MENU = `🛠️ *Extras e Diagnosticos*
• \`/addpair <alias> <chain> <pair> [label]\`
• \`/delpair <alias>\`
• \`/listpairs\`
• \`/watch <alias> <alvo> [intervalo]\`
• \`/unwatch <id>\`
• \`/watchlist\`
• \`/agendar HH:MM mensagem\`
• \`/sethorario abrir HH:MM\`
• \`/sethorario fechar HH:MM\`
• \`/manutencao on|off\`
• \`/testbot\`
• \`/dev on\`
• \`/dev off\``;
const PARTNER_COMMANDS_MENU = '';
const PARTNER_HIDDEN_COMMANDS_MENU = '';

function buildCommandsMenuText() {
    return `${COMMANDS_MENU}${PARTNER_COMMANDS_MENU}\n\n━━━━━━━━━━━━━━━━\n\n${HIDDEN_COMMANDS_MENU}${PARTNER_HIDDEN_COMMANDS_MENU}`;
}

function buildHiddenCommandsMenuText() {
    return buildCommandsMenuText();
}

function getCommandToken(normalizedText) {
    return String(normalizedText || '').trim().split(/\s+/)[0] || '';
}

const PRIVATE_REMINDER_COMMAND_TOKENS = new Set([
    '/lembrete',
    '/lembretes',
    '/lembretefixo',
    '/stoplembrete',
    '/stoplembretes',
    '/stoplembretefixo',
    '/stoplembretesfixos',
    '/testelembrete',
    '/testelembretes',
    '/editarlembrete',
    '/apagarlembrete',
    '/agendar'
]);

function normalizePrivateReminderCommandText(text) {
    const safe = String(text || '').trim();
    if (!safe) return safe;

    const parts = safe.split(/\s+/);
    const first = String(parts[0] || '').trim().toLowerCase();
    if (!first) return safe;

    const normalizedFirst = first.startsWith('/') ? first : `/${first}`;
    if (!PRIVATE_REMINDER_COMMAND_TOKENS.has(normalizedFirst)) {
        return safe;
    }

    return [normalizedFirst, ...parts.slice(1)].join(' ');
}

function isCryptoCommandToken(commandToken) {
    if (!commandToken || !commandToken.startsWith('/')) return false;
    if (PROJECT_TOKENS[commandToken]) return true;
    if (DIRECT_PAIR_COMMANDS[commandToken]) return true;
    if (isMarketPriceCommand(commandToken)) return true;
    if (commandToken.startsWith('/p') && commandToken.length > 2) return true;

    return commandToken === '/ca'
        || commandToken === '/grafico'
        || commandToken === '/listpairs'
        || commandToken === '/addpair'
        || commandToken === '/delpair'
        || commandToken === '/watch'
        || commandToken === '/unwatch'
        || commandToken === '/watchlist';
}

function isAllowedCommandForRestrictedGroup(commandToken) {
    if (!commandToken || !commandToken.startsWith('/')) return false;
    if (commandToken === '/aviso') return true;
    if (commandToken === '/lembrete') return true;
    if (commandToken === '/ranking') return true;
    if (commandToken === '/logs') return true;
    if (commandToken === '/addparceiro' || commandToken === '/adicionarparceiro' || commandToken === '/delparceiro' || commandToken === '/removerparceiro' || commandToken === '/listparceiros' || commandToken === '/listarparceiros') return true;
    if (commandToken === '/adicionartermo' || commandToken === '/adicionartemo' || commandToken === '/addtermo') return true;
    if (commandToken === '/removertermo' || commandToken === '/removertemo') return true;
    if (commandToken === '/listartermos') return true;
    if (commandToken === '/valyrafi') return true;
    return isCryptoCommandToken(commandToken);
}

function normalizeJidUser(jid) {
    return String(jid || '').split(':')[0];
}

function getJidLocalPart(jid) {
    const full = normalizeJidUser(jid);
    return String(full || '').split('@')[0].toLowerCase();
}

function getJidDigits(jid) {
    return getJidLocalPart(jid).replace(/\D/g, '');
}

function isSameJid(a, b) {
    if (!a || !b) return false;
    const aLocal = getJidLocalPart(a);
    const bLocal = getJidLocalPart(b);
    if (aLocal && bLocal && aLocal === bLocal) return true;

    const aDigits = getJidDigits(a);
    const bDigits = getJidDigits(b);
    return Boolean(aDigits && bDigits && aDigits === bDigits);
}

function getMentionedJidsFromMessage(message) {
    try {
        const root = message?.message || {};
        const messageObj =
            root?.ephemeralMessage?.message
            || root?.viewOnceMessage?.message
            || root?.viewOnceMessageV2?.message
            || root?.viewOnceMessageV2Extension?.message
            || root;
        const directMentions =
            messageObj?.extendedTextMessage?.contextInfo?.mentionedJid
            || messageObj?.imageMessage?.contextInfo?.mentionedJid
            || messageObj?.videoMessage?.contextInfo?.mentionedJid
            || messageObj?.documentMessage?.contextInfo?.mentionedJid
            || messageObj?.documentWithCaptionMessage?.message?.documentMessage?.contextInfo?.mentionedJid
            || messageObj?.buttonsResponseMessage?.contextInfo?.mentionedJid
            || messageObj?.listResponseMessage?.contextInfo?.mentionedJid
            || messageObj?.reactionMessage?.key?.participant
            || null;

        if (typeof directMentions === 'string') return [directMentions];
        if (Array.isArray(directMentions)) return directMentions;
    } catch { }
    return [];
}

function isImavyMentioned({ text, message, sock }) {
    const rawText = String(text || '');
    const lowerText = rawText.toLowerCase();
    const trimmedText = rawText.trim();

    // Regra principal: qualquer frase iniciando com "imavy" (com ou sem "@")
    if (/^@?(imavy|imavyagent)\b/i.test(trimmedText)) return true;

    const plainTextMention = /(^|\s)@(imavy|imavyagent)(\s|$|[!?,.:;])/i.test(rawText);
    if (plainTextMention) return true;

    const botJid = sock?.user?.id || '';
    if (botJid) {
        const botLocal = getJidLocalPart(botJid);
        const botDigits = getJidDigits(botJid);
        if ((botLocal && lowerText.includes(`@${botLocal}`)) || (botDigits && lowerText.includes(`@${botDigits}`))) {
            return true;
        }
    }

    const mentioned = getMentionedJidsFromMessage(message);
    if (!mentioned.length) return false;

    // Fallback para casos em que @iMavy vira @numero no inicio da mensagem.
    const numericMentionPrefix = /^@\d{6,}\s+/i.test(trimmedText);
    const likelyBotCall = /(analisa|analisar|responde|responder|btc|eth|sol|xrp|bnb|usdt|paxg|ouro|cripto|crypto|mercado)/i.test(trimmedText);
    if (numericMentionPrefix && likelyBotCall) return true;

    if (!botJid) return false;

    return mentioned.some((jid) => isSameJid(jid, botJid));
}

function parseYesNo(value) {
    const text = String(value || '').trim().toLowerCase();
    if (['s', 'sim', 'yes', 'y', '1'].includes(text)) return true;
    if (['n', 'nao', 'não', 'no', '0'].includes(text)) return false;
    return null;
}

function getWizard(senderId) {
    return addGroupWizardState.get(senderId);
}

function clearWizard(senderId) {
    addGroupWizardState.delete(senderId);
    persistPrivateWizardsState();
}

function getLaminaWizard(senderId) {
    return laminaWizardState.get(senderId);
}

function clearLaminaWizard(senderId) {
    laminaWizardState.delete(senderId);
    persistPrivateWizardsState();
}

function getStopLaminaWizard(senderId) {
    return stopLaminaWizardState.get(senderId);
}

function clearStopLaminaWizard(senderId) {
    stopLaminaWizardState.delete(senderId);
    persistPrivateWizardsState();
}

function getRankingWizard(senderId) {
    return rankingWizardState.get(senderId);
}

function clearRankingWizard(senderId) {
    rankingWizardState.delete(senderId);
    persistPrivateWizardsState();
}

function getLaminaShillWizard(senderId) {
    return laminaShillWizardState.get(senderId);
}

function clearLaminaShillWizard(senderId) {
    laminaShillWizardState.delete(senderId);
    persistPrivateWizardsState();
}

function getShillWizard(senderId) {
    return shillWizardState.get(senderId);
}

function clearShillWizard(senderId) {
    shillWizardState.delete(senderId);
    persistPrivateWizardsState();
}

function getNewsWizard(senderId) {
    return newsWizardState.get(senderId);
}

function clearNewsWizard(senderId) {
    newsWizardState.delete(senderId);
    persistPrivateWizardsState();
}

function toSerializableLaminaState(state = {}) {
    const copy = { ...state };
    if (Buffer.isBuffer(copy.imageBuffer)) {
        copy.imageBase64 = copy.imageBuffer.toString('base64');
        delete copy.imageBuffer;
    } else if (!copy.imageBuffer) {
        delete copy.imageBuffer;
    }
    return copy;
}

function fromSerializableLaminaState(state = {}) {
    const copy = { ...state };
    if (copy.imageBase64) {
        try {
            copy.imageBuffer = Buffer.from(copy.imageBase64, 'base64');
        } catch {
            copy.imageBuffer = null;
        }
    }
    delete copy.imageBase64;
    if (!copy.imageBuffer) copy.imageBuffer = null;
    return copy;
}

function toSerializableGroupRef(group) {
    if (!group || typeof group !== 'object') return null;
    const id = String(group.id || '').trim();
    if (!id) return null;
    const subject = String(group.subject || group.groupName || '').trim();
    return {
        id,
        subject: subject || id
    };
}

function toSerializableReminderConfig(config = {}) {
    if (!config || typeof config !== 'object') return null;
    return {
        ...config,
        groupName: String(config.groupName || '').trim()
    };
}

function toSerializableReminderEntry(entry = {}) {
    const id = String(entry?.id || entry?.config?.id || '').trim();
    const config = toSerializableReminderConfig(entry?.config || {});
    if (!id && !config) return null;
    return {
        id: id || String(config?.id || '').trim(),
        config
    };
}

function toSerializableEditableReminderItem(item = {}) {
    if (!item || typeof item !== 'object') return null;
    return {
        kind: String(item.kind || '').trim(),
        id: String(item.id || '').trim(),
        title: String(item.title || '').trim(),
        summary: String(item.summary || '').trim(),
        config: toSerializableReminderConfig(item.config || {})
    };
}

function toSerializableReminderState(state = {}) {
    if (!state || typeof state !== 'object') return {};
    return {
        step: String(state.step || '').trim(),
        action: String(state.action || '').trim(),
        groups: Array.isArray(state.groups) ? state.groups.map((group) => toSerializableGroupRef(group)).filter(Boolean) : [],
        group: toSerializableGroupRef(state.group),
        fixedEntries: Array.isArray(state.fixedEntries) ? state.fixedEntries.map((entry) => toSerializableReminderEntry(entry)).filter(Boolean) : [],
        editableItems: Array.isArray(state.editableItems) ? state.editableItems.map((item) => toSerializableEditableReminderItem(item)).filter(Boolean) : [],
        editTarget: state.editTarget && typeof state.editTarget === 'object'
            ? { kind: String(state.editTarget.kind || '').trim(), id: String(state.editTarget.id || '').trim() }
            : null,
        title: String(state.title || '').trim(),
        messageText: String(state.messageText || '').trim(),
        imageBase64: typeof state.imageBase64 === 'string' ? state.imageBase64 : '',
        intervalHours: Number.isFinite(Number(state.intervalHours)) ? Number(state.intervalHours) : null,
        durationDays: Number.isFinite(Number(state.durationDays)) ? Number(state.durationDays) : null,
        times: Array.isArray(state.times) ? state.times.map((value) => String(value || '').trim()).filter(Boolean) : []
    };
}

function persistPrivateWizardsState() {
    try {
        const payload = {
            updatedAt: new Date().toISOString(),
            addGroup: Array.from(addGroupWizardState.entries()),
            lamina: Array.from(laminaWizardState.entries()).map(([senderId, state]) => [senderId, toSerializableLaminaState(state)]),
            stopLamina: Array.from(stopLaminaWizardState.entries()),
            ranking: Array.from(rankingWizardState.entries()),
            laminaShill: Array.from(laminaShillWizardState.entries()).map(([senderId, state]) => [senderId, toSerializableLaminaState(state)]),
            shill: Array.from(shillWizardState.entries()),
            news: Array.from(newsWizardState.entries()),
            partner: Array.from(partnerWizardState.entries()),
            reminder: Array.from(reminderWizardState.entries()).map(([senderId, state]) => [senderId, toSerializableReminderState(state)])
        };
        fs.writeFileSync(PRIVATE_WIZARDS_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
        console.error('Falha ao persistir estado de wizards privados:', error.message || String(error));
    }
}

function loadPrivateWizardsState() {
    try {
        if (!fs.existsSync(PRIVATE_WIZARDS_FILE)) return;
        const parsed = JSON.parse(fs.readFileSync(PRIVATE_WIZARDS_FILE, 'utf8'));
        if (Array.isArray(parsed?.addGroup)) {
            for (const [senderId, state] of parsed.addGroup) {
                if (senderId && state && typeof state === 'object') addGroupWizardState.set(senderId, state);
            }
        }
        if (Array.isArray(parsed?.lamina)) {
            for (const [senderId, state] of parsed.lamina) {
                if (senderId && state && typeof state === 'object') laminaWizardState.set(senderId, fromSerializableLaminaState(state));
            }
        }
        if (Array.isArray(parsed?.stopLamina)) {
            for (const [senderId, state] of parsed.stopLamina) {
                if (senderId && state && typeof state === 'object') stopLaminaWizardState.set(senderId, state);
            }
        }
        if (Array.isArray(parsed?.ranking)) {
            for (const [senderId, state] of parsed.ranking) {
                if (senderId && state && typeof state === 'object') rankingWizardState.set(senderId, state);
            }
        }
        if (Array.isArray(parsed?.laminaShill)) {
            for (const [senderId, state] of parsed.laminaShill) {
                if (senderId && state && typeof state === 'object') laminaShillWizardState.set(senderId, fromSerializableLaminaState(state));
            }
        }
        if (Array.isArray(parsed?.shill)) {
            for (const [senderId, state] of parsed.shill) {
                if (senderId && state && typeof state === 'object') shillWizardState.set(senderId, state);
            }
        }
        if (Array.isArray(parsed?.news)) {
            for (const [senderId, state] of parsed.news) {
                if (senderId && state && typeof state === 'object') newsWizardState.set(senderId, state);
            }
        }
        if (Array.isArray(parsed?.partner)) {
            for (const [senderId, state] of parsed.partner) {
                if (senderId && state && typeof state === 'object') partnerWizardState.set(senderId, state);
            }
        }
        if (Array.isArray(parsed?.reminder)) {
            for (const [senderId, state] of parsed.reminder) {
                if (senderId && state && typeof state === 'object') reminderWizardState.set(senderId, state);
            }
        }
    } catch (error) {
        console.error('Falha ao carregar estado de wizards privados:', error.message || String(error));
    }
}

function setAddGroupWizard(senderId, state) {
    addGroupWizardState.set(senderId, state);
    persistPrivateWizardsState();
}

function setLaminaWizard(senderId, state) {
    laminaWizardState.set(senderId, state);
    persistPrivateWizardsState();
}

function setStopLaminaWizard(senderId, state) {
    stopLaminaWizardState.set(senderId, state);
    persistPrivateWizardsState();
}

function setRankingWizard(senderId, state) {
    rankingWizardState.set(senderId, state);
    persistPrivateWizardsState();
}

function setLaminaShillWizard(senderId, state) {
    laminaShillWizardState.set(senderId, state);
    persistPrivateWizardsState();
}

function setShillWizard(senderId, state) {
    shillWizardState.set(senderId, state);
    persistPrivateWizardsState();
}

function setNewsWizard(senderId, state) {
    newsWizardState.set(senderId, state);
    persistPrivateWizardsState();
}

function getPartnerWizard(senderId) {
    return partnerWizardState.get(senderId);
}

function clearPartnerWizard(senderId) {
    partnerWizardState.delete(senderId);
    persistPrivateWizardsState();
}

function setPartnerWizard(senderId, state) {
    partnerWizardState.set(senderId, state);
    persistPrivateWizardsState();
}

function getReminderWizard(senderId) {
    return reminderWizardState.get(senderId);
}

function clearReminderWizard(senderId) {
    reminderWizardState.delete(senderId);
    persistPrivateWizardsState();
}

function setReminderWizard(senderId, state) {
    reminderWizardState.set(senderId, state);
    persistPrivateWizardsState();
}

function hasNonJobPrivateWizard(senderId) {
    return Boolean(
        getReminderWizard(senderId)
        || getRankingWizard(senderId)
        || getNewsWizard(senderId)
        || getShillWizard(senderId)
        || getLaminaShillWizard(senderId)
        || getLaminaWizard(senderId)
        || getStopLaminaWizard(senderId)
        || getWizard(senderId)
        || getPartnerWizard(senderId)
    );
}

function parseNewsFeedUrls(text) {
    return Array.from(new Set(
        String(text || '')
            .split(/[\s,;]+/)
            .map((item) => item.trim())
            .filter((item) => /^https?:\/\//i.test(item))
    ));
}

function getNewsWizardPrompt(action, lines, shownCount, totalCount) {
    let prompt = '';
    if (action === '/stopnoticias') {
        prompt = `Para qual grupo deseja dar stop nas noticias?\n\n${lines}\n\nResponda com numero ou nome do grupo.`;
    } else if (action === '/monitor24h') {
        prompt = `Ativar monitor 24h Brasil + Mundo em qual grupo?\n\n${lines}\n\nResponda com numero ou nome do grupo.`;
    } else if (action === '/stopmonitor24h') {
        prompt = `Desativar monitor 24h em qual grupo?\n\n${lines}\n\nResponda com numero ou nome do grupo.`;
    } else {
        prompt = `Enviar noticias para qual grupo?\n\n${lines}\n\nResponda com numero ou nome do grupo.`;
    }

    if (totalCount > shownCount) {
        prompt += `\n\nMostrando ${shownCount} de ${totalCount} grupos.`;
    }

    return prompt;
}

function getRequiredPermissionForAdminCommand(commandToken) {
    const token = String(commandToken || '').toLowerCase();
    if (token === '/fechar' || token === '/abrir') return 'openClose';
    if (
        token === '/lembrete'
        || token === '/lembretes'
        || token === '/lembretefixo'
        || token === '/editarlembrete'
        || token === '/apagarlembrete'
        || token === '/stoplembrete'
        || token === '/stoplembretes'
        || token === '/stoplembretefixo'
        || token === '/stoplembretesfixos'
        || token === '/testelembrete'
        || token === '/testelembretes'
    ) return 'reminders';
    if (token === '/banir' || token === '/adicionartermo' || token === '/adicionartemo' || token === '/addtermo' || token === '/removertermo' || token === '/removertemo' || token === '/listartermos' || token === '/addparceiro' || token === '/adicionarparceiro' || token === '/delparceiro' || token === '/removerparceiro' || token === '/listparceiros' || token === '/listarparceiros') return 'moderation';
    if (token === '/engajamento') return 'engagement';
    if (token === '/leads') return 'leadsRead';
    return null;
}

function isPartnerAddCommand(text) {
    const safe = String(text || '').trim().toLowerCase();
    return safe.startsWith('/addparceiro') || safe.startsWith('/adicionarparceiro');
}

function isPartnerRemoveCommand(text) {
    const safe = String(text || '').trim().toLowerCase();
    return safe.startsWith('/delparceiro') || safe.startsWith('/removerparceiro');
}

function isPartnerListCommand(text) {
    const safe = String(text || '').trim().toLowerCase();
    return safe.startsWith('/listparceiros') || safe.startsWith('/listarparceiros');
}

function isPartnerCommandText(text) {
    return isPartnerAddCommand(text) || isPartnerRemoveCommand(text) || isPartnerListCommand(text);
}

function isStopIntervalReminderCommand(text) {
    const safe = String(text || '').trim().toLowerCase();
    if (safe.startsWith('/stoplembretefixo') || safe.startsWith('/stoplembretesfixos')) return false;
    return safe.startsWith('/stoplembrete') || safe.startsWith('/stoplembretes');
}

function isStopFixedReminderCommand(text) {
    const safe = String(text || '').trim().toLowerCase();
    return safe.startsWith('/stoplembretefixo') || safe.startsWith('/stoplembretesfixos');
}

function getPermissionLabel(permissionKey) {
    if (permissionKey === 'openClose') return 'abertura/fechamento';
    if (permissionKey === 'reminders') return 'lembretes';
    if (permissionKey === 'promo') return 'promo';
    if (permissionKey === 'moderation') return 'moderacao';
    if (permissionKey === 'engagement') return 'engajamento (leitura)';
    if (permissionKey === 'leadsRead') return 'leads (leitura)';
    return permissionKey || 'desconhecida';
}

function normalizeGroupSearch(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function splitGroupQueries(input) {
    const raw = String(input || '');
    return raw
        .split(/[\n,;]+/)
        .map((part) => part.trim())
        .filter(Boolean);
}

function resolveSingleGroupFromList(list, query) {
    if (query.endsWith('@g.us')) {
        const found = list.find((g) => g.id === query);
        if (!found) return { ok: false, message: `Grupo por ID nao encontrado: ${query}` };
        return { ok: true, group: found };
    }

    const normalizedQuery = normalizeGroupSearch(query);
    const exact = list.filter((g) => normalizeGroupSearch(g.subject) === normalizedQuery);
    if (exact.length === 1) return { ok: true, group: exact[0] };
    if (exact.length > 1) {
        return { ok: false, message: `Mais de um grupo com esse nome: "${query}". Informe um nome mais especifico.` };
    }

    const partial = list.filter((g) => normalizeGroupSearch(g.subject).includes(normalizedQuery));
    if (partial.length === 1) return { ok: true, group: partial[0] };
    if (partial.length > 1) {
        const opts = partial.slice(0, 8).map((g) => `- ${g.subject}`).join('\n');
        return { ok: false, message: `Encontrei varios grupos para "${query}". Seja mais especifico:\n${opts}` };
    }

    return { ok: false, message: `Grupo nao encontrado: "${query}"` };
}

async function resolveGroupsByInput(sock, input) {
    const queries = splitGroupQueries(input);
    if (!queries.length) {
        return { ok: false, message: 'Informe nome(s) ou ID(s) do(s) grupo(s).' };
    }

    let groups;
    try {
        groups = await sock.groupFetchAllParticipating();
    } catch (error) {
        return { ok: false, message: `Falha ao listar grupos: ${error.message}` };
    }

    const list = Object.entries(groups || {}).map(([id, data]) => ({
        id,
        subject: String(data?.subject || '')
    }));

    const selected = [];
    const selectedIds = new Set();
    const errors = [];

    for (const query of queries) {
        const resolved = resolveSingleGroupFromList(list, query);
        if (!resolved.ok) {
            errors.push(resolved.message);
            continue;
        }
        if (!selectedIds.has(resolved.group.id)) {
            selected.push(resolved.group);
            selectedIds.add(resolved.group.id);
        }
    }

    if (!selected.length) {
        return { ok: false, message: errors.join('\n') || 'Nenhum grupo valido selecionado.' };
    }
    if (errors.length) {
        return { ok: false, message: errors.join('\n') };
    }

    return { ok: true, groups: selected };
}

function normalizePartnerTarget(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    if (/@(c\.us|s\.whatsapp\.net|lid)$/i.test(raw)) return raw;

    const digits = getNumberFromJid(raw);
    if (!digits) return '';
    return `${digits}@c.us`;
}

async function resolvePartnerAliasesForGroup(sock, groupId, targetUserId) {
    const normalizedTarget = normalizePartnerTarget(targetUserId);
    if (!normalizedTarget || !groupId || !sock) {
        return normalizedTarget ? [normalizedTarget] : [];
    }

    try {
        const metadata = await sock.groupMetadata(groupId);
        const participant = (metadata?.participants || []).find((item) => {
            const candidates = [item?.id, item?.jid, item?.lid].filter(Boolean);
            return candidates.some((candidate) => isSameJid(candidate, normalizedTarget));
        });

        if (!participant) {
            return [normalizedTarget];
        }

        const aliases = [
            normalizedTarget,
            participant.id,
            participant.jid,
            participant.lid,
            participant.phoneNumber,
            participant.pn,
            participant.participantPn,
            participant.ownerPn
        ]
            .filter(Boolean)
            .map((value) => normalizePartnerTarget(value))
            .filter(Boolean);

        return Array.from(new Set(aliases));
    } catch {
        return [normalizedTarget];
    }
}

function formatPartnerPhone(digits) {
    if (!digits) return '';
    return digits.startsWith('55') ? `+${digits}` : `+55${digits}`;
}

async function formatPartnerListMessage(sock, groupId, groupName, partners = []) {
    if (!partners.length) {
        return `Parceiros\n\nNenhum parceiro cadastrado para ${groupName}.`;
    }

    const uniquePartners = [];
    const groupedPartners = new Map();

    for (const partner of partners) {
        const digits = getNumberFromJid(partner);
        const key = digits || String(partner || '').trim();
        if (!key) continue;
        if (!groupedPartners.has(key)) {
            groupedPartners.set(key, { digits, aliases: [] });
        }
        groupedPartners.get(key).aliases.push(String(partner || '').trim());
    }
    uniquePartners.push(...Array.from(groupedPartners.values()));

    let participants = [];
    try {
        const metadata = await sock.groupMetadata(groupId);
        participants = Array.isArray(metadata?.participants) ? metadata.participants : [];
    } catch {
        participants = [];
    }

    const lines = uniquePartners.map((partner, index) => {
        const participant = participants.find((item) => {
            const aliases = [item?.id, item?.jid, item?.lid].filter(Boolean);
            return aliases.some((alias) => getNumberFromJid(alias) === partner.digits);
        });

        const displayName = String(
            participant?.notify
            || participant?.verifiedName
            || participant?.name
            || participant?.pushName
            || ''
        ).trim();

        const phone = formatPartnerPhone(partner.digits);
        const header = displayName && phone
            ? `${index + 1}. ${displayName} - ${phone}`
            : displayName
                ? `${index + 1}. ${displayName}`
                : phone
                    ? `${index + 1}. ${phone}`
                    : `${index + 1}. Parceiro cadastrado`;
        const aliases = Array.from(new Set((partner.aliases || []).filter(Boolean)));
        const aliasesLine = aliases.length ? `Aliases: ${aliases.join(', ')}` : '';
        return aliasesLine ? `${header}\n${aliasesLine}` : header;
    }).join('\n');

    return `*PARCEIROS LIBERADOS*\n\nGrupo: ${groupName}\n\n${lines}\n\nTotal: ${uniquePartners.length}`;
}

async function ensurePartnerManagerAccess(sock, senderId, groupId) {
    return checkAuth(sock, senderId, groupId, { allowGroupAdmins: true });
}

function buildRankingMessageForGroup(ranking, title = 'RANKING TOP 10') {
    if (!ranking?.top?.length) {
        return '📊 Ainda nao ha mensagens suficientes para gerar ranking neste grupo.';
    }

    const medals = ['🥇', '🥈', '🥉'];
    let rankingMsg = `🏆 *${title}*\n`;
    rankingMsg += `📌 Grupo: ${ranking.groupName}\n`;
    rankingMsg += `💬 Mensagens totais: ${ranking.totalMessages}\n\n`;

    ranking.top.forEach((item, index) => {
        const medal = medals[index] || '🏅';
        rankingMsg += `${medal} *${item.senderName}*\n`;
        rankingMsg += `🔥 Grau: ${item.grade}\n`;
        rankingMsg += `💭 Total de mensagens: ${item.messages}\n\n`;
    });

    return rankingMsg.trim();
}

function resolveRankingGroupSelection(inputText, groups = []) {
    const raw = String(inputText || '').trim();
    if (!raw) return null;

    const byNumber = Number.parseInt(raw, 10);
    if (Number.isFinite(byNumber) && byNumber >= 1 && byNumber <= groups.length) {
        return groups[byNumber - 1];
    }

    const lowered = raw.toLowerCase();
    const exactId = groups.find((g) => String(g.id || '').toLowerCase() === lowered);
    if (exactId) return exactId;

    const exactName = groups.find((g) => String(g.subject || '').toLowerCase() === lowered);
    if (exactName) return exactName;

    const partial = groups.filter((g) => String(g.subject || '').toLowerCase().includes(lowered));
    if (partial.length === 1) return partial[0];

    return null;
}

function isNoneText(value) {
    const t = String(value || '').trim().toLowerCase();
    return t === 'nenhuma' || t === 'nenhum' || t === 'nao' || t === 'não' || t === 'sem';
}

function isLikelyHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || '').trim());
}

function buildLaminaPreview(state) {
    const groupsLines = (state.groups || []).map((g, idx) => `${idx + 1}. ${g.subject}`).join('\n');
    return `Previa da lamina\n\nTitulo: ${state.title || 'sem titulo'}\nGrupos de destino:\n${groupsLines}\n\nResponda APROVAR para enviar, REFAZER para ajustar ou CANCELAR para encerrar.`;
}

async function sendLaminaPreview(sock, senderId, state) {
    if (state.imageBuffer) {
        await sendSafeMessage(sock, senderId, {
            image: state.imageBuffer,
            caption: state.textBody
        });
        return;
    }

    const raw = String(state.imageSource || '').trim();
    if (!raw) {
        await sendSafeMessage(sock, senderId, { text: state.textBody });
        return;
    }

    if (isLikelyHttpUrl(raw)) {
        await sendSafeMessage(sock, senderId, {
            image: { url: raw },
            caption: state.textBody
        });
        return;
    }

    const absPath = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
    if (!fs.existsSync(absPath)) return;
    const imageBuffer = fs.readFileSync(absPath);
    await sendSafeMessage(sock, senderId, {
        image: imageBuffer,
        caption: state.textBody
    });
}

function isTransientLaminaSendError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('connection closed')
        || message.includes('timed out')
        || message.includes('stream errored out')
        || message.includes('not connected')
        || message.includes('connection lost')
        || message.includes('socket closed');
}

const LAMINA_RETRY_WINDOW_MS = 10 * 60 * 1000;

function isRetryableLaminaFailureMessage(message) {
    const safeMessage = String(message || '').trim();
    if (!safeMessage) return false;
    const detail = safeMessage.includes(': ')
        ? safeMessage.split(': ').slice(1).join(': ')
        : safeMessage;
    return isTransientLaminaSendError(detail);
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendLaminaToGroups(sock, state, options = {}) {
    const targets = Array.isArray(state.groups) ? state.groups : [];
    const failures = [];
    const delivered = [];
    const retryAttempts = Math.max(0, Number(options.retryAttempts || 0));
    const retryDelayMs = Math.max(250, Number(options.retryDelayMs || 1500));
    const laminaTitle = sanitizeEntityTitle(state?.title || '');
    const laminaLabel = laminaTitle || 'lamina-sem-titulo';

    for (const group of targets) {
        const targetId = group.id;
        const groupLabel = group.subject || group.id;
        const sendPayload = async () => {
            let sent = null;
            if (state.imageBuffer) {
                sent = await sendSafeMessage(sock, targetId, { image: state.imageBuffer, caption: state.textBody });
            } else if (!state.imageSource) {
                sent = await sendPlainText(sock, targetId, state.textBody);
            } else {
                const raw = String(state.imageSource || '').trim();
                if (isLikelyHttpUrl(raw)) {
                    sent = await sendSafeMessage(sock, targetId, { image: { url: raw }, caption: state.textBody });
                } else {
                    const absPath = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
                    if (!fs.existsSync(absPath)) {
                        throw new Error(`Imagem nao encontrada no caminho: ${absPath}`);
                    }
                    const imageBuffer = fs.readFileSync(absPath);
                    sent = await sendSafeMessage(sock, targetId, { image: imageBuffer, caption: state.textBody });
                }
            }

            if (!sent) {
                throw new Error('sendSafeMessage retornou vazio');
            }

            return sent;
        };

        try {
            let attempt = 0;
            while (true) {
                try {
                    await sendPayload();
                    delivered.push(groupLabel);
                    logger.info('lamina_dispatch_ok', {
                        title: laminaLabel,
                        targetId,
                        target: groupLabel,
                        hasImage: Boolean(state.imageBuffer || state.imageSource)
                    });
                    break;
                } catch (error) {
                    if (attempt >= retryAttempts || !isTransientLaminaSendError(error)) {
                        throw error;
                    }
                    logger.warn('lamina_dispatch_retry', {
                        title: laminaLabel,
                        targetId,
                        target: groupLabel,
                        attempt: attempt + 1,
                        error: error.message || String(error)
                    });
                    attempt += 1;
                    await delay(retryDelayMs);
                }
            }
        } catch (error) {
            failures.push(`${groupLabel}: ${error.message}`);
            logger.error('lamina_dispatch_failed', {
                title: laminaLabel,
                targetId,
                target: groupLabel,
                error: error.message || String(error)
            });
        }
    }

    return { failures, delivered };
}

function readSavedLaminas() {
    try {
        const parsed = readJsonWithRecovery(LAMINAS_FILE, []);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeSavedLaminas(items) {
    writeJsonAtomic(LAMINAS_FILE, Array.isArray(items) ? items : []);
}

function saveLaminaTemplate({ title, state, senderId }) {
    const safeTitle = String(title || '').trim();
    if (!safeTitle) {
        return { ok: false, message: 'Titulo invalido.' };
    }

    const list = readSavedLaminas();
    const nowIso = new Date().toISOString();
    const payload = {
        title: safeTitle,
        textBody: String(state?.textBody || ''),
        imageSource: String(state?.imageSource || ''),
        imageBase64: state?.imageBuffer ? state.imageBuffer.toString('base64') : '',
        groups: Array.isArray(state?.groups) ? state.groups : [],
        updatedAt: nowIso,
        createdBy: senderId
    };

    const index = list.findIndex((item) => String(item?.title || '').toLowerCase() === safeTitle.toLowerCase());
    if (index >= 0) {
        payload.createdAt = list[index].createdAt || nowIso;
        list[index] = payload;
    } else {
        payload.createdAt = nowIso;
        list.push(payload);
    }

    writeSavedLaminas(list);
    return { ok: true, message: `Lamina "${safeTitle}" salva com sucesso.` };
}

function buildSavedLaminasListMessage() {
    const list = readSavedLaminas();
    if (!list.length) return 'Nenhuma lamina salva.';

    const formatShortDateTime = (value) => {
        if (!value) return 'sem data';
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return 'sem data';
        return parsed.toLocaleString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            year: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    const lines = list
        .slice(-50)
        .reverse()
        .map((item, idx) => {
            const dt = formatShortDateTime(item?.updatedAt);
            return `${idx + 1}. *${item.title}*\n   Atualizada: ${dt}`;
        });

    return `📚 *LAMINAS SALVAS*\nTotal: ${list.length}\n\n${lines.join('\n\n')}`;
}

function buildSavedLaminasSelectionMessage(limit = 30) {
    const list = readSavedLaminas();
    if (!list.length) return { ok: false, message: 'Nenhuma lamina salva.' };
    const shown = list.slice(-limit).reverse();
    const lines = shown.map((item, idx) => `${idx + 1}. ${item.title}`).join('\n');
    return {
        ok: true,
        items: shown,
        message: `Qual lamina deseja editar?\n\n${lines}\n\nResponda com numero ou titulo.`
    };
}

function buildSavedLaminaTextMessages(lamina) {
    const title = String(lamina?.title || '').trim() || 'sem titulo';
    const textBody = String(lamina?.textBody || '').trim();
    if (!textBody) {
        return [`A lamina "${title}" esta sem texto configurado.`];
    }

    const limit = 3500;
    const chunks = [];
    for (let offset = 0; offset < textBody.length; offset += limit) {
        chunks.push(textBody.slice(offset, offset + limit));
    }

    return chunks.map((chunk, index) => {
        const partLabel = chunks.length > 1 ? `\n\nParte ${index + 1}/${chunks.length}` : '';
        return `📝 *TEXTO DA LAMINA*\n\nTitulo: ${title}\n\n${chunk}${partLabel}`;
    });
}

function resolveSavedLaminaByTitle(input) {
    const list = readSavedLaminas();
    if (!list.length) return { ok: false, message: 'Nao ha laminas salvas.' };

    const raw = String(input || '').trim();
    if (!raw) return { ok: false, message: 'Informe o titulo da lamina. Ex.: /usarlamina MinhaLamina' };

    const exact = list.find((item) => String(item?.title || '').toLowerCase() === raw.toLowerCase());
    if (exact) return { ok: true, lamina: exact };

    const partial = list.filter((item) => String(item?.title || '').toLowerCase().includes(raw.toLowerCase()));
    if (partial.length === 1) return { ok: true, lamina: partial[0] };
    if (partial.length > 1) {
        const options = partial.slice(0, 10).map((item, idx) => `${idx + 1}. ${item.title}`).join('\n');
        return { ok: false, message: `Mais de uma lamina encontrada:\n${options}\n\nSeja mais especifico no titulo.` };
    }

    return { ok: false, message: `Lamina "${raw}" nao encontrada.` };
}

function resolveSavedLaminaSelection(input, items = []) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    const byNumber = Number.parseInt(raw, 10);
    if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= items.length) {
        return items[byNumber - 1];
    }
    const lowered = raw.toLowerCase();
    return items.find((item) => String(item?.title || '').toLowerCase() === lowered) || null;
}

function buildLaminaStateFromSaved(lamina) {
    return {
        title: String(lamina?.title || ''),
        groups: Array.isArray(lamina?.groups) ? lamina.groups : [],
        imageSource: String(lamina?.imageSource || ''),
        imageBuffer: lamina?.imageBase64 ? Buffer.from(lamina.imageBase64, 'base64') : null,
        textBody: String(lamina?.textBody || '')
    };
}

function renameLaminaSchedulesTitle(oldTitle, newTitle) {
    const from = String(oldTitle || '').trim();
    const to = String(newTitle || '').trim();
    if (!from || !to || from.toLowerCase() === to.toLowerCase()) return 0;

    const list = readLaminaSchedules();
    let changed = 0;
    for (const item of list) {
        if (String(item?.title || '').toLowerCase() === from.toLowerCase()) {
            item.title = to;
            changed += 1;
        }
    }
    if (changed) writeLaminaSchedules(list);
    return changed;
}

function readLaminaSchedules() {
    try {
        const parsed = readJsonWithRecovery(LAMINA_SCHEDULES_FILE, []);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeLaminaSchedules(items) {
    writeJsonAtomic(LAMINA_SCHEDULES_FILE, Array.isArray(items) ? items : []);
}

function readLaminaConversations() {
    try {
        const parsed = readJsonWithRecovery(LAMINA_CONVERSATIONS_FILE, {});
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeLaminaConversations(data) {
    writeJsonAtomic(LAMINA_CONVERSATIONS_FILE, data && typeof data === 'object' ? data : {});
}

function trackLaminaConversation(senderId, context, messageText = '') {
    const safeSender = String(senderId || '').trim();
    if (!safeSender) return;

    const db = readLaminaConversations();
    const nowIso = new Date().toISOString();
    const current = db[safeSender] || {
        userId: safeSender,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        totalInteractions: 0,
        contexts: {},
        samples: []
    };

    current.lastSeenAt = nowIso;
    current.totalInteractions = Number(current.totalInteractions || 0) + 1;
    const ctx = String(context || 'unknown').trim() || 'unknown';
    current.contexts[ctx] = Number(current.contexts[ctx] || 0) + 1;
    if (String(messageText || '').trim()) {
        current.samples.push({
            at: nowIso,
            context: ctx,
            text: String(messageText).slice(0, 220)
        });
        if (current.samples.length > 20) current.samples.shift();
    }

    db[safeSender] = current;
    writeLaminaConversations(db);
}

function parseTimeHHMM(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hh = Number(match[1]);
    const mm = Number(match[2]);
    if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function parseMultipleTimesHHMM(value) {
    const items = String(value || '')
        .split(/[\s,;\n]+/)
        .map((item) => parseTimeHHMM(item))
        .filter(Boolean);

    return Array.from(new Set(items));
}

function parseUpToTenTimesHHMM(value) {
    const items = parseMultipleTimesHHMM(value);
    return items.slice(0, 10);
}

function getConfiguredDateTimeParts(now = new Date(), timeZone = REMINDER_TIMEZONE) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).formatToParts(now);

    const pick = (type) => parts.find((p) => p.type === type)?.value || '';
    const year = pick('year');
    const month = pick('month');
    const day = pick('day');
    const hour = pick('hour');
    const minute = pick('minute');
    return {
        dateKey: `${year}-${month}-${day}`,
        time: `${hour}:${minute}`
    };
}

function buildLaminaGroupsKey(groups = []) {
    const safeGroups = Array.isArray(groups)
        ? groups.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
    return safeGroups.slice().sort().join('|');
}

function createLaminaSchedule({ title, time, creatorId, groups = [] }) {
    const schedules = readLaminaSchedules();
    const safeGroups = Array.isArray(groups) ? groups.map((item) => String(item || '').trim()).filter(Boolean) : [];
    for (const groupId of safeGroups) {
        const activeCount = schedules.filter((item) => item?.active !== false && Array.isArray(item?.groups) && item.groups.includes(groupId)).length;
        if (activeCount >= MAX_GROUP_LAMINA_SCHEDULES) {
            throw new Error(`Limite de laminas agendadas por grupo atingido (${MAX_GROUP_LAMINA_SCHEDULES}).`);
        }
    }
    const groupsKey = buildLaminaGroupsKey(safeGroups);
    const existing = schedules.find((item) => {
        if (item?.active === false) return false;
        if (String(item?.title || '').trim().toLowerCase() !== String(title || '').trim().toLowerCase()) return false;
        if (String(item?.time || '') !== String(time || '')) return false;
        return buildLaminaGroupsKey(item?.groups || []) === groupsKey;
    });
    if (existing) {
        return { ...existing, reused: true };
    }
    const id = `lamina_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const item = {
        id,
        title,
        time,
        creatorId,
        groups: safeGroups,
        active: true,
        lastRunDate: null,
        createdAt: new Date().toISOString()
    };
    schedules.push(item);
    writeLaminaSchedules(schedules);
    return item;
}

function buildActiveLaminaSchedulesList() {
    const list = readLaminaSchedules().filter((item) => item?.active !== false);
    if (!list.length) {
        return { ok: false, message: 'Nao ha agendamentos de lamina ativos.' };
    }

    const lines = list.map((item, idx) => `${idx + 1}. ${item.title} | ${item.time}`);
    return {
        ok: true,
        items: list,
        message: `Agendamentos de lamina ativos:\n\n${lines.join('\n')}\n\nResponda com o numero do agendamento que deseja cancelar.`
    };
}

async function buildActiveLaminaSchedulesDetailedMessage(sock) {
    const list = readLaminaSchedules().filter((item) => item?.active !== false);
    if (!list.length) {
        return { ok: false, message: 'Nao ha laminas ativas no momento.' };
    }

    let groupNamesById = new Map();
    try {
        const groupsRaw = await sock.groupFetchAllParticipating();
        groupNamesById = new Map(
            Object.entries(groupsRaw || {}).map(([id, data]) => [id, String(data?.subject || '').trim() || id])
        );
    } catch (_) { }

    const grouped = new Map();
    for (const item of list) {
        const key = `${String(item?.title || '').trim()}__${buildLaminaGroupsKey(item?.groups || [])}`;
        if (!grouped.has(key)) {
            grouped.set(key, {
                title: String(item?.title || '').trim() || 'sem titulo',
                groups: Array.isArray(item?.groups) ? item.groups : [],
                times: []
            });
        }
        grouped.get(key).times.push(String(item?.time || '').trim());
    }

    const lines = Array.from(grouped.values()).map((item, index) => {
        const labels = item.groups.length
            ? item.groups.map((groupId) => groupNamesById.get(groupId) || groupId).join(', ')
            : 'sem grupos vinculados';
        const times = Array.from(new Set(item.times)).sort().join(', ');
        return `${index + 1}. ${item.title}\nHorarios: ${times}\nGrupos: ${labels}`;
    });

    return {
        ok: true,
        message: `Laminas ativas:\n\n${lines.join('\n\n')}`
    };
}

async function buildLaminaDispatchStatusMessage(sock) {
    const list = readLaminaSchedules().filter((item) => item?.active !== false);
    if (!list.length) {
        return { ok: false, message: 'Nao ha agendamentos de lamina ativos.' };
    }

    const now = getConfiguredDateTimeParts(new Date(), REMINDER_TIMEZONE);
    let groupNamesById = new Map();
    try {
        const groupsRaw = await sock.groupFetchAllParticipating();
        groupNamesById = new Map(
            Object.entries(groupsRaw || {}).map(([id, data]) => [id, String(data?.subject || '').trim() || id])
        );
    } catch (_) { }

    const formatGroups = (groups = []) => {
        if (!groups.length) return 'sem grupos vinculados';
        return groups.map((groupId) => groupNamesById.get(groupId) || groupId).join(', ');
    };

    const groupScheduleItems = (items, type) => {
        const grouped = new Map();
        for (const item of items) {
            const key = `${String(item?.title || '').trim()}__${buildLaminaGroupsKey(item?.groups || [])}`;
            if (!grouped.has(key)) {
                grouped.set(key, {
                    title: String(item?.title || '').trim() || 'sem titulo',
                    groups: Array.isArray(item?.groups) ? item.groups : [],
                    entries: []
                });
            }
            grouped.get(key).entries.push(item);
        }

        return Array.from(grouped.values()).map((item, index) => {
            const sortedEntries = item.entries
                .slice()
                .sort((a, b) => String(a?.time || '').localeCompare(String(b?.time || '')));
            const horarios = sortedEntries.map((entry) => {
                const base = String(entry?.time || '').trim();
                if (type === 'dispatched' && entry?.lastRunStatus === 'error') {
                    return `${base} (erro)`;
                }
                if (type === 'dispatched' && entry?.lastRunStatus === 'ok_parcial') {
                    return `${base} (parcial)`;
                }
                if (type === 'overdue') {
                    return `${base} (${entry?.lastRunMessage ? 'erro' : 'pendente'})`;
                }
                return base;
            }).join(', ');
            const detail = type === 'overdue'
                ? sortedEntries.find((entry) => entry?.lastRunMessage)?.lastRunMessage
                : '';
            const extra = detail ? `\nObs: ${String(detail).slice(0, 120)}` : '';
            return `${index + 1}. ${item.title}\nHorarios: ${horarios}\nGrupos: ${formatGroups(item.groups)}${extra}`;
        });
    };

    const dispatched = list.filter((item) => String(item?.lastRunDate || '') === now.dateKey);
    const upcoming = list.filter((item) => String(item?.lastRunDate || '') !== now.dateKey && String(item?.time || '') > now.time);
    const overdue = list.filter((item) => String(item?.lastRunDate || '') !== now.dateKey && String(item?.time || '') <= now.time);

    const dispatchedWithError = dispatched.filter((item) => item?.lastRunStatus === 'error').length;
    const dispatchedPartial = dispatched.filter((item) => item?.lastRunStatus === 'ok_parcial').length;
    const sections = [];
    sections.push(
        dispatched.length
            ? `Ja disparadas hoje (${now.dateKey}): ${dispatched.length}\nFalhas totais: ${dispatchedWithError}\nFalhas parciais: ${dispatchedPartial}\n\n${groupScheduleItems(dispatched, 'dispatched').join('\n\n')}`
            : `Ja disparadas hoje (${now.dateKey}):\n\nNenhuma.`
    );
    sections.push(
        upcoming.length
            ? `Ainda vao disparar hoje: ${upcoming.length}\n\n${groupScheduleItems(upcoming, 'upcoming').join('\n\n')}`
            : 'Ainda vao disparar hoje:\n\nNenhuma.'
    );
    sections.push(
        overdue.length
            ? `Atrasadas ou com indicio de erro hoje: ${overdue.length}\n\n${groupScheduleItems(overdue, 'overdue').join('\n\n')}`
            : 'Atrasadas ou com indicio de erro hoje:\n\nNenhuma.'
    );

    return {
        ok: true,
        message: `Status das laminas (${REMINDER_TIMEZONE} | agora ${now.time}):\n\n${sections.join('\n\n')}`
    };
}

function sanitizeEntityTitle(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildTitleFromText(prefix, text, fallbackSuffix = '') {
    const cleanText = sanitizeEntityTitle(String(text || '').replace(/\*|_/g, ''));
    const snippet = cleanText.slice(0, 40);
    if (snippet) return `${prefix} - ${snippet}`;
    return fallbackSuffix ? `${prefix} - ${fallbackSuffix}` : prefix;
}

function buildAutoReminderTitle(commandText, mode = 'fixed') {
    return buildTitleFromText(mode === 'interval' ? 'Lembrete' : 'Lembrete fixo', commandText, 'sem titulo');
}

function stopLaminaScheduleByInput(input) {
    const raw = String(input || '').trim();
    const list = readLaminaSchedules();
    const active = list.filter((item) => item?.active !== false);
    if (!active.length) {
        return { ok: false, message: 'Nao ha agendamentos de lamina ativos.' };
    }

    let target = null;
    const asNumber = Number.parseInt(raw, 10);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= active.length) {
        target = active[asNumber - 1];
    }

    if (!target) {
        target = active.find((item) => String(item?.id || '').toLowerCase() === raw.toLowerCase());
    }

    if (!target) {
        return { ok: false, message: 'Agendamento nao encontrado. Responda com o numero da lista.' };
    }

    const index = list.findIndex((item) => String(item?.id || '') === String(target.id || ''));
    if (index < 0) {
        return { ok: false, message: 'Agendamento nao encontrado na base.' };
    }

    list[index] = {
        ...list[index],
        active: false,
        stoppedAt: new Date().toISOString()
    };
    writeLaminaSchedules(list);

    return {
        ok: true,
        item: list[index],
        message: `Agendamento cancelado.\n\nLamina: ${list[index].title}\nHorario: ${list[index].time}\nID: ${list[index].id}`
    };
}

function buildAutoLaminaTitle(senderId) {
    const now = new Date();
    const stamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0')
    ].join('');
    const tail = String(senderId || '').replace(/\D/g, '').slice(-4) || 'pv';
    return `lamina-auto-${stamp}-${tail}`;
}

async function runScheduledLaminaItem(sock, scheduleItem) {
    const lamina = readSavedLaminas().find((item) => String(item?.title || '').toLowerCase() === String(scheduleItem.title || '').toLowerCase());
    if (!lamina) {
        return { ok: false, message: `Lamina "${scheduleItem.title}" nao encontrada.` };
    }

    const state = {
        title: String(scheduleItem.title || lamina.title || ''),
        groups: Array.isArray(lamina.groups) ? lamina.groups : [],
        imageSource: String(lamina.imageSource || ''),
        imageBuffer: lamina.imageBase64 ? Buffer.from(lamina.imageBase64, 'base64') : null,
        textBody: String(lamina.textBody || '')
    };

    logger.info('lamina_schedule_dispatch_started', {
        title: state.title || 'lamina-sem-titulo',
        scheduleId: String(scheduleItem.id || ''),
        time: String(scheduleItem.time || ''),
        groups: Array.isArray(state.groups) ? state.groups.length : 0
    });

    const result = await sendLaminaToGroups(sock, state, { retryAttempts: 1, retryDelayMs: 2000 });
    if (result.failures.length) {
        const shouldRetry = result.delivered.length === 0
            && result.failures.every((failure) => isRetryableLaminaFailureMessage(failure));
        logger.warn('lamina_schedule_dispatch_finished', {
            title: state.title || 'lamina-sem-titulo',
            scheduleId: String(scheduleItem.id || ''),
            time: String(scheduleItem.time || ''),
            delivered: result.delivered.length,
            failures: result.failures,
            shouldRetry
        });
        return {
            ok: result.delivered.length > 0,
            status: shouldRetry
                ? 'retry_pending'
                : (result.delivered.length > 0 ? 'ok_parcial' : 'error'),
            retrySuggested: shouldRetry,
            message: `Entregues: ${result.delivered.length}/${Array.isArray(state.groups) ? state.groups.length : 0}; Falhas: ${result.failures.join('; ')}`
        };
    }
    logger.info('lamina_schedule_dispatch_finished', {
        title: state.title || 'lamina-sem-titulo',
        scheduleId: String(scheduleItem.id || ''),
        time: String(scheduleItem.time || ''),
        delivered: result.delivered.length,
        failures: []
    });
    return {
        ok: true,
        status: 'ok',
        message: `Entregues: ${result.delivered.length}/${Array.isArray(state.groups) ? state.groups.length : 0}`
    };
}

function ensureLaminaScheduler(sock) {
    if (laminaSchedulerTimer) return;
    console.log(`[LAMINA] Scheduler iniciado (${REMINDER_TIMEZONE}).`);
    laminaSchedulerTimer = setInterval(async () => {
        const schedules = readLaminaSchedules();
        if (!schedules.length) return;

        const now = getConfiguredDateTimeParts(new Date(), REMINDER_TIMEZONE);
        let changed = false;

        for (const item of schedules) {
            if (!item?.active) continue;
            const retryPendingUntil = Number(item.retryPendingUntilTs || 0);
            if (retryPendingUntil && retryPendingUntil <= Date.now()) {
                delete item.retryPendingUntilTs;
                if (String(item.lastRunStatus || '') === 'retry_pending') {
                    item.lastRunStatus = 'error';
                    if (!String(item.lastRunMessage || '').trim()) {
                        item.lastRunMessage = 'Janela de retentativa encerrada sem entrega.';
                    }
                }
                changed = true;
            }
            const isRetryPending = retryPendingUntil > Date.now();
            const isScheduledTime = String(item.time || '') === now.time;

            if (!isScheduledTime && !isRetryPending) continue;
            if (!isRetryPending && String(item.lastRunDate || '') === now.dateKey) continue;
            if (isRetryPending && String(item.lastRunDate || '') === now.dateKey && String(item.lastRunStatus || '') !== 'retry_pending') continue;

            try {
                const exec = await runScheduledLaminaItem(sock, item);
                item.lastRunAt = new Date().toISOString();
                item.lastRunStatus = String(exec?.status || (exec?.ok ? 'ok' : 'error'));
                item.lastRunMessage = exec.message || '';
                if (exec?.retrySuggested) {
                    item.lastRunDate = now.dateKey;
                    item.retryPendingUntilTs = Date.now() + LAMINA_RETRY_WINDOW_MS;
                } else {
                    item.lastRunDate = now.dateKey;
                    delete item.retryPendingUntilTs;
                }
                changed = true;
            } catch (error) {
                item.lastRunDate = now.dateKey;
                item.lastRunAt = new Date().toISOString();
                item.lastRunStatus = 'error';
                item.lastRunMessage = error.message || String(error);
                delete item.retryPendingUntilTs;
                changed = true;
            }
        }

        if (changed) writeLaminaSchedules(schedules);
    }, 30000);
}

function readShillTemplates() {
    try {
        const parsed = readJsonWithRecovery(SHILL_TEMPLATES_FILE, []);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeShillTemplates(items) {
    writeJsonAtomic(SHILL_TEMPLATES_FILE, Array.isArray(items) ? items : []);
}

function saveShillTemplate({ state, senderId }) {
    const list = readShillTemplates();
    const nowIso = new Date().toISOString();
    const id = `shill_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const item = {
        id,
        title: id,
        textBody: String(state?.textBody || ''),
        imageSource: String(state?.imageSource || ''),
        imageBase64: state?.imageBuffer ? state.imageBuffer.toString('base64') : '',
        createdAt: nowIso,
        updatedAt: nowIso,
        createdBy: senderId
    };
    list.push(item);
    writeShillTemplates(list);
    return item;
}

function buildShillTemplatesList(limit = 30) {
    const list = readShillTemplates();
    if (!list.length) return { ok: false, message: 'Nao ha laminas de shill salvas. Use /laminashill primeiro.' };
    const shown = list.slice(-limit).reverse();
    const lines = shown.map((item, idx) => {
        const excerpt = String(item.textBody || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        return `${idx + 1}. ${item.title}${excerpt ? ` | ${excerpt}` : ''}`;
    }).join('\n');
    return { ok: true, shown, message: `Escolha a lamina de shill:\n\n${lines}\n\nResponda com numero ou titulo.` };
}

function resolveShillTemplateByInput(input, shownList) {
    const raw = String(input || '').trim();
    const list = Array.isArray(shownList) && shownList.length ? shownList : readShillTemplates();
    if (!raw || !list.length) return null;

    const asNumber = Number.parseInt(raw, 10);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= list.length) {
        return list[asNumber - 1];
    }

    const lower = raw.toLowerCase();
    const exact = list.find((item) => String(item?.title || '').toLowerCase() === lower || String(item?.id || '').toLowerCase() === lower);
    if (exact) return exact;

    const partial = list.filter((item) => String(item?.title || '').toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    return null;
}

function readShillSchedules() {
    try {
        const parsed = readJsonWithRecovery(SHILL_SCHEDULES_FILE, []);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeShillSchedules(items) {
    writeJsonAtomic(SHILL_SCHEDULES_FILE, Array.isArray(items) ? items : []);
}

function createShillSchedule({ group, perDay, template, creatorId }) {
    const schedules = readShillSchedules();
    const safePerDay = Math.max(1, Math.min(48, Number(perDay) || 1));
    const intervalMinutes = Math.max(5, Math.floor(1440 / safePerDay));
    const now = Date.now();
    const item = {
        id: `shill_${now}_${Math.floor(Math.random() * 1000)}`,
        active: true,
        group: { id: String(group.id || ''), subject: String(group.subject || group.id || '') },
        perDay: safePerDay,
        intervalMinutes,
        templateId: String(template.id || ''),
        templateTitle: String(template.title || template.id || ''),
        nextRunAt: now + 60 * 1000,
        lastRunAt: null,
        createdBy: creatorId,
        createdAt: new Date(now).toISOString()
    };
    schedules.push(item);
    writeShillSchedules(schedules);
    return item;
}

async function runShillScheduleItem(sock, scheduleItem) {
    const templates = readShillTemplates();
    const tpl = templates.find((item) => String(item.id || '') === String(scheduleItem.templateId || ''));
    if (!tpl) return { ok: false, message: `Template de shill nao encontrado: ${scheduleItem.templateId}` };

    const state = {
        groups: [scheduleItem.group],
        imageSource: String(tpl.imageSource || ''),
        imageBuffer: tpl.imageBase64 ? Buffer.from(tpl.imageBase64, 'base64') : null,
        textBody: String(tpl.textBody || '')
    };
    const result = await sendLaminaToGroups(sock, state);
    if (result.failures.length) {
        return { ok: false, message: result.failures.join('; ') };
    }
    return { ok: true };
}

function ensureShillScheduler(sock) {
    if (shillSchedulerTimer) return;
    console.log('[SHILL] Scheduler iniciado.');
    shillSchedulerTimer = setInterval(async () => {
        const schedules = readShillSchedules();
        if (!schedules.length) return;
        let changed = false;
        const now = Date.now();

        for (const item of schedules) {
            if (!item?.active) continue;
            const nextRunAt = Number(item.nextRunAt || 0);
            if (!nextRunAt || nextRunAt > now) continue;

            try {
                const exec = await runShillScheduleItem(sock, item);
                item.lastRunAt = new Date(now).toISOString();
                item.lastRunStatus = exec.ok ? 'ok' : 'error';
                item.lastRunMessage = exec.ok ? '' : exec.message;
            } catch (error) {
                item.lastRunAt = new Date(now).toISOString();
                item.lastRunStatus = 'error';
                item.lastRunMessage = error.message || String(error);
            }

            const intervalMinutes = Math.max(5, Number(item.intervalMinutes || 60));
            item.nextRunAt = now + (intervalMinutes * 60 * 1000);
            changed = true;
        }

        if (changed) writeShillSchedules(schedules);
    }, 30000);
}

function getIncomingImageMessageContent(message) {
    const root = message?.message || {};
    const unwrapped =
        root?.ephemeralMessage?.message
        || root?.viewOnceMessage?.message
        || root?.viewOnceMessageV2?.message
        || root?.viewOnceMessageV2Extension?.message
        || root;

    return unwrapped?.imageMessage || null;
}

function stripImavyMention(text) {
    return String(text || '')
        .replace(/^@?(imavy|imavyagent)\b[\s,:-]*/i, '')
        .trim();
}

function formatUsdCompact(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'N/A';
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    const fmt2 = (x) => x.toFixed(2).replace(/\.00$/, '');

    if (abs >= 1e9) return `${sign}$${fmt2(abs / 1e9)}B`;
    if (abs >= 1e6) return `${sign}$${fmt2(abs / 1e6)}M`;
    if (abs >= 1e3) return `${sign}$${fmt2(abs / 1e3)}K`;
    if (abs >= 1) return `${sign}$${abs.toFixed(4)}`;
    return `${sign}$${abs.toFixed(8)}`;
}

function formatPriceUsd(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'N/A';
    const abs = Math.abs(n);
    if (abs >= 1) return `$${n.toFixed(4)}`;
    if (abs >= 0.001) return `$${n.toFixed(5)}`;
    if (abs >= 0.0001) return `$${n.toFixed(6)}`;
    return `$${n.toFixed(8)}`;
}

function formatPercentChange(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'N/A';
    return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function formatUsdRounded(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'N/A';
    return `$${Math.round(n).toLocaleString('pt-BR')}`;
}

function formatLiveUsd(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'N/A';
    if (Math.abs(n) >= 1) {
        return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
    }
    return `$${n.toFixed(8)}`;
}

function formatLiveBrl(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'N/A';
    if (Math.abs(n) >= 1) {
        return `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 5 })}`;
    }
    return `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 5, maximumFractionDigits: 9 })}`;
}

function buildDexviewTokenUrl(tokenAddress, chain = 'bsc') {
    const safeToken = String(tokenAddress || '').trim();
    if (!/^0x[a-f0-9]{40}$/i.test(safeToken)) {
        return null;
    }
    const safeChain = String(chain || 'bsc').trim().toLowerCase() || 'bsc';
    return `https://www.dexview.com/${safeChain}/${safeToken}`;
}

function buildDexscreenerPairUrl(pairAddress, chain = 'bsc') {
    const safePair = String(pairAddress || '').trim();
    if (!safePair) {
        return null;
    }
    const safeChain = String(chain || 'bsc').trim().toLowerCase() || 'bsc';
    return `https://dexscreener.com/${safeChain}/${safePair}`;
}

function buildCryptoText({ label, chain, pairAddress, tokenAddress, snap }) {
    const changeTxt = formatPercentChange(snap.changeH24);
    const dexviewUrl = buildDexviewTokenUrl(tokenAddress || snap?.tokenAddress, chain);
    const dexscreenerUrl = buildDexscreenerPairUrl(pairAddress, chain);

    let text = `📈 ${label} (${String(chain).toUpperCase()})
💰 Preço: ${formatPriceUsd(snap.priceUsd)}
🕒 24h: ${changeTxt}
💧 Liquidez: ${formatUsdRounded(snap.liquidityUsd)}`;
    if (dexviewUrl) {
        text += `\n📊 Dexview: ${dexviewUrl}`;
    }
    if (dexscreenerUrl) {
        text += `\n📈 Dexscreener: ${dexscreenerUrl}`;
    }
    return text;
}

function getProjectTokenPairCacheKey(tokenConfig) {
    return `${String(tokenConfig?.chain || '').toLowerCase()}:${String(tokenConfig?.address || '').toLowerCase()}`;
}

function getCachedProjectTokenPair(tokenConfig) {
    const key = getProjectTokenPairCacheKey(tokenConfig);
    const entry = projectTokenPairCache.get(key);
    if (!entry) return null;
    if ((Date.now() - entry.ts) > PROJECT_TOKEN_PAIR_CACHE_TTL_MS) {
        projectTokenPairCache.delete(key);
        return null;
    }
    return entry.pairAddress || null;
}

function setCachedProjectTokenPair(tokenConfig, pairAddress) {
    const key = getProjectTokenPairCacheKey(tokenConfig);
    if (!key || !pairAddress) return;
    projectTokenPairCache.set(key, {
        pairAddress: String(pairAddress).trim(),
        ts: Date.now()
    });
}

async function resolveProjectTokenPairFast(tokenConfig) {
    const cached = getCachedProjectTokenPair(tokenConfig);
    if (cached) {
        return { ok: true, chain: tokenConfig.chain, pairAddress: cached, resolvedFrom: 'cache' };
    }

    const directPair = String(tokenConfig?.pair || '').trim();
    if (directPair) {
        setCachedProjectTokenPair(tokenConfig, directPair);
        return { ok: true, chain: tokenConfig.chain, pairAddress: directPair, resolvedFrom: 'config' };
    }

    const aliasKey = `p${String(tokenConfig?.label || '').trim().toLowerCase()}`;
    if (aliasKey.length > 1) {
        const alias = await getAlias(aliasKey);
        if (alias?.pair && alias.chain === tokenConfig.chain) {
            setCachedProjectTokenPair(tokenConfig, alias.pair);
            return { ok: true, chain: tokenConfig.chain, pairAddress: alias.pair, resolvedFrom: 'alias' };
        }
    }

    const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve({ ok: false, timeout: true }), PROJECT_TOKEN_RESOLVE_TIMEOUT_MS);
    });

    const resolved = await Promise.race([
        resolveDexTarget(`${tokenConfig.chain} ${tokenConfig.address}`, tokenConfig.chain),
        timeoutPromise
    ]);

    if (resolved?.ok && resolved?.pairAddress) {
        setCachedProjectTokenPair(tokenConfig, resolved.pairAddress);
        return resolved;
    }

    if (resolved?.timeout) {
        return { ok: false, timeout: true };
    }

    return resolved || { ok: false, error: 'Falha ao resolver o par principal do token.' };
}

function readRecentLogs(lines = 20) {
    if (!fs.existsSync(BOT_LOG_FILE)) {
        return { ok: false, message: 'Arquivo bot.log não encontrado.' };
    }

    const safeLines = Math.min(80, Math.max(5, Number(lines) || 20));
    const allLines = fs.readFileSync(BOT_LOG_FILE, 'utf8').split(/\r?\n/);
    const recentLines = allLines.slice(-safeLines).join('\n').trim();

    if (!recentLines) {
        return { ok: false, message: 'bot.log está vazio.' };
    }

    const maxChars = 3400;
    const clipped = recentLines.length > maxChars
        ? `...${recentLines.slice(-(maxChars - 3))}`
        : recentLines;

    return { ok: true, text: clipped, safeLines };
}

let lembretesAtivos = {};
let lembretesFixosAtivos = {};
const MAX_GROUP_DAILY_REMINDERS = 7;
const MAX_GROUP_LAMINA_SCHEDULES = 10;

function stripUtf8Bom(value) {
    return String(value || '')
        .replace(/^\uFEFF/, '')
        .replace(/^(?:ï»¿|´╗┐)+/, '')
        .trimStart();
}

function parseJsonFileWithEncodingFallback(filePath, fallbackValue) {
    if (!fs.existsSync(filePath)) {
        return fallbackValue;
    }

    const rawFile = fs.readFileSync(filePath, 'utf8');
    const sanitized = stripUtf8Bom(rawFile);
    if (!sanitized) {
        return fallbackValue;
    }

    try {
        if (sanitized !== rawFile) {
            fs.writeFileSync(filePath, sanitized, 'utf8');
        }
        return JSON.parse(sanitized);
    } catch (error) {
        const repaired = sanitized.replace(/^(?:["']?(?:ï»¿|´╗┐))+/, '').trimStart();
        if (repaired && repaired !== sanitized) {
            try {
                const parsed = JSON.parse(repaired);
                fs.writeFileSync(filePath, repaired, 'utf8');
                return parsed;
            } catch (_) { }
        }
        throw error;
    }
}

function extractReminderPayload(text, command) {
    const raw = String(text || '').trim();
    const prefixRegex = new RegExp(`^\\/${String(command || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const withoutCommand = raw.replace(prefixRegex, '').trim();
    if (!withoutCommand) return '';
    return withoutCommand.startsWith('+')
        ? withoutCommand.slice(1).trim()
        : withoutCommand;
}

function buildReminderBody(command) {
    return `*NOTIFICAÇÃO AUTOMÁTICA*\n\n${command}\n\n_iMavyAgent | Sistema de Lembretes_`;
}

async function sendReminderMessage(sock, groupId, config) {
    const body = buildReminderBody(config?.comando || '');
    const imageBase64 = String(config?.imageBase64 || '').trim();
    if (imageBase64) {
        try {
            const imageBuffer = Buffer.from(imageBase64, 'base64');
            if (imageBuffer.length > 0) {
                return await sendSafeMessage(sock, groupId, {
                    image: imageBuffer,
                    caption: body
                });
            }
        } catch (_) { }
    }
    return sendPlainText(sock, groupId, body);
}

function hasAnySerializedReminderData(data) {
    if (!data || typeof data !== 'object') return false;
    const interval = data.interval && typeof data.interval === 'object' ? Object.keys(data.interval) : [];
    if (interval.length) return true;
    const daily = data.daily && typeof data.daily === 'object' ? Object.values(data.daily) : [];
    for (const entry of daily) {
        if (Array.isArray(entry) && entry.length) return true;
        if (entry && typeof entry === 'object') return true;
    }
    return false;
}

function saveLembretes(options = {}) {
    try {
        const force = options.force === true;
        const data = { interval: {}, daily: {} };
        for (const [groupId, interval] of Object.entries(lembretesAtivos)) {
            if (interval.config) data.interval[groupId] = interval.config;
        }
        for (const [groupId, dailyList] of Object.entries(lembretesFixosAtivos)) {
            const safeList = Array.isArray(dailyList) ? dailyList : [];
            const serialized = safeList
                .map((item) => item?.config)
                .filter(Boolean);
            if (serialized.length === 1) {
                data.daily[groupId] = serialized[0];
            } else if (serialized.length > 1) {
                data.daily[groupId] = serialized;
            }
        }
        if (!force && !hasAnySerializedReminderData(data) && fs.existsSync(LEMBRETES_FILE)) {
            try {
                const currentDiskData = parseJsonFileWithEncodingFallback(LEMBRETES_FILE, {});
                if (hasAnySerializedReminderData(currentDiskData)) {
                    console.warn('[LEMBRETES] Salvamento vazio ignorado para evitar sobrescrever estado persistido durante reconexao.');
                    return;
                }
            } catch (_) { }
        }
        fs.writeFileSync(LEMBRETES_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Erro ao salvar lembretes:', e);
    }
}

function normalizeIntervalReminderConfig(config) {
    if (!config || typeof config !== 'object') return null;
    const comando = String(config.comando || '').trim();
    const intervalo = Number(config.intervalo);
    const encerramento = Number(config.encerramento);
    const startTime = Number(config.startTime);
    const nextTrigger = Number(config.nextTrigger || startTime);
    if (!comando || !Number.isFinite(intervalo) || !Number.isFinite(encerramento) || !Number.isFinite(startTime)) {
        return null;
    }
    return {
        ...config,
        title: sanitizeEntityTitle(config.title || buildAutoReminderTitle(comando, 'interval')),
        comando,
        intervalo,
        encerramento,
        startTime,
        nextTrigger: Number.isFinite(nextTrigger) ? nextTrigger : startTime,
        groupName: String(config.groupName || '').trim(),
        imageBase64: typeof config.imageBase64 === 'string' ? config.imageBase64 : ''
    };
}

function normalizeDailyReminderConfig(config) {
    if (!config || typeof config !== 'object') return null;
    const comando = String(config.comando || '').trim();
    const rawTimes = Array.isArray(config.horarios)
        ? config.horarios
        : (typeof config.horarios === 'string' ? [config.horarios] : []);
    const horarios = [];
    for (const rawTime of rawTimes) {
        const parsed = normalizeTimeToken(String(rawTime || '').trim());
        if (parsed.ok && !horarios.includes(parsed.value)) {
            horarios.push(parsed.value);
        }
    }
    if (!comando || !horarios.length) return null;
    return {
        ...config,
        id: String(config.id || buildDailyReminderId()),
        title: sanitizeEntityTitle(config.title || buildAutoReminderTitle(comando, 'fixed')),
        comando,
        horarios,
        startTime: Number.isFinite(Number(config.startTime)) ? Number(config.startTime) : Date.now(),
        groupName: String(config.groupName || '').trim(),
        imageBase64: typeof config.imageBase64 === 'string' ? config.imageBase64 : ''
    };
}

function normalizeDailyReminderCollection(config) {
    const items = Array.isArray(config) ? config : [config];
    return items
        .map((item) => normalizeDailyReminderConfig(item))
        .filter(Boolean);
}

function clearReminderRuntimeState() {
    for (const entry of Object.values(lembretesAtivos || {})) {
        if (entry?.timer) {
            clearTimeout(entry.timer);
            clearInterval(entry.timer);
        }
    }

    for (const dailyList of Object.values(lembretesFixosAtivos || {})) {
        const safeList = Array.isArray(dailyList) ? dailyList : [];
        for (const item of safeList) {
            for (const timer of Object.values(item?.timers || {})) {
                clearTimeout(timer);
            }
        }
    }

    lembretesAtivos = {};
    lembretesFixosAtivos = {};
}

// Exported initialization function
export function initLembretes(sock) {
    try {
        ensureLaminaStorageFiles();
        ensureScheduledStatePersistence();
        clearReminderRuntimeState();

        if (fs.existsSync(LEMBRETES_FILE)) {
            const raw = parseJsonFileWithEncodingFallback(LEMBRETES_FILE, {});
            if (raw && typeof raw === 'object') {
                if (raw.interval || raw.daily) {
                    const intervalData = raw.interval || {};
                    const dailyData = raw.daily || {};
                    for (const [groupId, config] of Object.entries(intervalData)) {
                        const normalized = normalizeIntervalReminderConfig(config);
                        if (!normalized) {
                            console.warn(`Lembrete intervalar ignorado em ${groupId}: configuracao invalida.`);
                            continue;
                        }
                        restartLembrete(sock, groupId, normalized);
                    }
                    for (const [groupId, config] of Object.entries(dailyData)) {
                        const items = normalizeDailyReminderCollection(config);
                        if (!items.length) {
                            console.warn(`Lembrete fixo ignorado em ${groupId}: configuracao invalida.`);
                            continue;
                        }
                        for (const item of items) {
                            restartLembreteFixo(sock, groupId, item);
                        }
                    }
                } else {
                    // Compatibilidade com formato antigo (apenas intervalos)
                    for (const [groupId, config] of Object.entries(raw)) {
                        const normalized = normalizeIntervalReminderConfig(config);
                        if (!normalized) {
                            console.warn(`Lembrete legado ignorado em ${groupId}: configuracao invalida.`);
                            continue;
                        }
                        restartLembrete(sock, groupId, normalized);
                    }
                }
            }
        }
        persistScheduledAutomationState('init_lembretes');
    } catch (e) {
        console.error('Erro ao carregar lembretes:', e);
    }
}

export function resetLembretesRuntime() {
    clearReminderRuntimeState();
}

// Função auxiliar para iniciar timer com persistência
function startReminderTimer(sock, groupId, config) {
    const { comando, intervalo, nextTrigger } = config;
    const intervaloMs = intervalo * 60 * 60 * 1000;
    const now = Date.now();

    // Se o próximo trigger já passou, agenda para "agora" (catch-up) ou define novo
    let timeToNext = nextTrigger - now;
    if (timeToNext < 0) {
        // Se passou do horário, envia IMEDIATAMENTE e então retoma o ciclo
        console.log(`⚠️ Lembrete do grupo ${groupId} atrasado em ${Math.abs(timeToNext)}ms. Enviando agora...`);
        timeToNext = 0;
    }

    lembretesAtivos[groupId] = {
        config: { ...config, nextTrigger: now + timeToNext }, // Atualiza estado
        timer: setTimeout(async () => {
            const msgText = `*NOTIFICAÇÃO AUTOMÁTICA*\n\n${comando}\n\n_iMavyAgent | Sistema de Lembretes_`;

            await sendPlainText(sock, groupId, msgText);

            // Depois do primeiro envio (recuperado ou novo), configura intervalo regular
            lembretesAtivos[groupId].timer = setInterval(async () => {
                await sendPlainText(sock, groupId, msgText);

                // Atualizar nextTrigger no estado para persistência
                if (lembretesAtivos[groupId]) {
                    lembretesAtivos[groupId].config.nextTrigger = Date.now() + intervaloMs;
                    saveLembretes();
                }
            }, intervaloMs);

            // Atualizar trigger do intervalo
            if (lembretesAtivos[groupId]) {
                lembretesAtivos[groupId].config.nextTrigger = Date.now() + intervaloMs;
                saveLembretes();
            }
        }, timeToNext)
    };
    persistScheduledAutomationState('start_interval_reminder');
}

function stopReminder(groupId, sock = null) {
    if (lembretesAtivos[groupId]) {
        clearTimeout(lembretesAtivos[groupId].timer); // Limpa timeout inicial
        clearInterval(lembretesAtivos[groupId].timer); // Limpa intervalo se já existir (mesma prop)
        delete lembretesAtivos[groupId];
        saveLembretes({ force: true });
        if (sock) {
            sendSafeMessage(sock, groupId, { text: '⏰ *Lembrete encerrado automaticamente*\n\n*_iMavyAgent — Automação Inteligente_*' }).catch(() => { });
        }
    }
}

function restartLembrete(sock, groupId, config) {
    const { encerramento, startTime } = config;
    const encerramentoMs = encerramento * 60 * 60 * 1000;
    const elapsed = Date.now() - startTime;

    if (elapsed >= encerramentoMs) return;

    // Recalcula nextTrigger se não existir (compatibilidade)
    if (!config.nextTrigger) {
        const intervaloMs = config.intervalo * 60 * 60 * 1000;
        const cycles = Math.ceil(elapsed / intervaloMs);
        config.nextTrigger = startTime + (cycles * intervaloMs);
    }

    startReminderTimer(sock, groupId, config);

    setTimeout(() => {
        stopReminder(groupId, sock);
    }, encerramentoMs - elapsed);
}


const MAX_DAILY_TIMES = 6;
const MIN_REMINDER_GAP_MINUTES = 60;
const MAX_REMINDERS_PER_HOUR = 3;

function normalizeTimeToken(token) {
    if (!/^\d{1,2}:\d{2}$/.test(token)) return { ok: false };
    const parts = token.split(':');
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
        return { ok: false };
    }
    return { ok: true, value: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` };
}

function timeTokenToMinutes(token) {
    const parsed = normalizeTimeToken(String(token || '').trim());
    if (!parsed.ok) return null;
    const [hour, minute] = parsed.value.split(':').map(Number);
    return (hour * 60) + minute;
}

function minutesToTimeToken(totalMinutes) {
    const normalized = ((Number(totalMinutes) % 1440) + 1440) % 1440;
    const hour = Math.floor(normalized / 60);
    const minute = normalized % 60;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function getCircularMinuteDistance(a, b) {
    const diff = Math.abs(a - b);
    return Math.min(diff, 1440 - diff);
}

function collectAllFixedReminderSlots(exclude = {}) {
    const slots = [];
    for (const [groupId, entries] of Object.entries(lembretesFixosAtivos || {})) {
        const safeEntries = Array.isArray(entries) ? entries : [];
        for (const entry of safeEntries) {
            const reminderId = String(entry?.id || entry?.config?.id || '');
            if (exclude.groupId === groupId && exclude.reminderId === reminderId) continue;
            const horarios = Array.isArray(entry?.config?.horarios) ? entry.config.horarios : [];
            for (const time of horarios) {
                const minutes = timeTokenToMinutes(time);
                if (minutes === null) continue;
                slots.push({ groupId, reminderId, time, minutes });
            }
        }
    }
    return slots;
}

function validateFixedReminderTimes(times, exclude = {}) {
    const normalizedTimes = [];
    for (const rawTime of Array.isArray(times) ? times : []) {
        const parsed = normalizeTimeToken(String(rawTime || '').trim());
        if (parsed.ok && !normalizedTimes.includes(parsed.value)) {
            normalizedTimes.push(parsed.value);
        }
    }

    const requested = normalizedTimes
        .map((time) => ({ time, minutes: timeTokenToMinutes(time) }))
        .filter((item) => item.minutes !== null);

    for (let i = 0; i < requested.length; i += 1) {
        for (let j = i + 1; j < requested.length; j += 1) {
            const sameHour = Math.floor(requested[i].minutes / 60) === Math.floor(requested[j].minutes / 60);
            const sameMinute = requested[i].minutes === requested[j].minutes;
            if (sameHour && !sameMinute) {
                return {
                    ok: false,
                    message: `Ja possui conflito entre os horarios ${requested[i].time} e ${requested[j].time}. Escolha intervalo de uma hora.`,
                    conflictingTime: requested[j].time,
                    conflictingWith: requested[i].time
                };
            }
            if (!sameHour && getCircularMinuteDistance(requested[i].minutes, requested[j].minutes) < MIN_REMINDER_GAP_MINUTES) {
                return {
                    ok: false,
                    message: `Ja possui conflito entre os horarios ${requested[i].time} e ${requested[j].time}. Escolha intervalo de uma hora.`,
                    conflictingTime: requested[j].time,
                    conflictingWith: requested[i].time
                };
            }
        }
    }

    const existing = collectAllFixedReminderSlots(exclude);
    for (const item of requested) {
        const exactMinuteCount = existing.filter((slot) => slot.minutes === item.minutes).length;
        if (exactMinuteCount >= MAX_REMINDERS_PER_HOUR) {
            return {
                ok: false,
                message: `Ja possui ${MAX_REMINDERS_PER_HOUR} lembretes no horario ${item.time}. Escolha outro intervalo de uma hora.`,
                conflictingTime: item.time,
                conflictingWith: item.time
            };
        }
        const gapConflict = existing.find((slot) => {
            const sameHour = Math.floor(slot.minutes / 60) === Math.floor(item.minutes / 60);
            if (sameHour) {
                return slot.minutes !== item.minutes;
            }
            return getCircularMinuteDistance(slot.minutes, item.minutes) < MIN_REMINDER_GAP_MINUTES;
        });
        if (gapConflict) {
            return {
                ok: false,
                message: `Ja existe um lembrete em conflito com ${item.time}. Horario ja usado: ${gapConflict.time}. Escolha intervalo de uma hora.`,
                conflictingTime: item.time,
                conflictingWith: gapConflict.time
            };
        }
    }

    return { ok: true, times: normalizedTimes };
}

function splitMessageAndTimes(input) {
    const raw = String(input || '').trim();
    if (!raw) return { ok: false, error: 'Use: /lembretefixo + mensagem 08:00 21:00' };

    const tokens = raw.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    const times = [];

    while (tokens.length > 0) {
        const token = tokens[tokens.length - 1];
        if (!/^\d{1,2}:\d{2}$/.test(token)) break;
        const parsed = normalizeTimeToken(token);
        if (!parsed.ok) {
            return { ok: false, error: `Horário inválido: ${token}` };
        }
        if (!times.includes(parsed.value)) times.unshift(parsed.value);
        tokens.pop();
    }

    const message = tokens.join(' ').trim();
    if (!message || times.length === 0) {
        return { ok: false, error: 'Use: /lembretefixo + mensagem 08:00 21:00' };
    }

    return { ok: true, message, times };
}

function ensureDailyReminderList(groupId) {
    if (!Array.isArray(lembretesFixosAtivos[groupId])) {
        lembretesFixosAtivos[groupId] = [];
    }
    return lembretesFixosAtivos[groupId];
}

function getDailyReminderEntries(groupId) {
    return Array.isArray(lembretesFixosAtivos[groupId]) ? lembretesFixosAtivos[groupId] : [];
}

function buildDailyReminderId() {
    return `daily_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
}

function buildReminderEntryLabel(config = {}, kind = 'fixed') {
    const title = sanitizeEntityTitle(config.title || buildAutoReminderTitle(config.comando || '', kind));
    return title || (kind === 'interval' ? 'Lembrete' : 'Lembrete fixo');
}

function buildReminderEntryPreview(config = {}) {
    const message = sanitizeEntityTitle(config.comando || config.messageText || '');
    if (!message) return '';
    const compact = message.replace(/\s+/g, ' ').trim();
    return compact.length > 52 ? `${compact.slice(0, 52).trim()}...` : compact;
}

function buildFixedReminderSelection(groupId) {
    const entries = getDailyReminderEntries(groupId);
    if (!entries.length) {
        return { ok: false, message: 'Nao ha lembretes fixos ativos neste grupo.' };
    }

    const lines = entries.map((entry, index) => {
        const config = entry?.config || {};
        const horarios = Array.isArray(config.horarios) ? config.horarios.join(', ') : '';
        const titulo = buildReminderEntryLabel(config, 'fixed');
        const preview = buildReminderEntryPreview(config);
        const previewPart = preview ? ` | ${preview}` : '';
        return `${index + 1}. ${titulo} | ${horarios || 'sem horario'}${previewPart}`;
    });

    return {
        ok: true,
        entries,
        message: `Qual lembrete fixo deseja desativar?\n\n${lines.join('\n')}\n\nResponda com o numero do lembrete.`
    };
}

function stopSingleLembreteFixo(groupId, reminderId) {
    const entries = getDailyReminderEntries(groupId);
    if (!entries.length) {
        return { ok: false, message: 'Nao ha lembretes fixos ativos neste grupo.' };
    }

    const raw = String(reminderId || '').trim().toLowerCase();
    let target = null;
    const asNumber = Number.parseInt(raw, 10);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= entries.length) {
        target = entries[asNumber - 1];
    }
    if (!target) {
        target = entries.find((item) => String(item?.id || '').toLowerCase() === raw);
    }
    if (!target) {
        return { ok: false, message: 'Lembrete fixo nao encontrado. Responda com o numero da lista.' };
    }

    for (const timer of Object.values(target.timers || {})) {
        clearTimeout(timer);
    }

    const remaining = entries.filter((item) => item?.id !== target.id);
    if (remaining.length) {
        lembretesFixosAtivos[groupId] = remaining;
    } else {
        delete lembretesFixosAtivos[groupId];
    }
    saveLembretes({ force: true });

    return {
        ok: true,
        entry: target,
        message: `Lembrete fixo desativado.\n\nHorarios: ${Array.isArray(target?.config?.horarios) ? target.config.horarios.join(', ') : 'N/D'}`
    };
}

function buildIntervalReminderSelection(groupId) {
    const current = lembretesAtivos[groupId];
    if (!current || !current.config) {
        return { ok: false, message: 'Nao ha lembrete automatico ativo neste grupo.' };
    }

    const config = current.config || {};
    const title = buildReminderEntryLabel(config, 'interval');
    const preview = buildReminderEntryPreview(config);
    return {
        ok: true,
        message: `Qual lembrete automatico deseja desativar?\n\n1. ${title} | Intervalo: ${config.intervalo}h${preview ? ` | ${preview}` : ''}`,
        items: [{ id: '1' }]
    };
}

function buildStopReminderSelection(groupId) {
    const items = buildEditableReminderItems(groupId);
    if (!items.length) {
        return { ok: false, message: 'Nao ha lembretes ativos neste grupo.' };
    }

    const lines = items.map((item, index) => `${index + 1}. ${item.title} | ${item.summary}`).join('\n');
    return {
        ok: true,
        items,
        message: `Qual lembrete deseja desativar?\n\n${lines}`
    };
}

function hasActiveIntervalReminder(groupId) {
    return Boolean(lembretesAtivos[groupId]?.config);
}

function hasActiveFixedReminder(groupId) {
    return getDailyReminderEntries(groupId).length > 0;
}

function hasAnyActiveReminder(groupId) {
    return hasActiveIntervalReminder(groupId) || hasActiveFixedReminder(groupId);
}

function getStoredReminderGroupName(groupId) {
    const intervalName = String(lembretesAtivos[groupId]?.config?.groupName || '').trim();
    if (intervalName) return intervalName;

    const fixedEntry = getDailyReminderEntries(groupId).find((entry) => String(entry?.config?.groupName || '').trim());
    const fixedName = String(fixedEntry?.config?.groupName || '').trim();
    if (fixedName) return fixedName;

    return '';
}

function listRuntimeReminderGroups(filterMode = 'any') {
    const ids = new Set();

    if (filterMode === 'interval' || filterMode === 'any') {
        for (const groupId of Object.keys(lembretesAtivos || {})) {
            if (hasActiveIntervalReminder(groupId)) ids.add(groupId);
        }
    }

    if (filterMode === 'fixed' || filterMode === 'any') {
        for (const groupId of Object.keys(lembretesFixosAtivos || {})) {
            if (hasActiveFixedReminder(groupId)) ids.add(groupId);
        }
    }

    return Array.from(ids)
        .map((id) => ({ id, subject: getStoredReminderGroupName(id) || null }))
        .sort((a, b) => String(a.subject || a.id).localeCompare(String(b.subject || b.id), 'pt-BR'));
}

function stopSingleReminder(groupId, reminderId) {
    const current = lembretesAtivos[groupId];
    if (!current || !current.config) {
        return { ok: false, message: 'Nao ha lembrete automatico ativo neste grupo.' };
    }

    const raw = String(reminderId || '').trim().toLowerCase();
    if (raw !== '1' && raw !== 'primeiro' && raw !== 'unico') {
        return { ok: false, message: 'Lembrete automatico nao encontrado. Responda com 1.' };
    }

    stopReminder(groupId);
    return {
        ok: true,
        message: `Lembrete automatico desativado.\n\nIntervalo: ${current.config.intervalo}h`
    };
}

function getNextDailyTrigger(timeStr, nowDate = new Date()) {
    const now = (nowDate instanceof Date) ? nowDate : new Date(nowDate);
    const parts = timeStr.split(':');
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const nowTzParts = getDatePartsInTimeZone(now, REMINDER_TIMEZONE);
    const dayAnchor = new Date(Date.UTC(nowTzParts.year, nowTzParts.month - 1, nowTzParts.day));
    let nextTs = buildUtcTimestampForTimeZone({
        year: nowTzParts.year,
        month: nowTzParts.month,
        day: nowTzParts.day,
        hour: h,
        minute: m,
        second: 0
    }, REMINDER_TIMEZONE);

    if (nextTs <= now.getTime()) {
        dayAnchor.setUTCDate(dayAnchor.getUTCDate() + 1);
        nextTs = buildUtcTimestampForTimeZone({
            year: dayAnchor.getUTCFullYear(),
            month: dayAnchor.getUTCMonth() + 1,
            day: dayAnchor.getUTCDate(),
            hour: h,
            minute: m,
            second: 0
        }, REMINDER_TIMEZONE);
    }

    return {
        nextTs,
        delayMs: Math.max(0, nextTs - now.getTime())
    };
}

function getDatePartsInTimeZone(date, timeZone = REMINDER_TIMEZONE) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    const parts = formatter.formatToParts(date);
    const lookup = {};
    for (const part of parts) {
        if (part.type !== 'literal') {
            lookup[part.type] = part.value;
        }
    }
    return {
        year: Number(lookup.year),
        month: Number(lookup.month),
        day: Number(lookup.day),
        hour: Number(lookup.hour),
        minute: Number(lookup.minute),
        second: Number(lookup.second)
    };
}

function buildUtcTimestampForTimeZone(target, timeZone = REMINDER_TIMEZONE) {
    let utcGuess = Date.UTC(
        Number(target.year),
        Number(target.month) - 1,
        Number(target.day),
        Number(target.hour || 0),
        Number(target.minute || 0),
        Number(target.second || 0)
    );

    for (let i = 0; i < 4; i += 1) {
        const guessParts = getDatePartsInTimeZone(new Date(utcGuess), timeZone);
        const guessAsUtc = Date.UTC(
            guessParts.year,
            guessParts.month - 1,
            guessParts.day,
            guessParts.hour,
            guessParts.minute,
            guessParts.second
        );
        const targetAsUtc = Date.UTC(
            Number(target.year),
            Number(target.month) - 1,
            Number(target.day),
            Number(target.hour || 0),
            Number(target.minute || 0),
            Number(target.second || 0)
        );
        const diff = targetAsUtc - guessAsUtc;
        utcGuess += diff;
        if (Math.abs(diff) < 1000) {
            break;
        }
    }

    return utcGuess;
}

function scheduleDailyTime(sock, groupId, reminderId, config, timeStr) {
    const { nextTs, delayMs } = getNextDailyTrigger(timeStr);
    const entry = getDailyReminderEntries(groupId).find((item) => item?.id === reminderId);
    if (entry) {
        entry.nextTriggers[timeStr] = nextTs;
    }

    return setTimeout(async () => {
        const msgText = `*NOTIFICAÇÃO AUTOMÁTICA*\n\n${config.comando}\n\n_iMavyAgent | Sistema de Lembretes_`;
        await sendPlainText(sock, groupId, msgText);

        const activeEntry = getDailyReminderEntries(groupId).find((item) => item?.id === reminderId);
        if (activeEntry) {
            const timer = scheduleDailyTime(sock, groupId, reminderId, config, timeStr);
            activeEntry.timers[timeStr] = timer;
            saveLembretes();
        }
    }, delayMs);
}

function rebuildFixedReminderTimers(sock, groupId, entry) {
    for (const timer of Object.values(entry?.timers || {})) {
        clearTimeout(timer);
    }
    entry.timers = {};
    entry.nextTriggers = {};
    for (const timeStr of entry.config.horarios) {
        const timer = scheduleDailyTime(sock, groupId, entry.id, entry.config, timeStr);
        entry.timers[timeStr] = timer;
    }
}

function rebalanceFixedReminderSchedules(sock) {
    const slotQueue = [];
    for (const [groupId, entries] of Object.entries(lembretesFixosAtivos || {})) {
        const safeEntries = Array.isArray(entries) ? entries : [];
        for (const entry of safeEntries) {
            const horarios = Array.isArray(entry?.config?.horarios) ? entry.config.horarios : [];
            for (const time of horarios) {
                const minutes = timeTokenToMinutes(time);
                if (minutes === null) continue;
                slotQueue.push({
                    groupId,
                    entry,
                    originalMinutes: minutes,
                    originalTime: time,
                    sortKey: `${String(entry?.config?.startTime || 0).padStart(16, '0')}:${String(entry?.id || '')}:${time}`
                });
            }
        }
    }

    if (!slotQueue.length) return false;

    slotQueue.sort((a, b) => {
        if (a.originalMinutes !== b.originalMinutes) return a.originalMinutes - b.originalMinutes;
        return a.sortKey.localeCompare(b.sortKey, 'pt-BR');
    });

    const assigned = [];
    let changed = false;

    for (const slot of slotQueue) {
        let chosenMinutes = slot.originalMinutes;
        let found = false;
        for (let offset = 0; offset < 1440; offset += MIN_REMINDER_GAP_MINUTES) {
            const candidate = (slot.originalMinutes + offset) % 1440;
            const sameHourCount = assigned.filter((item) => Math.floor(item.minutes / 60) === Math.floor(candidate / 60)).length;
            const hasGapConflict = assigned.some((item) => getCircularMinuteDistance(item.minutes, candidate) < MIN_REMINDER_GAP_MINUTES);
            if (sameHourCount < MAX_REMINDERS_PER_HOUR && !hasGapConflict) {
                chosenMinutes = candidate;
                found = true;
                break;
            }
        }
        if (!found) continue;
        if (chosenMinutes !== slot.originalMinutes) changed = true;
        assigned.push({ groupId: slot.groupId, entry: slot.entry, minutes: chosenMinutes });
    }

    const byEntry = new Map();
    for (const item of assigned) {
        const key = `${item.groupId}::${String(item.entry?.id || '')}`;
        if (!byEntry.has(key)) byEntry.set(key, []);
        byEntry.get(key).push(minutesToTimeToken(item.minutes));
    }

    for (const [groupId, entries] of Object.entries(lembretesFixosAtivos || {})) {
        const safeEntries = Array.isArray(entries) ? entries : [];
        for (const entry of safeEntries) {
            const key = `${groupId}::${String(entry?.id || '')}`;
            const adjustedTimes = (byEntry.get(key) || []).filter(Boolean);
            if (!adjustedTimes.length) continue;
            const uniqueSorted = Array.from(new Set(adjustedTimes)).sort((a, b) => timeTokenToMinutes(a) - timeTokenToMinutes(b));
            if (JSON.stringify(uniqueSorted) !== JSON.stringify(entry.config.horarios || [])) {
                entry.config.horarios = uniqueSorted;
                changed = true;
            }
            rebuildFixedReminderTimers(sock, groupId, entry);
        }
    }

    if (changed) {
        saveLembretes({ force: true });
    }

    return changed;
}

function startLembreteFixo(sock, groupId, config) {
    const rawTimes = Array.isArray(config.horarios) ? config.horarios : [];
    const horarios = [];
    for (const t of rawTimes) {
        const parsed = normalizeTimeToken(String(t).trim());
        if (parsed.ok && !horarios.includes(parsed.value)) horarios.push(parsed.value);
    }
    if (!horarios.length || !config.comando) return;

    const list = ensureDailyReminderList(groupId);
    if (list.length >= MAX_GROUP_DAILY_REMINDERS) {
        throw new Error(`Limite de lembretes fixos por grupo atingido (${MAX_GROUP_DAILY_REMINDERS}).`);
    }
    const validation = validateFixedReminderTimes(horarios);
    if (!validation.ok) {
        throw new Error(validation.message);
    }

    const reminderId = String(config.id || buildDailyReminderId());
    const entry = {
        id: reminderId,
        config: { ...config, id: reminderId, horarios: validation.times || horarios },
        timers: {},
        nextTriggers: {}
    };
    list.push(entry);

    for (const timeStr of horarios) {
        const timer = scheduleDailyTime(sock, groupId, reminderId, entry.config, timeStr);
        entry.timers[timeStr] = timer;
    }

    saveLembretes();
}

function stopLembreteFixo(groupId, sock = null) {
    const entries = getDailyReminderEntries(groupId);
    if (!entries.length) {
        return { ok: false, removedCount: 0 };
    }

    for (const entry of entries) {
        for (const timer of Object.values(entry.timers || {})) {
            clearTimeout(timer);
        }
    }

    delete lembretesFixosAtivos[groupId];
    saveLembretes({ force: true });

    if (sock) {
        sendSafeMessage(sock, groupId, { text: `🛑 *Lembrete fixo desativado*

*_iMavyAgent — Automação Inteligente_*` }).catch(() => { });
    }

    return { ok: true, removedCount: entries.length };
}

function restartLembreteFixo(sock, groupId, config) {
    const safeGroupId = String(groupId || '').trim() || 'grupo-desconhecido';
    const normalized = normalizeDailyReminderConfig(config);
    if (!normalized) {
        console.warn(`Lembrete fixo ignorado em ${safeGroupId}: configuracao invalida.`);
        return;
    }
    try {
        startLembreteFixo(sock, safeGroupId, normalized);
    } catch (error) {
        console.error(`Falha ao restaurar lembrete fixo em ${safeGroupId}:`, error.message || String(error));
    }
}

function buildReminderStatusText(groupId) {
    const parts = [];

    if (lembretesAtivos[groupId]) {
        const config = lembretesAtivos[groupId].config;
        const startTime = new Date(config.startTime);
        const now = Date.now();
        const nextTrigger = lembretesAtivos[groupId].config.nextTrigger || (now + (config.intervalo * 3600000));
        const timeToNext = Math.max(0, nextTrigger - now);
        const hours = Math.floor(timeToNext / 3600000);
        const minutes = Math.floor((timeToNext % 3600000) / 60000);
        const seconds = Math.floor((timeToNext % 60000) / 1000);
        const remainingDuration = Math.max(0, (config.startTime + (config.encerramento * 3600000)) - now);
        const remainingHours = (remainingDuration / 3600000).toFixed(1);

        parts.push(
            `⏰ *LEMBRETE ATIVO*\n\n` +
            `🏷️ *Titulo:* ${buildReminderEntryLabel(config, 'interval')}\n` +
            `📝 *Mensagem:* ${config.comando}\n` +
            `⏱️ *Intervalo:* ${config.intervalo}h\n` +
            `⏭️ *Próximo envio em:* ${hours}h ${minutes}m ${seconds}s\n` +
            `⏳ *Encerra em:* ${remainingHours}h\n` +
            `📅 *Início:* ${startTime.toLocaleString('pt-BR')}`
        );
    }

    if (Array.isArray(lembretesFixosAtivos[groupId]) && lembretesFixosAtivos[groupId].length) {
        const blocks = lembretesFixosAtivos[groupId].map((entry, index) => {
            const config = entry?.config || {};
            const horarios = Array.isArray(config.horarios) ? config.horarios : [];
            const now = new Date();
            const nextLines = horarios.map((h) => {
                const nextTs = getNextDailyTrigger(h, now).nextTs;
                const when = new Date(nextTs).toLocaleString('pt-BR');
                return `• ${h} (próximo: ${when})`;
            }).join('\n');
            const startTxt = config.startTime ? new Date(config.startTime).toLocaleString('pt-BR') : 'N/D';

            return (
                `📆 *LEMBRETE FIXO DIÁRIO ${index + 1}*\n\n` +
                `🏷️ *Titulo:* ${buildReminderEntryLabel(config, 'fixed')}\n` +
                `📝 *Mensagem:* ${config.comando}\n` +
                `⏰ *Horários:* ${horarios.join(', ')}\n` +
                `📅 *Início:* ${startTxt}` +
                (nextLines ? `\n\n🔜 *Próximos envios:*\n${nextLines}` : '')
            );
        });

        parts.push(blocks.join('\n\n'));
    } else if (lembretesFixosAtivos[groupId]) {
        const config = lembretesFixosAtivos[groupId].config;
        const horarios = Array.isArray(config.horarios) ? config.horarios : [];
        const now = new Date();
        const nextLines = horarios.map((h) => {
            const nextTs = getNextDailyTrigger(h, now).nextTs;
            const when = new Date(nextTs).toLocaleString('pt-BR');
            return `• ${h} (próximo: ${when})`;
        }).join('\n');
        const startTxt = config.startTime ? new Date(config.startTime).toLocaleString('pt-BR') : 'N/D';

        parts.push(
            `📅 *LEMBRETE FIXO DIÁRIO*\n\n` +
            `🏷️ *Titulo:* ${buildReminderEntryLabel(config, 'fixed')}\n` +
            `📝 *Mensagem:* ${config.comando}\n` +
            `⏰ *Horários:* ${horarios.join(', ')}\n` +
            `📅 *Início:* ${startTxt}` +
            (nextLines ? `\n\n🔜 *Próximos envios:*\n${nextLines}` : '')
        );
    }

    return parts.length ? parts.join('\n\n') : 'ℹ️ Nenhum lembrete ativo no momento.';
}

async function configureIntervalReminder(sock, groupId, text) {
    const payload = extractReminderPayload(text, 'lembrete');
    if (!payload) {
        return { ok: false, message: '❗ Use: /lembrete + mensagem 1h 24h\nEx: /lembrete + REUNIÃO HOJE! 1h 24h' };
    }

    const resto = payload.split(/\s+/).filter(Boolean);
    const tempos = resto.slice(-2);
    const comando = resto.slice(0, -2).join(' ');
    const intervalo = parseFloat(String(tempos[0] || '').replace('h', ''));
    const encerramento = parseFloat(String(tempos[1] || '').replace('h', ''));

    if (!comando || !intervalo || !encerramento) {
        return { ok: false, message: '❗ Use: /lembrete + mensagem 1h 24h\nEx: /lembrete + REUNIÃO HOJE! 1h 24h' };
    }
    if (intervalo < 1 || intervalo > 24) {
        return { ok: false, message: '⛔ O intervalo deve ser entre *1 e 24 horas*.' };
    }
    if (encerramento < 24 || encerramento > 168) {
        return { ok: false, message: '⛔ A duração (encerramento) deve ser de no mínimo *24 horas* e no máximo *7 dias (168h)*.' };
    }

    const intervaloMs = intervalo * 60 * 60 * 1000;
    const encerramentoMs = encerramento * 60 * 60 * 1000;

    if (lembretesAtivos[groupId]) {
        stopReminder(groupId);
    }

    const msgFormatada = `*NOTIFICAÇÃO AUTOMÁTICA*\n\n${comando}\n\n_iMavyAgent | Sistema de Lembretes_`;
    await sendPlainText(sock, groupId, msgFormatada);

    const config = {
        title: buildAutoReminderTitle(comando, 'interval'),
        comando,
        intervalo,
        encerramento,
        startTime: Date.now(),
        groupName: getStoredReminderGroupName(groupId)
    };
    const nextTrigger = Date.now() + intervaloMs;
    startReminderTimer(sock, groupId, { ...config, nextTrigger });
    saveLembretes();

    setTimeout(async () => {
        stopReminder(groupId, sock);
    }, encerramentoMs);

    return { ok: true, message: '✅ Lembrete automático ativado com sucesso!' };
}

async function configureFixedReminder(sock, groupId, text) {
    const payload = extractReminderPayload(text, 'lembretefixo');
    if (!payload) {
        return { ok: false, message: `❗ Use: /lembretefixo + mensagem 08:00 21:00\nEx: /lembretefixo + LEMBRETE DIÁRIO 08:00 15:00 21:00` };
    }

    const parsed = splitMessageAndTimes(payload);
    if (!parsed.ok) {
        return { ok: false, message: `⚠️ ${parsed.error}\nEx: /lembretefixo + LEMBRETE DIÁRIO 08:00 15:00 21:00` };
    }
    if (parsed.times.length > MAX_DAILY_TIMES) {
        return { ok: false, message: `⚠️ Máximo de horários por lembrete fixo: ${MAX_DAILY_TIMES}.` };
    }

    if (getDailyReminderEntries(groupId).length >= MAX_GROUP_DAILY_REMINDERS) {
        return { ok: false, message: `⚠️ Limite de lembretes fixos ativos neste grupo: ${MAX_GROUP_DAILY_REMINDERS}.` };
    }

    try {
        startLembreteFixo(sock, groupId, {
            title: buildAutoReminderTitle(parsed.message, 'fixed'),
            comando: parsed.message,
            horarios: parsed.times,
            startTime: Date.now(),
            groupName: getStoredReminderGroupName(groupId)
        });
    } catch (error) {
        return { ok: false, message: `⚠️ ${error.message || String(error)}` };
    }

    return {
        ok: true,
        message: `✅ Lembrete fixo diário ativado.\n\nHorários: ${parsed.times.join(', ')}\nAtivos neste grupo: ${getDailyReminderEntries(groupId).length}/${MAX_GROUP_DAILY_REMINDERS}\nPara desativar: /stoplembretefixo`
    };
}



// Respostas pré-definidas
const RESPONSES = {
    'oi': '👋 Olá! Como posso ajudar?',
    'ajuda': 'Use /comandos para ver o menu completo.',
    'status': '✅ Bot online e funcionando!',
    'info': '🤖 iMavyAgent - Bot para WhatsApp',
    '/snappy': '0x3a9e15b28E099708D0812E0843a9Ed70c508FB4b',
    '/nix': '0xBe96fcF736AD906b1821Ef74A0e4e346C74e6221',
    '/coffee': '0x2cAA9De4E4BB8202547afFB19b5830DC16184451',
    '/lux': '0xa3baAAD9C19805f52cFa2490700C297359b4fA52',
    '/kenesis': '0x76d7966227939b67D66FDB1373A0808ac53Ca9ad',
    '/dcar': '0xe1f7DD2812e91D1f92a8Fa1115f3ACA4aff82Fe5',
    '/fsx': '0xcD4fA13B6f5Cad65534DC244668C5270EC7e961a',
    '/nlc': '0x5f320c3b8f82acfe8f2bb1c85d63aa66a7ff524f',
    '/masaka': '96jWXh7S6Yh1Lkj4Fss14q1jRMwhTKkVpSFzRaunsMKT',
    '/valyrafi': VALYRAFI_MESSAGE
};

loadPrivateWizardsState();

// Inicialização movida para index.js
// if (!global.lembretesLoaded) {
//     global.lembretesLoaded = true;
//     setTimeout(() => loadLembretes(global.sock), 2000);
// }

export async function handleGroupMessages(sock, message, context = {}) {
    if (!global.sock) global.sock = sock;
    ensureLaminaScheduler(sock);
    ensureShillScheduler(sock);
    const groupId = message.key.remoteJid;
    const isGroup = groupId.endsWith('@g.us');
    const senderId = resolveSenderIdFromGroupMessage(message);

    // Modo manutenção - só admins
    if (isMaintenanceMode()) {
        const authorized = await isAuthorized(senderId);
        if (!authorized) return;
    }

    const contentType = Object.keys(message.message)[0];
    let text = '';
    const imageMessageContent = getIncomingImageMessageContent(message);
    const hasIncomingImage = Boolean(imageMessageContent);

    // Permitir /comandos no PV
    switch (contentType) {
        case 'conversation':
            text = message.message.conversation;
            break;
        case 'extendedTextMessage':
            text = message.message.extendedTextMessage.text;
            break;
    }

    if (!isGroup) {
        text = normalizePrivateReminderCommandText(text);
    }

    // Bloquear mensagens vazias
    if ((!text || text.trim().length === 0) && !(hasIncomingImage && !isGroup)) return;

    // Funcionalidade de resposta automática desabilitada

    if (!isGroup && text.toLowerCase().includes('/comandos')) {
        const comandosMsg = buildCommandsMenuText();

        await sendSafeMessage(sock, senderId, { text: comandosMsg });
        return;
    }

    if (!isGroup && String(text || '').trim().toLowerCase().startsWith('/comandos2')) {
        const comandosOcultos = buildHiddenCommandsMenuText();
        await sendSafeMessage(sock, senderId, { text: comandosOcultos });
        return;
    }

    // Permitir respostas em PV usando o dicionário RESPONSES
    if (!isGroup) {
        const textLower = (text || '').trim().toLowerCase();
        const normalizedPrivateText = String(text || '')
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .trim();
        const isStopIntervalPvCommand = isStopIntervalReminderCommand(textLower);
        const isStopFixedPvCommand = isStopFixedReminderCommand(textLower);
        if (isStopIntervalPvCommand || isStopFixedPvCommand) {
            const groups = listRuntimeReminderGroups(isStopFixedPvCommand ? 'fixed' : 'interval');
            if (!groups.length) {
                await sendSafeMessage(sock, senderId, {
                    text: isStopFixedPvCommand
                        ? 'Nao encontrei grupos com lembretes fixos ativos.'
                        : 'Nao encontrei grupos com lembrete automatico ativo.'
                });
                return;
            }

            const shown = groups.slice(0, 30);
            const lines = shown.map((g, i) => `${i + 1}. ${g.subject}`).join('\n');
            const action = isStopFixedPvCommand ? '/stoplembretefixo' : '/stoplembrete';
            setReminderWizard(senderId, {
                step: 'chooseGroup',
                action,
                groups: shown,
                group: null,
                fixedEntries: [],
                editableItems: [],
                editTarget: null,
                title: '',
                messageText: '',
                imageBase64: '',
                intervalHours: null,
                durationDays: null,
                times: []
            });

            let prompt = action === '/stoplembretefixo'
                ? `De qual grupo deseja parar o lembrete fixo?\n\n${lines}\n\nResponda com numero ou nome do grupo.`
                : `De qual grupo deseja parar o lembrete automático?\n\n${lines}\n\nResponda com numero ou nome do grupo.`;
            if (groups.length > shown.length) {
                prompt += `\n\nMostrando ${shown.length} de ${groups.length} grupos.`;
            }
            await sendSafeMessage(sock, senderId, { text: prompt });
            return;
        }
        const hasOtherPrivateWizard = hasNonJobPrivateWizard(senderId);
        const hasPrivateJobConversation = hasPendingPrivateJobConversation(senderId);
        const hasPrivateJobIntent = isManualPrivateJobRequest(text);
        if ((!textLower.startsWith('/') || textLower === '/cancelar') && (hasPrivateJobConversation || hasPrivateJobIntent)) {
            const result = await sendPrivateJobsOnDemand(sock, senderId, { text });
            if (result.handled) {
                appendPrivateJobIntentAudit({
                    senderId,
                    decision: 'handled',
                    hasConversation: hasPrivateJobConversation,
                    hasIntent: hasPrivateJobIntent,
                    blockedByOtherWizard: hasOtherPrivateWizard,
                    text: String(text || '').slice(0, 500)
                });
                logger.info('private_job_flow_handled', {
                    senderId,
                    hasConversation: hasPrivateJobConversation,
                    hasIntent: hasPrivateJobIntent,
                    textPreview: String(text || '').slice(0, 140)
                });
                return;
            }
            appendPrivateJobIntentAudit({
                senderId,
                decision: 'not_handled',
                hasConversation: hasPrivateJobConversation,
                hasIntent: hasPrivateJobIntent,
                blockedByOtherWizard: hasOtherPrivateWizard,
                text: String(text || '').slice(0, 500)
            });
            logger.warn('private_job_flow_not_handled', {
                senderId,
                hasConversation: hasPrivateJobConversation,
                hasIntent: hasPrivateJobIntent,
                textPreview: String(text || '').slice(0, 140)
            });
        } else if (!textLower.startsWith('/') && /\b(vaga|vagas|emprego|empregos|trabalho|trabalhar|curriculo|curriculo|currículo|oportunidade|oportunidades)\b/.test(normalizedPrivateText)) {
            appendPrivateJobIntentAudit({
                senderId,
                decision: 'candidate_seen',
                hasConversation: hasPrivateJobConversation,
                hasIntent: hasPrivateJobIntent,
                blockedByOtherWizard: hasOtherPrivateWizard,
                text: String(text || '').slice(0, 500)
            });
            logger.info('private_job_candidate_message_seen', {
                senderId,
                hasConversation: hasPrivateJobConversation,
                hasIntent: hasPrivateJobIntent,
                blockedByOtherWizard: hasOtherPrivateWizard,
                textPreview: String(text || '').slice(0, 140)
            });
        }
        if (!hasOtherPrivateWizard && isFacebookJobLinkRequest(text)) {
            const result = await handleFacebookJobLinkRequest(sock, senderId, text);
            if (result.handled) {
                return;
            }
        }
        const reminderState = getReminderWizard(senderId);
        if (reminderState) {
            if (textLower === '/cancelar' || textLower === 'cancelar') {
                clearReminderWizard(senderId);
                await sendSafeMessage(sock, senderId, { text: 'Fluxo de lembretes cancelado.' });
                return;
            }

            if (reminderState.step === 'chooseGroup') {
                const allowMultiGroupFixed = reminderState.action === '/lembretefixo';
                const selectedGroups = allowMultiGroupFixed
                    ? resolveMultipleGroupSelections(text, reminderState.groups || [])
                    : [resolveRankingGroupSelection(text, reminderState.groups || [])].filter(Boolean);
                if (!selectedGroups.length) {
                    await sendSafeMessage(sock, senderId, {
                        text: allowMultiGroupFixed
                            ? 'Grupo invalido. Responda com numero/nome. Para mais de um grupo, separe por virgula.'
                            : 'Grupo invalido. Responda com o numero da lista ou nome exato do grupo.'
                    });
                    return;
                }
                for (const selected of selectedGroups) {
                    const allowed = await checkAuth(sock, senderId, selected.id, { allowGroupAdmins: true });
                    if (!allowed) {
                        clearReminderWizard(senderId);
                        await sendSafeMessage(sock, senderId, {
                            text: `Acesso negado para o grupo ${selected.subject}. Apenas administradores do grupo ou autorizados podem gerenciar lembretes.`
                        });
                        return;
                    }
                }

                const selected = selectedGroups[0];
                reminderState.group = selected;
                reminderState.selectedGroups = selectedGroups;
                if (reminderState.action === '/lembretes') {
                    clearReminderWizard(senderId);
                    await sendSafeMessage(sock, senderId, {
                        text: `Grupo: ${selected.subject}\n\n${buildReminderStatusText(selected.id)}`
                    });
                    return;
                }
                if (reminderState.action === '/stoplembrete') {
                    const selection = buildStopReminderSelection(selected.id);
                    if (!selection.ok) {
                        clearReminderWizard(senderId);
                        await sendSafeMessage(sock, senderId, { text: `ℹ️ ${selection.message}` });
                        return;
                    }
                    reminderState.step = 'chooseStopReminder';
                    reminderState.editableItems = selection.items || [];
                    setReminderWizard(senderId, reminderState);
                    await sendSafeMessage(sock, senderId, {
                        text: `Grupo selecionado: ${selected.subject}\n\n${selection.message}\n\nResponda com o numero ou titulo.`
                    });
                    return;
                }
                if (reminderState.action === '/stoplembretefixo') {
                    const currentEntries = getDailyReminderEntries(selected.id);
                    if (!currentEntries.length) {
                        clearReminderWizard(senderId);
                        await sendSafeMessage(sock, senderId, { text: 'ℹ️ Nao ha lembretes fixos ativos neste grupo.' });
                        return;
                    }
                    reminderState.step = 'chooseFixedStopMode';
                    reminderState.fixedEntries = currentEntries;
                    setReminderWizard(senderId, reminderState);
                    await sendSafeMessage(sock, senderId, {
                        text: `Grupo selecionado: ${selected.subject}\n\nForam encontrados ${currentEntries.length} lembrete(s) fixo(s) ativo(s).\n\nResponda:\n- APAGAR TUDO\n- ESCOLHER UM\n- /cancelar`
                    });
                    return;
                }

                if (reminderState.action === '/editarlembrete') {
                    const items = buildEditableReminderItems(selected.id);
                    if (!items.length) {
                        clearReminderWizard(senderId);
                        await sendSafeMessage(sock, senderId, { text: 'ℹ️ Nao ha lembretes ativos neste grupo para editar.' });
                        return;
                    }
                    reminderState.step = 'chooseReminderToEdit';
                    reminderState.editableItems = items;
                    setReminderWizard(senderId, reminderState);
                    const lines = items.map((item, index) => `${index + 1}. ${item.title} | ${item.summary}`).join('\n');
                    await sendSafeMessage(sock, senderId, {
                        text: `Grupo selecionado: ${selected.subject}\n\nQual lembrete deseja editar?\n\n${lines}\n\nResponda com numero ou titulo.`
                    });
                    return;
                }

                if (reminderState.action === '/apagarlembrete') {
                    const items = buildEditableReminderItems(selected.id);
                    if (!items.length) {
                        clearReminderWizard(senderId);
                        await sendSafeMessage(sock, senderId, { text: 'ℹ️ Nao ha lembretes ativos neste grupo para apagar.' });
                        return;
                    }
                    reminderState.step = 'chooseReminderToDelete';
                    reminderState.editableItems = items;
                    setReminderWizard(senderId, reminderState);
                    const lines = items.map((item, index) => `${index + 1}. ${item.title} | ${item.summary}`).join('\n');
                    await sendSafeMessage(sock, senderId, {
                        text: `Grupo selecionado: ${selected.subject}\n\nQual lembrete deseja apagar?\n\n${lines}\n\nResponda com numero ou titulo.`
                    });
                    return;
                }

                if (reminderState.action === '/testelembrete') {
                    const result = await runTestReminderForGroup(sock, selected.id, reminderState.messageText);
                    clearReminderWizard(senderId);
                    await sendSafeMessage(sock, senderId, {
                        text: `${result.message}\n\nGrupo: ${selected.subject}`
                    });
                    return;
                }

                reminderState.step = 'title';
                setReminderWizard(senderId, reminderState);
                await sendSafeMessage(sock, senderId, {
                    text: allowMultiGroupFixed
                        ? `Grupo(s) selecionado(s): ${selectedGroups.map((group) => group.subject).join(', ')}\n\nQual titulo do lembrete?`
                        : `Grupo selecionado: ${selected.subject}\n\nQual titulo do lembrete?`
                });
                return;
            }

            if (reminderState.step === 'chooseReminderToEdit') {
                const selectedReminder = resolveEditableReminderSelection(text, reminderState.editableItems || []);
                if (!selectedReminder) {
                    await sendSafeMessage(sock, senderId, { text: 'Lembrete invalido. Responda com o numero da lista ou com o titulo exato.' });
                    return;
                }
                reminderState.action = '/editarlembrete';
                reminderState.editTarget = { kind: selectedReminder.kind, id: selectedReminder.id };
                reminderState.title = selectedReminder.title;
                reminderState.messageText = String(selectedReminder.config?.comando || '');
                reminderState.imageBase64 = String(selectedReminder.config?.imageBase64 || '');
                reminderState.intervalHours = selectedReminder.kind === 'interval' ? Number(selectedReminder.config?.intervalo || 0) : null;
                reminderState.durationDays = selectedReminder.kind === 'interval'
                    ? Math.max(1, Math.round(Number(selectedReminder.config?.encerramento || 24) / 24))
                    : null;
                reminderState.times = selectedReminder.kind === 'fixed' ? Array.isArray(selectedReminder.config?.horarios) ? selectedReminder.config.horarios : [] : [];
                reminderState.step = 'title';
                setReminderWizard(senderId, reminderState);
                await sendSafeMessage(sock, senderId, { text: `Editando lembrete: ${selectedReminder.title}\n\nQual sera o novo titulo?` });
                return;
            }

            if (reminderState.step === 'chooseReminderToDelete') {
                const selectedReminder = resolveEditableReminderSelection(text, reminderState.editableItems || []);
                if (!selectedReminder) {
                    await sendSafeMessage(sock, senderId, { text: 'Lembrete invalido. Responda com o numero da lista ou com o titulo exato.' });
                    return;
                }
                const deleted = deleteEditableReminder(reminderState.group?.id, selectedReminder);
                if (!deleted.ok) {
                    await sendSafeMessage(sock, senderId, { text: `${deleted.message}\n\nResponda com o numero da lista ou digite /cancelar.` });
                    return;
                }
                const groupName = reminderState.group?.subject || reminderState.group?.id || 'grupo';
                clearReminderWizard(senderId);
                await sendSafeMessage(sock, senderId, { text: `${deleted.message}\nGrupo: ${groupName}` });
                return;
            }

            if (reminderState.step === 'chooseStopReminder') {
                const selectedReminder = resolveEditableReminderSelection(text, reminderState.editableItems || []);
                if (!selectedReminder) {
                    await sendSafeMessage(sock, senderId, { text: 'Lembrete invalido. Responda com o numero da lista ou com o titulo exato.' });
                    return;
                }
                const stopped = deleteEditableReminder(reminderState.group?.id, selectedReminder);
                if (!stopped.ok) {
                    await sendSafeMessage(sock, senderId, { text: `${stopped.message}\n\nResponda com o numero da lista ou digite /cancelar.` });
                    return;
                }
                const groupName = reminderState.group?.subject || reminderState.group?.id || 'grupo';
                clearReminderWizard(senderId);
                await sendSafeMessage(sock, senderId, { text: `${stopped.message}\nGrupo: ${groupName}` });
                return;
            }

            if (reminderState.step === 'chooseFixedReminder') {
                const stopped = stopSingleLembreteFixo(reminderState.group?.id, text);
                if (!stopped.ok) {
                    await sendSafeMessage(sock, senderId, { text: `${stopped.message}\n\nResponda com o numero da lista ou digite /cancelar.` });
                    return;
                }
                const groupName = reminderState.group?.subject || reminderState.group?.id || 'grupo';
                clearReminderWizard(senderId);
                await sendSafeMessage(sock, senderId, { text: `${stopped.message}\nGrupo: ${groupName}` });
                return;
            }

            if (reminderState.step === 'chooseFixedStopMode') {
                if (/^(escolher um|escolher|um|1)$/i.test(textLower)) {
                    const selection = buildFixedReminderSelection(reminderState.group?.id);
                    if (!selection.ok) {
                        clearReminderWizard(senderId);
                        await sendSafeMessage(sock, senderId, { text: `ℹ️ ${selection.message}` });
                        return;
                    }
                    reminderState.step = 'chooseFixedReminder';
                    setReminderWizard(senderId, reminderState);
                    await sendSafeMessage(sock, senderId, {
                        text: `${selection.message}\n\nResponda com o numero da lista ou digite /cancelar.`
                    });
                    return;
                }
                if (!/^(apagar tudo|parar tudo|remover tudo|sim|confirmar|aprovar)$/i.test(textLower)) {
                    await sendSafeMessage(sock, senderId, { text: 'Responda APAGAR TUDO, ESCOLHER UM, ou /cancelar.' });
                    return;
                }
                const stopped = stopLembreteFixo(reminderState.group?.id);
                const groupName = reminderState.group?.subject || reminderState.group?.id || 'grupo';
                clearReminderWizard(senderId);
                await sendSafeMessage(sock, senderId, {
                    text: stopped?.ok
                        ? `Lembretes fixos desativados.\n\nQuantidade removida: ${stopped.removedCount}\nGrupo: ${groupName}`
                        : `Nao havia lembretes fixos ativos.\nGrupo: ${groupName}`
                });
                return;
            }

            if (reminderState.step === 'confirmStopAllFixed') {
                if (!/^(apagar tudo|parar tudo|remover tudo|sim|confirmar|aprovar)$/i.test(textLower)) {
                    await sendSafeMessage(sock, senderId, { text: 'Responda APAGAR TUDO para cancelar todos, ou /cancelar.' });
                    return;
                }
                const stopped = stopLembreteFixo(reminderState.group?.id);
                const groupName = reminderState.group?.subject || reminderState.group?.id || 'grupo';
                clearReminderWizard(senderId);
                await sendSafeMessage(sock, senderId, {
                    text: stopped?.ok
                        ? `Lembretes fixos desativados.\n\nQuantidade removida: ${stopped.removedCount}\nGrupo: ${groupName}`
                        : `Nao havia lembretes fixos ativos.\nGrupo: ${groupName}`
                });
                return;
            }

            if (reminderState.step === 'chooseIntervalReminder') {
                const stopped = stopSingleReminder(reminderState.group?.id, text);
                if (!stopped.ok) {
                    await sendSafeMessage(sock, senderId, { text: `${stopped.message}\n\nResponda com 1 ou digite /cancelar.` });
                    return;
                }
                const groupName = reminderState.group?.subject || reminderState.group?.id || 'grupo';
                clearReminderWizard(senderId);
                await sendSafeMessage(sock, senderId, { text: `${stopped.message}\nGrupo: ${groupName}` });
                return;
            }

            if (reminderState.step === 'message') {
                const messageText = String(text || '').trim();
                if (!messageText) {
                    await sendSafeMessage(sock, senderId, { text: 'Mensagem vazia. Envie a mensagem do lembrete.' });
                    return;
                }
                reminderState.messageText = messageText;
                reminderState.step = 'mediaChoice';
                setReminderWizard(senderId, reminderState);
                await sendSafeMessage(sock, senderId, { text: 'Com foto ou sem foto?' });
                return;
            }

            if (reminderState.step === 'title') {
                const title = sanitizeEntityTitle(text);
                if (!title) {
                    await sendSafeMessage(sock, senderId, { text: 'Informe um titulo para o lembrete.' });
                    return;
                }
                reminderState.title = title;
                reminderState.step = 'message';
                setReminderWizard(senderId, reminderState);
                await sendSafeMessage(sock, senderId, { text: 'Qual mensagem do lembrete?' });
                return;
            }

            if (reminderState.step === 'mediaChoice') {
                const isFixedReminderFlow = reminderState.action === '/lembretefixo' || reminderState.editTarget?.kind === 'fixed';
                if (/^(sem foto|sem|nao|não)$/i.test(textLower)) {
                    reminderState.imageBase64 = '';
                    if (isFixedReminderFlow) {
                        const groups = Array.isArray(reminderState.selectedGroups) && reminderState.selectedGroups.length
                            ? reminderState.selectedGroups
                            : [reminderState.group].filter(Boolean);
                        const suggestions = buildSuggestedCommercialTimes(groups);
                        reminderState.step = 'suggestTimes';
                        reminderState.suggestedTimes = suggestions;
                    } else {
                        reminderState.step = 'interval';
                    }
                    setReminderWizard(senderId, reminderState);
                    await sendSafeMessage(sock, senderId, {
                        text: isFixedReminderFlow
                            ? `Sugestao de horarios comerciais disponiveis: ${(reminderState.suggestedTimes || []).join(', ') || 'nenhum encontrado'}\n\nResponda com os horarios sugeridos desejados ou digite "escolher manualmente".`
                            : 'De quantas em quantas horas? Ex: 1h'
                    });
                    return;
                }
                if (/^(com foto|com|foto|imagem)$/i.test(textLower)) {
                    reminderState.step = 'image';
                    setReminderWizard(senderId, reminderState);
                    await sendSafeMessage(sock, senderId, { text: 'Envie a foto do lembrete agora.' });
                    return;
                }
                await sendSafeMessage(sock, senderId, { text: 'Responda com "com foto" ou "sem foto".' });
                return;
            }

            if (reminderState.step === 'image') {
                const imageResult = await buildReminderImageState(sock, message, hasIncomingImage);
                if (!imageResult.ok) {
                    await sendSafeMessage(sock, senderId, { text: imageResult.message });
                    return;
                }
                reminderState.imageBase64 = imageResult.imageBase64 || '';
                const isFixedReminderFlow = reminderState.action === '/lembretefixo' || reminderState.editTarget?.kind === 'fixed';
                if (isFixedReminderFlow) {
                    const groups = Array.isArray(reminderState.selectedGroups) && reminderState.selectedGroups.length
                        ? reminderState.selectedGroups
                        : [reminderState.group].filter(Boolean);
                    const suggestions = buildSuggestedCommercialTimes(groups);
                    reminderState.step = 'suggestTimes';
                    reminderState.suggestedTimes = suggestions;
                } else {
                    reminderState.step = 'interval';
                }
                setReminderWizard(senderId, reminderState);
                await sendSafeMessage(sock, senderId, {
                    text: isFixedReminderFlow
                        ? `Sugestao de horarios comerciais disponiveis: ${(reminderState.suggestedTimes || []).join(', ') || 'nenhum encontrado'}\n\nResponda com os horarios sugeridos desejados ou digite "escolher manualmente".`
                        : 'De quantas em quantas horas? Ex: 1h'
                });
                return;
            }

            if (reminderState.step === 'suggestTimes') {
                if (/^escolher manualmente$/i.test(String(text || '').trim())) {
                    reminderState.step = 'times';
                    setReminderWizard(senderId, reminderState);
                    await sendSafeMessage(sock, senderId, { text: 'Quais horarios? Envie um ou mais no formato HH:MM. Ex: 08:00 12:00 21:00' });
                    return;
                }
                const parsed = splitMessageAndTimes(`tmp ${String(text || '').trim()}`);
                const times = parsed.ok ? parsed.times : [];
                if (!times.length) {
                    await sendSafeMessage(sock, senderId, { text: 'Responda com um ou mais horarios sugeridos ou digite "escolher manualmente".' });
                    return;
                }
                const validation = validateFixedReminderTimes(times);
                if (!validation.ok) {
                    reminderState.step = 'suggestTimes';
                    setReminderWizard(senderId, reminderState);
                    await sendSafeMessage(sock, senderId, { text: `⚠️ ${validation.message}` });
                    return;
                }
                reminderState.step = 'confirm';
                reminderState.times = validation.times || times;
                setReminderWizard(senderId, reminderState);
                await sendReminderConfirmationPreview(sock, senderId, reminderState, 'fixed');
                return;
            }

            if (reminderState.step === 'interval') {
                const intervalHours = parseReminderHoursInput(text);
                if (!intervalHours) {
                    await sendSafeMessage(sock, senderId, { text: 'Valor invalido. Envie em horas, ex: 1h ou 2.' });
                    return;
                }
                reminderState.intervalHours = intervalHours;
                reminderState.step = 'duration';
                setReminderWizard(senderId, reminderState);
                await sendSafeMessage(sock, senderId, { text: 'Quantos dias deve durar? Ex: 1 dia ou 3 dias' });
                return;
            }

            if (reminderState.step === 'duration') {
                const durationDays = parseReminderDaysInput(text);
                if (!durationDays) {
                    await sendSafeMessage(sock, senderId, { text: 'Valor invalido. Envie a quantidade de dias, ex: 1 ou 3 dias.' });
                    return;
                }
                reminderState.durationDays = durationDays;
                reminderState.step = 'confirm';
                setReminderWizard(senderId, reminderState);
                await sendReminderConfirmationPreview(sock, senderId, reminderState, 'interval');
                return;
            }

            if (reminderState.step === 'times') {
                const parsed = splitMessageAndTimes(`tmp ${String(text || '').trim()}`);
                const times = parsed.ok ? parsed.times : [];
                if (!times.length) {
                    await sendSafeMessage(sock, senderId, { text: 'Horarios invalidos. Envie no formato HH:MM. Ex: 08:00 12:00 21:00' });
                    return;
                }
                const exclude = reminderState.editTarget?.kind === 'fixed'
                    ? { groupId: reminderState.group?.id, reminderId: String(reminderState.editTarget?.id || '') }
                    : {};
                const validation = validateFixedReminderTimes(times, exclude);
                if (!validation.ok) {
                    reminderState.step = 'times';
                    reminderState.times = times;
                    setReminderWizard(senderId, reminderState);
                    await sendSafeMessage(sock, senderId, { text: `⚠️ ${validation.message}` });
                    return;
                }
                reminderState.times = validation.times || times;
                reminderState.step = 'confirm';
                setReminderWizard(senderId, reminderState);
                await sendReminderConfirmationPreview(sock, senderId, reminderState, 'fixed');
                return;
            }

            if (reminderState.step === 'confirm') {
                if (!/^(aprovar|sim|ok|confirmo)$/i.test(textLower)) {
                    await sendSafeMessage(sock, senderId, { text: 'Responda APROVAR ou CANCELAR.' });
                    return;
                }
                const selected = reminderState.group;
                if (!selected?.id) {
                    clearReminderWizard(senderId);
                    await sendSafeMessage(sock, senderId, { text: 'Grupo do fluxo perdido. Recomece o comando.' });
                    return;
                }
                const result = reminderState.action === '/editarlembrete'
                    ? (reminderState.editTarget?.kind === 'fixed'
                        ? await updateFixedReminderFromState(sock, reminderState)
                        : await updateIntervalReminderFromState(sock, reminderState))
                    : (reminderState.action === '/lembretefixo'
                        ? await configureFixedReminderFromState(sock, reminderState)
                        : await configureIntervalReminderFromState(sock, reminderState));
                if (!result.ok) {
                    if (reminderState.action === '/lembretefixo' || reminderState.editTarget?.kind === 'fixed') {
                        reminderState.step = 'times';
                        setReminderWizard(senderId, reminderState);
                    } else {
                        setReminderWizard(senderId, reminderState);
                    }
                    await sendSafeMessage(sock, senderId, {
                        text: `${result.message}\n\nGrupo: ${selected.subject}`
                    });
                    return;
                }
                clearReminderWizard(senderId);
                await sendSafeMessage(sock, senderId, {
                    text: `${result.message}\n\nGrupo: ${selected.subject}`
                });
                return;
            }
        }

        if (
            textLower.startsWith('/lembrete')
            || textLower.startsWith('/lembretefixo')
            || textLower.startsWith('/editarlembrete')
            || textLower.startsWith('/apagarlembrete')
            || textLower.startsWith('/testelembrete')
            || isStopIntervalReminderCommand(textLower)
            || isStopFixedReminderCommand(textLower)
            || textLower === '/lembretes'
        ) {
            if (textLower.startsWith('/testelembrete')) {
                const testMessage = String(text || '').replace(/^\/testelembretes?/i, '').trim();
                if (!testMessage) {
                    await sendSafeMessage(sock, senderId, { text: '❗ Use: /testelembrete [mensagem]' });
                    return;
                }
            }

            let groups = [];
            const shouldUseRuntimeGroups =
                textLower === '/lembretes'
                || textLower.startsWith('/editarlembrete')
                || textLower.startsWith('/apagarlembrete')
                || isStopFixedReminderCommand(textLower)
                || isStopIntervalReminderCommand(textLower);

            if (shouldUseRuntimeGroups) {
                if (textLower === '/lembretes') {
                    groups = listRuntimeReminderGroups('any');
                } else if (textLower.startsWith('/editarlembrete')) {
                    groups = listRuntimeReminderGroups('any');
                } else if (textLower.startsWith('/apagarlembrete')) {
                    groups = listRuntimeReminderGroups('any');
                } else if (isStopFixedReminderCommand(textLower)) {
                    groups = listRuntimeReminderGroups('fixed');
                } else if (isStopIntervalReminderCommand(textLower)) {
                    groups = listRuntimeReminderGroups('interval');
                }

                if (groups.length) {
                    let groupsRaw = null;
                    try {
                        groupsRaw = await sock.groupFetchAllParticipating();
                    } catch (_) { }

                    if (groupsRaw && typeof groupsRaw === 'object') {
                        groups = groups
                            .map((group) => ({
                                id: group.id,
                                subject: String(groupsRaw[group.id]?.subject || '').trim() || group.subject || group.id
                            }))
                            .sort((a, b) => a.subject.localeCompare(b.subject, 'pt-BR'));
                    }
                }
            } else {
                let groupsRaw;
                try {
                    groupsRaw = await sock.groupFetchAllParticipating();
                } catch (error) {
                    await sendSafeMessage(sock, senderId, { text: `Falha ao listar grupos: ${error.message}` });
                    return;
                }

                groups = Object.entries(groupsRaw || {})
                    .map(([id, data]) => ({ id, subject: String(data?.subject || '').trim() || id }))
                    .sort((a, b) => a.subject.localeCompare(b.subject, 'pt-BR'));
            }

            if (!groups.length) {
                let emptyMessage = 'Nao encontrei grupos para configurar lembretes.';
                if (textLower === '/lembretes') {
                    emptyMessage = 'Nao encontrei grupos com lembretes ativos.';
                } else if (isStopFixedReminderCommand(textLower)) {
                    emptyMessage = 'Nao encontrei grupos com lembretes fixos ativos.';
                } else if (isStopIntervalReminderCommand(textLower)) {
                    emptyMessage = 'Nao encontrei grupos com lembrete automatico ativo.';
                }
                await sendSafeMessage(sock, senderId, { text: emptyMessage });
                return;
            }

            const shown = groups.slice(0, 30);
            const lines = shown.map((g, i) => `${i + 1}. ${g.subject}`).join('\n');
            let action = '/lembrete';
            if (textLower.startsWith('/lembretefixo')) action = '/lembretefixo';
            if (textLower.startsWith('/editarlembrete')) action = '/editarlembrete';
            if (textLower.startsWith('/apagarlembrete')) action = '/apagarlembrete';
            if (textLower.startsWith('/testelembrete')) action = '/testelembrete';
            if (isStopFixedReminderCommand(textLower)) action = '/stoplembretefixo';
            else if (isStopIntervalReminderCommand(textLower)) action = '/stoplembrete';
            if (textLower === '/lembretes') action = '/lembretes';

            setReminderWizard(senderId, {
                step: 'chooseGroup',
                action,
                groups: shown,
                group: null,
                fixedEntries: [],
                editableItems: [],
                editTarget: null,
                title: '',
                messageText: action === '/testelembrete'
                    ? String(text || '').replace(/^\/testelembretes?/i, '').trim()
                    : '',
                imageBase64: '',
                intervalHours: null,
                durationDays: null,
                times: []
            });

            let prompt = `Para qual grupo deseja usar ${action}?\n\n${lines}\n\nResponda com numero ou nome do grupo.`;
            if (action === '/lembretes') {
                prompt = `De qual grupo deseja ver os lembretes ativos?\n\n${lines}\n\nResponda com numero ou nome do grupo.`;
            } else if (action === '/editarlembrete') {
                prompt = `Em qual grupo deseja editar o lembrete?\n\n${lines}\n\nResponda com numero ou nome do grupo.`;
            } else if (action === '/apagarlembrete') {
                prompt = `Em qual grupo deseja apagar o lembrete?\n\n${lines}\n\nResponda com numero ou nome do grupo.`;
            } else if (action === '/testelembrete') {
                prompt = `Em qual grupo deseja testar o lembrete?\n\n${lines}\n\nResponda com numero ou nome do grupo.`;
            } else if (action === '/stoplembrete') {
                prompt = `Em qual grupo deseja parar o lembrete automático?\n\n${lines}\n\nResponda com numero ou nome do grupo.`;
            } else if (action === '/stoplembretefixo') {
                prompt = `Em qual grupo deseja parar o lembrete fixo?\n\n${lines}\n\nResponda com numero ou nome do grupo.`;
            }

            if (isGroup && (action === '/stoplembrete' || action === '/stoplembretefixo')) {
                const directGroupId = chatId;
                const hasDirectInterval = action === '/stoplembrete' && hasActiveIntervalReminder(directGroupId);
                const hasDirectFixed = action === '/stoplembretefixo' && hasActiveFixedReminder(directGroupId);
                if (hasDirectInterval || hasDirectFixed) {
                    if (action === '/stoplembrete') {
                        stopReminder(directGroupId);
                        await sendSafeMessage(sock, groupId, { text: '🛑 O lembrete automático deste grupo foi desativado.' });
                        return;
                    }
                    const stopped = stopLembreteFixo(directGroupId);
                    await sendSafeMessage(sock, groupId, {
                        text: stopped?.ok
                            ? `🛑 Todos os lembretes fixos deste grupo foram desativados.\n\nQuantidade removida: ${stopped.removedCount}`
                            : 'ℹ️ Não há nenhum lembrete fixo ativo neste grupo.'
                    });
                    return;
                }
            }
            if (groups.length > shown.length) {
                prompt += `\n\nMostrando ${shown.length} de ${groups.length} grupos.`;
            }
            await sendSafeMessage(sock, senderId, { text: prompt });
            return;
        }
        if (textLower && RESPONSES[textLower]) {
            await sendSafeMessage(sock, senderId, { text: RESPONSES[textLower] });
            return;
        }

        const rankingState = getRankingWizard(senderId);
        if (rankingState) {
            if (textLower === '/cancelar' || textLower === 'cancelar') {
                clearRankingWizard(senderId);
                await sendSafeMessage(sock, senderId, { text: 'Fluxo /ranking cancelado.' });
                return;
            }

            if (rankingState.step === 'chooseGroup') {
                const selected = resolveRankingGroupSelection(text, rankingState.groups || []);
                if (!selected) {
                    await sendSafeMessage(sock, senderId, {
                        text: 'Grupo invalido. Responda com o numero da lista ou nome exato do grupo.'
                    });
                    return;
                }

                clearRankingWizard(senderId);
                const ranking = getGroupTopRanking(selected.id, 10);
                await sendSafeMessage(sock, senderId, { text: buildRankingMessageForGroup(ranking, 'RANKING TOP 10') });
                return;
            }
        }

        if (textLower.startsWith('/ranking')) {
            let groupsRaw;
            try {
                groupsRaw = await sock.groupFetchAllParticipating();
            } catch (error) {
                await sendSafeMessage(sock, senderId, { text: `Falha ao listar grupos: ${error.message}` });
                return;
            }

            const groups = Object.entries(groupsRaw || {})
                .map(([id, data]) => ({ id, subject: String(data?.subject || '').trim() || id }))
                .sort((a, b) => a.subject.localeCompare(b.subject, 'pt-BR'));

            if (!groups.length) {
                await sendSafeMessage(sock, senderId, { text: 'Nao encontrei grupos para consultar ranking.' });
                return;
            }

            const maxList = 30;
            const shown = groups.slice(0, maxList);
            const lines = shown.map((g, i) => `${i + 1}. ${g.subject}`).join('\n');
            setRankingWizard(senderId, { step: 'chooseGroup', groups: shown });

            let msg = `Qual grupo deseja consultar no /ranking?\n\n${lines}\n\nResponda com numero ou nome do grupo.`;
            if (groups.length > maxList) {
                msg += `\n\nMostrando ${maxList} de ${groups.length} grupos.`;
            }
            await sendSafeMessage(sock, senderId, { text: msg });
            return;
        }

        const newsState = getNewsWizard(senderId);
        if (newsState) {
            if (textLower === '/cancelar' || textLower === 'cancelar') {
                clearNewsWizard(senderId);
                await sendSafeMessage(sock, senderId, { text: 'Fluxo de noticias cancelado.' });
                return;
            }

            if (newsState.step === 'chooseGroup') {
                const selected = resolveRankingGroupSelection(text, newsState.groups || []);
                if (!selected) {
                    await sendSafeMessage(sock, senderId, {
                        text: 'Grupo invalido. Responda com o numero da lista ou nome exato do grupo.'
                    });
                    return;
                }

                if (newsState.action === '/stopnoticias') {
                    const result = removeNewsSubscription(selected.id, selected.subject);
                    clearNewsWizard(senderId);
                    if (result.removed > 0) {
                        await sendSafeMessage(sock, senderId, { text: `🛑 Noticias desativadas em: ${selected.subject}` });
                    } else {
                        await sendSafeMessage(sock, senderId, { text: `ℹ️ Nao havia captacao ativa em: ${selected.subject}` });
                    }
                    return;
                }

                if (newsState.action === '/monitor24h') {
                    const result = upsertNewsPresetSubscriptions({
                        groupId: selected.id,
                        groupName: selected.subject,
                        presetKey: 'monitor24h'
                    });
                    clearNewsWizard(senderId);
                    if (!result.ok) {
                        await sendSafeMessage(sock, senderId, { text: result.message || 'Falha ao ativar monitor 24h.' });
                        return;
                    }
                    const feedsList = (result.subscriptions || [])
                        .map((item, index) => `${index + 1}. ${item.feedUrl}`)
                        .join('\n');
                    await sendSafeMessage(sock, senderId, {
                        text: `📰 Monitor 24h ativado.

Grupo: ${selected.subject}
Preset: ${result.preset?.label || 'Monitor 24h Brasil + Mundo'}
Feeds salvos:
${feedsList}`
                    });
                    return;
                }

                if (newsState.action === '/stopmonitor24h') {
                    const result = removeNewsPresetSubscriptions({
                        groupId: selected.id,
                        groupName: selected.subject,
                        presetKey: 'monitor24h'
                    });
                    clearNewsWizard(senderId);
                    if (result.removed > 0) {
                        await sendSafeMessage(sock, senderId, { text: `🛑 Monitor 24h desativado em: ${selected.subject}` });
                    } else {
                        await sendSafeMessage(sock, senderId, { text: `ℹ️ Nao havia monitor 24h ativo em: ${selected.subject}` });
                    }
                    return;
                }

                newsState.group = selected;
                newsState.step = 'feedUrl';
                setNewsWizard(senderId, newsState);
                await sendSafeMessage(sock, senderId, {
                    text: `Qual link deve captar as noticias para o grupo "${selected.subject}"?\n\nVoce pode enviar um ou mais links na mesma mensagem.\nSepare por linha, espaco, virgula ou ponto e virgula.`
                });
                return;
            }

            if (newsState.step === 'feedUrl') {
                const feedUrls = parseNewsFeedUrls(text);
                const result = upsertMultipleNewsSubscriptions({
                    groupId: newsState.group?.id,
                    groupName: newsState.group?.subject,
                    feedUrls
                });
                clearNewsWizard(senderId);
                if (!result.ok) {
                    await sendSafeMessage(sock, senderId, { text: result.message || 'Falha ao salvar captacao de noticias.' });
                    return;
                }
                const feedsList = (result.subscriptions || [])
                    .map((item, index) => `${index + 1}. ${item.feedUrl}`)
                    .join('\n');
                await sendSafeMessage(sock, senderId, {
                    text: `Captacao de noticias ativada.

Grupo: ${newsState.group?.subject}
Feeds salvos:
${feedsList}`
                });
                return;
            }
        }

        if (
            textLower.startsWith('/noticias')
            || textLower.startsWith('/stopnoticias')
            || textLower.startsWith('/monitor24h')
            || textLower.startsWith('/stopmonitor24h')
        ) {
            const authorized = await isAuthorized(senderId);
            if (!authorized) {
                await sendSafeMessage(sock, senderId, { text: 'Acesso negado. Apenas administradores autorizados.' });
                return;
            }

            let groupsRaw;
            try {
                groupsRaw = await sock.groupFetchAllParticipating();
            } catch (error) {
                await sendSafeMessage(sock, senderId, { text: `Falha ao listar grupos: ${error.message}` });
                return;
            }

            const groups = Object.entries(groupsRaw || {})
                .map(([id, data]) => ({ id, subject: String(data?.subject || '').trim() || id }))
                .sort((a, b) => a.subject.localeCompare(b.subject, 'pt-BR'));

            if (!groups.length) {
                await sendSafeMessage(sock, senderId, { text: 'Nao encontrei grupos para configurar noticias.' });
                return;
            }

            const shown = groups.slice(0, 30);
            const lines = shown.map((g, i) => `${i + 1}. ${g.subject}`).join('\n');
            const action = textLower.startsWith('/stopmonitor24h')
                ? '/stopmonitor24h'
                : textLower.startsWith('/monitor24h')
                    ? '/monitor24h'
                    : textLower.startsWith('/stopnoticias')
                        ? '/stopnoticias'
                        : '/noticias';
            setNewsWizard(senderId, { step: 'chooseGroup', action, groups: shown });

            const prompt = getNewsWizardPrompt(action, lines, shown.length, groups.length);
            await sendSafeMessage(sock, senderId, { text: prompt });
            return;
        }

        if (textLower.startsWith('/stopvagas') || textLower.startsWith('/startvagas')) {
            const authorized = await isAuthorized(senderId);
            if (!authorized) {
                await sendSafeMessage(sock, senderId, { text: 'Acesso negado. Apenas administradores autorizados.' });
                return;
            }

            const wantsStart = textLower.startsWith('/startvagas');

            if (wantsStart) {
                if (isJobPublishingEnabled()) {
                    await sendSafeMessage(sock, senderId, { text: 'As vagas ja estao ativas.' });
                    return;
                }

                startJobPublishing();
                await sendSafeMessage(sock, senderId, {
                    text: 'Captacao e envio de vagas reativados com sucesso.\n\nGrupos afetados:\n- DESENVOLVIMENTO IA\n- EMPREGOS PVH 2.0\n- EMPREGOS PVH'
                });
                return;
            }

            if (!isJobPublishingEnabled()) {
                await sendSafeMessage(sock, senderId, { text: 'As vagas ja estao pausadas.' });
                return;
            }

            stopJobPublishing();
            await sendSafeMessage(sock, senderId, {
                text: 'Captacao e envio de vagas pausados com sucesso.\n\nGrupos afetados:\n- DESENVOLVIMENTO IA\n- EMPREGOS PVH 2.0\n- EMPREGOS PVH'
            });
            return;
        }

        if (textLower.startsWith('/statusvagas')) {
            const authorized = await isAuthorized(senderId);
            if (!authorized) {
                await sendSafeMessage(sock, senderId, { text: 'Acesso negado. Apenas administradores autorizados.' });
                return;
            }

            const groupStatus = getJobForwarderStatus();
            const privateStatus = getPrivateJobAlertsStatus();
            const targetLines = (groupStatus.targets || []).slice(0, 10).map((item) => `- ${item}`).join('\n') || '- nenhum';
            const cooldownEntries = Object.entries(groupStatus.sourceCooldowns || {});
            const cooldownLines = cooldownEntries.length
                ? cooldownEntries.slice(0, 8).map(([sourceId, info]) => `- ${sourceId}: ate ${info?.until || 'N/D'}`).join('\n')
                : '- nenhuma';
            const profileLines = (privateStatus.profiles || []).slice(0, 8)
                .map((profile) => `- ${profile.jobType || 'N/D'}${Array.isArray(profile.secondaryJobTypes) && profile.secondaryJobTypes.length ? ` | + ${profile.secondaryJobTypes.join(', ')}` : ''} | ${profile.city || 'N/D'}`)
                .join('\n') || '- nenhum';

            await sendSafeMessage(sock, senderId, {
                text: [
                    '*STATUS VAGAS*',
                    '',
                    `Grupos: ${groupStatus.enabled ? 'ativo' : 'pausado'}`,
                    `Cron grupos: ${groupStatus.cron}`,
                    `Ultima rodada grupos: ${groupStatus.lastRunAt || 'N/D'}`,
                    `Rastreadas: ${groupStatus.trackedUrls || 0} URLs | ${groupStatus.trackedFingerprints || 0} fingerprints`,
                    '',
                    'Destinos configurados:',
                    targetLines,
                    '',
                    'Fontes em cooldown:',
                    cooldownLines,
                    '',
                    `Privado: ${privateStatus.enabled ? 'ativo' : 'pausado'}`,
                    `Cron privado: ${privateStatus.cron}`,
                    `Ultima rodada privado: ${privateStatus.lastRunAt || 'N/D'}`,
                    `Perfis ativos: ${privateStatus.activeProfiles || 0}`,
                    `Legado: ${privateStatus.legacySubscriptions || 0}`,
                    '',
                    'Perfis privados:',
                    profileLines
                ].join('\n')
            });
            return;
        }

        const laminaShillState = getLaminaShillWizard(senderId);
        if (laminaShillState) {
            if (textLower === '/cancelar' || textLower === 'cancelar') {
                clearLaminaShillWizard(senderId);
                await sendSafeMessage(sock, senderId, { text: 'Fluxo /laminashill cancelado.' });
                return;
            }

            if (laminaShillState.step === 'image') {
                if (hasIncomingImage) {
                    try {
                        const media = typeof sock.downloadMediaMessage === 'function'
                            ? await sock.downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage })
                            : await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
                        if (!media || !Buffer.isBuffer(media) || media.length === 0) {
                            await sendSafeMessage(sock, senderId, { text: 'Nao consegui ler a imagem enviada. Tente novamente.' });
                            return;
                        }
                        laminaShillState.imageBuffer = media;
                        laminaShillState.imageSource = 'upload_pv';
                    } catch (error) {
                        await sendSafeMessage(sock, senderId, { text: `Falha ao processar imagem: ${error.message}` });
                        return;
                    }
                } else {
                    const raw = String(text || '').trim();
                    if (isNoneText(raw)) {
                        laminaShillState.imageSource = '';
                        laminaShillState.imageBuffer = null;
                    } else {
                        laminaShillState.imageSource = raw;
                        laminaShillState.imageBuffer = null;
                    }
                }
                laminaShillState.step = 'text';
                setLaminaShillWizard(senderId, laminaShillState);
                await sendSafeMessage(sock, senderId, { text: 'Qual texto da lamina de shill?' });
                return;
            }

            if (laminaShillState.step === 'text') {
                const body = String(text || '').trim();
                if (!body) {
                    await sendSafeMessage(sock, senderId, { text: 'Texto vazio. Envie o texto da lamina de shill.' });
                    return;
                }
                laminaShillState.textBody = body;
                const saved = saveShillTemplate({ state: laminaShillState, senderId });
                clearLaminaShillWizard(senderId);
                await sendSafeMessage(sock, senderId, {
                    text: `Lamina de shill salva.\nTitulo: ${saved.title}\nID: ${saved.id}\n\nUse /shill para agendar envio.`
                });
                return;
            }
        }

        const shillState = getShillWizard(senderId);
        if (shillState) {
            if (textLower === '/cancelar' || textLower === 'cancelar') {
                clearShillWizard(senderId);
                await sendSafeMessage(sock, senderId, { text: 'Fluxo /shill cancelado.' });
                return;
            }

            if (shillState.step === 'group') {
                const resolved = await resolveGroupsByInput(sock, text);
                if (!resolved.ok) {
                    await sendSafeMessage(sock, senderId, { text: `${resolved.message}\n\nInforme o nome exato do grupo.` });
                    return;
                }
                if (!Array.isArray(resolved.groups) || resolved.groups.length !== 1) {
                    await sendSafeMessage(sock, senderId, { text: 'Escolha apenas 1 grupo para o /shill.' });
                    return;
                }
                shillState.group = resolved.groups[0];
                shillState.step = 'perDay';
                setShillWizard(senderId, shillState);
                await sendSafeMessage(sock, senderId, { text: 'Quantas vezes por dia deve enviar? (ex: 6)' });
                return;
            }

            if (shillState.step === 'perDay') {
                const perDay = Number.parseInt(String(text || '').trim(), 10);
                if (!Number.isInteger(perDay) || perDay < 1 || perDay > 48) {
                    await sendSafeMessage(sock, senderId, { text: 'Valor invalido. Informe um numero entre 1 e 48.' });
                    return;
                }
                shillState.perDay = perDay;
                const list = buildShillTemplatesList(30);
                if (!list.ok) {
                    clearShillWizard(senderId);
                    await sendSafeMessage(sock, senderId, { text: list.message });
                    return;
                }
                shillState.step = 'template';
                shillState.templates = list.shown;
                setShillWizard(senderId, shillState);
                await sendSafeMessage(sock, senderId, { text: list.message });
                return;
            }

            if (shillState.step === 'template') {
                const tpl = resolveShillTemplateByInput(text, shillState.templates || []);
                if (!tpl) {
                    await sendSafeMessage(sock, senderId, { text: 'Lamina de shill invalida. Responda com numero ou titulo da lista.' });
                    return;
                }
                const created = createShillSchedule({
                    group: shillState.group,
                    perDay: shillState.perDay,
                    template: tpl,
                    creatorId: senderId
                });
                clearShillWizard(senderId);
                await sendSafeMessage(sock, senderId, {
                    text: `Shill agendado com sucesso.\nGrupo: ${created.group.subject}\nFrequencia: ${created.perDay}x por dia\nLamina: ${created.templateTitle}\nProximo envio: ${new Date(created.nextRunAt).toLocaleString('pt-BR')}`
                });
                return;
            }
        }

        if (textLower.startsWith('/laminashill')) {
            const authorized = await isAuthorized(senderId);
            if (!authorized) {
                await sendSafeMessage(sock, senderId, { text: 'Acesso negado. Apenas administradores autorizados.' });
                return;
            }
            setLaminaShillWizard(senderId, { step: 'image', imageSource: '', imageBuffer: null, textBody: '' });
            await sendSafeMessage(sock, senderId, {
                text: 'Fluxo /laminashill iniciado.\n\nQual imagem?\nEnvie a imagem aqui no PV, URL HTTP/HTTPS, caminho local, ou NENHUMA.'
            });
            return;
        }

        if (textLower.startsWith('/shill')) {
            const authorized = await isAuthorized(senderId);
            if (!authorized) {
                await sendSafeMessage(sock, senderId, { text: 'Acesso negado. Apenas administradores autorizados.' });
                return;
            }
            setShillWizard(senderId, { step: 'group', group: null, perDay: 0, templates: [] });
            await sendSafeMessage(sock, senderId, { text: 'Fluxo /shill iniciado.\n\nQual grupo?' });
            return;
        }

        if (textLower.startsWith('/listarlaminas')) {
            const authorized = await isAuthorized(senderId);
            if (!authorized) {
                await sendSafeMessage(sock, senderId, { text: 'Acesso negado. Apenas administradores autorizados.' });
                return;
            }
            trackLaminaConversation(senderId, 'list', text);
            await sendSafeMessage(sock, senderId, { text: buildSavedLaminasListMessage() });
            return;
        }

        if (textLower.startsWith('/textolamina')) {
            const authorized = await isAuthorized(senderId);
            if (!authorized) {
                await sendSafeMessage(sock, senderId, { text: 'Acesso negado. Apenas administradores autorizados.' });
                return;
            }
            const param = text.replace(/^\/textolamina/i, '').trim();
            const resolved = resolveSavedLaminaByTitle(param);
            if (!resolved.ok) {
                await sendSafeMessage(sock, senderId, { text: resolved.message });
                return;
            }
            trackLaminaConversation(senderId, 'view_text', text);
            const messages = buildSavedLaminaTextMessages(resolved.lamina);
            for (const messageText of messages) {
                await sendSafeMessage(sock, senderId, { text: messageText });
            }
            return;
        }

        if (textLower.startsWith('/laminasativas')) {
            const authorized = await isAuthorized(senderId);
            if (!authorized) {
                await sendSafeMessage(sock, senderId, { text: 'Acesso negado. Apenas administradores autorizados.' });
                return;
            }
            trackLaminaConversation(senderId, 'list_active', text);
            const active = await buildActiveLaminaSchedulesDetailedMessage(sock);
            await sendSafeMessage(sock, senderId, { text: active.message });
            return;
        }

        if (textLower.startsWith('/laminasdisparadas')) {
            const authorized = await isAuthorized(senderId);
            if (!authorized) {
                await sendSafeMessage(sock, senderId, { text: 'Acesso negado. Apenas administradores autorizados.' });
                return;
            }
            trackLaminaConversation(senderId, 'list_dispatch_status', text);
            const status = await buildLaminaDispatchStatusMessage(sock);
            await sendSafeMessage(sock, senderId, { text: status.message });
            return;
        }

        if (textLower.startsWith('/usarlamina')) {
            const selection = buildSavedLaminasSelectionMessage();
            if (!selection.ok) {
                await sendSafeMessage(sock, senderId, { text: selection.message });
                return;
            }

            trackLaminaConversation(senderId, 'use_saved', text);
            setLaminaWizard(senderId, {
                step: 'useSavedChoose',
                mode: 'useSaved',
                availableItems: selection.items || []
            });
            await sendSafeMessage(sock, senderId, {
                text: `Qual lamina deseja usar?\n\n${selection.items.map((item, idx) => `${idx + 1}. ${item.title}`).join('\n')}\n\nResponda com numero ou titulo.`
            });
            return;
        }

        const stopLaminaState = getStopLaminaWizard(senderId);
        if (stopLaminaState) {
            if (textLower === '/cancelar' || textLower === 'cancelar') {
                clearStopLaminaWizard(senderId);
                await sendSafeMessage(sock, senderId, { text: 'Fluxo /stoplamina cancelado.' });
                return;
            }

            if (stopLaminaState.step === 'choose') {
                const stopped = stopLaminaScheduleByInput(text);
                if (!stopped.ok) {
                    await sendSafeMessage(sock, senderId, { text: `${stopped.message}\n\nResponda com o numero da lista ou digite /cancelar.` });
                    return;
                }
                clearStopLaminaWizard(senderId);
                await sendSafeMessage(sock, senderId, { text: stopped.message });
                return;
            }
        }

        const laminaState = getLaminaWizard(senderId);
        if (laminaState) {
            if (textLower === '/cancelar' || textLower === 'cancelar') {
                clearLaminaWizard(senderId);
                await sendSafeMessage(sock, senderId, { text: 'Fluxo /lamina cancelado.' });
                return;
            }

            if (laminaState.step === 'chooseSaved') {
                const selected = resolveSavedLaminaSelection(text, laminaState.availableItems || []);
                if (!selected) {
                    await sendSafeMessage(sock, senderId, { text: 'Lamina invalida. Responda com o numero da lista ou com o titulo exato.' });
                    return;
                }
                Object.assign(laminaState, buildLaminaStateFromSaved(selected), {
                    mode: 'edit',
                    originalTitle: String(selected.title || ''),
                    step: 'title'
                });
                setLaminaWizard(senderId, laminaState);
                await sendSafeMessage(sock, senderId, {
                    text: `Editando lamina: ${selected.title}\n\nQual sera o novo titulo?`
                });
                return;
            }

            if (laminaState.step === 'useSavedChoose') {
                const selected = resolveSavedLaminaSelection(text, laminaState.availableItems || []);
                if (!selected) {
                    await sendSafeMessage(sock, senderId, { text: 'Lamina invalida. Responda com o numero da lista ou com o titulo exato.' });
                    return;
                }

                const state = buildLaminaStateFromSaved(selected);
                if (!state.groups.length) {
                    clearLaminaWizard(senderId);
                    await sendSafeMessage(sock, senderId, { text: `A lamina "${selected.title}" nao tem grupos configurados.` });
                    return;
                }
                if (!state.textBody) {
                    clearLaminaWizard(senderId);
                    await sendSafeMessage(sock, senderId, { text: `A lamina "${selected.title}" esta sem texto configurado.` });
                    return;
                }

                Object.assign(laminaState, state, {
                    title: String(selected.title || ''),
                    originalTitle: String(selected.title || ''),
                    step: 'useSavedMode'
                });
                setLaminaWizard(senderId, laminaState);
                await sendSafeMessage(sock, senderId, {
                    text: `Lamina selecionada: ${selected.title}\n\nDeseja enviar somente uma vez ou agendar varios horarios?\nResponda com:\n1 para enviar uma vez\n2 para agendar`
                });
                return;
            }

            if (laminaState.step === 'useSavedMode') {
                const raw = String(text || '').trim().toLowerCase();
                const wantsSingle = raw === '1' || /uma vez|enviar uma vez|somente uma vez|sozinho|unica|única/.test(raw);
                const wantsSchedule = raw === '2' || /agendar|varios horarios|v[aá]rios hor[aá]rios|horarios|horários/.test(raw);

                if (wantsSingle) {
                    try {
                        const result = await sendLaminaToGroups(sock, laminaState);
                        const total = Array.isArray(laminaState.groups) ? laminaState.groups.length : 0;
                        const sent = total - result.failures.length;
                        let summary = `Lamina "${laminaState.title}" enviada.\nSucesso: ${sent}\nFalhas: ${result.failures.length}`;
                        if (result.failures.length) {
                            summary += `\n\nDetalhes:\n- ${result.failures.join('\n- ')}`;
                        }
                        clearLaminaWizard(senderId);
                        await sendSafeMessage(sock, senderId, { text: summary });
                    } catch (error) {
                        clearLaminaWizard(senderId);
                        await sendSafeMessage(sock, senderId, { text: `Falha ao usar lamina salva: ${error.message}` });
                    }
                    return;
                }

                if (wantsSchedule) {
                    laminaState.step = 'useSavedTimes';
                    setLaminaWizard(senderId, laminaState);
                    await sendSafeMessage(sock, senderId, {
                        text: `Informe de 1 a 10 horarios no formato HH:MM.\nEx.: 01:00 05:00 08:00 12:00 16:00 20:00\n\nConsidere o fuso ${REMINDER_TIMEZONE}.`
                    });
                    return;
                }

                await sendSafeMessage(sock, senderId, {
                    text: 'Resposta invalida.\nResponda com 1 para enviar uma vez ou 2 para agendar.'
                });
                return;
            }

            if (laminaState.step === 'useSavedTimes') {
                const parsedTimes = parseUpToTenTimesHHMM(text);
                if (!parsedTimes.length) {
                    await sendSafeMessage(sock, senderId, { text: 'Horarios invalidos. Informe de 1 a 10 horarios no formato HH:MM.\nEx.: 01:00 05:00 08:00 12:00 16:00 20:00' });
                    return;
                }

                const rawTimes = parseMultipleTimesHHMM(text);
                if (rawTimes.length > 10) {
                    await sendSafeMessage(sock, senderId, { text: 'Voce pode agendar no maximo 10 horarios por lamina.' });
                    return;
                }

                try {
                    const created = parsedTimes.map((time) => createLaminaSchedule({
                        title: laminaState.title,
                        time,
                        creatorId: senderId,
                        groups: (laminaState.groups || []).map((group) => group.id)
                    }));
                    const skipped = created.filter((item) => item?.reused).length;
                    clearLaminaWizard(senderId);
                    await sendSafeMessage(sock, senderId, {
                        text: `Lamina "${laminaState.title}" agendada com sucesso.\nHorarios: ${parsedTimes.join(', ')} (${REMINDER_TIMEZONE})\nAgendamentos criados: ${created.length - skipped}\nDuplicados ignorados: ${skipped}`
                    });
                } catch (error) {
                    clearLaminaWizard(senderId);
                    await sendSafeMessage(sock, senderId, { text: `Nao foi possivel agendar a lamina: ${error.message || String(error)}` });
                }
                return;
            }

            if (laminaState.step === 'title') {
                const title = sanitizeEntityTitle(text);
                if (!title) {
                    await sendSafeMessage(sock, senderId, { text: 'Informe um titulo para a lamina.' });
                    return;
                }
                laminaState.title = title;
                laminaState.step = 'group';
                setLaminaWizard(senderId, laminaState);
                await sendSafeMessage(sock, senderId, {
                    text: 'Informe o grupo ou os grupos de destino.\nVoce pode enviar nomes ou IDs, separados por virgula ou quebra de linha.'
                });
                return;
            }

            if (laminaState.step === 'group') {
                const resolved = await resolveGroupsByInput(sock, text);
                if (!resolved.ok) {
                    await sendSafeMessage(sock, senderId, { text: `${resolved.message}\n\nInforme o nome dos grupos, separados por virgula ou quebra de linha.` });
                    return;
                }
                laminaState.groups = resolved.groups;
                laminaState.step = 'image';
                setLaminaWizard(senderId, laminaState);
                await sendSafeMessage(sock, senderId, {
                    text: 'Envie a imagem aqui ou digite NENHUMA.'
                });
                return;
            }

            if (laminaState.step === 'image') {
                if (hasIncomingImage) {
                    try {
                        const media = typeof sock.downloadMediaMessage === 'function'
                            ? await sock.downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage })
                            : await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
                        if (!media || !Buffer.isBuffer(media) || media.length === 0) {
                            await sendSafeMessage(sock, senderId, { text: 'Nao consegui ler a imagem enviada. Tente novamente.' });
                            return;
                        }
                        laminaState.imageBuffer = media;
                        laminaState.imageSource = 'upload_pv';
                    } catch (error) {
                        await sendSafeMessage(sock, senderId, { text: `Falha ao processar imagem: ${error.message}` });
                        return;
                    }
                } else {
                    const raw = String(text || '').trim();
                    if (isNoneText(raw)) {
                        laminaState.imageSource = '';
                        laminaState.imageBuffer = null;
                    } else {
                        laminaState.imageSource = raw;
                        laminaState.imageBuffer = null;
                    }
                }
                laminaState.step = 'text';
                setLaminaWizard(senderId, laminaState);
                await sendSafeMessage(sock, senderId, { text: 'Agora envie o texto da lamina.' });
                return;
            }

            if (laminaState.step === 'text') {
                const body = String(text || '').trim();
                if (!body) {
                    await sendSafeMessage(sock, senderId, { text: 'Informe o texto da lamina para continuar.' });
                    return;
                }
                laminaState.textBody = body;
                laminaState.step = 'confirm';
                setLaminaWizard(senderId, laminaState);
                await sendLaminaPreview(sock, senderId, laminaState);
                await sendSafeMessage(sock, senderId, { text: buildLaminaPreview(laminaState) });
                return;
            }

            if (laminaState.step === 'confirm') {
                if (/^(aprovar|aprovado|aprovo|sim|ok|confirmo)$/i.test(textLower)) {
                    if (laminaState.mode === 'edit') {
                        const saveResult = saveLaminaTemplate({ title: laminaState.title, state: laminaState, senderId });
                        if (!saveResult?.ok) {
                            await sendSafeMessage(sock, senderId, { text: saveResult?.message || 'Falha ao salvar a lamina.' });
                            clearLaminaWizard(senderId);
                            return;
                        }
                        renameLaminaSchedulesTitle(laminaState.originalTitle, laminaState.title);
                        clearLaminaWizard(senderId);
                        await sendSafeMessage(sock, senderId, { text: `Lamina atualizada com sucesso.\n\nTitulo: ${laminaState.title}` });
                        return;
                    } else {
                        try {
                            const result = await sendLaminaToGroups(sock, laminaState);
                            const total = Array.isArray(laminaState.groups) ? laminaState.groups.length : 0;
                            const sent = total - result.failures.length;
                            let summary = `Lamina enviada com sucesso.\n\nEnvios concluidos: ${sent}\nFalhas: ${result.failures.length}`;
                            if (result.failures.length) {
                                summary += `\n\nDetalhes de falhas:\n- ${result.failures.join('\n- ')}`;
                            }
                            await sendSafeMessage(sock, senderId, {
                                text: summary
                            });
                        } catch (error) {
                            await sendSafeMessage(sock, senderId, { text: `Falha ao enviar lamina: ${error.message}` });
                            clearLaminaWizard(senderId);
                            return;
                        }
                        laminaState.step = 'dailyPrompt';
                        setLaminaWizard(senderId, laminaState);
                        await sendSafeMessage(sock, senderId, { text: 'Deseja programar o envio diario desta lamina? (sim/nao)' });
                        return;
                    }
                }

                if (/^(refazer|refaco|refaço|editar|nao|não)$/i.test(textLower)) {
                    laminaState.step = 'title';
                    laminaState.groups = [];
                    laminaState.imageSource = '';
                    laminaState.imageBuffer = null;
                    laminaState.textBody = '';
                    setLaminaWizard(senderId, laminaState);
                    await sendSafeMessage(sock, senderId, { text: 'Vamos ajustar a configuracao.\n\nInforme novamente o titulo da lamina.' });
                    return;
                }

                await sendSafeMessage(sock, senderId, { text: 'Responda com APROVAR, REFAZER ou CANCELAR.' });
                return;
            }

            if (laminaState.step === 'dailyPrompt') {
                const answer = parseYesNo(textLower);
                if (answer === null) {
                    await sendSafeMessage(sock, senderId, { text: 'Resposta invalida. Responda com sim ou nao.' });
                    return;
                }
                if (!answer) {
                    clearLaminaWizard(senderId);
                    await sendSafeMessage(sock, senderId, { text: 'Lamina enviada com sucesso.' });
                    return;
                }
                laminaState.step = 'dailyTimes';
                setLaminaWizard(senderId, laminaState);
                await sendSafeMessage(sock, senderId, { text: `Informe os horarios de envio.\nEx.: 07:00 15:00 22:00\n\nConsidere o fuso ${REMINDER_TIMEZONE}.` });
                return;
            }

            if (laminaState.step === 'dailyTimes') {
                const parsedTimes = parseUpToTenTimesHHMM(text);
                if (!parsedTimes.length) {
                    await sendSafeMessage(sock, senderId, { text: 'Horarios invalidos. Informe de 1 a 10 horarios no formato HH:MM.\nEx.: 07:00 15:00 22:00' });
                    return;
                }

                const rawTimes = parseMultipleTimesHHMM(text);
                if (rawTimes.length > 10) {
                    await sendSafeMessage(sock, senderId, { text: 'Voce pode agendar no maximo 10 horarios por lamina.' });
                    return;
                }

                const autoTitle = buildAutoLaminaTitle(senderId);
                const customTitle = sanitizeEntityTitle(laminaState.title || autoTitle);
                const saved = saveLaminaTemplate({ title: customTitle, state: laminaState, senderId });
                if (!saved?.ok) {
                    await sendSafeMessage(sock, senderId, { text: saved?.message || 'Falha ao salvar lamina para agendamento.' });
                    clearLaminaWizard(senderId);
                    return;
                }

                let created;
                try {
                    created = parsedTimes.map((time) => createLaminaSchedule({
                        title: customTitle,
                        time,
                        creatorId: senderId,
                        groups: (laminaState.groups || []).map((group) => group.id)
                    }));
                } catch (error) {
                    clearLaminaWizard(senderId);
                    await sendSafeMessage(sock, senderId, { text: `Nao foi possivel agendar a lamina: ${error.message || String(error)}` });
                    return;
                }

                clearLaminaWizard(senderId);
                const skipped = created.filter((item) => item?.reused).length;
                await sendSafeMessage(sock, senderId, {
                    text: `Envio diario configurado com sucesso.\n\nLamina: ${customTitle}\nHorarios: ${parsedTimes.join(', ')} (${REMINDER_TIMEZONE})\nAgendamentos criados: ${created.length - skipped}\nDuplicados ignorados: ${skipped}`
                });
                return;
            }
        }

        if (textLower.startsWith('/lamina')) {
            trackLaminaConversation(senderId, 'lamina_start', text);
            setLaminaWizard(senderId, {
                step: 'title',
                mode: 'create',
                originalTitle: '',
                title: '',
                groups: [],
                imageSource: '',
                imageBuffer: null,
                textBody: ''
            });
            await sendSafeMessage(sock, senderId, {
                text: 'Criacao de lamina iniciada.\n\nQual sera o titulo da lamina?'
            });
            return;
        }

        if (textLower.startsWith('/editarlamina')) {
            trackLaminaConversation(senderId, 'edit_lamina_start', text);
            const selection = buildSavedLaminasSelectionMessage();
            if (!selection.ok) {
                await sendSafeMessage(sock, senderId, { text: selection.message });
                return;
            }
            setLaminaWizard(senderId, {
                step: 'chooseSaved',
                mode: 'edit',
                availableItems: selection.items,
                originalTitle: '',
                title: '',
                groups: [],
                imageSource: '',
                imageBuffer: null,
                textBody: ''
            });
            await sendSafeMessage(sock, senderId, { text: selection.message });
            return;
        }

        if (textLower.startsWith('/stoplamina')) {
            const authorized = await isAuthorized(senderId);
            if (!authorized) {
                await sendSafeMessage(sock, senderId, { text: 'Acesso negado. Apenas administradores autorizados.' });
                return;
            }
            const active = buildActiveLaminaSchedulesList();
            if (!active.ok) {
                await sendSafeMessage(sock, senderId, { text: active.message });
                return;
            }
            trackLaminaConversation(senderId, 'stop_lamina_start', text);
            setStopLaminaWizard(senderId, { step: 'choose' });
            await sendSafeMessage(sock, senderId, { text: active.message });
            return;
        }

        const wizard = getWizard(senderId);
        if (wizard) {
            if (textLower === '/cancelar') {
                clearWizard(senderId);
                await sendSafeMessage(sock, senderId, { text: 'Fluxo de adicionar grupo cancelado.' });
                return;
            }

            if (wizard.step === 'name') {
                const name = String(text || '').trim();
                if (!name) {
                    await sendSafeMessage(sock, senderId, { text: 'Envie o nome do grupo para continuar.' });
                    return;
                }
                wizard.groupName = name;
                wizard.step = 'openClose';
                setAddGroupWizard(senderId, wizard);
                await sendSafeMessage(sock, senderId, { text: 'Permitir abertura/fechamento automatico? (sim/nao)' });
                return;
            }

            if (wizard.step === 'openClose') {
                const value = parseYesNo(textLower);
                if (value === null) {
                    await sendSafeMessage(sock, senderId, { text: 'Resposta invalida. Digite sim ou nao.' });
                    return;
                }
                wizard.permissions.openClose = value;
                wizard.step = 'spam';
                setAddGroupWizard(senderId, wizard);
                await sendSafeMessage(sock, senderId, { text: 'Permitir anti-spam neste grupo? (sim/nao)' });
                return;
            }

            if (wizard.step === 'spam') {
                const value = parseYesNo(textLower);
                if (value === null) {
                    await sendSafeMessage(sock, senderId, { text: 'Resposta invalida. Digite sim ou nao.' });
                    return;
                }
                wizard.permissions.spam = value;
                wizard.step = 'reminders';
                setAddGroupWizard(senderId, wizard);
                await sendSafeMessage(sock, senderId, { text: 'Permitir comandos de lembrete neste grupo? (sim/nao)' });
                return;
            }

            if (wizard.step === 'reminders') {
                const value = parseYesNo(textLower);
                if (value === null) {
                    await sendSafeMessage(sock, senderId, { text: 'Resposta invalida. Digite sim ou nao.' });
                    return;
                }
                wizard.permissions.reminders = value;
                wizard.step = 'promo';
                setAddGroupWizard(senderId, wizard);
                await sendSafeMessage(sock, senderId, { text: 'Permitir mensagens de promo neste grupo? (sim/nao)' });
                return;
            }

            if (wizard.step === 'promo') {
                const value = parseYesNo(textLower);
                if (value === null) {
                    await sendSafeMessage(sock, senderId, { text: 'Resposta invalida. Digite sim ou nao.' });
                    return;
                }
                wizard.permissions.promo = value;
                wizard.step = 'moderation';
                setAddGroupWizard(senderId, wizard);
                await sendSafeMessage(sock, senderId, { text: 'Permitir comandos de moderacao (ban/termos)? (sim/nao)' });
                return;
            }

            if (wizard.step === 'moderation') {
                const value = parseYesNo(textLower);
                if (value === null) {
                    await sendSafeMessage(sock, senderId, { text: 'Resposta invalida. Digite sim ou nao.' });
                    return;
                }
                wizard.permissions.moderation = value;
                wizard.step = 'engagement';
                setAddGroupWizard(senderId, wizard);
                await sendSafeMessage(sock, senderId, { text: 'Permitir leitura para engajamento neste grupo? (sim/nao)' });
                return;
            }

            if (wizard.step === 'engagement') {
                const value = parseYesNo(textLower);
                if (value === null) {
                    await sendSafeMessage(sock, senderId, { text: 'Resposta invalida. Digite sim ou nao.' });
                    return;
                }
                wizard.permissions.engagement = value;
                wizard.step = 'leadsRead';
                setAddGroupWizard(senderId, wizard);
                await sendSafeMessage(sock, senderId, { text: 'Permitir leitura para leads neste grupo? (sim/nao)' });
                return;
            }

            if (wizard.step === 'leadsRead') {
                const value = parseYesNo(textLower);
                if (value === null) {
                    await sendSafeMessage(sock, senderId, { text: 'Resposta invalida. Digite sim ou nao.' });
                    return;
                }
                wizard.permissions.leadsRead = value;
                wizard.step = 'welcome';
                setAddGroupWizard(senderId, wizard);
                await sendSafeMessage(sock, senderId, { text: 'Permitir mensagens de boas-vindas neste grupo? (sim/nao)' });
                return;
            }

            if (wizard.step === 'welcome') {
                const value = parseYesNo(textLower);
                if (value === null) {
                    await sendSafeMessage(sock, senderId, { text: 'Resposta invalida. Digite sim ou nao.' });
                    return;
                }
                wizard.permissions.welcome = value;
                wizard.step = 'confirm';
                setAddGroupWizard(senderId, wizard);
                const summary = `Confirma cadastro do grupo?\n\nGrupo: ${wizard.groupName}\nAbertura/fechamento: ${wizard.permissions.openClose ? 'SIM' : 'NAO'}\nAnti-spam: ${wizard.permissions.spam ? 'SIM' : 'NAO'}\nLembretes: ${wizard.permissions.reminders ? 'SIM' : 'NAO'}\nPromo: ${wizard.permissions.promo ? 'SIM' : 'NAO'}\nModeracao: ${wizard.permissions.moderation ? 'SIM' : 'NAO'}\nEngajamento (ler grupo): ${wizard.permissions.engagement ? 'SIM' : 'NAO'}\nLeads (ler grupo): ${wizard.permissions.leadsRead ? 'SIM' : 'NAO'}\nBoas-vindas: ${wizard.permissions.welcome ? 'SIM' : 'NAO'}\n\nResponda sim para confirmar ou nao para cancelar.`;
                await sendSafeMessage(sock, senderId, { text: summary });
                return;
            }

            if (wizard.step === 'confirm') {
                const value = parseYesNo(textLower);
                if (value === null) {
                    await sendSafeMessage(sock, senderId, { text: 'Resposta invalida. Digite sim ou nao.' });
                    return;
                }
                clearWizard(senderId);
                if (!value) {
                    await sendSafeMessage(sock, senderId, { text: 'Cadastro cancelado.' });
                    return;
                }
                const result = await addAllowedGroup(senderId, wizard.groupName, { permissions: wizard.permissions });
                await sendSafeMessage(sock, senderId, { text: result.message });
                return;
            }
        }

        const partnerWizard = getPartnerWizard(senderId);
        if (partnerWizard) {
            if (textLower === '/cancelar' || textLower === 'cancelar') {
                clearPartnerWizard(senderId);
                await sendSafeMessage(sock, senderId, { text: 'Fluxo de parceiros cancelado.' });
                return;
            }

            if (partnerWizard.step === 'group') {
                let selectedGroup = null;
                if (Array.isArray(partnerWizard.availableGroups) && partnerWizard.availableGroups.length) {
                    selectedGroup = resolveRankingGroupSelection(text, partnerWizard.availableGroups);
                }

                if (!selectedGroup) {
                    const resolved = await resolveGroupsByInput(sock, text);
                    if (resolved.ok && Array.isArray(resolved.groups) && resolved.groups.length === 1) {
                        selectedGroup = resolved.groups[0];
                    }
                }

                if (!selectedGroup) {
                    await sendSafeMessage(sock, senderId, { text: 'Grupo invalido. Responda com o numero da lista ou nome exato do grupo.' });
                    return;
                }
                const hasAccess = await ensurePartnerManagerAccess(sock, senderId, selectedGroup.id);
                if (!hasAccess) {
                    clearPartnerWizard(senderId);
                    await sendSafeMessage(sock, senderId, { text: 'Acesso negado. Voce nao administra esse grupo.' });
                    return;
                }

                partnerWizard.groupId = selectedGroup.id;
                partnerWizard.groupName = selectedGroup.subject || selectedGroup.id;

                if (partnerWizard.action === 'list') {
                    clearPartnerWizard(senderId);
                    const partners = await listGroupPartners(selectedGroup.id);
                    await sendSafeMessage(sock, senderId, { text: await formatPartnerListMessage(sock, selectedGroup.id, partnerWizard.groupName, partners) });
                    return;
                }

                if (partnerWizard.targetUserId) {
                    const partnerAliases = await resolvePartnerAliasesForGroup(sock, partnerWizard.groupId, partnerWizard.targetUserId);
                    const result = partnerWizard.action === 'add'
                        ? await addGroupPartner(senderId, partnerWizard.groupId, partnerAliases)
                        : await removeGroupPartner(senderId, partnerWizard.groupId, partnerWizard.targetUserId);

                    clearPartnerWizard(senderId);
                    await sendSafeMessage(sock, senderId, {
                        text: `${result.message}\nGrupo: ${partnerWizard.groupName}`
                    });
                    return;
                }

                partnerWizard.step = 'user';
                setPartnerWizard(senderId, partnerWizard);
                await sendSafeMessage(sock, senderId, {
                    text: partnerWizard.action === 'add'
                        ? `Grupo selecionado: ${partnerWizard.groupName}\n\nQual usuario deseja adicionar como parceiro?\nEnvie @usuario ou numero.`
                        : `Grupo selecionado: ${partnerWizard.groupName}\n\nQual usuario deseja remover da lista de parceiros?\nEnvie @usuario ou numero.`
                });
                return;
            }

            if (partnerWizard.step === 'user') {
                const targetUserId = normalizePartnerTarget(text);
                if (!targetUserId) {
                    await sendSafeMessage(sock, senderId, { text: 'Usuario invalido. Envie @usuario ou numero valido.' });
                    return;
                }

                const hasAccess = await ensurePartnerManagerAccess(sock, senderId, partnerWizard.groupId);
                if (!hasAccess) {
                    clearPartnerWizard(senderId);
                    await sendSafeMessage(sock, senderId, { text: 'Acesso negado. Voce nao administra esse grupo.' });
                    return;
                }

                const result = partnerWizard.action === 'add'
                    ? await addGroupPartner(senderId, partnerWizard.groupId, await resolvePartnerAliasesForGroup(sock, partnerWizard.groupId, targetUserId))
                    : await removeGroupPartner(senderId, partnerWizard.groupId, targetUserId);

                clearPartnerWizard(senderId);
                await sendSafeMessage(sock, senderId, {
                    text: `${result.message}\nGrupo: ${partnerWizard.groupName}`
                });
                return;
            }
        }

        // Permitir comandos administrativos em PV para administradores autorizados
        if (textLower && (
            textLower.includes('/adicionargrupo')
            || textLower.includes('/removergrupo')
            || textLower.includes('/listargrupos')
            || textLower.includes('/adicionaradmin')
            || textLower.includes('/removeradmin')
            || textLower.includes('/listaradmins')
            || textLower.includes('/addparceiro')
            || textLower.includes('/adicionarparceiro')
            || textLower.includes('/delparceiro')
            || textLower.includes('/removerparceiro')
            || textLower.includes('/listparceiros')
            || textLower.includes('/listarparceiros')
            || textLower.includes('/logs')
            || textLower.includes('/adicionartermo')
            || textLower.includes('/adicionartemo')
            || textLower.includes('/addtermo')
            || textLower.includes('/removertermo')
            || textLower.includes('/removertemo')
            || textLower.includes('/listartermos')
        )) {
            const normalizedText = textLower;
            const isPartnerCommand = isPartnerCommandText(normalizedText);
            const authorized = isPartnerCommand ? true : await isAuthorized(senderId);

            if (authorized) {
                // Processar comando administrativo em PV
                if (normalizedText.startsWith('/adicionargrupo')) {
                    let param = text.replace(/\/adicionargrupo/i, '').trim();
                    setAddGroupWizard(senderId, {
                        step: param ? 'openClose' : 'name',
                        groupName: param || '',
                        permissions: { openClose: true, spam: true, reminders: true, promo: true, moderation: true, engagement: true, leadsRead: true, welcome: true }
                    });
                    if (!param) {
                        await sendSafeMessage(sock, senderId, { text: 'Qual o nome do grupo que deseja adicionar?' });
                    } else {
                        await sendSafeMessage(sock, senderId, {
                            text: `Vamos configurar o grupo: ${param}\nPermitir abertura/fechamento automatico? (sim/nao)`
                        });
                    }
                } else if (normalizedText.startsWith('/removergrupo')) {
                    let param = text.replace(/\/removergrupo/i, '').trim();
                    const result = await removeAllowedGroup(senderId, param);
                    await sendSafeMessage(sock, senderId, { text: result.message });
                } else if (normalizedText.startsWith('/listargrupos')) {
                    const allowed = await listAllowedGroups();
                    if (!allowed || allowed.length === 0) {
                        await sendSafeMessage(sock, senderId, { text: 'ℹ️ A lista de grupos permitidos está vazia.' });
                    } else {
                        const formatted = allowed.map((g, i) => `${i + 1}. ${g}`).join('\n');
                        const reply = `📋 Grupos permitidos:\n\n${formatted}`;
                        await sendSafeMessage(sock, senderId, { text: reply });
                    }
                } else if (normalizedText.startsWith('/adicionaradmin')) {
                    let param = text.replace(/\/adicionaradmin/i, '').trim();
                    if (!param) {
                        await sendSafeMessage(sock, senderId, { text: '❌ *Uso incorreto!*\n\n📝 Use: `/adicionaradmin 5564993344024`' });
                        return;
                    }
                    const result = await addAdmin(senderId, param);
                    await sendSafeMessage(sock, senderId, { text: result.message });
                } else if (normalizedText.startsWith('/removeradmin')) {
                    let param = text.replace(/\/removeradmin/i, '').trim();
                    if (!param) {
                        await sendSafeMessage(sock, senderId, { text: '❌ *Uso incorreto!*\n\n📝 Use: `/removeradmin 5564993344024`' });
                        return;
                    }
                    const result = await removeAdmin(senderId, param);
                    await sendSafeMessage(sock, senderId, { text: result.message });
                } else if (normalizedText.startsWith('/listaradmins')) {
                    const admins = await listAdmins();
                    const stats = await getAdminStats();

                    if (admins.length === 0) {
                        await sendSafeMessage(sock, senderId, { text: 'ℹ️ Nenhum administrador configurado.\n\nConfigure via .env (AUTHORIZED_IDS) ou use /adicionaradmin' });
                        return;
                    }

                    let adminList = `👮 *ADMINISTRADORES DO BOT* 👮\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                    adminList += `📊 *Estatísticas:*\n`;
                    adminList += `• Total: ${stats.total}\n`;
                    adminList += `• Do .env: ${stats.fromEnv}\n`;
                    adminList += `• Do JSON: ${stats.fromFile}\n\n`;
                    adminList += `━━━━━━━━━━━━━━━━━━━━━━━\n📋 *Lista de Administradores:*\n\n`;

                    admins.forEach((admin, index) => {
                        adminList += `${index + 1}. ${admin.id}\n   └─ Fonte: ${admin.source}\n`;
                    });

                    adminList += `\n━━━━━━━━━━━━━━━━━━━━━━━\n💡 Use /adicionaradmin ou /removeradmin para gerenciar`;

                    await sendSafeMessage(sock, senderId, { text: adminList });
                } else if (normalizedText.startsWith('/logs')) {
                    const linesRaw = text.replace(/^\/logs/i, '').trim();
                    const requestedLines = Number.parseInt(linesRaw, 10);
                    const logs = readRecentLogs(Number.isFinite(requestedLines) ? requestedLines : 20);
                    if (!logs.ok) {
                        await sendSafeMessage(sock, senderId, { text: `❌ ${logs.message}` });
                    } else {
                        await sendSafeMessage(sock, senderId, {
                            text: `📋 *Últimos logs (${logs.safeLines} linhas)*\n\n\`\`\`\n${logs.text}\n\`\`\``
                        });
                    }
                } else if (normalizedText.startsWith('/adicionartermo') || normalizedText.startsWith('/adicionartemo') || normalizedText.startsWith('/addtermo')) {
                    const termo = text.replace(/^\/(adicionartermo|adicionartemo|addtermo)/i, '').trim();
                    if (!termo) {
                        await sendSafeMessage(sock, senderId, { text: '❌ Use: `/adicionartermo palavra ou frase`' });
                    } else {
                        const result = addBannedWord(termo);
                        await sendSafeMessage(sock, senderId, { text: result.message });
                    }
                } else if (normalizedText.startsWith('/removertermo') || normalizedText.startsWith('/removertemo')) {
                    const termo = text.replace(/^\/(removertermo|removertemo)/i, '').trim();
                    if (!termo) {
                        await sendSafeMessage(sock, senderId, { text: '❌ Use: `/removertermo palavra ou frase`' });
                    } else {
                        const result = removeBannedWord(termo);
                        await sendSafeMessage(sock, senderId, { text: result.message });
                    }
                } else if (normalizedText.startsWith('/listartermos')) {
                    const termos = listBannedWords();
                    if (!termos.length) {
                        await sendSafeMessage(sock, senderId, { text: 'ℹ️ Nenhum termo proibido cadastrado.' });
                    } else {
                        const lista = termos.map((t, i) => `${i + 1}. ${t}`).join('\n');
                        await sendSafeMessage(sock, senderId, { text: `🚫 *TERMOS PROIBIDOS*\n\n${lista}\n\n📊 Total: ${termos.length}` });
                    }
                } else if (isPartnerCommandText(normalizedText)) {
                    let action = 'add';
                    if (isPartnerRemoveCommand(normalizedText)) action = 'remove';
                    if (isPartnerListCommand(normalizedText)) action = 'list';

                    let param = text.replace(/^\/(addparceiro|adicionarparceiro|delparceiro|removerparceiro|listparceiros|listarparceiros)/i, '').trim();
                    let targetUserId = '';

                    if (action !== 'list' && param) {
                        targetUserId = normalizePartnerTarget(param);
                        if (!targetUserId) {
                            await sendSafeMessage(sock, senderId, { text: 'Usuario invalido. Envie @usuario ou numero valido.' });
                            return;
                        }
                    }

                    let groupsRaw;
                    try {
                        groupsRaw = await sock.groupFetchAllParticipating();
                    } catch (error) {
                        await sendSafeMessage(sock, senderId, { text: `Falha ao listar grupos: ${error.message}` });
                        return;
                    }

                    const availableGroups = Object.entries(groupsRaw || {})
                        .map(([id, data]) => ({ id, subject: String(data?.subject || '').trim() || id }))
                        .sort((a, b) => a.subject.localeCompare(b.subject, 'pt-BR'))
                        .slice(0, 30);

                    if (!availableGroups.length) {
                        await sendSafeMessage(sock, senderId, { text: 'Nao encontrei grupos para gerenciar parceiros.' });
                        return;
                    }

                    setPartnerWizard(senderId, {
                        action,
                        step: 'group',
                        groupId: '',
                        groupName: '',
                        targetUserId,
                        availableGroups
                    });

                    const groupsList = availableGroups.map((group, index) => `${index + 1}. ${group.subject}`).join('\n');
                    await sendSafeMessage(sock, senderId, {
                        text: action === 'list'
                            ? `Qual grupo deseja consultar?\n\n${groupsList}\n\nResponda com o numero da lista ou nome do grupo.`
                            : `Qual grupo deseja ${action === 'add' ? 'usar para adicionar' : 'usar para remover'} parceiro?\n\n${groupsList}\n\nResponda com o numero da lista ou nome do grupo.`
                    });
                }
                return;
            } else {
                await sendSafeMessage(sock, senderId, { text: '❌ *Acesso Negado*\n\n⚠️ Apenas administradores autorizados podem usar comandos do bot.' });
                return;
            }
        }

        if (!textLower.startsWith('/') && PRIVATE_AI_AUTO_REPLY_ENABLED) {
            try {
                const instantSalesReply = getInstantSalesReply(text, senderId);
                if (instantSalesReply) {
                    registerSalesTurn(senderId, text, instantSalesReply);
                    await sendSafeMessage(sock, senderId, { text: instantSalesReply });
                    return;
                }

                const salesReply = await analyzeLeadIntent(text, senderId);
                if (salesReply?.response) {
                    await sendSafeMessage(sock, senderId, { text: salesReply.response });
                    await notifyAdminsAboutPrivateLead(sock, senderId, text, salesReply);
                    return;
                }
            } catch (error) {
                logger.warn('private_ai_auto_reply_failed', {
                    senderId,
                    error: error?.message || String(error)
                });
            }
        }

        // Caso não seja um comando conhecido em PV, ignorar
        return;
    }

    text = '';

    switch (contentType) {
        case 'conversation':
            text = message.message.conversation;
            break;
        case 'extendedTextMessage':
            text = message.message.extendedTextMessage.text;
            break;
        default:
            return;
    }

    console.log(`💬 Mensagem de ${senderId}: "${text}"`);
    const normalizedText = text.trim().toLowerCase();
    const commandToken = getCommandToken(normalizedText);
    const groupSubject = typeof context.groupSubject === 'string' ? context.groupSubject : '';
    const isRestrictedGroup = isGroup && (context.isRestrictedGroup === true || isRestrictedGroupName(groupSubject));
    const imavyMentioned = isImavyMentioned({ text, message, sock });
    const isSlashCommand = commandToken.startsWith('/');

    function registrarComandoAceitoAtual(commandOverride) {
        const token = String(commandOverride || commandToken || '').trim().toLowerCase();
        if (!token.startsWith('/')) {
            return;
        }

        registrarComandoAceito({
            messageId: message?.key?.id,
            command: token,
            groupId,
            senderId
        });
    }

    if (!isSlashCommand && !imavyMentioned) {
        return;
    }

    if (isRestrictedGroup) {
        if (!imavyMentioned && !isSlashCommand) {
            return;
        }

        if (!imavyMentioned && !isAllowedCommandForRestrictedGroup(commandToken)) {
            return;
        }
    }

    // Ignorar comandos dentro de mensagens pré-definidas (como regras)
    if (text.includes('REGRAS OFICIAIS DO GRUPO') || text.includes('iMavyAgent') || text.includes('Bem-vindo(a) ao grupo')) {
        console.log('⏭️ Ignorando comandos dentro de mensagem pré-definida');
        return;
    }

    // @IMAVY: analise cripto somente por mencao explicita
    if (imavyMentioned && !isSlashCommand) {
        console.log(`✅ @IMAVY mencionado por ${senderId}`);
        const cooldown = parseInt(process.env.IMAVY_MENTION_COOLDOWN || '12', 10) * 1000;
        const rateCheck = checkRateLimit(`${senderId}:imavy`, cooldown);
        if (rateCheck.limited) {
            await sendSafeMessage(sock, groupId, { text: `Aguarde ${rateCheck.remaining}s para chamar o @IMAVY novamente.` });
            return;
        }

        const question = stripImavyMention(text) || text;
        const chatReply = await askChatGPT(question, senderId);
        if (chatReply) {
            await sendSafeMessage(sock, groupId, { text: chatReply });
            return;
        }

        const cryptoReply = await generateImavyCryptoReply(text);
        await sendSafeMessage(sock, groupId, { text: cryptoReply });
        return;
    }

    if (normalizedText.startsWith('/valyrafi')) {
        await sendSafeMessage(sock, groupId, { text: VALYRAFI_MESSAGE });
        registrarComandoAceitoAtual('/valyrafi');
        return;
    }

    // Comandos de mercado global: /usdt /btc /sol /xrp /bnb /eth /ouro(/paxg)
    {
        const firstToken = normalizedText.trim().split(/\s+/)[0];
        if (isMarketPriceCommand(firstToken)) {
            const quote = await getMarketQuote(firstToken);
            if (!quote?.ok) {
                await sendSafeMessage(sock, groupId, { text: `❌ ${quote?.error || 'Nao foi possivel buscar cotacao agora.'}` });
                return;
            }

            const change = Number(quote.change24h);
            const changeTxt = Number.isFinite(change)
                ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`
                : 'N/A';
            const updatedTxt = quote.lastUpdatedAt
                ? new Date(quote.lastUpdatedAt).toLocaleString('pt-BR', { hour12: false })
                : null;

            let reply =
                `📊 *${quote.symbol}* (${quote.label})\n` +
                `💵 USD: ${formatLiveUsd(quote.usd)}\n` +
                `🇧🇷 BRL: ${formatLiveBrl(quote.brl)}\n` +
                `🕒 24h: ${changeTxt}\n` +
                `📈 CoinMarketCap: ${quote.cmcUrl}`;

            if (quote.command === '/usdt') {
                reply += `\n✅ USDT em preco real: ${formatLiveBrl(quote.brl)}`;
            }
            if (updatedTxt) {
                reply += `\n⏱️ Atualizado: ${updatedTxt}`;
            }
            if (quote.source) {
                reply += `\n📡 Fonte: ${quote.source}`;
            }

            await sendSafeMessage(sock, groupId, { text: reply });
            registrarComandoAceitoAtual(firstToken);
            return;
        }
    }

    // 🔗 Atalhos cripto diretos por par (Grupo): comandos tipo /vkinha
    {
        const firstToken = normalizedText.trim().split(/\s+/)[0];
        const directPair = firstToken ? DIRECT_PAIR_COMMANDS[firstToken] : null;
        if (directPair) {
            const snap = await fetchDexPairSnapshot(directPair.chain, directPair.pair, {
                allowCache: true,
                cacheTtlMs: CRYPTO_COMMAND_CACHE_TTL_MS,
                allowStale: true,
                staleMaxAgeMs: CRYPTO_COMMAND_STALE_MAX_AGE_MS,
                allowAnyCached: true,
                backgroundRefresh: true,
                timeoutMs: CRYPTO_COMMAND_TIMEOUT_MS
            });
            if (!snap?.ok) {
                await sendSafeMessage(sock, groupId, { text: `❌ Não consegui buscar dados pra ${directPair.label || firstToken.replace('/', '').toUpperCase()}.` });
                return;
            }
            const reply = buildCryptoText({
                label: directPair.label || firstToken.replace('/', '').toUpperCase(),
                chain: directPair.chain,
                pairAddress: directPair.pair,
                snap
            });
            await sendSafeMessage(sock, groupId, { text: reply });
            registrarComandoAceitoAtual(firstToken);
            return;
        }
    }


    // 🔎 Atalhos cripto (Grupo): comandos curtos tipo /pnix, /pbtc
    // Responde com link + preço + métricas (opção completa)
    {
        const firstToken = normalizedText.trim().split(/\s+/)[0];
        if (firstToken && firstToken.startsWith('/p')) {
            const key = firstToken.replace(/^\//, '');
            const alias = await getAlias(key);
            if (alias) {
                const snap = await fetchDexPairSnapshot(alias.chain, alias.pair, {
                    allowCache: true,
                    cacheTtlMs: CRYPTO_COMMAND_CACHE_TTL_MS,
                    allowStale: true,
                    staleMaxAgeMs: CRYPTO_COMMAND_STALE_MAX_AGE_MS,
                    allowAnyCached: true,
                    backgroundRefresh: true,
                    timeoutMs: CRYPTO_COMMAND_TIMEOUT_MS
                });
                if (!snap?.ok) {
                    await sendSafeMessage(sock, groupId, { text: `❌ Não consegui buscar dados pra ${alias.label || key}.` });
                    return;
                }
                const reply = buildCryptoText({ label: alias.label || key.toUpperCase(), chain: alias.chain, pairAddress: alias.pair, tokenAddress: alias.address || null, snap });
                await sendSafeMessage(sock, groupId, { text: reply });
                registrarComandoAceitoAtual(firstToken);
                return;
            }
        }
    }

    // 📋 /listpairs (público) - lista atalhos cadastrados
    if (normalizedText.startsWith('/listpairs')) {
        const all = await listCryptoAliases();
        if (!all.length) {
            await sendSafeMessage(sock, groupId, { text: 'ℹ️ Nenhum atalho cripto cadastrado.' });
            return;
        }
        const msg = all
            .sort((a, b) => a.alias.localeCompare(b.alias))
            .map(x => `/${x.alias} → ${x.label || ''} (${String(x.chain).toUpperCase()})`)
            .join('\n');
        await sendSafeMessage(sock, groupId, { text: `📋 *ATALHOS CRIPTO*\n\n${msg}` });
        registrarComandoAceitoAtual('/listpairs');
        return;
    }

    // 🔔 /watch (público em grupos) - assinatura automática de preço/infos
    // Uso:
    //  - /watch <alias> [intervalo]
    //    intervalo: 5m (padrão), 10m, 1h, 30s (mínimo recomendado 1m)
    if (normalizedText.startsWith('/watch')) {
        const args = text.replace(/\/watch/i, '').trim().split(/\s+/).filter(Boolean);
        const aliasKey = (args.shift() || '').replace(/^\//, '').toLowerCase();

        if (!aliasKey) {
            await sendSafeMessage(sock, groupId, { text: '❌ Use: /watch <alias> [intervalo]\nEx: /watch pnix 5m' });
            return;
        }

        const alias = await getAlias(aliasKey);
        if (!alias) {
            await sendSafeMessage(sock, groupId, { text: `❌ Alias não encontrado: ${aliasKey}. Use /listpairs para ver os disponíveis.` });
            return;
        }

        const intervalMsRaw = parseIntervalMs(args[0], 5);

        // Guardrails: mínimo 60s, máximo 60min
        const intervalMs = Math.max(60_000, Math.min(intervalMsRaw, 60 * 60_000));

        // Limite por grupo (evita bagunça)
        const active = listWatches(groupId);
        const MAX_WATCHES = parseInt(process.env.MAX_WATCHES_PER_GROUP || '5');
        if (active.length >= MAX_WATCHES) {
            await sendSafeMessage(sock, groupId, { text: `❌ Limite de assinaturas ativas atingido neste grupo (${MAX_WATCHES}). Use /watchlist e /unwatch.` });
            return;
        }

        const res = await startWatch({ sock, groupId, aliasKey, alias, intervalMs });
        if (!res.ok) {
            await sendSafeMessage(sock, groupId, { text: `❌ ${res.error}` });
            return;
        }

        const mins = Math.round(intervalMs / 60_000);
        await sendSafeMessage(sock, groupId, { text: `✅ Assinatura ativada: /${aliasKey} a cada ~${mins} min.\nPara parar: /unwatch ${aliasKey}` });
        registrarComandoAceitoAtual('/watch');
        return;
    }

    // 🛑 /unwatch (público em grupos) - desativa assinatura
    // Uso:
    //  - /unwatch <alias>
    //  - /unwatch all
    if (normalizedText.startsWith('/unwatch')) {
        const args = text.replace(/\/unwatch/i, '').trim().split(/\s+/).filter(Boolean);
        const target = (args.shift() || '').replace(/^\//, '').toLowerCase();

        if (!target) {
            await sendSafeMessage(sock, groupId, { text: '❌ Use: /unwatch <alias|all>\nEx: /unwatch pnix' });
            return;
        }

        if (target === 'all') {
            const res = stopAllWatches(groupId);
            await sendSafeMessage(sock, groupId, { text: `✅ Assinaturas desativadas: ${res.count}` });
            registrarComandoAceitoAtual('/unwatch');
            return;
        }

        const res = stopWatch(groupId, target);
        if (!res.ok) {
            await sendSafeMessage(sock, groupId, { text: `❌ ${res.error}` });
            return;
        }
        await sendSafeMessage(sock, groupId, { text: `✅ Assinatura desativada: /${target}` });
        registrarComandoAceitoAtual('/unwatch');
        return;
    }

    // 📡 /watchlist (público) - lista assinaturas ativas no grupo
    if (normalizedText.startsWith('/watchlist')) {
        const active = listWatches(groupId);
        if (!active.length) {
            await sendSafeMessage(sock, groupId, { text: 'ℹ️ Nenhuma assinatura ativa neste grupo.' });
            return;
        }
        const msg = active
            .map(w => `• /${w.aliasKey} — ${Math.round(w.intervalMs / 60_000)} min`)
            .join('\n');
        await sendSafeMessage(sock, groupId, { text: `📡 Assinaturas ativas:\n${msg}` });
        registrarComandoAceitoAtual('/watchlist');
        return;
    }

    // Comando !sorteio (público) - apenas em grupos
    if (normalizedText.startsWith('!sorteio') || normalizedText.startsWith('!participar')) {
        console.log('🎲 SORTEIO DETECTADO - isGroup:', isGroup);
        if (isGroup) {
            console.log('✅ Executando handleSorteio...');
            await handleSorteio(sock, message, text);
        } else {
            console.log('❌ Comando ignorado - não é grupo');
        }
        return;
    }


    // Comando /sorteio (público)
    if (normalizedText.startsWith('/sorteio')) {

        if (isGroup) {
            await handleSorteio(sock, message, text);
            registrarComandoAceitoAtual('/sorteio');
        }
        return;
    }

    if (normalizedText.startsWith('/cap')) {
        await handleCap(sock, message, text);
        registrarComandoAceitoAtual('/cap');
        return;
    }

    if (normalizedText.startsWith('/curso')) {
        await handleCurso(sock, message, text);
        registrarComandoAceitoAtual('/curso');
        return;
    }

    // 📈 Comando /grafico (público) - Dexscreener (Opção A)
    // Uso:
    //  - /grafico <link Dexscreener>
    //  - /grafico <0xPAIR>
    //  - /grafico bsc <0xPAIR>
    //  - /grafico bsc <0xTOKEN>  (resolve pool líder)
    if (normalizedText.startsWith('/grafico')) {
        // Rate-limit dedicado (mais pesado que comandos comuns)
        const cooldown = parseInt(process.env.GRAFICO_COOLDOWN || '8') * 1000;
        const rateCheck = checkRateLimit(`${senderId}:grafico`, cooldown);
        if (rateCheck.limited) {
            await sendSafeMessage(sock, groupId, { text: `⏱️ Aguarde ${rateCheck.remaining}s para pedir outro gráfico.` });
            return;
        }

        const argsText = text.replace(/\/grafico/i, '').trim();
        const resolved = await resolveDexTarget(argsText, 'bsc');
        if (!resolved.ok) {
            await sendSafeMessage(sock, groupId, { text: `❌ ${resolved.error}` });
            return;
        }

        const key = `${resolved.chain}:${resolved.pairAddress}`;

        // Snapshot (com cache curto interno)
        const snap = await fetchDexPairSnapshot(resolved.chain, resolved.pairAddress, {
            allowCache: true,
            cacheTtlMs: CRYPTO_COMMAND_CACHE_TTL_MS,
            allowStale: true,
            staleMaxAgeMs: CRYPTO_COMMAND_STALE_MAX_AGE_MS,
            allowAnyCached: true,
            backgroundRefresh: true,
            timeoutMs: CRYPTO_COMMAND_TIMEOUT_MS
        });
        if (!snap.ok) {
            await sendSafeMessage(sock, groupId, { text: `❌ ${snap.error}` });
            return;
        }


        const symbolPair = snap.quoteSymbol ? `${snap.baseSymbol}/${snap.quoteSymbol}` : snap.baseSymbol;
        const priceTxt = formatPriceUsd(snap.priceUsd);
        const changeTxt = formatPercentChange(snap.changeH24);
        const liqTxt = formatUsdRounded(snap.liquidityUsd);


        const caption = `📈 *${symbolPair}* (${resolved.chain.toUpperCase()})\n\n` +
            `💰 *Preço:* ${priceTxt}\n` +
            `📊 *Variação 24h:* ${changeTxt}\n` +
            `💧 *Liquidez:* ${liqTxt}` +
            (snap.url ? `\n\n🔗 ${snap.url}` : '');

        const sent = await sendSafeMessage(sock, groupId, {
            text: caption
        });
        logger.info('crypto_graph_command_result', {
            groupId,
            senderId,
            chain: resolved.chain,
            pairAddress: resolved.pairAddress,
            source: snap.source || 'dexscreener',
            sent: Boolean(sent)
        });
        registrarComandoAceitoAtual('/grafico');

        return;
    }

    // Comandos de contratos (Públicos - Contatos de projetos e criptomoedas)

    // 1. Comando /ca (Contract Address) - Apenas o contrato para copiar fácil
    // Uso: /ca snappy, /ca nix, /ca (mostra lista)
    if (normalizedText.startsWith('/ca')) {
        const args = normalizedText.replace(/^\/ca/i, '').trim().split(/\s+/);
        const tokenName = args[0] ? '/' + args[0].replace(/^\//, '') : '';

        if (tokenName && PROJECT_TOKENS[tokenName]) {
            await sendSafeMessage(sock, groupId, { text: PROJECT_TOKENS[tokenName].address });
            registrarComandoAceitoAtual('/ca');
            return;
        }

        // Se não achou ou sem argumento, listar opções
        const options = Object.keys(PROJECT_TOKENS).map(k => k.replace('/', '')).join(', ');
        await sendSafeMessage(sock, groupId, { text: `❓ Token não encontrado. Tente: /ca [nome]\nOpções: ${options}` });
        registrarComandoAceitoAtual('/ca');
        return;
    }

    const cleanCmd = normalizedText.trim();
    if (PROJECT_TOKENS[cleanCmd]) {
        const tokenConfig = PROJECT_TOKENS[cleanCmd];

        // Rate-limit curto para priorizar comandos cripto mais usados.
        const cooldown = parseInt(process.env.CRYPTO_COMMAND_COOLDOWN || '2') * 1000;
        const rateCheck = checkRateLimit(`${senderId}:${cleanCmd}`, cooldown);

        if (rateCheck.limited) {
            await sendSafeMessage(sock, groupId, { text: `⏱️ Aguarde ${rateCheck.remaining}s...` });
            return;
        }

        const start = Date.now();
        const resolved = await resolveProjectTokenPairFast(tokenConfig);
        const resolveFinishedAt = Date.now();

        if (!resolved.ok) {
            const fallbackText = resolved.timeout
                ? `📄 Contrato ${tokenConfig.label}: ${tokenConfig.address}\n\nConsulta de mercado temporariamente lenta.`
                : `📄 Contrato ${tokenConfig.label}: ${tokenConfig.address}\n(API Temporariamente indisponível)`;
            await sendSafeMessage(sock, groupId, { text: fallbackText });
            registrarComandoAceitoAtual(cleanCmd);
            return;
        }

        const snap = await fetchDexPairSnapshot(resolved.chain, resolved.pairAddress, {
            allowCache: true,
            cacheTtlMs: CRYPTO_COMMAND_CACHE_TTL_MS,
            allowStale: true,
            staleMaxAgeMs: CRYPTO_COMMAND_STALE_MAX_AGE_MS,
            allowAnyCached: true,
            backgroundRefresh: true,
            timeoutMs: CRYPTO_COMMAND_TIMEOUT_MS
        });
        const snapshotFinishedAt = Date.now();

        if (!snap.ok) {
            await sendSafeMessage(sock, groupId, { text: `📄 Contrato ${tokenConfig.label}: ${tokenConfig.address}` });
            registrarComandoAceitoAtual(cleanCmd);
            return;
        }

        snap.tokenAddress = snap.tokenAddress || tokenConfig.address;

        const symbolPair = snap.quoteSymbol ? `${snap.baseSymbol}/${snap.quoteSymbol}` : snap.baseSymbol;
        const priceTxt = formatPriceUsd(snap.priceUsd);
        const changeTxt = formatPercentChange(snap.changeH24);
        const liqTxt = formatUsdRounded(snap.liquidityUsd);

        let caption = `📈 *${tokenConfig.label}* (${symbolPair})\n\n` +
            `💰 *Preço:* ${priceTxt}\n` +
            `📊 *Variação 24h:* ${changeTxt}\n` +
            `💧 *Liquidez:* ${liqTxt}\n` +
            `📄 *Contrato:* ${tokenConfig.address}`;

        const dexviewUrl = buildDexviewTokenUrl(tokenConfig.address, resolved.chain);
        const dexscreenerUrl = buildDexscreenerPairUrl(resolved.pairAddress, resolved.chain);
        if (dexviewUrl) {
            caption += `\n\n📊 *Dexview:* ${dexviewUrl}`;
        }
        if (dexscreenerUrl) {
            caption += `\n📈 *Dexscreener:* ${dexscreenerUrl}`;
        }

        const sent = await sendSafeMessage(sock, groupId, {
            text: caption
        });
        logger.info('crypto_token_command_result', {
            command: cleanCmd,
            groupId,
            senderId,
            chain: resolved.chain,
            pairAddress: resolved.pairAddress,
            resolvedFrom: resolved.resolvedFrom || null,
            source: snap.source || 'dexscreener',
            resolveMs: Math.max(0, resolveFinishedAt - start),
            snapshotMs: Math.max(0, snapshotFinishedAt - resolveFinishedAt),
            totalMs: Math.max(0, snapshotFinishedAt - start),
            sent: Boolean(sent)
        });
        registrarComandoAceitoAtual(cleanCmd);
        return;
    }

    // Comandos administrativos
    if (normalizedText.includes('/fechar') || normalizedText.includes('/abrir') || normalizedText.includes('/fixar') || normalizedText.includes('/aviso') || normalizedText.includes('/todos') || normalizedText.includes('/regras') || normalizedText.includes('/descricao') || normalizedText.includes('/status') || normalizedText.includes('/stats') || normalizedText.includes('/hora') || normalizedText.includes('/banir') || normalizedText.includes('/link') || normalizedText.includes('/promover') || normalizedText.includes('/rebaixar') || normalizedText.includes('/agendar') || normalizedText.includes('/manutencao') || normalizedText.includes('/lembrete') || normalizedText.includes('/stoplembrete') || normalizedText.includes('/comandos') || normalizedText.includes('/comandos2') || normalizedText.includes('/adicionargrupo') || normalizedText.includes('/removergrupo') || normalizedText.includes('/listargrupos') || normalizedText.includes('/adicionaradmin') || normalizedText.includes('/removeradmin') || normalizedText.includes('/listaradmins') || normalizedText.includes('/addparceiro') || normalizedText.includes('/adicionarparceiro') || normalizedText.includes('/delparceiro') || normalizedText.includes('/removerparceiro') || normalizedText.includes('/listparceiros') || normalizedText.includes('/listarparceiros') || normalizedText.includes('/adicionartermo') || normalizedText.includes('/adicionartemo') || normalizedText.includes('/addtermo') || normalizedText.includes('/removertermo') || normalizedText.includes('/removertemo') || normalizedText.includes('/listartermos') || normalizedText.includes('/testia') || normalizedText.includes('/leads') || normalizedText.includes('/engajamento') || normalizedText.includes('/sethorario') || normalizedText.includes('/testelembrete') || normalizedText.includes('/logs') || normalizedText.includes('/ranking') || normalizedText.includes('/shill') || normalizedText.includes('/laminashill')) {

        const cooldown = parseInt(process.env.COMMAND_COOLDOWN || '3') * 1000;
        const rateCheck = checkRateLimit(senderId, cooldown);
        if (rateCheck.limited) {
            await sendSafeMessage(sock, groupId, { text: `⏱️ Aguarde ${rateCheck.remaining}s` });
            return;
        }

        let commandMessageKey = message.key;

        try {
            const isPublicInfoCommand = normalizedText.startsWith('/regras') || normalizedText.startsWith('/ranking') || normalizedText.startsWith('/comandos2');
            const requiresAuth = !isPublicInfoCommand;

            // Se requer autorização, verificar se o usuário é admin
            if (requiresAuth) {
                const authorized = await checkAuth(sock, senderId, groupId, { allowGroupAdmins: true });
                if (!authorized) {
                    await sendSafeMessage(sock, groupId, {
                        text: '❌ *Acesso Negado*\n\n⚠️ Apenas administradores autorizados podem usar comandos do bot.\n👥 Integrantes comuns têm acesso somente ao comando /regras.\n\n💡 Entre em contato com um administrador para solicitar permissão.'
                    });
                    console.log(`🚫 Comando administrativo bloqueado para usuário não autorizado: ${senderId}`);
                    return;
                }
            }

            registrarComandoAceitoAtual(commandToken);
            const groupPerms = await getAllowedGroupPermissions(groupSubject);
            const requiredPermission = getRequiredPermissionForAdminCommand(commandToken);
            if (requiredPermission && !groupPerms[requiredPermission]) {
                await sendSafeMessage(sock, groupId, {
                    text: `Este grupo esta sem permissao para ${getPermissionLabel(requiredPermission)}.`
                });
                return;
            }

            if (normalizedText.startsWith('/descricao')) {
                try {
                    const metadata = await sock.groupMetadata(groupId);
                    const desc = metadata.desc || 'Sem descrição';
                    await sendSafeMessage(sock, groupId, { text: `📝 *DESCRIÇÃO DO GRUPO*\n\n${desc}` });
                } catch (e) {
                    await sendSafeMessage(sock, groupId, { text: '❌ Erro ao ler descrição.' });
                }
            } else if (normalizedText.startsWith('/regras')) {
                try {
                    const metadata = await sock.groupMetadata(groupId);
                    const desc = metadata.desc?.trim();

                    let rulesMessage;
                    if (desc) {
                        rulesMessage = `⚠ *REGRAS OFICIAIS DO GRUPO* ⚠\n\n${desc}`;
                    } else {
                        rulesMessage = `⚠ *REGRAS OFICIAIS DO GRUPO* ⚠
     *Bem-vindo(a) ao grupo!*
_Leia com atenção antes de participar das conversas!_

❗ *Respeito acima de tudo!*
_Nada de xingamentos, discussões ou qualquer tipo de preconceito._

❗ *Proibido SPAM e divulgação sem permissão.*
_Mensagens repetidas, links suspeitos e propaganda não autorizada serão removidos._

❗ *Mantenha o foco do grupo.*
_Conversas fora do tema principal atrapalham todos._

❗ *Conteúdo inadequado não será tolerado.*
_Nada de conteúdo adulto, político, religioso ou violento._

❗ *Use o bom senso.*
_Se não agregou valor, não envie._

❗ *Apenas administradores podem alterar o grupo.*
_Nome, foto e descrição são gerenciados pelos administradores._

❗ *Dúvidas?*
_Use o comando /comandos ou marque um administrador._ 💬
━━━━━━━━━━━━━━━━━━━
🕒 *Horários do Grupo:*
☀ _Abertura automática:_ *07:00*
🌙 _Fechamento automático:_ *00:00*

💡 _Dica:_ Digite */comandos* para ver todos os comandos disponíveis.

❕ _Seu comportamento define a qualidade do grupo._`;
                    }

                    await sendSafeMessage(sock, groupId, { text: rulesMessage });
                } catch (e) {
                    console.error('Erro ao enviar regras:', e);
                }
            } else if (normalizedText.startsWith('/fechar')) {
                await sock.groupSettingUpdate(groupId, 'announcement');
                const closeMessage = `Grupo Temporariamente Fechado

O envio de mensagens está desativado até 08:00.

                A funcionalidade será reativada automaticamente no horário programado.`;
                await sendSafeMessage(sock, groupId, { text: closeMessage });
            } else if (normalizedText.startsWith('/abrir')) {
                await sock.groupSettingUpdate(groupId, 'not_announcement');
                const openMessage = `Grupo Aberto

As mensagens foram reativadas.
Desejamos a todos um excelente dia.`;
                await sendSafeMessage(sock, groupId, { text: openMessage });
            } else if (normalizedText.startsWith('/status')) {
                const statusMessage = await getGroupStatus(sock, groupId);
                await sendSafeMessage(sock, groupId, { text: statusMessage });
            } else if (normalizedText.startsWith('/shill') || normalizedText.startsWith('/laminashill')) {
                await sendSafeMessage(sock, groupId, { text: 'Use este comando no privado com o bot (PV).' });
            } else if (normalizedText.startsWith('/ranking')) {
                const ranking = getGroupTopRanking(groupId, 10);
                await sendSafeMessage(sock, groupId, { text: buildRankingMessageForGroup(ranking, 'RANKING TOP 10') });
            } else if (normalizedText.startsWith('/comandos2')) {
                const comandosOcultos = buildHiddenCommandsMenuText();
                await sendSafeMessage(sock, groupId, { text: comandosOcultos });
            } else if (normalizedText.startsWith('/stats')) {
                const statsMessage = formatStats();
                await sendSafeMessage(sock, groupId, { text: statsMessage });
                logger.info('Comando /stats', { userId: senderId });
            } else if (normalizedText.startsWith('/hora')) {
                const now = new Date();
                const hora = now.toLocaleTimeString('pt-BR', { timeZone: REMINDER_TIMEZONE });
                const data = now.toLocaleDateString('pt-BR', { timeZone: REMINDER_TIMEZONE });
                await sendSafeMessage(sock, groupId, {
                    text: `🕒 *Horário do Bot:*

📅 Data: ${data}
⏰ Hora: ${hora}`
                });
            } else if (normalizedText.startsWith('/logs')) {
                const linesRaw = text.replace(/^\/logs/i, '').trim();
                const requestedLines = Number.parseInt(linesRaw, 10);
                const logs = readRecentLogs(Number.isFinite(requestedLines) ? requestedLines : 20);

                if (!logs.ok) {
                    await sendSafeMessage(sock, groupId, { text: `❌ ${logs.message}` });
                    return;
                }

                await sendSafeMessage(sock, groupId, {
                    text: `📋 *Últimos logs (${logs.safeLines} linhas)*\n\n\`\`\`\n${logs.text}\n\`\`\``
                });
            } else if (normalizedText.startsWith('/fixar')) {
                const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                let messageToPin = text.replace(/\/fixar/i, '').trim();
                if (messageToPin) {
                    const agora = new Date();
                    const data = agora.toLocaleDateString('pt-BR');
                    const hora = agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                    const pinnedMsg = `📌 MENSAGEM IMPORTANTE 📌
━━━━━━━━━━━━━━━━━━━
${messageToPin}
━━━━━━━━━━━━━━━━━━━
| 📅 DATA: ${data}
| 🕓HORA: ${hora}`;
                    await sendSafeMessage(sock, groupId, { text: pinnedMsg, mentions: mentionedJids });
                } else {
                    await sendSafeMessage(sock, groupId, { text: '❌ *Uso incorreto!*\n\n📝 Use: `/fixar sua mensagem aqui`' });
                }
            } else if (normalizedText.startsWith('/aviso')) {
                const avisoMsg = text.replace(/\/aviso/i, '').trim();
                if (!avisoMsg) {
                    await sendSafeMessage(sock, groupId, { text: '❌ Use: `/aviso sua mensagem`' });
                    return;
                }

                try {
                    // Montar lista de membros para mentions
                    const metadata = await sock.groupMetadata(groupId);
                    if (!metadata || !metadata.participants) {
                        throw new Error('Metadados do grupo inválidos ou vazios');
                    }
                    const members = metadata.participants.map(m => m.id);
                    await sendSafeMessage(sock, groupId, { text: avisoMsg, mentions: members });
                    console.log(`✅ Aviso enviado para ${members.length} membros no grupo ${groupId}`);
                } catch (err) {
                    console.error('❌ Erro ao enviar aviso:', err);
                    await sendSafeMessage(sock, groupId, {
                        text: '❌ Erro ao processar o comando de aviso. Verifique os logs ou tente novamente em alguns instantes.'
                    });
                }
            } else if (normalizedText.startsWith('/addpair')) {
                // /addpair <alias> <chain> <pairAddress> <label opcional...>
                // Ex: /addpair pnix bsc 0x... NIX/WBNB
                const args = text.replace(/\/addpair/i, '').trim();
                const parts = args.split(/\s+/);
                const alias = parts.shift();
                const chain = parts.shift();
                const pair = parts.shift();
                const label = parts.join(' ').trim();

                const res = await addCryptoAlias(alias, chain, pair, label);
                if (!res.ok) {
                    await sendSafeMessage(sock, groupId, { text: `❌ ${res.error}\n\nUso: /addpair pnix bsc 0x... NIX/WBNB` });
                    return;
                }
                await sendSafeMessage(sock, groupId, { text: `✅ Atalho criado: /${alias.replace(/^\//, '').toLowerCase()} → ${res.value.label} (${String(res.value.chain).toUpperCase()})` });
                return;

            } else if (normalizedText.startsWith('/delpair')) {
                // /delpair <alias>
                const alias = text.replace(/\/delpair/i, '').trim();
                const res = await removeCryptoAlias(alias);
                if (!res.ok) {
                    await sendSafeMessage(sock, groupId, { text: `❌ ${res.error}\n\nUso: /delpair pnix` });
                    return;
                }
                await sendSafeMessage(sock, groupId, { text: `🗑️ Atalho removido: /${String(alias).replace(/^\//, '').toLowerCase()}` });
                return;

            } else if (normalizedText.startsWith('/todos')) {
                const msg = text.replace(/\/todos/i, '').trim();
                const metadata = await sock.groupMetadata(groupId);
                const members = metadata.participants.map(m => m.id);

                if (msg) {
                    await sendSafeMessage(sock, groupId, { text: msg, mentions: members });
                } else {
                    await sendSafeMessage(sock, groupId, { text: 'Atenção membros do grupo.', mentions: members });
                }
            } else if (normalizedText.startsWith('/link')) {
                try {
                    const inviteCode = await sock.groupInviteCode(groupId);
                    const link = `https://chat.whatsapp.com/${inviteCode}`;
                    await sendSafeMessage(sock, groupId, { text: `🔗 *Link do Grupo:*\n\n${link}` });
                } catch (e) {
                    await sendSafeMessage(sock, groupId, { text: '❌ Erro ao gerar link. Bot precisa ser admin.' });
                }
            } else if (normalizedText.startsWith('/promover')) {
                const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                if (mentionedJids.length > 0) {
                    try {
                        await sock.groupParticipantsUpdate(groupId, mentionedJids, 'promote');
                        await sendSafeMessage(sock, groupId, { text: '✅ Membro promovido a admin!' });
                    } catch (e) {
                        await sendSafeMessage(sock, groupId, { text: '❌ Erro ao promover. Bot precisa ser admin.' });
                    }
                } else {
                    await sendSafeMessage(sock, groupId, { text: '❌ Use: `/promover @usuario`' });
                }
            } else if (normalizedText.startsWith('/rebaixar')) {
                const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                if (mentionedJids.length > 0) {
                    try {
                        await sock.groupParticipantsUpdate(groupId, mentionedJids, 'demote');
                        await sendSafeMessage(sock, groupId, { text: '✅ Admin rebaixado a membro!' });
                    } catch (e) {
                        await sendSafeMessage(sock, groupId, { text: '❌ Erro ao rebaixar. Bot precisa ser admin.' });
                    }
                } else {
                    await sendSafeMessage(sock, groupId, { text: '❌ Use: `/rebaixar @usuario`' });
                }
            } else if (normalizedText.startsWith('/agendar')) {
                const parts = text.replace(/\/agendar/i, '').trim().split(' ');
                const time = parts[0];
                const msg = parts.slice(1).join(' ');

                if (time && msg && /^\d{1,2}:\d{2}$/.test(time)) {
                    const result = scheduleMessage(groupId, time, msg);
                    await sendSafeMessage(sock, groupId, { text: `⏰ Mensagem agendada para ${result.scheduledFor}` });
                } else {
                    await sendSafeMessage(sock, groupId, { text: '❌ Use: `/agendar 14:30 Sua mensagem`' });
                }
            } else if (normalizedText.startsWith('/manutencao')) {
                const mode = text.replace(/\/manutencao/i, '').trim().toLowerCase();
                if (mode === 'on') {
                    enableMaintenance();
                    await sendSafeMessage(sock, groupId, { text: '🔧 Modo manutenção ATIVADO. Apenas admins podem usar o bot.' });
                } else if (mode === 'off') {
                    disableMaintenance();
                    await sendSafeMessage(sock, groupId, { text: '✅ Modo manutenção DESATIVADO.' });
                } else {
                    await sendSafeMessage(sock, groupId, { text: '❌ Use: `/manutencao on` ou `/manutencao off`' });
                }
            } else if (normalizedText.startsWith('/banir')) {
                const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                if (mentionedJids.length > 0) {
                    const groupMetadata = await sock.groupMetadata(groupId);
                    for (const memberId of mentionedJids) {
                        const memberNumber = memberId.split('@')[0];
                        await sock.groupParticipantsUpdate(groupId, [memberId], 'remove');
                        await sendSafeMessage(sock, groupId, { text: `🚫 Membro banido com sucesso!` });

                        // Notificar administradores
                        const admins = groupMetadata.participants.filter(p => p.admin && p.id !== memberId).map(p => p.id);
                        const dataHora = new Date().toLocaleString('pt-BR');
                        const adminNotification = `🔥👮 *ATENÇÃO, ADMINISTRADORES!* 👮🔥

Um membro foi banido do grupo:

📌 *Informações:*
• 🆔 ID: ${memberId}
• 📱 Número: ${memberNumber}
• 🕓 Data/Hora: ${dataHora}

🚫 Ação executada por comando administrativo.`;

                        for (const adminId of admins) {
                            await sendSafeMessage(sock, adminId, { text: adminNotification });
                        }
                    }
                } else {
                    await sendSafeMessage(sock, groupId, { text: '❌ Use: `/banir @membro`' });
                }
            } else if (normalizedText.startsWith('/testbot')) {
                try {
                    const groupMetadata = await sock.groupMetadata(groupId);
                    const botJid = sock.user.id;
                    const botParticipant = groupMetadata.participants.find(p => p.id === botJid);
                    const isAdmin = botParticipant?.admin ? 'SIM' : 'NÃO';
                    await sendSafeMessage(sock, groupId, { text: `🤖 Bot ID: ${botJid}\n👮 É admin: ${isAdmin}` });
                } catch (e) {
                    await sendSafeMessage(sock, groupId, { text: `Erro: ${e.message}` });
                }
            } else if (normalizedText.startsWith('/adicionargrupo')) {
                let param = text.replace(/\/adicionargrupo/i, '').trim();
                if (!param && isGroup) {
                    const gm = await sock.groupMetadata(groupId);
                    param = gm.subject || '';
                }
                setAddGroupWizard(senderId, {
                    step: 'openClose',
                    groupName: param,
                    permissions: { openClose: true, spam: true, reminders: true, promo: true, moderation: true, engagement: true, leadsRead: true, welcome: true }
                });
                await sendSafeMessage(sock, senderId, {
                    text: `Configurando grupo: ${param}\nPermitir abertura/fechamento automatico? (sim/nao)\n\nResponda no privado.`
                });
                await sendSafeMessage(sock, groupId, { text: 'Enviei no seu privado a configuracao de permissoes deste grupo.' });
            } else if (normalizedText.startsWith('/removergrupo')) {
                let param = text.replace(/\/removergrupo/i, '').trim();
                if (!param && isGroup) {
                    const gm = await sock.groupMetadata(groupId);
                    param = gm.subject || '';
                }
                const result = await removeAllowedGroup(senderId, param);
                await sendSafeMessage(sock, senderId, { text: result.message });
                if (result.success) {
                    await sendSafeMessage(sock, groupId, { text: '✅ Grupo removido da lista!' });
                }
            } else if (normalizedText.startsWith('/listargrupos')) {
                const allowed = await listAllowedGroups();
                if (!allowed || allowed.length === 0) {
                    await sendSafeMessage(sock, senderId, { text: 'ℹ️ Lista de grupos vazia.' });
                } else {
                    const formatted = allowed.map((g, i) => `${i + 1}. ${g}`).join('\n');
                    await sendSafeMessage(sock, senderId, { text: `📋 Grupos permitidos:\n\n${formatted}` });
                }
            } else if (normalizedText.startsWith('/adicionaradmin')) {
                const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                let param = text.replace(/\/adicionaradmin/i, '').trim();
                if (mentionedJids.length > 0) param = mentionedJids[0];
                if (!param) {
                    await sendSafeMessage(sock, groupId, { text: '❌ Use: `/adicionaradmin @usuario`' });
                    return;
                }
                const result = await addAdmin(senderId, param);
                await sendSafeMessage(sock, senderId, { text: result.message });
                if (result.success) {
                    await sendSafeMessage(sock, groupId, { text: '✅ Admin adicionado!' });
                }
            } else if (normalizedText.startsWith('/removeradmin')) {
                const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                let param = text.replace(/\/removeradmin/i, '').trim();
                if (mentionedJids.length > 0) param = mentionedJids[0];
                if (!param) {
                    await sendSafeMessage(sock, groupId, { text: '❌ Use: `/removeradmin @usuario`' });
                    return;
                }
                const result = await removeAdmin(senderId, param);
                await sendSafeMessage(sock, senderId, { text: result.message });
                if (result.success) {
                    await sendSafeMessage(sock, groupId, { text: '✅ Admin removido!' });
                }
            } else if (normalizedText.startsWith('/listaradmins')) {
                const admins = await listAdmins();
                if (admins.length === 0) {
                    await sendSafeMessage(sock, senderId, { text: 'ℹ️ Nenhum admin configurado.' });
                } else {
                    let adminList = `👮 *ADMINISTRADORES*\n━━━━━━━━━━━━━━━━\n\n`;
                    admins.forEach((admin, index) => {
                        adminList += `${index + 1}. ${admin.id}\n`;
                    });
                    await sendSafeMessage(sock, senderId, { text: adminList });
                }
            } else if (isPartnerAddCommand(normalizedText)) {
                const mentionedJids = getMentionedJidsFromMessage(message);
                let param = text.replace(/^\/(addparceiro|adicionarparceiro)/i, '').trim();
                if (mentionedJids.length > 0) param = mentionedJids[0];
                const targetUserId = normalizePartnerTarget(param);
                if (!targetUserId) {
                    await sendSafeMessage(sock, groupId, { text: '❌ Use: `/adicionarparceiro @usuario` ou `/adicionarparceiro 5511999999999`' });
                    return;
                }

                const result = await addGroupPartner(senderId, groupId, await resolvePartnerAliasesForGroup(sock, groupId, targetUserId));
                await sendSafeMessage(sock, groupId, {
                    text: `${result.message}\nGrupo: ${groupSubject || groupId}`
                });
            } else if (isPartnerRemoveCommand(normalizedText)) {
                const mentionedJids = getMentionedJidsFromMessage(message);
                let param = text.replace(/^\/(delparceiro|removerparceiro)/i, '').trim();
                if (mentionedJids.length > 0) param = mentionedJids[0];
                const targetUserId = normalizePartnerTarget(param);
                if (!targetUserId) {
                    await sendSafeMessage(sock, groupId, { text: '❌ Use: `/removerparceiro @usuario` ou `/removerparceiro 5511999999999`' });
                    return;
                }

                const result = await removeGroupPartner(senderId, groupId, targetUserId);
                await sendSafeMessage(sock, groupId, {
                    text: `${result.message}\nGrupo: ${groupSubject || groupId}`
                });
            } else if (isPartnerListCommand(normalizedText)) {
                const partners = await listGroupPartners(groupId);
                await sendSafeMessage(sock, groupId, {
                    text: await formatPartnerListMessage(sock, groupId, groupSubject || groupId, partners)
                });
            } else if (normalizedText.startsWith('/adicionartermo') || normalizedText.startsWith('/adicionartemo') || normalizedText.startsWith('/addtermo')) {
                const termo = text.replace(/^\/(adicionartermo|adicionartemo|addtermo)/i, '').trim();
                if (termo) {
                    const result = addBannedWord(termo);
                    await sendSafeMessage(sock, groupId, { text: result.message });
                } else {
                    await sendSafeMessage(sock, groupId, { text: '❌ Use: `/adicionartermo palavra ou frase`' });
                }
            } else if (normalizedText.startsWith('/removertermo') || normalizedText.startsWith('/removertemo')) {
                const termo = text.replace(/^\/(removertermo|removertemo)/i, '').trim();
                if (termo) {
                    const result = removeBannedWord(termo);
                    await sendSafeMessage(sock, groupId, { text: result.message });
                } else {
                    await sendSafeMessage(sock, groupId, { text: '❌ Use: `/removertermo palavra ou frase`' });
                }
            } else if (normalizedText.startsWith('/listartermos')) {
                const termos = listBannedWords();
                if (termos.length === 0) {
                    await sendSafeMessage(sock, groupId, { text: 'ℹ️ Nenhum termo proibido cadastrado.' });
                } else {
                    const lista = termos.map((t, i) => `${i + 1}. ${t}`).join('\n');
                    await sendSafeMessage(sock, groupId, { text: `🚫 *TERMOS PROIBIDOS*\n\n${lista}\n\n📊 Total: ${termos.length}` });
                }
            } else if (normalizedText.startsWith('/lembretefixo')) {
                const payload = extractReminderPayload(text, 'lembretefixo');
                if (!payload) {
                    await sendSafeMessage(sock, groupId, { text: `❗ Use: /lembretefixo + mensagem 08:00 21:00
Ex: /lembretefixo + LEMBRETE DIÁRIO 08:00 15:00 21:00` });
                    return;
                }

                const parsed = splitMessageAndTimes(payload);
                if (!parsed.ok) {
                    await sendSafeMessage(sock, groupId, { text: `⚠️ ${parsed.error}\nEx: /lembretefixo + LEMBRETE DIARIO 08:00 15:00 21:00` });
                    return;
                }
                const fixedTimeValidation = validateFixedReminderTimes(parsed.times);
                if (!fixedTimeValidation.ok) {
                    await sendSafeMessage(sock, groupId, { text: `⚠️ ${fixedTimeValidation.message}` });
                    return;
                }

                if (parsed.times.length > MAX_DAILY_TIMES) {
                    await sendSafeMessage(sock, groupId, { text: `⚠️ Máximo de horários por lembrete fixo: ${MAX_DAILY_TIMES}.` });
                    return;
                }

                if (getDailyReminderEntries(groupId).length >= MAX_GROUP_DAILY_REMINDERS) {
                    await sendSafeMessage(sock, groupId, { text: `⚠️ Limite de lembretes fixos ativos neste grupo: ${MAX_GROUP_DAILY_REMINDERS}.` });
                    return;
                }

                const config = {
                    title: buildAutoReminderTitle(parsed.message, 'fixed'),
                    comando: parsed.message,
                    horarios: fixedTimeValidation.times,
                    startTime: Date.now(),
                    groupName: String(groupSubject || getStoredReminderGroupName(groupId) || '').trim()
                };

                try {
                    startLembreteFixo(sock, groupId, config);
                } catch (error) {
                    await sendSafeMessage(sock, groupId, { text: `⚠️ ${error.message || String(error)}` });
                    return;
                }

                await sendSafeMessage(sock, groupId, {
                    text: `✅ Lembrete fixo diário ativado.\n\nHorários: ${fixedTimeValidation.times.join(', ')}\nAtivos neste grupo: ${getDailyReminderEntries(groupId).length}/${MAX_GROUP_DAILY_REMINDERS}\nPara desativar: /stoplembretefixo`
                });
            } else if (normalizedText.startsWith('/lembrete') && !normalizedText.startsWith('/lembretes') && !normalizedText.startsWith('/lembretefixo')) {
                const payload = extractReminderPayload(text, 'lembrete');
                if (!payload) {
                    await sendSafeMessage(sock, groupId, { text: '❗ Use: /lembrete + mensagem 1h 24h\nEx: /lembrete + REUNIÃO HOJE! 1h 24h' });
                    return;
                }

                const resto = payload.split(/\s+/).filter(Boolean);
                const tempos = resto.slice(-2); // últimos 2 elementos (1h 24h)
                const comando = resto.slice(0, -2).join(' '); // tudo menos os 2 últimos

                const intervalo = parseFloat(tempos[0].replace('h', ''));
                const encerramento = parseFloat(tempos[1].replace('h', ''));

                if (!comando || !intervalo || !encerramento) {
                    await sendSafeMessage(sock, groupId, { text: '❗ Use: /lembrete + mensagem 1h 24h\nEx: /lembrete + REUNIÃO HOJE! 1h 24h' });
                    return;
                }

                // Validações
                if (intervalo < 1 || intervalo > 24) {
                    await sendSafeMessage(sock, groupId, { text: '⛔ O intervalo deve ser entre *1 e 24 horas*.' });
                    return;
                }

                if (encerramento < 24 || encerramento > 168) {
                    await sendSafeMessage(sock, groupId, { text: '⛔ A duração (encerramento) deve ser de no mínimo *24 horas* e no máximo *7 dias (168h)*.' });
                    return;
                }

                const intervaloMs = intervalo * 60 * 60 * 1000;
                const encerramentoMs = encerramento * 60 * 60 * 1000;

                // cancelar lembrete existente
                if (lembretesAtivos[groupId]) {
                    stopReminder(groupId);
                }

                // MENSAGEM FORMATADA
                const data = new Date();
                const dia = `${data.getDate()}`.padStart(2, '0');
                const mes = `${data.getMonth() + 1}`.padStart(2, '0');
                const ano = data.getFullYear();
                const hora = `${data.getHours()}`.padStart(2, '0');
                const min = `${data.getMinutes()}`.padStart(2, '0');

                const msgFormatada = `*NOTIFICAÇÃO AUTOMÁTICA*

${comando}

_iMavyAgent | Sistema de Lembretes_`;

                // Enviar primeira vez
                await sendPlainText(sock, groupId, msgFormatada);

                const config = {
                    title: buildAutoReminderTitle(comando, 'interval'),
                    comando,
                    intervalo,
                    encerramento,
                    startTime: Date.now(),
                    groupName: String(groupSubject || getStoredReminderGroupName(groupId) || '').trim()
                };


                // Lógica de agendamento robusta
                const nextTrigger = Date.now() + intervaloMs;
                startReminderTimer(sock, groupId, { ...config, nextTrigger });

                saveLembretes();

                // Encerramento automático
                setTimeout(async () => {
                    stopReminder(groupId, sock);
                }, encerramentoMs);
            } else if (isStopFixedReminderCommand(normalizedText)) {
                const reminderRef = text.replace(/^\/stoplembretefixo|^\/stoplembretesfixos/i, '').trim();
                const entries = getDailyReminderEntries(groupId);
                if (!entries.length) {
                    await sendSafeMessage(sock, groupId, { text: 'ℹ️ Não há nenhum lembrete fixo ativo neste grupo.' });
                } else if (reminderRef) {
                    const stopped = stopSingleLembreteFixo(groupId, reminderRef);
                    await sendSafeMessage(sock, groupId, {
                        text: stopped.ok
                            ? `🛑 ${stopped.message}`
                            : `ℹ️ ${stopped.message}`
                    });
                } else {
                    const stopped = stopLembreteFixo(groupId);
                    await sendSafeMessage(sock, groupId, {
                        text: stopped?.ok
                            ? `🛑 Todos os lembretes fixos foram *desativados* com sucesso!\n\nQuantidade removida: ${stopped.removedCount}`
                            : 'ℹ️ Não há nenhum lembrete fixo ativo neste grupo.'
                    });
                }
} else if (isStopIntervalReminderCommand(normalizedText)) {
                const hasInterval = Boolean(lembretesAtivos[groupId]);
                const hasFixed = getDailyReminderEntries(groupId).length > 0;

                if (hasInterval) {
                    stopReminder(groupId);
                    const msg = hasFixed
                        ? '🛑 O lembrete automático foi *desativado*!\n\nLembretes fixos continuam ativos. Para pará-los: /stoplembretefixo'
                        : '🛑 O lembrete automático foi *desativado* com sucesso!';
                    await sendSafeMessage(sock, groupId, { text: msg });
                } else if (hasFixed) {
                    await sendSafeMessage(sock, groupId, {
                        text: 'ℹ️ Não há lembrete automático ativo neste grupo.\n\nPara parar lembretes fixos, use: /stoplembretefixo\nPara ver todos: /lembretes'
                    });
                } else {
                    await sendSafeMessage(sock, groupId, {
                        text: 'ℹ️ Não há nenhum lembrete ativo neste grupo.\n\nPara criar: /lembrete + mensagem 1h 24h\nOu: /lembretefixo + mensagem 08:00 21:00'
                    });
                }
            } else if (normalizedText === '/lembretes') {
                await sendSafeMessage(sock, groupId, { text: buildReminderStatusText(groupId) });
            } else if (normalizedText.startsWith('/testelembrete')) {
                // Remove o comando, suportando singular e plural (/testelembrete ou /testelembretes)
                const comando = text.replace(/^\/testelembretes?/i, '').trim();

                if (!comando) {
                    await sendSafeMessage(sock, groupId, { text: '❗ Use: /testelembrete [mensagem]' });
                    return;
                }

                // Configuração de teste (1 min intervalo, 10 min duração)
                const config = {
                    comando,
                    intervalo: 0.0166666, // ~1 minuto em horas
                    encerramento: 0.166666, // ~10 minutos em horas
                    startTime: Date.now()
                };

                // Cancelar anterior
                if (lembretesAtivos[groupId]) {
                    stopReminder(groupId);
                }

                const msgText = `✅ *Teste Iniciado*\nIntervalo: 1 minuto\nDuração: 10 minutos\n\n${comando}`;

                await sendPlainText(sock, groupId, msgText);

                const nextTrigger = Date.now() + 60000;
                startReminderTimer(sock, groupId, { ...config, nextTrigger });
                saveLembretes();

                // Encerramento
                setTimeout(() => {
                    stopReminder(groupId, sock);
                }, 600000);
            } else if (normalizedText.startsWith('/testia')) {
                const testMsg = text.replace(/\/testia/i, '').trim() || 'Olá, quero saber mais sobre seus serviços';
                try {
                    const aiSales = await analyzeLeadIntent(testMsg, senderId);
                    const aiMod = await analyzeMessage(testMsg);

                    let result = `🧪 *TESTE DE IA*\n━━━━━━━━━━━━━━━━\n\n`;
                    result += `📝 Mensagem: "${testMsg}"\n\n`;
                    result += `💼 *IA Vendas:*\n`;
                    result += `• Intent: ${aiSales.intent}\n`;
                    result += `• Confiança: ${aiSales.confidence}%\n`;
                    result += `• Resposta: ${aiSales.response}\n`;
                    result += `• Precisa humano: ${aiSales.needsHuman ? 'Sim' : 'Não'}\n\n`;
                    result += `🛡️ *IA Moderação:*\n`;
                    result += `• Seguro: ${aiMod.safe ? 'Sim' : 'Não'}\n`;
                    result += `• Motivo: ${aiMod.reason}`;

                    await sendSafeMessage(sock, groupId, { text: result });
                } catch (e) {
                    await sendSafeMessage(sock, groupId, { text: `❌ Erro: ${e.message}` });
                }
            } else if (normalizedText.startsWith('/leads')) {
                const leads = getLeads();
                if (!leads || !Array.isArray(leads) || leads.length === 0) {
                    await sendSafeMessage(sock, groupId, { text: 'ℹ️ Nenhum lead registrado ainda.' });
                } else {
                    let msg = `📊 *LEADS CAPTURADOS* (${leads.length})\n━━━━━━━━━━━━━━━━\n\n`;
                    const leadsArray = Array.isArray(leads) ? leads : Object.values(leads);
                    leadsArray.slice(-10).reverse().forEach((lead, i) => {
                        const date = new Date(lead.timestamp).toLocaleString('pt-BR');
                        msg += `${i + 1}. 📱 ${lead.phone}\n`;
                        msg += `   • Intent: ${lead.intent} (${lead.confidence}%)\n`;
                        msg += `   • Conversas: ${lead.conversationCount}\n`;
                        msg += `   • Data: ${date}\n\n`;
                    });
                    if (leadsArray.length > 10) msg += `\n... e mais ${leadsArray.length - 10} leads`;
                    await sendSafeMessage(sock, groupId, { text: msg });
                }
            } else if (normalizedText.startsWith('/sethorario')) {
                const args = text.split(' ');
                const tipo = args[1]?.toLowerCase();
                const horario = args[2];

                if ((tipo === 'abrir' || tipo === 'fechar') && horario && /^\d{1,2}:\d{2}$/.test(horario)) {
                    const configPath = path.join(__dirname, '..', 'schedule_config.json');
                    let config = { openTime: '07:00', closeTime: '00:00' };

                    if (fs.existsSync(configPath)) {
                        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    }

                    if (tipo === 'abrir') config.openTime = horario;
                    if (tipo === 'fechar') config.closeTime = horario;

                    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                    await sendSafeMessage(sock, groupId, { text: `✅ Horário de ${tipo} definido: ${horario}\n\n⚠️ Reinicie o bot para aplicar` });
                } else {
                    await sendSafeMessage(sock, groupId, { text: '❌ Use: /sethorario abrir 07:00\nou\n/sethorario fechar 23:00' });
                }
            } else if (normalizedText.startsWith('/comandos')) {
                const comandosMsg = buildCommandsMenuText();
                await sendSafeMessage(sock, senderId, { text: comandosMsg });
                if (isGroup) {
                    await sendSafeMessage(sock, groupId, { text: '📱 *Lista de comandos enviada no privado!*' });
                }
            }
        } catch (err) {
            console.error('❌ Erro ao executar comando:', err);
        }

        // Auto-delete do comando
        setTimeout(async () => {
            try {
                await sendSafeMessage(sock, groupId, { delete: commandMessageKey });
            } catch (e) { }
        }, 3000);

        return;
    }

// Modo de respostas inteligentes desabilitado - apenas comandos
}

startReminderTimer = function (sock, groupId, config) {
    const { comando, intervalo, nextTrigger } = config;
    const intervaloMs = intervalo * 60 * 60 * 1000;
    const now = Date.now();
    let timeToNext = nextTrigger - now;
    if (timeToNext < 0) timeToNext = 0;

    lembretesAtivos[groupId] = {
        config: { ...config, nextTrigger: now + timeToNext },
        timer: setTimeout(async () => {
            await sendReminderMessage(sock, groupId, { ...config, comando });
            lembretesAtivos[groupId].timer = setInterval(async () => {
                await sendReminderMessage(sock, groupId, { ...config, comando });
                if (lembretesAtivos[groupId]) {
                    lembretesAtivos[groupId].config.nextTrigger = Date.now() + intervaloMs;
                    saveLembretes();
                }
            }, intervaloMs);

            if (lembretesAtivos[groupId]) {
                lembretesAtivos[groupId].config.nextTrigger = Date.now() + intervaloMs;
                saveLembretes();
            }
        }, timeToNext)
    };
};

scheduleDailyTime = function (sock, groupId, reminderId, config, timeStr) {
    const { nextTs, delayMs } = getNextDailyTrigger(timeStr);
    const entry = getDailyReminderEntries(groupId).find((item) => item?.id === reminderId);
    if (entry) {
        entry.nextTriggers[timeStr] = nextTs;
    }

    return setTimeout(async () => {
        await sendReminderMessage(sock, groupId, config);
        const activeEntry = getDailyReminderEntries(groupId).find((item) => item?.id === reminderId);
        if (activeEntry) {
            const timer = scheduleDailyTime(sock, groupId, reminderId, config, timeStr);
            activeEntry.timers[timeStr] = timer;
            saveLembretes();
        }
    }, delayMs);
};

function parseReminderHoursInput(value) {
    const match = String(value || '').trim().match(/(\d+(?:[.,]\d+)?)\s*h?/i);
    if (!match) return null;
    const parsed = Number.parseFloat(match[1].replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
}

function parseReminderDaysInput(value) {
    const match = String(value || '').trim().match(/(\d+(?:[.,]\d+)?)\s*(?:d|dia|dias)?/i);
    if (!match) return null;
    const parsed = Number.parseFloat(match[1].replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
}

async function buildReminderImageState(sock, message, hasIncomingImage) {
    if (!hasIncomingImage) return { ok: true, imageBase64: '' };
    try {
        const media = typeof sock.downloadMediaMessage === 'function'
            ? await sock.downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage })
            : await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
        if (!media || !Buffer.isBuffer(media) || media.length === 0) {
            return { ok: false, message: 'Nao consegui ler a foto enviada. Tente novamente.' };
        }
        return { ok: true, imageBase64: media.toString('base64') };
    } catch (error) {
        return { ok: false, message: `Falha ao processar foto: ${error.message}` };
    }
}

function buildIntervalReminderConfirmText(state) {
    return `Confirma o lembrete?\n\nGrupo: ${state.group?.subject}\nTitulo: ${state.title || 'sem titulo'}\nMensagem: ${state.messageText}\nFoto: ${state.imageBase64 ? 'com foto' : 'sem foto'}\nIntervalo: ${state.intervalHours}h\nDuracao: ${state.durationDays} dia(s)\n\nResponda APROVAR ou CANCELAR.`;
}

async function sendReminderConfirmationPreview(sock, chatId, state, mode = 'interval') {
    const text = mode === 'fixed'
        ? buildFixedReminderConfirmText(state)
        : buildIntervalReminderConfirmText(state);
    const imageBase64 = String(state?.imageBase64 || '').trim();

    if (!imageBase64) {
        await sendSafeMessage(sock, chatId, { text });
        return;
    }

    try {
        const imageBuffer = Buffer.from(imageBase64, 'base64');
        if (imageBuffer.length > 0) {
            await sendSafeMessage(sock, chatId, {
                image: imageBuffer,
                caption: text
            });
            return;
        }
    } catch (_) { }

    await sendSafeMessage(sock, chatId, { text });
}

function resolveSenderIdFromGroupMessage(message) {
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

export function initGroupResponderSchedulers(sock) {
    ensureLaminaStorageFiles();
    ensureScheduledStatePersistence();
    ensureLaminaScheduler(sock);
    ensureShillScheduler(sock);
    persistScheduledAutomationState('init_group_schedulers', { saveReminders: false });
}

export function flushScheduledAutomationState(reason = 'manual_flush') {
    ensureLaminaStorageFiles();
    ensureScheduledStatePersistence();
    persistScheduledAutomationState(reason);
}

export function flushScheduledAutomationStateWithoutReminders(reason = 'manual_flush_without_reminders') {
    ensureLaminaStorageFiles();
    ensureScheduledStatePersistence();
    persistScheduledAutomationState(reason, { saveReminders: false });
}

function buildFixedReminderConfirmText(state) {
    const groups = Array.isArray(state.selectedGroups) && state.selectedGroups.length
        ? state.selectedGroups.map((group) => group.subject).join(', ')
        : state.group?.subject;
    return `Confirma o lembrete fixo?\n\nGrupo(s): ${groups}\nTitulo: ${state.title || 'sem titulo'}\nMensagem: ${state.messageText}\nFoto: ${state.imageBase64 ? 'com foto' : 'sem foto'}\nHorarios: ${(state.times || []).join(', ')}\n\nResponda APROVAR ou CANCELAR.`;
}

function resolveMultipleGroupSelections(input, groups = []) {
    const raw = String(input || '').trim();
    if (!raw) return [];
    const parts = raw.split(',').map((item) => item.trim()).filter(Boolean);
    if (!parts.length) return [];
    const selected = [];
    for (const part of parts) {
        const found = resolveRankingGroupSelection(part, groups);
        if (!found) return [];
        if (!selected.find((item) => item.id === found.id)) {
            selected.push(found);
        }
    }
    return selected;
}

function buildSuggestedCommercialTimes(groups = [], exclude = {}) {
    const candidates = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00'];
    const available = [];
    for (const time of candidates) {
        let ok = true;
        for (const group of groups) {
            const validation = validateFixedReminderTimes([time], {
                ...exclude,
                groupId: group.id
            });
            if (!validation.ok) {
                ok = false;
                break;
            }
        }
        if (ok) available.push(time);
        if (available.length >= 5) break;
    }
    return available;
}

async function configureIntervalReminderFromState(sock, state) {
    const intervalo = Number(state.intervalHours);
    const durationDays = Number(state.durationDays);
    if (!Number.isFinite(intervalo) || intervalo < 1 || intervalo > 24) {
        return { ok: false, message: '⛔ O intervalo deve ser entre *1 e 24 horas*.' };
    }
    if (!Number.isFinite(durationDays) || durationDays < 1 || durationDays > 7) {
        return { ok: false, message: '⛔ A duração deve ser entre *1 e 7 dias*.' };
    }
    const encerramento = durationDays * 24;
    const intervaloMs = intervalo * 60 * 60 * 1000;
    const encerramentoMs = encerramento * 60 * 60 * 1000;
    const groupId = state.group.id;

    if (lembretesAtivos[groupId]) stopReminder(groupId);

    const config = {
        title: sanitizeEntityTitle(state.title || buildAutoReminderTitle(state.messageText, 'interval')),
        comando: state.messageText,
        intervalo,
        encerramento,
        startTime: Date.now(),
        groupName: String(state.group?.subject || '').trim(),
        imageBase64: state.imageBase64 || ''
    };
    await sendReminderMessage(sock, groupId, config);
    startReminderTimer(sock, groupId, { ...config, nextTrigger: Date.now() + intervaloMs });
    saveLembretes();
    setTimeout(async () => {
        stopReminder(groupId, sock);
    }, encerramentoMs);
    return { ok: true, message: '✅ Lembrete automático ativado com sucesso!' };
}

async function configureFixedReminderFromState(sock, state) {
    const times = Array.isArray(state.times) ? state.times : [];
    if (!times.length) {
        return { ok: false, message: '⚠️ Envie ao menos 1 horario no formato HH:MM.' };
    }
    const targetGroups = Array.isArray(state.selectedGroups) && state.selectedGroups.length
        ? state.selectedGroups
        : [state.group].filter(Boolean);
    for (const group of targetGroups) {
        const validation = validateFixedReminderTimes(times);
        if (!validation.ok) {
            return { ok: false, message: `⚠️ ${group.subject}: ${validation.message}` };
        }
        if (getDailyReminderEntries(group.id).length >= MAX_GROUP_DAILY_REMINDERS) {
            return { ok: false, message: `⚠️ ${group.subject}: limite de lembretes fixos ativos neste grupo: ${MAX_GROUP_DAILY_REMINDERS}.` };
        }
    }
    try {
        for (const group of targetGroups) {
            startLembreteFixo(sock, group.id, {
                title: sanitizeEntityTitle(state.title || buildAutoReminderTitle(state.messageText, 'fixed')),
                comando: state.messageText,
                horarios: times,
                startTime: Date.now(),
                groupName: String(group?.subject || '').trim(),
                imageBase64: state.imageBase64 || ''
            });
        }
    } catch (error) {
        return { ok: false, message: `⚠️ ${error.message || String(error)}` };
    }
    return { ok: true, message: `Lembrete fixo diario ativado.\n\nGrupos: ${targetGroups.map((group) => group.subject).join(', ')}\nHorarios: ${times.join(', ')}` };
}

function buildEditableReminderItems(groupId) {
    const items = [];
    const interval = lembretesAtivos[groupId]?.config;
    if (interval) {
        items.push({
            kind: 'interval',
            id: 'interval',
            title: buildReminderEntryLabel(interval, 'interval'),
            summary: `Intervalo ${interval.intervalo}h`,
            config: interval
        });
    }
    for (const entry of getDailyReminderEntries(groupId)) {
        const config = entry?.config || {};
        items.push({
            kind: 'fixed',
            id: String(entry?.id || config.id || ''),
            title: buildReminderEntryLabel(config, 'fixed'),
            summary: `Horarios ${(config.horarios || []).join(', ')}`,
            config
        });
    }
    return items;
}

function resolveEditableReminderSelection(input, items = []) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    const byNumber = Number.parseInt(raw, 10);
    if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= items.length) {
        return items[byNumber - 1];
    }
    const lowered = raw.toLowerCase();
    return items.find((item) => String(item.id || '').toLowerCase() === lowered || String(item.title || '').toLowerCase() === lowered) || null;
}

function deleteEditableReminder(groupId, item) {
    if (!groupId || !item) {
        return { ok: false, message: 'Lembrete nao encontrado.' };
    }
    if (item.kind === 'interval') {
        if (!lembretesAtivos[groupId]?.config) {
            return { ok: false, message: 'Lembrete automatico nao encontrado.' };
        }
        stopReminder(groupId);
        return { ok: true, message: 'Lembrete automatico apagado.' };
    }
    if (item.kind === 'fixed') {
        return stopSingleLembreteFixo(groupId, item.id);
    }
    return { ok: false, message: 'Tipo de lembrete invalido.' };
}

async function runTestReminderForGroup(sock, groupId, comando) {
    const safeMessage = String(comando || '').trim();
    if (!safeMessage) {
        return { ok: false, message: 'Use: /testelembrete [mensagem]' };
    }

    const config = {
        title: buildAutoReminderTitle(safeMessage, 'interval'),
        comando: safeMessage,
        intervalo: 0.0166666,
        encerramento: 0.166666,
        startTime: Date.now(),
        groupName: getStoredReminderGroupName(groupId),
        nextTrigger: Date.now() + 60000
    };

    if (lembretesAtivos[groupId]) {
        stopReminder(groupId);
    }

    const msgText = `✅ *Teste Iniciado*\nIntervalo: 1 minuto\nDuração: 10 minutos\n\n${safeMessage}`;
    await sendPlainText(sock, groupId, msgText);
    startReminderTimer(sock, groupId, config);
    saveLembretes();

    setTimeout(() => {
        stopReminder(groupId, sock);
    }, 600000);

    return { ok: true, message: 'Teste de lembrete iniciado com sucesso.' };
}

async function updateIntervalReminderFromState(sock, state) {
    const groupId = state.group?.id;
    if (!groupId || !lembretesAtivos[groupId]?.config) {
        return { ok: false, message: 'Lembrete automatico nao encontrado.' };
    }
    stopReminder(groupId);
    return configureIntervalReminderFromState(sock, state);
}

async function updateFixedReminderFromState(sock, state) {
    const groupId = state.group?.id;
    const reminderId = String(state.editTarget?.id || '');
    if (!groupId || !reminderId) {
        return { ok: false, message: 'Lembrete fixo nao encontrado.' };
    }
    const stopped = stopSingleLembreteFixo(groupId, reminderId);
    if (!stopped.ok) return stopped;
    return configureFixedReminderFromState(sock, state);
}

export function hasPendingPrivateWizard(senderId) {
    return addGroupWizardState.has(senderId)
        || laminaWizardState.has(senderId)
        || stopLaminaWizardState.has(senderId)
        || rankingWizardState.has(senderId)
        || laminaShillWizardState.has(senderId)
        || shillWizardState.has(senderId)
        || newsWizardState.has(senderId)
        || reminderWizardState.has(senderId);
}





