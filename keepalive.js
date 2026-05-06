import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { refreshAuthBackup, sanitizeAuthStateDir } from './functions/waSessionHygiene.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let lastHeartbeat = Date.now();
let isConnected = false;
let healthHeartbeatTimer = null;
let healthCheckTimer = null;
let sessionBackupTimer = null;
let healthEscalationFn = null;

export function updateHeartbeat() {
    lastHeartbeat = Date.now();
    const statusFile = path.join(__dirname, '.bot_status');
    fs.writeFileSync(statusFile, JSON.stringify({
        lastHeartbeat,
        isConnected,
        timestamp: new Date().toISOString()
    }));
}

export function setConnected(status) {
    isConnected = status;
    updateHeartbeat();
}

export function setHealthEscalationHandler(handler) {
    healthEscalationFn = typeof handler === 'function' ? handler : null;
}

export function checkHealth() {
    const now = Date.now();
    const timeSinceLastHeartbeat = now - lastHeartbeat;
    const maxIdleTime = 5 * 60 * 1000;

    if (timeSinceLastHeartbeat > maxIdleTime) {
        console.log('Bot parece estar travado. Ultimo heartbeat:', new Date(lastHeartbeat).toISOString());
        return false;
    }

    return true;
}

export function startHealthMonitor() {
    if (healthHeartbeatTimer || healthCheckTimer) {
        return;
    }

    healthHeartbeatTimer = setInterval(() => {
        updateHeartbeat();
    }, 30000);

    healthCheckTimer = setInterval(() => {
        const healthy = checkHealth();
        if (!healthy) {
            console.log('Bot nao esta respondendo. Considere reiniciar.');
            if (healthEscalationFn) {
                try {
                    healthEscalationFn({ reason: 'heartbeat_stalled', lastHeartbeat });
                } catch (error) {
                    console.error('Erro ao escalar problema de saude:', error.message);
                }
            }
        }
    }, 60000);

    console.log('Monitor de saude iniciado');
}

export function startSessionBackup() {
    if (sessionBackupTimer) {
        return;
    }

    sessionBackupTimer = setInterval(() => {
        try {
            const authPath = path.join(__dirname, 'auth_info');
            const backupPath = path.join(__dirname, 'auth_backup');

            if (fs.existsSync(authPath)) {
                const backupResult = refreshAuthBackup(authPath, backupPath);
                console.log('Backup da sessao criado:', {
                    at: new Date().toISOString(),
                    removedFiles: backupResult.removedFiles,
                    remainingFiles: backupResult.remainingFiles
                });
            }
        } catch (error) {
            console.error('Erro ao fazer backup da sessao:', error.message);
        }
    }, 30 * 60 * 1000);

    console.log('Backup automatico de sessao iniciado');
}

export function restoreSessionFromBackup() {
    try {
        const authPath = path.join(__dirname, 'auth_info');
        const backupPath = path.join(__dirname, 'auth_backup');

        if (!fs.existsSync(authPath) && fs.existsSync(backupPath)) {
            console.log('Restaurando sessao do backup...');
            fs.cpSync(backupPath, authPath, { recursive: true });
            const hygiene = sanitizeAuthStateDir(authPath);
            console.log('Sessao restaurada do backup');
            console.log('Sessao restaurada higienizada:', hygiene);
            return true;
        }
    } catch (error) {
        console.error('Erro ao restaurar sessao:', error.message);
    }
    return false;
}

export function clearSessionBackup() {
    try {
        const backupPath = path.join(__dirname, 'auth_backup');
        if (fs.existsSync(backupPath)) {
            fs.rmSync(backupPath, { recursive: true, force: true });
            console.log('Backup da sessao removido preventivamente');
        }
    } catch (error) {
        console.error('Erro ao limpar backup da sessao:', error.message);
    }
}
