// groupResponder.js
import { getGroupStatus } from './groupStats.js';

import { addAllowedGroup, listAllowedGroups, removeAllowedGroup, getAllowedGroupPermissions } from './adminCommands.js';
import { addAdmin, removeAdmin, listAdmins, getAdminStats, isAuthorized, checkAuth } from './authManager.js';
import { addBannedWord, removeBannedWord, listBannedWords } from './antiSpam.js';
import { analyzeLeadIntent, getLeads } from './aiSales.js';
import { analyzeMessage } from './aiModeration.js';
import { addPromoGroup, removePromoGroup, listPromoGroups, setPromoInterval, togglePromo, getPromoConfig } from './autoPromo.js';
import { checkRateLimit } from './rateLimiter.js';
import { logger } from './logger.js';
import { formatStats } from './stats.js';
import { enableMaintenance, disableMaintenance, isMaintenanceMode } from './maintenance.js';
import { scheduleMessage } from './scheduler2.js';
import { handleSorteio } from './custom/sorteio.js';
import { sendSafeMessage, sendPlainText } from './messageHandler.js';
import { resolveDexTarget, fetchDexPairSnapshot } from './crypto/dexscreener.js';
import { pushPoint, getSeries } from './crypto/timeseries.js';
import { renderSparklinePng } from './crypto/chart.js';
import { getAlias, listAliases as listCryptoAliases, addAlias as addCryptoAlias, removeAlias as removeCryptoAlias } from './crypto/aliasStore.js';
import { startWatch, stopWatch, stopAllWatches, listWatches, parseIntervalMs } from './crypto/watchManager.js';
import { isMarketPriceCommand, getMarketQuote } from './crypto/marketPrices.js';
import { generateImavyCryptoReply } from './crypto/imavyAnalyst.js';
import { askChatGPT } from './chatgpt.js';
import { isRestrictedGroupName } from './groupPolicy.js';
import { registrarComandoAceito } from './commandMetrics.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEMBRETES_FILE = path.join(__dirname, '..', 'lembretes.json');
const BOT_LOG_FILE = path.join(__dirname, '..', 'bot.log');
const BOT_TRIGGER = 'bot';
const addGroupWizardState = new Map();
const laminaWizardState = new Map();

// Configuração dos tokens do projeto (Centralizada)
const PROJECT_TOKENS = {
    '/snappy': { address: '0x3a9e15b28E099708D0812E0843a9Ed70c508FB4b', chain: 'bsc', label: 'SNAPPY' },
    '/nix': { address: '0xBe96fcF736AD906b1821Ef74A0e4e346C74e6221', chain: 'bsc', label: 'NIX' },
    '/coffee': { address: '0x2cAA9De4E4BB8202547afFB19b5830DC16184451', chain: 'bsc', label: 'COFFEE' },
    '/lux': { address: '0xa3baAAD9C19805f52cFa2490700C297359b4fA52', chain: 'bsc', label: 'LUX' },
    '/kenesis': { address: '0x76d7966227939b67D66FDB1373A0808ac53Ca9ad', chain: 'bsc', label: 'KENESIS' },
    '/dcar': { address: '0xe1f7DD2812e91D1f92a8Fa1115f3ACA4aff82Fe5', chain: 'bsc', label: 'DCAR' },
    '/fsx': { address: '0xcD4fA13B6f5Cad65534DC244668C5270EC7e961a', chain: 'bsc', label: 'FSX' },
    '/nlc': { address: '0x5f320c3b8f82acfe8f2bb1c85d63aa66a7ff524f', chain: 'bsc', label: 'NLC' },
    '/masaka': { address: '96jWXh7S6Yh1Lkj4Fss14q1jRMwhTKkVpSFzRaunsMKT', chain: 'solana', label: 'MASAKA' }
};
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

function getCommandToken(normalizedText) {
    return String(normalizedText || '').trim().split(/\s+/)[0] || '';
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
}

function getLaminaWizard(senderId) {
    return laminaWizardState.get(senderId);
}

function clearLaminaWizard(senderId) {
    laminaWizardState.delete(senderId);
}

function getRequiredPermissionForAdminCommand(commandToken) {
    const token = String(commandToken || '').toLowerCase();
    if (token === '/fechar' || token === '/abrir') return 'openClose';
    if (token === '/lembrete' || token === '/lembretefixo' || token === '/stoplembrete' || token === '/stoplembretefixo' || token === '/testelembrete') return 'reminders';
    if (token === '/promo' || token === '/sethorario') return 'promo';
    if (token === '/banir' || token === '/adicionartermo' || token === '/removertermo' || token === '/listartermos') return 'moderation';
    return null;
}

function getPermissionLabel(permissionKey) {
    if (permissionKey === 'openClose') return 'abertura/fechamento';
    if (permissionKey === 'reminders') return 'lembretes';
    if (permissionKey === 'promo') return 'promo';
    if (permissionKey === 'moderation') return 'moderacao';
    return permissionKey || 'desconhecida';
}

