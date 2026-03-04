// Sistema de Autorização e Permissões
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getNumberFromJid } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMINS_FILE = path.join(__dirname, '..', 'admins.json');

// Carregar admins do arquivo JSON
async function loadAdmins() {
    try {
        const raw = await fs.readFile(ADMINS_FILE, 'utf8');
        const data = JSON.parse(raw);
        return data.admins || [];
    } catch (error) {
        // Se arquivo não existe, criar com array vazio
        if (error.code === 'ENOENT') {
            await saveAdmins([]);
            return [];
        }
        console.error('❌ Erro ao carregar admins:', error);
        return [];
    }
}

// Salvar admins no arquivo JSON
async function saveAdmins(admins) {
    try {
        const data = { admins, lastUpdate: new Date().toISOString() };
        await fs.writeFile(ADMINS_FILE, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('❌ Erro ao salvar admins:', error);
        return false;
    }
}

// Carregar admins do .env (variável de ambiente)
function loadEnvAdmins() {
    const envAdmins = (process.env.AUTHORIZED_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
    return envAdmins;
}

// Verificar se usuário é autorizado
export async function isAuthorized(senderId) {
    if (!senderId) return false;

    const senderNumber = getNumberFromJid(senderId);

    // 1. Verificar variaveis de ambiente (prioridade alta)
    const envAdmins = loadEnvAdmins();
    for (const adminId of envAdmins) {
        if (senderId === adminId || senderNumber === getNumberFromJid(adminId)) {
            return true;
        }
    }

    // 2. Verificar arquivo JSON de admins
    const fileAdmins = await loadAdmins();
    for (const adminId of fileAdmins) {
        if (senderId === adminId || senderNumber === getNumberFromJid(adminId)) {
            return true;
        }
    }

    return false;
}

// Verificar se usuário é admin do grupo WhatsApp
export async function isGroupAdmin(sock, groupId, userId) {
    try {
        const groupMetadata = await sock.groupMetadata(groupId);
        const participant = groupMetadata.participants.find(p =>
            p.id === userId || p.jid === userId || getNumberFromJid(p.id) === getNumberFromJid(userId)
        );
        return participant && (
            participant.admin === true
            || participant.admin === 'admin'
            || participant.admin === 'superadmin'
        );
    } catch (error) {
        console.error('❌ Erro ao verificar admin do grupo:', error);
        return false;
    }
}

// Verificar autorização com múltiplas opções
export async function checkAuth(sock, senderId, groupId = null, options = {}) {
    const {
        allowGroupAdmins = false,  // Permitir admins do grupo WhatsApp
        requireAuth = true          // Requer autorização do bot
    } = options;

    // Se não requer autorização, permitir
    if (!requireAuth) return true;

    // Verificar se é autorizado pelo bot
    const isBotAdmin = await isAuthorized(senderId);
    if (isBotAdmin) return true;

    // Se permitir admins do grupo e estiver em grupo
    if (allowGroupAdmins && groupId) {
        const isAdm = await isGroupAdmin(sock, groupId, senderId);
        if (isAdm) return true;
    }

    return false;
}

// Adicionar admin (apenas admins existentes podem adicionar)
export async function addAdmin(currentAdminId, newAdminId) {
    // Verificar se quem está adicionando é autorizado
    const isCurrentAuth = await isAuthorized(currentAdminId);
    if (!isCurrentAuth) {
        return { success: false, message: '❌ Você não tem permissão para adicionar administradores.' };
    }

    // Verificar se já é admin
    const admins = await loadAdmins();
    const newAdminNum = getNumberFromJid(newAdminId);

    for (const admin of admins) {
        if (admin === newAdminId || getNumberFromJid(admin) === newAdminNum) {
            return { success: false, message: '⚠️ Este usuário já é administrador do bot.' };
        }
    }

    // Adicionar novo admin
    admins.push(newAdminId);
    const saved = await saveAdmins(admins);

    if (saved) {
        return { success: true, message: `✅ Administrador adicionado com sucesso: ${newAdminId}` };
    } else {
        return { success: false, message: '❌ Erro ao salvar administrador. Veja os logs.' };
    }
}

// Remover admin (apenas admins existentes podem remover)
export async function removeAdmin(currentAdminId, adminToRemove) {
    // Verificar se quem está removendo é autorizado
    const isCurrentAuth = await isAuthorized(currentAdminId);
    if (!isCurrentAuth) {
        return { success: false, message: '❌ Você não tem permissão para remover administradores.' };
    }

    // Não permitir remover a si mesmo
    if (currentAdminId === adminToRemove || getNumberFromJid(currentAdminId) === getNumberFromJid(adminToRemove)) {
        return { success: false, message: '⚠️ Você não pode remover a si mesmo.' };
    }

    // Remover admin
    const admins = await loadAdmins();
    const adminToRemoveNum = getNumberFromJid(adminToRemove);

    const filteredAdmins = admins.filter(admin => {
        const adminNum = getNumberFromJid(admin);
        return admin !== adminToRemove && adminNum !== adminToRemoveNum;
    });

    if (filteredAdmins.length === admins.length) {
        return { success: false, message: '⚠️ Administrador não encontrado na lista.' };
    }

    const saved = await saveAdmins(filteredAdmins);

    if (saved) {
        return { success: true, message: `✅ Administrador removido com sucesso: ${adminToRemove}` };
    } else {
        return { success: false, message: '❌ Erro ao salvar alteração. Veja os logs.' };
    }
}

// Listar todos os admins
export async function listAdmins() {
    const envAdmins = loadEnvAdmins();
    const fileAdmins = await loadAdmins();

    const allAdmins = [
        ...envAdmins.map(id => ({ id, source: 'ENV (.env)' })),
        ...fileAdmins.map(id => ({ id, source: 'JSON (admins.json)' }))
    ];

    return allAdmins;
}

// Obter estatísticas de admins
export async function getAdminStats() {
    const envAdmins = loadEnvAdmins();
    const fileAdmins = await loadAdmins();

    return {
        total: envAdmins.length + fileAdmins.length,
        fromEnv: envAdmins.length,
        fromFile: fileAdmins.length,
        envAdmins,
        fileAdmins
    };
}

// Obter lista de admins (para notificações)
export async function getAdmins() {
    const envAdmins = loadEnvAdmins();
    const fileAdmins = await loadAdmins();
    return [...envAdmins, ...fileAdmins].map(id => ({ user_id: id }));
}

