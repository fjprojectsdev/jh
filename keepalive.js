// keepalive.js - Mantém o bot vivo e monitora a saúde da conexão
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let lastHeartbeat = Date.now();
let isConnected = false;

// Atualizar heartbeat
export function updateHeartbeat() {
    lastHeartbeat = Date.now();
    const statusFile = path.join(__dirname, '.bot_status');
    fs.writeFileSync(statusFile, JSON.stringify({
        lastHeartbeat,
        isConnected,
        timestamp: new Date().toISOString()
    }));
}

// Marcar como conectado
export function setConnected(status) {
    isConnected = status;
    updateHeartbeat();
}

// Verificar se o bot está vivo
export function checkHealth() {
    const now = Date.now();
    const timeSinceLastHeartbeat = now - lastHeartbeat;
    const maxIdleTime = 5 * 60 * 1000; // 5 minutos

    if (timeSinceLastHeartbeat > maxIdleTime) {
        console.log('⚠️ Bot parece estar travado. Último heartbeat:', new Date(lastHeartbeat).toISOString());
        return false;
    }

    return true;
}

// Iniciar monitoramento
export function startHealthMonitor() {
    // Atualizar heartbeat a cada 30 segundos
    setInterval(() => {
        updateHeartbeat();
    }, 30000);

    // Verificar saúde a cada minuto
    setInterval(() => {
        const healthy = checkHealth();
        if (!healthy) {
            console.log('❌ Bot não está respondendo. Considere reiniciar.');
        }
    }, 60000);

    console.log('💓 Monitor de saúde iniciado');
}

// Salvar estado da sessão periodicamente
export function startSessionBackup() {
    setInterval(() => {
        try {
            const authPath = path.join(__dirname, 'auth_info');
            const backupPath = path.join(__dirname, 'auth_backup');

            if (fs.existsSync(authPath)) {
                // Criar backup da sessão
                if (fs.existsSync(backupPath)) {
                    fs.rmSync(backupPath, { recursive: true, force: true });
                }

                // Copiar recursivamente
                fs.cpSync(authPath, backupPath, { recursive: true });
                console.log('💾 Backup da sessão criado:', new Date().toISOString());
            }
        } catch (e) {
            console.error('Erro ao fazer backup da sessão:', e.message);
        }
    }, 30 * 60 * 1000); // A cada 30 minutos

    console.log('💾 Backup automático de sessão iniciado');
}

// Restaurar sessão do backup se necessário
export function restoreSessionFromBackup() {
    try {
        const authPath = path.join(__dirname, 'auth_info');
        const backupPath = path.join(__dirname, 'auth_backup');

        if (!fs.existsSync(authPath) && fs.existsSync(backupPath)) {
            console.log('🔄 Restaurando sessão do backup...');
            fs.cpSync(backupPath, authPath, { recursive: true });
            console.log('✅ Sessão restaurada do backup');
            return true;
        }
    } catch (e) {
        console.error('Erro ao restaurar sessão:', e.message);
    }
    return false;
}

// Limpar backup da sessão (usado ao desconectar manualmente)
export function clearSessionBackup() {
    try {
        const backupPath = path.join(__dirname, 'auth_backup');
        if (fs.existsSync(backupPath)) {
            fs.rmSync(backupPath, { recursive: true, force: true });
            console.log('🗑️ Backup da sessão removido preventivamente');
        }
    } catch (e) {
        console.error('Erro ao limpar backup da sessão:', e.message);
    }
}
