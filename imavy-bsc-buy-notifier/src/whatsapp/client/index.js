const { EventEmitter } = require('events');
const fs = require('fs');
const pino = require('pino');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

class WhatsAppGroupClient extends EventEmitter {
    constructor({ sessionDir, groupName, logger }) {
        super();
        this.sessionDir = sessionDir;
        this.groupName = groupName;
        this.logger = logger;

        this.sock = null;
        this.saveCreds = null;
        this.ready = false;
        this.reconnectTimer = null;
        this.reconnectBackoffMs = [2_000, 5_000, 10_000, 20_000, 30_000, 45_000, 60_000];
        this.reconnectIndex = 0;
        this.targetGroupJid = null;
    }

    async start() {
        fs.mkdirSync(this.sessionDir, { recursive: true });
        await this.connect();
    }

    async stop() {
        this.ready = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.sock) {
            try {
                this.sock.end(new Error('shutdown'));
            } catch (_) {
                // noop
            }
        }
    }

    async connect() {
        const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
        this.saveCreds = saveCreds;

        const { version } = await fetchLatestBaileysVersion();
        this.sock = makeWASocket({
            auth: state,
            version,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' })
        });

        this.sock.ev.on('creds.update', async () => {
            try {
                await this.saveCreds();
            } catch (error) {
                if (this.logger) {
                    this.logger.error('Falha ao persistir credenciais do WhatsApp.', { error: error.message });
                }
            }
        });

        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update || {};

            if (update && update.qr && this.logger) {
                this.logger.info('QR Code gerado para autenticar WhatsApp Web.');
            }

            if (connection === 'open') {
                this.ready = true;
                this.reconnectIndex = 0;
                this.targetGroupJid = await this.findGroupJidByName(this.groupName);
                this.emit('ready', { targetGroupJid: this.targetGroupJid });
                if (this.logger) {
                    this.logger.info('WhatsApp conectado.', {
                        targetGroup: this.groupName,
                        targetJid: this.targetGroupJid
                    });
                }
                return;
            }

            if (connection === 'close') {
                this.ready = false;
                const statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
                    ? lastDisconnect.error.output.statusCode
                    : null;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                if (this.logger) {
                    this.logger.warn('WhatsApp desconectado.', { statusCode, shouldReconnect });
                }

                if (shouldReconnect) {
                    this.scheduleReconnect();
                } else {
                    this.emit('fatal', new Error('Sessao WhatsApp desconectada (logged out). Requer novo QR.'));
                }
            }
        });
    }

    scheduleReconnect() {
        if (this.reconnectTimer) {
            return;
        }

        const idx = Math.min(this.reconnectIndex, this.reconnectBackoffMs.length - 1);
        const delayMs = this.reconnectBackoffMs[idx];
        this.reconnectIndex += 1;

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.connect();
            } catch (error) {
                if (this.logger) {
                    this.logger.error('Falha ao reconectar WhatsApp.', { error: error.message });
                }
                this.scheduleReconnect();
            }
        }, delayMs);

        if (typeof this.reconnectTimer.unref === 'function') {
            this.reconnectTimer.unref();
        }
    }

    async findGroupJidByName(groupName) {
        if (!this.sock) {
            throw new Error('Socket WhatsApp nao inicializado.');
        }

        const target = normalize(groupName);
        const groups = await this.sock.groupFetchAllParticipating();
        const entries = Object.values(groups || {});

        for (const group of entries) {
            const subject = normalize(group && group.subject);
            if (subject === target) {
                const jid = String(group.id || '');
                if (!jid.endsWith('@g.us')) {
                    continue;
                }
                return jid;
            }
        }

        throw new Error(`Grupo "${groupName}" nao encontrado no WhatsApp.`);
    }

    async waitUntilReady(timeoutMs = 120_000) {
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
            if (this.ready && this.targetGroupJid) {
                return;
            }
            await sleep(1_000);
        }

        throw new Error('Timeout aguardando conexao do WhatsApp e resolucao do grupo alvo.');
    }

    async sendMessageWithRetry(content) {
        if (!this.ready || !this.sock) {
            throw new Error('WhatsApp ainda nao esta pronto para envio.');
        }

        if (!this.targetGroupJid || !this.targetGroupJid.endsWith('@g.us')) {
            throw new Error('Grupo alvo invalido para envio. Mensagens privadas sao bloqueadas.');
        }

        const maxAttempts = 3;
        let lastError = null;
        const payload = content && typeof content === 'object'
            ? content
            : { text: String(content || '') };

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                await this.sock.sendMessage(this.targetGroupJid, payload);
                return;
            } catch (error) {
                lastError = error;
                if (attempt >= maxAttempts) {
                    break;
                }
                const waitMs = 1_000 * Math.pow(2, attempt - 1);
                if (this.logger) {
                    this.logger.warn('Falha no envio WhatsApp. Retry em andamento.', {
                        attempt,
                        waitMs,
                        error: error.message
                    });
                }
                await sleep(waitMs);
            }
        }

        throw lastError || new Error('Falha desconhecida ao enviar mensagem WhatsApp.');
    }
}

module.exports = {
    WhatsAppGroupClient
};