function normalizeGroupSearch(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

async function resolveGroupByInput(sock, input) {
    const query = String(input || '').trim();
    if (!query) {
        return { ok: false, message: 'Informe o nome ou ID do grupo.' };
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

    if (query.endsWith('@g.us')) {
        const found = list.find((g) => g.id === query);
        if (!found) return { ok: false, message: 'Grupo por ID nao encontrado.' };
        return { ok: true, group: found };
    }

    const normalizedQuery = normalizeGroupSearch(query);
    const exact = list.filter((g) => normalizeGroupSearch(g.subject) === normalizedQuery);
    if (exact.length === 1) return { ok: true, group: exact[0] };
    if (exact.length > 1) {
        return { ok: false, message: 'Mais de um grupo com esse nome. Informe o ID @g.us.' };
    }

    const partial = list.filter((g) => normalizeGroupSearch(g.subject).includes(normalizedQuery));
    if (partial.length === 1) return { ok: true, group: partial[0] };
    if (partial.length > 1) {
        const opts = partial.slice(0, 8).map((g) => `- ${g.subject} | ${g.id}`).join('\n');
        return { ok: false, message: `Encontrei varios grupos. Seja mais especifico:\n${opts}` };
    }

    return { ok: false, message: 'Grupo nao encontrado.' };
}

function isNoneText(value) {
    const t = String(value || '').trim().toLowerCase();
    return t === 'nenhuma' || t === 'nenhum' || t === 'nao' || t === 'não' || t === 'sem';
}

function isLikelyHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || '').trim());
}

function buildLaminaPreview(state) {
    return `PREVIA /lamina\n\nGrupo: ${state.groupName}\nID: ${state.groupId}\nImagem: ${state.imageSource ? state.imageSource : 'nenhuma'}\n\nTexto:\n${state.textBody}\n\nResponda APROVAR para enviar, REFAZER para recomecar ou CANCELAR para abortar.`;
}

