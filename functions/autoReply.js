import { sendSafeMessage } from './messageHandler.js';

function sanitizeIncomingText(value) {
    if (typeof value !== 'string') return '';
    return value
        .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
        .replace(/\r/g, '')
        .trim();
}

export function initAutoReply(sock) {
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        if (!msg.key.remoteJid || msg.key.remoteJid === 'status@broadcast') return;
        if (msg.key.remoteJid.endsWith('@broadcast')) return;
        if (msg.messageStubType !== undefined && msg.messageStubType !== null) return;

        const sender = msg.key.remoteJid;
        const messageContent = sanitizeIncomingText(
            msg.message.conversation || msg.message.extendedTextMessage?.text || ''
        );
        if (!messageContent) return;

        let reply = '';
        if (messageContent.toLowerCase().includes('oi')) {
            reply = 'Olá! Bem-vindo ao iMavyBot 🤖';
        } else if (messageContent.toLowerCase().includes('tudo bem')) {
            reply = 'Tudo ótimo por aqui! E você?';
        } else {
            reply = 'Mensagem recebida! Aguarde que iMavyBot responderá em breve...';
        }

        await sendSafeMessage(sock, sender, { text: reply });
    });
}
