// groupResponder.js
import { getGroupStatus } from './groupStats.js';

import { addAllowedGroup, listAllowedGroups, removeAllowedGroup } from './adminCommands.js';
import { addAdmin, removeAdmin, listAdmins, getAdminStats, isAuthorized } from './authManager.js';
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
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEMBRETES_FILE = path.join(__dirname, '..', 'lembretes.json');
const BOT_TRIGGER = 'bot';

let lembretesAtivos = {};

function saveLembretes() {
    try {
        const data = {};
        for (const [groupId, interval] of Object.entries(lembretesAtivos)) {
            if (interval.config) data[groupId] = interval.config;
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
            const data = JSON.parse(fs.readFileSync(LEMBRETES_FILE, 'utf8'));
            for (const [groupId, config] of Object.entries(data)) {
                restartLembrete(sock, groupId, config);
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
    '/fsx': '0xcD4fA13B6f5Cad65534DC244668C5270EC7e961a'
};

// Inicialização movida para index.js
// if (!global.lembretesLoaded) {
//     global.lembretesLoaded = true;
//     setTimeout(() => loadLembretes(global.sock), 2000);
// }

export async function handleGroupMessages(sock, message) {
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
* 📢 /lembrete + mensagem 1h 24h - Lembrete automático
* 🛑 /stoplembrete - Para lembrete
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
━━━━━━━━━━━━━━━━
📝 *CONTRATOS E PROJETOS:*

* /Snappy
* /Nix
* /Coffee
* /Lux
* /Kenesis
* /Dcar
* /Fsx
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

        // Permitir comandos administrativos em PV para administradores autorizados
        if (textLower && (textLower.includes('/adicionargrupo') || textLower.includes('/removergrupo') || textLower.includes('/listargrupos') || textLower.includes('/adicionaradmin') || textLower.includes('/removeradmin') || textLower.includes('/listaradmins'))) {
            const authorized = await isAuthorized(senderId);
            if (authorized) {
                // Processar comando administrativo em PV
                const normalizedText = textLower;

                if (normalizedText.startsWith('/adicionargrupo')) {
                    let param = text.replace(/\/adicionargrupo/i, '').trim();
                    const result = await addAllowedGroup(senderId, param);
                    await sendSafeMessage(sock, senderId, { text: result.message });
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
    const normalizedText = text.toLowerCase();

    // Ignorar comandos dentro de mensagens pré-definidas (como regras)
    if (text.includes('REGRAS OFICIAIS DO GRUPO') || text.includes('iMavyAgent') || text.includes('Bem-vindo(a) ao grupo')) {
        console.log('⏭️ Ignorando comandos dentro de mensagem pré-definida');
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
        }
        return;
    }

    // Comandos de contratos (Públicos - Contatos de projetos e criptomoedas)
    const cleanCmd = normalizedText.trim();

    if (cleanCmd === '/snappy') {
        await sendSafeMessage(sock, groupId, { text: '0x3a9e15b28E099708D0812E0843a9Ed70c508FB4b' });
        return;
    }
    if (cleanCmd === '/nix') {
        await sendSafeMessage(sock, groupId, { text: '0xBe96fcF736AD906b1821Ef74A0e4e346C74e6221' });
        return;
    }
    if (cleanCmd === '/coffee') {
        await sendSafeMessage(sock, groupId, { text: '0x2cAA9De4E4BB8202547afFB19b5830DC16184451' });
        return;
    }
    if (cleanCmd === '/lux') {
        await sendSafeMessage(sock, groupId, { text: '0xa3baAAD9C19805f52cFa2490700C297359b4fA52' });
        return;
    }
    if (cleanCmd === '/kenesis') {
        await sendSafeMessage(sock, groupId, { text: '0x76d7966227939b67D66FDB1373A0808ac53Ca9ad' });
        return;
    }
    if (cleanCmd === '/dcar') {
        await sendSafeMessage(sock, groupId, { text: '0xe1f7DD2812e91D1f92a8Fa1115f3ACA4aff82Fe5' });
        return;
    }
    if (cleanCmd === '/fsx') {
        await sendSafeMessage(sock, groupId, { text: '0xcD4fA13B6f5Cad65534DC244668C5270EC7e961a' });
        return;
    }

    // Comandos administrativos
    if (normalizedText.includes('/fechar') || normalizedText.includes('/abrir') || normalizedText.includes('/fixar') || normalizedText.includes('/aviso') || normalizedText.includes('/todos') || normalizedText.includes('/regras') || normalizedText.includes('/descricao') || normalizedText.includes('/status') || normalizedText.includes('/stats') || normalizedText.includes('/hora') || normalizedText.includes('/banir') || normalizedText.includes('/link') || normalizedText.includes('/promover') || normalizedText.includes('/rebaixar') || normalizedText.includes('/agendar') || normalizedText.includes('/manutencao') || normalizedText.includes('/lembrete') || normalizedText.includes('/stoplembrete') || normalizedText.includes('/comandos') || normalizedText.includes('/adicionargrupo') || normalizedText.includes('/removergrupo') || normalizedText.includes('/listargrupos') || normalizedText.includes('/adicionaradmin') || normalizedText.includes('/removeradmin') || normalizedText.includes('/listaradmins') || normalizedText.includes('/adicionartermo') || normalizedText.includes('/removertermo') || normalizedText.includes('/listartermos') || normalizedText.includes('/testia') || normalizedText.includes('/leads') || normalizedText.includes('/promo') || normalizedText.includes('/sethorario') || normalizedText.includes('/testelembrete')) {

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
                const authorized = await isAuthorized(senderId);
                if (!authorized) {
                    await sendSafeMessage(sock, groupId, {
                        text: '❌ *Acesso Negado*\n\n⚠️ Apenas administradores autorizados podem usar comandos do bot.\n👥 Integrantes comuns têm acesso somente ao comando /regras.\n\n💡 Entre em contato com um administrador para solicitar permissão.'
                    });
                    console.log(`🚫 Comando administrativo bloqueado para usuário não autorizado: ${senderId}`);
                    return;
                }
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
                if (avisoMsg) {
                    await sendSafeMessage(sock, groupId, { text: avisoMsg, mentions: members });
                } else {
                    await sendSafeMessage(sock, groupId, { text: '❌ Use: `/aviso sua mensagem`' });
                }
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
                const result = await addAllowedGroup(senderId, param);
                await sendSafeMessage(sock, senderId, { text: result.message });
                if (result.success) {
                    await sendSafeMessage(sock, groupId, { text: '✅ Grupo adicionado à lista!' });
                }
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
            } else if (normalizedText.startsWith('/lembrete') && !normalizedText.startsWith('/lembretes')) {
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
            } else if (normalizedText === '/lembretes') {
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

                    const msg = `📋 *LEMBRETE ATIVO*\n\n` +
                        `📝 *Mensagem:* ${config.comando}\n` +
                        `⏱️ *Intervalo:* ${config.intervalo}h\n` +
                        `🔜 *Próximo envio em:* ${hours}h ${minutes}m ${seconds}s\n` +
                        `⌛ *Encerra em:* ${remainingHours}h\n` +
                        `📅 *Início:* ${startTime.toLocaleString('pt-BR')}`;

                    await sendSafeMessage(sock, groupId, { text: msg });
                } else {
                    await sendSafeMessage(sock, groupId, { text: 'ℹ️ Nenhum lembrete ativo no momento.' });
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
* 📢 /lembrete + mensagem 1h 24h - Lembrete automático
* 🛑 /stoplembrete - Para lembrete
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