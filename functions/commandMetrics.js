import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const METRICS_FILE = path.join(__dirname, '..', 'comandos_aceitos.json');
const MAX_EVENTS = 12000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function readMetricsFile() {
    try {
        if (!fs.existsSync(METRICS_FILE)) {
            return { eventos: [] };
        }

        const raw = fs.readFileSync(METRICS_FILE, 'utf8');
        const parsed = raw ? JSON.parse(raw) : {};
        const eventos = Array.isArray(parsed.eventos) ? parsed.eventos : [];
        return { eventos };
    } catch (_) {
        return { eventos: [] };
    }
}

function writeMetricsFile(payload) {
    try {
        fs.writeFileSync(METRICS_FILE, JSON.stringify(payload, null, 2));
    } catch (_) {}
}

function sanitizeCommandToken(command) {
    return String(command || '').trim().toLowerCase();
}

export function registrarComandoAceito({ messageId, command, groupId, senderId, timestamp }) {
    const token = sanitizeCommandToken(command);
    if (!token.startsWith('/')) {
        return { ok: false, skipped: true, reason: 'invalid_command' };
    }

    const nowMs = Number.isFinite(timestamp) ? timestamp : Date.now();
    const boundary = nowMs - RETENTION_MS;
    const payload = readMetricsFile();

    let eventos = payload.eventos.filter((item) => {
        const ts = Number(item && item.timestamp || 0);
        return Number.isFinite(ts) && ts >= boundary;
    });

    const msgId = String(messageId || '').trim();
    if (msgId && eventos.some((item) => String(item && item.messageId || '') === msgId)) {
        return { ok: true, skipped: true, reason: 'duplicate_message' };
    }

    eventos.push({
        messageId: msgId || null,
        command: token,
        groupId: String(groupId || ''),
        senderId: String(senderId || ''),
        timestamp: nowMs
    });

    if (eventos.length > MAX_EVENTS) {
        eventos = eventos.slice(eventos.length - MAX_EVENTS);
    }

    writeMetricsFile({ eventos });
    return { ok: true };
}
