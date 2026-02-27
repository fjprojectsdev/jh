import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { isAuthorized, checkAuth } from './authManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED_GROUPS_FILE = path.join(__dirname, '..', 'allowed_groups.json');
const ALLOWED_USERS_FILE = path.join(__dirname, '..', 'allowed_users.json');

// Re-export for compatibility
export { isAuthorized, checkAuth };

function buildDefaultPermissions() {
    return {
        openClose: true,
        spam: true,
        reminders: true,
        promo: true,
        moderation: true
    };
}

function normalizePermissions(perms = {}) {
    const defaults = buildDefaultPermissions();
    return {
        openClose: typeof perms.openClose === 'boolean' ? perms.openClose : defaults.openClose,
        spam: typeof perms.spam === 'boolean' ? perms.spam : defaults.spam,
        reminders: typeof perms.reminders === 'boolean' ? perms.reminders : defaults.reminders,
        promo: typeof perms.promo === 'boolean' ? perms.promo : defaults.promo,
        moderation: typeof perms.moderation === 'boolean' ? perms.moderation : defaults.moderation
    };
}

function normalizeGroupEntry(entry) {
    if (typeof entry === 'string') {
        const name = entry.trim();
        if (!name) return null;
        return { name, permissions: buildDefaultPermissions() };
    }

    if (entry && typeof entry === 'object') {
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (!name) return null;
        return {
            name,
            permissions: normalizePermissions(entry.permissions || {})
        };
    }

    return null;
}

async function readAllowedGroupsRaw() {
    try {
        const raw = await fs.readFile(ALLOWED_GROUPS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
        return [];
    } catch (e) {
        return [];
    }
}

async function readAllowedGroupEntries() {
    const raw = await readAllowedGroupsRaw();
    return raw.map((entry) => normalizeGroupEntry(entry)).filter(Boolean);
}

async function writeAllowedGroups(list) {
    const data = JSON.stringify(list, null, 2);
    await fs.writeFile(ALLOWED_GROUPS_FILE, data, 'utf8');
}

async function readAllowedUsers() {
    try {
        const raw = await fs.readFile(ALLOWED_USERS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
        return [];
    } catch (e) {
        return [];
    }
}

async function writeAllowedUsers(list) {
    const data = JSON.stringify(list, null, 2);
    await fs.writeFile(ALLOWED_USERS_FILE, data, 'utf8');
}

export async function addAllowedGroup(senderId, groupName, options = {}) {
    if (!(await isAuthorized(senderId))) {
        return { success: false, message: 'Acesso negado. Voce nao tem permissao para usar este comando.' };
    }

    if (!groupName || typeof groupName !== 'string' || !groupName.trim()) {
        return { success: false, message: 'Parametro invalido. Use /adicionargrupo Nome do Grupo ou /adicionargrupo 5511999999999@c.us' };
    }

    const param = groupName.trim();

    try {
        // If looks like JID, save as allowed user
        if (param.includes('@')) {
            const currentUsers = await readAllowedUsers();
            if (currentUsers.includes(param)) {
                return { success: false, message: `O usuario "${param}" ja esta habilitado para o bot.` };
            }
            currentUsers.push(param);
            await writeAllowedUsers(currentUsers);
            return { success: true, message: `Usuario "${param}" adicionado com sucesso a lista de permitidos.` };
        }

        const name = param;
        const current = await readAllowedGroupEntries();
        if (current.some((entry) => entry.name === name)) {
            return { success: false, message: `O grupo "${name}" ja esta habilitado para o bot.` };
        }

        const permissions = normalizePermissions(options.permissions || {});
        current.push({ name, permissions });
        await writeAllowedGroups(current);

        return {
            success: true,
            message: `Grupo "${name}" adicionado com sucesso.\n\nPermissoes:\n- abertura/fechamento: ${permissions.openClose ? 'SIM' : 'NAO'}\n- anti-spam: ${permissions.spam ? 'SIM' : 'NAO'}\n- lembretes: ${permissions.reminders ? 'SIM' : 'NAO'}\n- promo: ${permissions.promo ? 'SIM' : 'NAO'}\n- moderacao: ${permissions.moderation ? 'SIM' : 'NAO'}`
        };
    } catch (e) {
        console.error('Erro ao adicionar permitido:', e);
        return { success: false, message: 'Falha ao salvar a alteracao. Veja os logs do bot.' };
    }
}

export async function listAllowedGroups() {
    const groups = await readAllowedGroupEntries();
    const users = await readAllowedUsers();

    const combined = [];
    for (const g of groups) {
        combined.push(
            `Grupo: ${g.name} | abrir/fechar=${g.permissions.openClose ? 'SIM' : 'NAO'} | spam=${g.permissions.spam ? 'SIM' : 'NAO'} | lembretes=${g.permissions.reminders ? 'SIM' : 'NAO'} | promo=${g.permissions.promo ? 'SIM' : 'NAO'} | moderacao=${g.permissions.moderation ? 'SIM' : 'NAO'}`
        );
    }
    for (const u of users) combined.push(`Usuario: ${u}`);
    return combined;
}

export async function removeAllowedGroup(senderId, groupName) {
    if (!(await isAuthorized(senderId))) {
        return { success: false, message: 'Acesso negado. Voce nao tem permissao para usar este comando.' };
    }

    if (!groupName || typeof groupName !== 'string' || !groupName.trim()) {
        return { success: false, message: 'Parametro invalido. Use /removergrupo Nome do Grupo ou /removergrupo 5511999999999@c.us' };
    }

    const param = groupName.trim();

    try {
        if (param.includes('@')) {
            const currentUsers = await readAllowedUsers();
            const index = currentUsers.indexOf(param);
            if (index === -1) {
                return { success: false, message: `O usuario "${param}" nao esta na lista de permitidos.` };
            }
            currentUsers.splice(index, 1);
            await writeAllowedUsers(currentUsers);
            return { success: true, message: `Usuario "${param}" removido com sucesso da lista de permitidos.` };
        }

        const current = await readAllowedGroupEntries();
        const index = current.findIndex((entry) => entry.name === param);
        if (index === -1) {
            return { success: false, message: `O grupo "${param}" nao esta na lista de permitidos.` };
        }

        current.splice(index, 1);
        await writeAllowedGroups(current);
        return { success: true, message: `Grupo "${param}" removido com sucesso da lista de grupos permitidos.` };
    } catch (e) {
        console.error('Erro ao remover permitido:', e);
        return { success: false, message: 'Falha ao salvar alteracao. Veja os logs do bot.' };
    }
}

export async function getAllowedGroupPermissions(groupName) {
    const safeName = String(groupName || '').trim();
    if (!safeName) return buildDefaultPermissions();

    const entries = await readAllowedGroupEntries();
    const found = entries.find((entry) => entry.name === safeName);
    if (!found) return buildDefaultPermissions();

    return normalizePermissions(found.permissions || {});
}