async function sendLaminaToGroup(sock, state) {
    const targetId = state.groupId;
    if (!state.imageSource) {
        await sendSafeMessage(sock, targetId, { text: state.textBody });
        return;
    }

    const raw = String(state.imageSource || '').trim();
    if (isLikelyHttpUrl(raw)) {
        await sendSafeMessage(sock, targetId, { image: { url: raw }, caption: state.textBody });
        return;
    }

    const absPath = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
    if (!fs.existsSync(absPath)) {
        throw new Error(`Imagem nao encontrada no caminho: ${absPath}`);
    }
    const imageBuffer = fs.readFileSync(absPath);
    await sendSafeMessage(sock, targetId, { image: imageBuffer, caption: state.textBody });
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
    if (Math.abs(n) >= 1) return `$${n.toFixed(4)}`;
    return `$${n.toFixed(8)}`;
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

function buildCryptoText({ label, chain, pairAddress, snap }) {
    const change = Number(snap.changeH24 ?? 0);
    const changeTxt = Number.isFinite(change) ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : 'N/A';
    const link = snap.url || `https://dexscreener.com/${chain}/${pairAddress}`;

    return `📈 ${label} (${String(chain).toUpperCase()})
💰 Preço: ${formatPriceUsd(snap.priceUsd)}
🕒 24h: ${changeTxt}
💧 Liquidez: ${formatUsdCompact(snap.liquidityUsd)}
🔗 ${link}`;
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

function saveLembretes() {
    try {
        const data = { interval: {}, daily: {} };
        for (const [groupId, interval] of Object.entries(lembretesAtivos)) {
            if (interval.config) data.interval[groupId] = interval.config;
        }
        for (const [groupId, daily] of Object.entries(lembretesFixosAtivos)) {
            if (daily.config) data.daily[groupId] = daily.config;
        }
        fs.writeFileSync(LEMBRETES_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Erro ao salvar lembretes:', e);
    }
}

// Exported initialization function
export function initLembretes(sock) {
    try {
        if (fs.existsSync(LEMBRETES_FILE)) {
            const raw = JSON.parse(fs.readFileSync(LEMBRETES_FILE, 'utf8'));
            if (raw && typeof raw === 'object') {
                if (raw.interval || raw.daily) {
                    const intervalData = raw.interval || {};
                    const dailyData = raw.daily || {};
                    for (const [groupId, config] of Object.entries(intervalData)) {
                        restartLembrete(sock, groupId, config);
                    }
                    for (const [groupId, config] of Object.entries(dailyData)) {
                        restartLembreteFixo(sock, groupId, config);
                    }
                } else {
                    // Compatibilidade com formato antigo (apenas intervalos)
                    for (const [groupId, config] of Object.entries(raw)) {
                        restartLembrete(sock, groupId, config);
                    }
                }
            }
        }
    } catch (e) {
        console.error('Erro ao carregar lembretes:', e);
    }
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
}

function stopReminder(groupId, sock = null) {
    if (lembretesAtivos[groupId]) {
        clearTimeout(lembretesAtivos[groupId].timer); // Limpa timeout inicial
        clearInterval(lembretesAtivos[groupId].timer); // Limpa intervalo se já existir (mesma prop)
        delete lembretesAtivos[groupId];
        saveLembretes();
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

function getNextDailyTrigger(timeStr, nowDate = new Date()) {
    const now = (nowDate instanceof Date) ? nowDate : new Date(nowDate);
    const parts = timeStr.split(':');
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
    }
    return { nextTs: next.getTime(), delayMs: next.getTime() - now.getTime() };
}

function scheduleDailyTime(sock, groupId, config, timeStr) {
    const { nextTs, delayMs } = getNextDailyTrigger(timeStr);
    if (lembretesFixosAtivos[groupId]) {
        lembretesFixosAtivos[groupId].nextTriggers[timeStr] = nextTs;
    }

    return setTimeout(async () => {
        const msgText = `*NOTIFICAÇÃO AUTOMÁTICA*

${config.comando}

_iMavyAgent | Sistema de Lembretes_`;
        await sendPlainText(sock, groupId, msgText);

        if (lembretesFixosAtivos[groupId]) {
            const timer = scheduleDailyTime(sock, groupId, config, timeStr);
            lembretesFixosAtivos[groupId].timers[timeStr] = timer;
            saveLembretes();
        }
    }, delayMs);
}

function startLembreteFixo(sock, groupId, config) {
    const rawTimes = Array.isArray(config.horarios) ? config.horarios : [];
    const horarios = [];
    for (const t of rawTimes) {
        const parsed = normalizeTimeToken(String(t).trim());
        if (parsed.ok && !horarios.includes(parsed.value)) horarios.push(parsed.value);
    }
    if (!horarios.length || !config.comando) return;

    lembretesFixosAtivos[groupId] = {
        config: { ...config, horarios },
        timers: {},
        nextTriggers: {}
    };

    for (const timeStr of horarios) {
        const timer = scheduleDailyTime(sock, groupId, lembretesFixosAtivos[groupId].config, timeStr);
        lembretesFixosAtivos[groupId].timers[timeStr] = timer;
    }

    saveLembretes();
}

function stopLembreteFixo(groupId, sock = null) {
    const current = lembretesFixosAtivos[groupId];
    if (!current) return;

    for (const timer of Object.values(current.timers || {})) {
        clearTimeout(timer);
    }

    delete lembretesFixosAtivos[groupId];
    saveLembretes();

    if (sock) {
        sendSafeMessage(sock, groupId, { text: `🛑 *Lembrete fixo desativado*

*_iMavyAgent — Automação Inteligente_*` }).catch(() => { });
    }
}

function restartLembreteFixo(sock, groupId, config) {
    if (!config || !config.comando || !Array.isArray(config.horarios) || config.horarios.length === 0) return;
    startLembreteFixo(sock, groupId, config);
}



// Respostas pré-definidas
const RESPONSES = {
    'oi': '👋 Olá! Como posso ajudar?',
    'ajuda': '📋 Comandos disponíveis:\n- oi\n- ajuda\n- status\n- info\n- /fechar\n- /abrir\n- /fixar\n- /regras\n- /status\n- /comandos',
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

// Inicialização movida para index.js
// if (!global.lembretesLoaded) {
//     global.lembretesLoaded = true;
//     setTimeout(() => loadLembretes(global.sock), 2000);
// }

export async function handleGroupMessages(sock, message, context = {}) {
    if (!global.sock) global.sock = sock;
    const groupId = message.key.remoteJid;
    const isGroup = groupId.endsWith('@g.us');
    const senderId = message.key.participant || message.key.remoteJid;

    // Modo manutenção - só admins
    if (isMaintenanceMode()) {
        const authorized = await isAuthorized(senderId);
        if (!authorized) return;
    }

    const contentType = Object.keys(message.message)[0];
    let text = '';

    // Permitir /comandos no PV
    switch (contentType) {
        case 'conversation':
            text = message.message.conversation;
            break;
        case 'extendedTextMessage':
            text = message.message.extendedTextMessage.text;
            break;
    }

    // Bloquear mensagens vazias
    if (!text || text.trim().length === 0) return;

    // Funcionalidade de resposta automática desabilitada

    if (!isGroup && text.toLowerCase().includes('/comandos')) {
        const comandosMsg = `🤖 *LISTA COMPLETA DE COMANDOS* 🤖
━━━━━━━━━━━━━━━━
👮 *COMANDOS ADMINISTRATIVOS:*

* 🔒 /fechar - Fecha o grupo
* 🔓 /abrir - Abre o grupo
* 🚫 /banir @membro - Bane membro
* 📢 /aviso [mensagem] - Menciona todos
* 📋 /logs [linhas] - Mostra os últimos logs do bot
* 📢 /lembrete + mensagem 1h 24h - Lembrete automático
* 🛑 /stoplembrete - Para lembrete
* ⏰ /lembretefixo + mensagem 08:00 21:00 - Lembrete fixo diário
* 🛑 /stoplembretefixo - Para lembrete fixo
* 🚫 /adicionartermo [palavra] - Bloqueia palavra
* ✏️ /removertermo [palavra] - Remove palavra
* 📝 /listartermos - Lista palavras bloqueadas
* 👮 /adicionaradmin @usuario - Adiciona admin
* 🗑️ /removeradmin @usuario - Remove admin
* 📋 /listaradmins - Lista admins
* 👑 /promover @usuario - Promove a admin
* 👤 /rebaixar @usuario - Rebaixa admin
━━━━━━━━━━━━━━━━
📊 *COMANDOS DE INFORMAÇÃO:*

* 📊 /status - Status e estatísticas
* 📋 /regras - Regras do grupo
* 🔗 /link - Link do grupo
* 🕒 /hora - Horário do bot
* 📱 /comandos - Lista de comandos
* 🚀 /valyrafi - Apresentação oficial ValyraFi
* @IMAVY [pergunta] - Analista cripto por menção
* 💹 /btc /eth /bnb /sol /xrp /usdt - Cotação de mercado
* 🥇 /ouro (ou /paxg) - Pax Gold com gráfico no CoinMarketCap
━━━━━━━━━━━━━━━━
📝 *CONTRATOS E PROJETOS:*

* /Snappy
* /Nix
* /Coffee
* /Lux
* /Kenesis
* /Dcar
* /Fsx
* /Nlc
* /Masaka
* /Vkinha
━━━━━━━━━━━━━━━━
🔒 *Sistema de Segurança Ativo*
* Anti-spam automático com IA
* Sistema de strikes (3 = expulsão)
* Bloqueio de palavras proibidas
* Notificação automática aos admins
* Lembretes com encerramento automático
━━━━━━━━━━━━━━━━
🤖 *iMavyAgent* - Protegendo seu grupo 24/7`;

        await sendSafeMessage(sock, senderId, { text: comandosMsg });
        return;
    }

    // Permitir respostas em PV usando o dicionário RESPONSES
    if (!isGroup) {
        const textLower = (text || '').trim().toLowerCase();
        if (textLower && RESPONSES[textLower]) {
            await sendSafeMessage(sock, senderId, { text: RESPONSES[textLower] });
            return;
        }

        const laminaState = getLaminaWizard(senderId);
        if (laminaState) {
            if (textLower === '/cancelar' || textLower === 'cancelar') {
                clearLaminaWizard(senderId);
                await sendSafeMessage(sock, senderId, { text: 'Fluxo /lamina cancelado.' });
                return;
            }

            if (laminaState.step === 'group') {
                const resolved = await resolveGroupByInput(sock, text);
                if (!resolved.ok) {
                    await sendSafeMessage(sock, senderId, { text: `${resolved.message}\n\nInforme nome ou ID do grupo (@g.us).` });
                    return;
                }
                laminaState.groupId = resolved.group.id;
                laminaState.groupName = resolved.group.subject || resolved.group.id;
                laminaState.step = 'image';
                laminaWizardState.set(senderId, laminaState);
                await sendSafeMessage(sock, senderId, {
                    text: 'Qual imagem deseja enviar junto? Envie URL HTTP/HTTPS, caminho local (ex: assets/minha.jpg) ou digite NENHUMA.'
                });
                return;
            }

            if (laminaState.step === 'image') {
                const raw = String(text || '').trim();
                if (isNoneText(raw)) {
                    laminaState.imageSource = '';
                } else {
                    laminaState.imageSource = raw;
                }
                laminaState.step = 'text';
                laminaWizardState.set(senderId, laminaState);
                await sendSafeMessage(sock, senderId, { text: 'Agora envie o texto completo da lamina.' });
                return;
            }

            if (laminaState.step === 'text') {
                const body = String(text || '').trim();
                if (!body) {
                    await sendSafeMessage(sock, senderId, { text: 'Texto vazio. Envie o texto da lamina.' });
                    return;
                }
                laminaState.textBody = body;
                laminaState.step = 'confirm';
                laminaWizardState.set(senderId, laminaState);
                await sendSafeMessage(sock, senderId, { text: buildLaminaPreview(laminaState) });
                return;
            }

            if (laminaState.step === 'confirm') {
                if (/^(aprovar|aprovado|aprovo|sim|ok|confirmo)$/i.test(textLower)) {
                    try {
                        await sendLaminaToGroup(sock, laminaState);
                        await sendSafeMessage(sock, senderId, {
                            text: `Lamina enviada com sucesso para ${laminaState.groupName} (${laminaState.groupId}).`
                        });
                    } catch (error) {
                        await sendSafeMessage(sock, senderId, { text: `Falha ao enviar lamina: ${error.message}` });
                    }
                    clearLaminaWizard(senderId);
                    return;
                }

                if (/^(refazer|refaco|refaço|editar|nao|não)$/i.test(textLower)) {
                    laminaState.step = 'group';
                    laminaState.groupId = '';
                    laminaState.groupName = '';
                    laminaState.imageSource = '';
                    laminaState.textBody = '';
                    laminaWizardState.set(senderId, laminaState);
                    await sendSafeMessage(sock, senderId, { text: 'Vamos refazer. Para qual grupo enviar o texto?' });
                    return;
                }

                await sendSafeMessage(sock, senderId, { text: 'Responda APROVAR, REFAZER ou CANCELAR.' });
                return;
            }
        }

        if (textLower.startsWith('/lamina')) {
            const authorized = await isAuthorized(senderId);
            if (!authorized) {
                await sendSafeMessage(sock, senderId, { text: 'Acesso negado. Apenas administradores autorizados.' });
                return;
            }
            laminaWizardState.set(senderId, {
                step: 'group',
                groupId: '',
                groupName: '',
                imageSource: '',
                textBody: ''
            });
            await sendSafeMessage(sock, senderId, { text: 'Fluxo /lamina iniciado.\n\nPara qual grupo enviar o texto?' });
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
                    await sendSafeMessage(sock, senderId, { text: 'Envie o nome/ID do grupo para continuar.' });
                    return;
                }
                wizard.groupName = name;
                wizard.step = 'openClose';
                addGroupWizardState.set(senderId, wizard);
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
                addGroupWizardState.set(senderId, wizard);
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
                addGroupWizardState.set(senderId, wizard);
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
                addGroupWizardState.set(senderId, wizard);
                await sendSafeMessage(sock, senderId, { text: 'Permitir comandos de promo neste grupo? (sim/nao)' });
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
                addGroupWizardState.set(senderId, wizard);
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
                wizard.step = 'confirm';
                addGroupWizardState.set(senderId, wizard);
                const summary = `Confirma cadastro do grupo?\n\nGrupo: ${wizard.groupName}\nAbertura/fechamento: ${wizard.permissions.openClose ? 'SIM' : 'NAO'}\nAnti-spam: ${wizard.permissions.spam ? 'SIM' : 'NAO'}\nLembretes: ${wizard.permissions.reminders ? 'SIM' : 'NAO'}\nPromo: ${wizard.permissions.promo ? 'SIM' : 'NAO'}\nModeracao: ${wizard.permissions.moderation ? 'SIM' : 'NAO'}\n\nResponda sim para confirmar ou nao para cancelar.`;
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

        // Permitir comandos administrativos em PV para administradores autorizados
        if (textLower && (textLower.includes('/adicionargrupo') || textLower.includes('/removergrupo') || textLower.includes('/listargrupos') || textLower.includes('/adicionaradmin') || textLower.includes('/removeradmin') || textLower.includes('/listaradmins'))) {
            const authorized = await isAuthorized(senderId);
            if (authorized) {
                // Processar comando administrativo em PV
                const normalizedText = textLower;

                if (normalizedText.startsWith('/adicionargrupo')) {
                    let param = text.replace(/\/adicionargrupo/i, '').trim();
                    addGroupWizardState.set(senderId, {
                        step: param ? 'openClose' : 'name',
                        groupName: param || '',
                        permissions: { openClose: true, spam: true, reminders: true, promo: true, moderation: true }
                    });
                    if (!param) {
                        await sendSafeMessage(sock, senderId, { text: 'Qual o nome/ID do grupo que deseja adicionar?' });
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
                }
                return;
            } else {
                await sendSafeMessage(sock, senderId, { text: '❌ *Acesso Negado*\n\n⚠️ Apenas administradores autorizados podem usar comandos do bot.' });
                return;
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
            await sendSafeMessage(sock, groupId, {
                text: '⚠️ Neste grupo, apenas funções de cripto, /aviso e /lembrete estão ativas.'
            });
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
            const snap = await fetchDexPairSnapshot(directPair.chain, directPair.pair, { allowCache: true });
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
                const snap = await fetchDexPairSnapshot(alias.chain, alias.pair, { allowCache: true });
                if (!snap?.ok) {
                    await sendSafeMessage(sock, groupId, { text: `❌ Não consegui buscar dados pra ${alias.label || key}.` });
                    return;
                }
                const reply = buildCryptoText({ label: alias.label || key.toUpperCase(), chain: alias.chain, pairAddress: alias.pair, snap });
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
        const snap = await fetchDexPairSnapshot(resolved.chain, resolved.pairAddress, { allowCache: true });
        if (!snap.ok) {
            await sendSafeMessage(sock, groupId, { text: `❌ ${snap.error}` });
            return;
        }


        const symbolPair = snap.quoteSymbol ? `${snap.baseSymbol}/${snap.quoteSymbol}` : snap.baseSymbol;
        const priceTxt = Number.isFinite(snap.priceUsd) ? `$${snap.priceUsd}` : 'N/D';
        const changeTxt = Number.isFinite(snap.changeH24) ? `${snap.changeH24}%` : 'N/D';
        const liqTxt = snap.liquidityUsd ? `$${Math.round(snap.liquidityUsd).toLocaleString('pt-BR')}` : 'N/D';


        const caption = `📈 *${symbolPair}* (${resolved.chain.toUpperCase()})\n\n` +
            `💰 *Preço:* ${priceTxt}\n` +
            `📊 *Variação 24h:* ${changeTxt}\n` +
            `💧 *Liquidez:* ${liqTxt}` +
            (snap.url ? `\n\n🔗 ${snap.url}` : '');

        await sendSafeMessage(sock, groupId, {
            text: caption
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

        // Rate-limit para evitar spam de gráficos
        const cooldown = parseInt(process.env.GRAFICO_COOLDOWN || '5') * 1000;
        const rateCheck = checkRateLimit(`${senderId}:${cleanCmd}`, cooldown);

        if (rateCheck.limited) {
            // Fallback para apenas texto se estiver em cooldown (opcional, ou apenas avisa)
            // Vamos apenas avisar, pois gerar gráfico é pesado
            await sendSafeMessage(sock, groupId, { text: `⏱️ Aguarde ${rateCheck.remaining}s...` });
            return;
        }



        // 1. Tentar resolver como PAR primeiro (Snapshot)
        // Nota: fetchDexPairSnapshot espera um endereço de PAR.
        // Se o address configurado for do TOKEN, precisamos descobrir o par primeiro.
        // Vamos tentar resolver inteligente: resolveDexTarget lida com isso.

        const resolved = await resolveDexTarget(`${tokenConfig.chain} ${tokenConfig.address}`, tokenConfig.chain);

        if (!resolved.ok) {
            // Se falhar API, manda só o contrato como fallback
            await sendSafeMessage(sock, groupId, { text: `📄 Contrato ${tokenConfig.label}: ${tokenConfig.address}\n(API Temporariamente indisponível)` });
            registrarComandoAceitoAtual(cleanCmd);
            return;
        }

        // 2. Buscar dados atualizados
        const snap = await fetchDexPairSnapshot(resolved.chain, resolved.pairAddress, { allowCache: true });

        if (!snap.ok) {
            await sendSafeMessage(sock, groupId, { text: `📄 Contrato ${tokenConfig.label}: ${tokenConfig.address}` });
            registrarComandoAceitoAtual(cleanCmd);
            return;
        }

        // 4. Montar Legenda Rica
        const symbolPair = snap.quoteSymbol ? `${snap.baseSymbol}/${snap.quoteSymbol}` : snap.baseSymbol;
        const priceTxt = Number.isFinite(snap.priceUsd) ? `$${snap.priceUsd}` : 'N/D';
        const changeTxt = Number.isFinite(snap.changeH24) ? `${snap.changeH24 >= 0 ? '+' : ''}${snap.changeH24}%` : 'N/D';
        const liqTxt = snap.liquidityUsd ? `$${Math.round(snap.liquidityUsd).toLocaleString('pt-BR')}` : 'N/D';

        let caption = `📈 *${tokenConfig.label}* (${symbolPair})\n\n` +
            `💰 *Preço:* ${priceTxt}\n` +
            `📊 *Variação 24h:* ${changeTxt}\n` +
            `💧 *Liquidez:* ${liqTxt}\n` +
            `📄 *Contrato:* ${tokenConfig.address}`;

        if (snap.url) {
            caption += `\n\n🔗 ${snap.url}`;
        }

        // 5. Enviar apenas TEXTO (sem gráfico)
        await sendSafeMessage(sock, groupId, {
            text: caption
        });
        registrarComandoAceitoAtual(cleanCmd);
        return;
    }

    // Comandos administrativos
    if (normalizedText.includes('/fechar') || normalizedText.includes('/abrir') || normalizedText.includes('/fixar') || normalizedText.includes('/aviso') || normalizedText.includes('/todos') || normalizedText.includes('/regras') || normalizedText.includes('/descricao') || normalizedText.includes('/status') || normalizedText.includes('/stats') || normalizedText.includes('/hora') || normalizedText.includes('/banir') || normalizedText.includes('/link') || normalizedText.includes('/promover') || normalizedText.includes('/rebaixar') || normalizedText.includes('/agendar') || normalizedText.includes('/manutencao') || normalizedText.includes('/lembrete') || normalizedText.includes('/stoplembrete') || normalizedText.includes('/comandos') || normalizedText.includes('/adicionargrupo') || normalizedText.includes('/removergrupo') || normalizedText.includes('/listargrupos') || normalizedText.includes('/adicionaradmin') || normalizedText.includes('/removeradmin') || normalizedText.includes('/listaradmins') || normalizedText.includes('/adicionartermo') || normalizedText.includes('/removertermo') || normalizedText.includes('/listartermos') || normalizedText.includes('/testia') || normalizedText.includes('/leads') || normalizedText.includes('/promo') || normalizedText.includes('/sethorario') || normalizedText.includes('/testelembrete') || normalizedText.includes('/logs')) {

        const cooldown = parseInt(process.env.COMMAND_COOLDOWN || '3') * 1000;
        const rateCheck = checkRateLimit(senderId, cooldown);
        if (rateCheck.limited) {
            await sendSafeMessage(sock, groupId, { text: `⏱️ Aguarde ${rateCheck.remaining}s` });
            return;
        }

        let commandMessageKey = message.key;

        try {
            const isRulesCommand = normalizedText.includes('/regras');
            const requiresAuth = !isRulesCommand;

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
            } else if (normalizedText.startsWith('/stats')) {
                const statsMessage = formatStats();
                await sendSafeMessage(sock, groupId, { text: statsMessage });
                logger.info('Comando /stats', { userId: senderId });
            } else if (normalizedText.startsWith('/hora')) {
                const now = new Date();
                const hora = now.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                const data = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
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
                addGroupWizardState.set(senderId, {
                    step: 'openClose',
                    groupName: param,
                    permissions: { openClose: true, spam: true, reminders: true, promo: true, moderation: true }
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
            } else if (normalizedText.startsWith('/adicionartermo')) {
                const termo = text.replace(/\/adicionartermo/i, '').trim();
                if (termo) {
                    const result = addBannedWord(termo);
                    await sendSafeMessage(sock, groupId, { text: result.message });
                } else {
                    await sendSafeMessage(sock, groupId, { text: '❌ Use: `/adicionartermo palavra ou frase`' });
                }
            } else if (normalizedText.startsWith('/removertermo')) {
                const termo = text.replace(/\/removertermo/i, '').trim();
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
                const partes = text.split(' + ');

                if (partes.length < 2) {
                    await sendSafeMessage(sock, groupId, { text: `❗ Use: /lembretefixo + mensagem 08:00 21:00
Ex: /lembretefixo + LEMBRETE DIÁRIO 08:00 15:00 21:00` });
                    return;
                }

                const parsed = splitMessageAndTimes(partes[1]);
                if (!parsed.ok) {
                    await sendSafeMessage(sock, groupId, { text: `⚠️ ${parsed.error}
Ex: /lembretefixo + LEMBRETE DIÁRIO 08:00 15:00 21:00` });
                    return;
                }

                if (parsed.times.length > MAX_DAILY_TIMES) {
                    await sendSafeMessage(sock, groupId, { text: `⚠️ Máximo de horários por lembrete fixo: ${MAX_DAILY_TIMES}.` });
                    return;
                }

                // Se existir lembrete fixo ativo, substitui
                if (lembretesFixosAtivos[groupId]) {
                    stopLembreteFixo(groupId);
                }

                const config = {
                    comando: parsed.message,
                    horarios: parsed.times,
                    startTime: Date.now()
                };

                startLembreteFixo(sock, groupId, config);

                await sendSafeMessage(sock, groupId, {
                    text: `✅ Lembrete fixo diário ativado.

Horários: ${parsed.times.join(', ')}
Para desativar: /stoplembretefixo`
                });
            } else if (normalizedText.startsWith('/lembrete') && !normalizedText.startsWith('/lembretes') && !normalizedText.startsWith('/lembretefixo')) {
                const partes = text.split(' + ');

                if (partes.length < 2) {
                    await sendSafeMessage(sock, groupId, { text: '❗ Use: /lembrete + mensagem 1h 24h\nEx: /lembrete + REUNIÃO HOJE! 1h 24h' });
                    return;
                }

                const resto = partes[1].trim().split(' ');
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
                    clearInterval(lembretesAtivos[groupId].interval);
                    delete lembretesAtivos[groupId];
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

                const config = { comando, intervalo, encerramento, startTime: Date.now() };


                // Lógica de agendamento robusta
                const nextTrigger = Date.now() + intervaloMs;
                startReminderTimer(sock, groupId, { ...config, nextTrigger });

                saveLembretes();

                // Encerramento automático
                setTimeout(async () => {
                    stopReminder(groupId, sock);
                }, encerramentoMs);
            } else if (normalizedText === '/stoplembrete') {
                if (lembretesAtivos[groupId]) {
                    stopReminder(groupId);
                    await sendSafeMessage(sock, groupId, { text: '🛑 O lembrete automático foi *desativado* com sucesso!' });
                } else {
                    await sendSafeMessage(sock, groupId, { text: 'ℹ️ Não há nenhum lembrete ativo neste grupo.' });
                }
            } else if (normalizedText === '/stoplembretefixo') {
                if (lembretesFixosAtivos[groupId]) {
                    stopLembreteFixo(groupId);
                    await sendSafeMessage(sock, groupId, { text: '🛑 O lembrete fixo foi *desativado* com sucesso!' });
                } else {
                    await sendSafeMessage(sock, groupId, { text: 'ℹ️ Não há nenhum lembrete fixo ativo neste grupo.' });
                }
            } else if (normalizedText === '/lembretes') {
                const parts = [];

                if (lembretesAtivos[groupId]) {
                    const config = lembretesAtivos[groupId].config;
                    const startTime = new Date(config.startTime);
                    const now = Date.now();

                    // Calcular tempo restante
                    const nextTrigger = lembretesAtivos[groupId].config.nextTrigger || (now + (config.intervalo * 3600000));
                    const timeToNext = Math.max(0, nextTrigger - now);

                    const hours = Math.floor(timeToNext / 3600000);
                    const minutes = Math.floor((timeToNext % 3600000) / 60000);
                    const seconds = Math.floor((timeToNext % 60000) / 1000);

                    const remainingDuration = Math.max(0, (config.startTime + (config.encerramento * 3600000)) - now);
                    const remainingHours = (remainingDuration / 3600000).toFixed(1);

                    const msg = `⏰ *LEMBRETE ATIVO*\n\n` +
                        `📝 *Mensagem:* ${config.comando}\n` +
                        `⏱️ *Intervalo:* ${config.intervalo}h\n` +
                        `⏭️ *Próximo envio em:* ${hours}h ${minutes}m ${seconds}s\n` +
                        `⏳ *Encerra em:* ${remainingHours}h\n` +
                        `📅 *Início:* ${startTime.toLocaleString('pt-BR')}`;

                    parts.push(msg);
                }

                if (lembretesFixosAtivos[groupId]) {
                    const config = lembretesFixosAtivos[groupId].config;
                    const horarios = Array.isArray(config.horarios) ? config.horarios : [];
                    const now = new Date();
                    const nextLines = horarios.map((h) => {
                        const nextTs = getNextDailyTrigger(h, now).nextTs;
                        const when = new Date(nextTs).toLocaleString('pt-BR');
                        return `• ${h} (próximo: ${when})`;
                    }).join('\n');

                    const startTxt = config.startTime ? new Date(config.startTime).toLocaleString('pt-BR') : 'N/D';

                    const msg = `📅 *LEMBRETE FIXO DIÁRIO*\n\n` +
                        `📝 *Mensagem:* ${config.comando}\n` +
                        `⏰ *Horários:* ${horarios.join(', ')}\n` +
                        `📅 *Início:* ${startTxt}` +
                        (nextLines ? `\n\n🔜 *Próximos envios:*\n${nextLines}` : '');

                    parts.push(msg);
                }

                if (parts.length === 0) {
                    await sendSafeMessage(sock, groupId, { text: 'ℹ️ Nenhum lembrete ativo no momento.' });
                } else {
                    await sendSafeMessage(sock, groupId, { text: parts.join('\n\n') });
                }
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
            } else if (normalizedText.startsWith('/promo')) {
                const args = text.split(' ');
                const subCmd = args[1]?.toLowerCase();

                if (subCmd === 'add') {
                    const gm = await sock.groupMetadata(groupId);
                    addPromoGroup(groupId, gm.subject);
                    await sendSafeMessage(sock, groupId, { text: '✅ Grupo adicionado à lista de promoção!' });
                } else if (subCmd === 'remove') {
                    removePromoGroup(groupId);
                    await sendSafeMessage(sock, groupId, { text: '❌ Grupo removido da lista de promoção!' });
                } else if (subCmd === 'list') {
                    const groups = listPromoGroups();
                    if (groups.length === 0) {
                        await sendSafeMessage(sock, groupId, { text: 'ℹ️ Nenhum grupo na lista de promoção.' });
                    } else {
                        let msg = `📊 *GRUPOS DE PROMOÇÃO* (${groups.length})\n\n`;
                        groups.forEach((g, i) => {
                            const lastPromo = g.lastPromo ? new Date(g.lastPromo).toLocaleString('pt-BR') : 'Nunca';
                            msg += `${i + 1}. ${g.name}\n   Último: ${lastPromo}\n\n`;
                        });
                        await sendSafeMessage(sock, groupId, { text: msg });
                    }
                } else if (subCmd === 'interval') {
                    const hours = parseInt(args[2]);
                    if (hours && hours > 0) {
                        setPromoInterval(hours);
                        await sendSafeMessage(sock, groupId, { text: `⏰ Intervalo definido: ${hours}h` });
                    } else {
                        await sendSafeMessage(sock, groupId, { text: '❌ Use: /promo interval 6' });
                    }
                } else if (subCmd === 'on') {
                    togglePromo(true);
                    await sendSafeMessage(sock, groupId, { text: '✅ Auto-promoção ATIVADA!' });
                } else if (subCmd === 'off') {
                    togglePromo(false);
                    await sendSafeMessage(sock, groupId, { text: '❌ Auto-promoção DESATIVADA!' });
                } else if (subCmd === 'config') {
                    const config = getPromoConfig();
                    let msg = `⚙️ *CONFIGURAÇÃO DE PROMO*\n\n`;
                    msg += `• Status: ${config.enabled ? '✅ Ativo' : '❌ Inativo'}\n`;
                    msg += `• Intervalo: ${config.intervalHours}h\n`;
                    msg += `• Grupos: ${config.groups.length}\n`;
                    msg += `• Mensagens: ${config.messages.length}`;
                    await sendSafeMessage(sock, groupId, { text: msg });
                } else {
                    const help = `📊 *COMANDOS DE PROMOÇÃO*\n\n• /promo add - Adiciona grupo atual\n• /promo remove - Remove grupo atual\n• /promo list - Lista grupos\n• /promo interval [horas] - Define intervalo\n• /promo on - Ativa\n• /promo off - Desativa\n• /promo config - Ver configuração`;
                    await sendSafeMessage(sock, groupId, { text: help });
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
                const comandosMsg = `🤖 *LISTA COMPLETA DE COMANDOS* 🤖
━━━━━━━━━━━━━━━━
👮 *COMANDOS ADMINISTRATIVOS:*

* 🔒 /fechar - Fecha o grupo
* 🔓 /abrir - Abre o grupo
* 🚫 /banir @membro - Bane membro
* 📢 /aviso [mensagem] - Menciona todos
* 📋 /logs [linhas] - Mostra os últimos logs do bot
* 📢 /lembrete + mensagem 1h 24h - Lembrete automático
* 🛑 /stoplembrete - Para lembrete
* ⏰ /lembretefixo + mensagem 08:00 21:00 - Lembrete fixo diário
* 🛑 /stoplembretefixo - Para lembrete fixo
* 🚫 /adicionartermo [palavra] - Bloqueia palavra
* ✏️ /removertermo [palavra] - Remove palavra
* 📝 /listartermos - Lista palavras bloqueadas
* 👮 /adicionaradmin @usuario - Adiciona admin
* 🗑️ /removeradmin @usuario - Remove admin
* 📋 /listaradmins - Lista admins
* 👑 /promover @usuario - Promove a admin
* 👤 /rebaixar @usuario - Rebaixa admin
━━━━━━━━━━━━━━━━
📊 *COMANDOS DE INFORMAÇÃO:*

* 📊 /status - Status e estatísticas
* 📋 /regras - Regras do grupo
* 🔗 /link - Link do grupo
* 🕒 /hora - Horário do bot
* 📱 /comandos - Lista de comandos
* 🚀 /valyrafi - Apresentação oficial ValyraFi
* @IMAVY [pergunta] - Analista cripto por menção
* 💹 /btc /eth /bnb /sol /xrp /usdt - Cotação de mercado
* 🥇 /ouro (ou /paxg) - Pax Gold com gráfico no CoinMarketCap
━━━━━━━━━━━━━━━━
🔒 *Sistema de Segurança Ativo*
* Anti-spam automático com IA
* Sistema de strikes (3 = expulsão)
* Bloqueio de palavras proibidas
* Notificação automática aos admins
* Lembretes com encerramento automático
━━━━━━━━━━━━━━━━
🤖 *iMavyAgent* - Protegendo seu grupo 24/7`;
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
