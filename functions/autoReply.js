import { sendSafeMessage } from './messageHandler.js';

export function initAutoReply(sock) {
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const messageContent = msg.message.conversation || '';

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
