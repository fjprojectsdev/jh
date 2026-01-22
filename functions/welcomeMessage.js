import { sendSafeMessage } from './messageHandler.js';

// Mapa para armazenar buffers de usuários por grupo
// Chave: groupId, Valor: { timer: Timeout, participants: Set<string> }
const welcomeBuffer = new Map();
const DEBOUNCE_TIME = 10000; // 10 segundos para acumular

// Cache para evitar repetições (Deduplicação)
// Chave: groupId:userId, Valor: timestamp
const recentlyWelcomed = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutos

export async function handleWelcomeEvent(sock, groupId, newParticipants) {
    if (!welcomeBuffer.has(groupId)) {
        welcomeBuffer.set(groupId, {
            timer: null,
            participants: new Set()
        });
    }

    const buffer = welcomeBuffer.get(groupId);

    // Adiciona novos participantes ao buffer se não forem recentes
    const candidates = Array.isArray(newParticipants) ? newParticipants : [newParticipants];

    for (const p of candidates) {
        const jid = (typeof p === 'object' && p.id) ? p.id : p;
        if (!jid) continue;

        const cacheKey = `${groupId}:${jid}`;
        const lastWelcome = recentlyWelcomed.get(cacheKey);

        // Se já foi saudado recentemente (< 30min), ignora
        if (lastWelcome && (Date.now() - lastWelcome < CACHE_TTL)) {
            console.log(`♻️ Ignorando boas-vindas repetida para ${jid} (Cache Hit)`);
            continue;
        }

        buffer.participants.add(jid);
        recentlyWelcomed.set(cacheKey, Date.now()); // Marca como "pendente de envio" ou "enviado"
    }

    // Limpeza periódica do cache (lazy)
    if (recentlyWelcomed.size > 1000) {
        const now = Date.now();
        for (const [key, time] of recentlyWelcomed.entries()) {
            if (now - time > CACHE_TTL) recentlyWelcomed.delete(key);
        }
    }

    // Se não sobrou ninguém novo, não faz nada
    if (buffer.participants.size === 0) return;

    // Reinicia o timer (Debounce)
    if (buffer.timer) {
        clearTimeout(buffer.timer);
    }

    buffer.timer = setTimeout(async () => {
        await processWelcomeBuffer(sock, groupId);
    }, DEBOUNCE_TIME);

    console.log(`⏳ Boas-vindas agendadas para ${groupId}. Buffer atual: ${buffer.participants.size}`);
}

async function processWelcomeBuffer(sock, groupId) {
    const buffer = welcomeBuffer.get(groupId);
    if (!buffer || buffer.participants.size === 0) return;

    const participants = Array.from(buffer.participants);
    welcomeBuffer.delete(groupId); // Limpa o buffer imediatamente para evitar concorrência

    console.log(`🚀 Processando boas-vindas para ${groupId}. Total: ${participants.length}`);

    try {
        if (participants.length <= 2) {
            // MODO INDIVIDUAL (1 ou 2 pessoas)
            for (const memberJid of participants) {
                await sendSingleWelcome(sock, groupId, memberJid);
                // Pequeno delay entre mensagens para parecer natural
                await new Promise(r => setTimeout(r, 1000));
            }
        } else {
            // MODO BATCH (> 2 pessoas)
            await sendBatchWelcome(sock, groupId, participants);
        }
    } catch (e) {
        console.error(`❌ Erro ao processar buffer de boas-vindas:`, e);
    }
}

async function sendSingleWelcome(sock, groupId, memberJid) {
    const userNumber = memberJid.split('@')[0];
    const welcomeText = `Bem-vindo(a) ao grupo, @${userNumber}.

Antes de interagir, recomendamos a leitura das regras:
/regras

Este espaço é voltado para troca construtiva e convivência respeitosa.
Contamos com sua colaboração.

Mensagem automática — iMavyAgent`;

    await sendSafeMessage(sock, groupId, {
        text: welcomeText,
        mentions: [memberJid]
    });
}

async function sendBatchWelcome(sock, groupId, participants) {
    // Formatar menções: @1234, @5678, etc.
    const mentions = participants;
    const mentionsText = participants.map(jid => `@${jid.split('@')[0]}`).join(', ');

    const welcomeText = `Sejam todos bem-vindos! 👋

${mentionsText}

Recomendamos a leitura das regras do grupo antes de interagir:
/regras

Contamos com a colaboração de todos para manter uma boa convivência.

Mensagem automática — iMavyAgent`;

    await sendSafeMessage(sock, groupId, {
        text: welcomeText,
        mentions: mentions
    });
}
