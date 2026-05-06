import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { isAuthorized, checkAuth } from './authManager.js';
import { getNumberFromJid } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED_GROUPS_FILE = path.join(__dirname, '..', 'allowed_groups.json');
const ALLOWED_USERS_FILE = path.join(__dirname, '..', 'allowed_users.json');
const GROUP_PARTNERS_FILE = path.join(__dirname, '..', 'group_partners.json');

// Re-export for compatibility
export { isAuthorized, checkAuth };

function normalizeGroupName(name) {
    return String(name || '')
        .normalize('NFKC')
        .replace(/[\u200D\uFE0E\uFE0F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function buildDefaultPermissions() {
    return {
        openClose: true,
        spam: true,
        reminders: true,
        promo: true,
        moderation: true,
        engagement: true,
        leadsRead: true,
        welcome: true
    };
}

function isJidLike(value) {
    const safe = String(value || '').trim();
    return /^\d{6,}@(c\.us|g\.us|s\.whatsapp\.net|lid)$/i.test(safe);
}

function normalizePermissions(perms = {}) {
    const defaults = buildDefaultPermissions();
    return {
        openClose: typeof perms.openClose === 'boolean' ? perms.openClose : defaults.openClose,
        spam: typeof perms.spam === 'boolean' ? perms.spam : defaults.spam,
        reminders: typeof perms.reminders === 'boolean' ? perms.reminders : defaults.reminders,
        promo: typeof perms.promo === 'boolean' ? perms.promo : defaults.promo,
        moderation: typeof perms.moderation === 'boolean' ? perms.moderation : defaults.moderation,
        engagement: typeof perms.engagement === 'boolean' ? perms.engagement : defaults.engagement,
        leadsRead: typeof perms.leadsRead === 'boolean' ? perms.leadsRead : defaults.leadsRead,
        welcome: typeof perms.welcome === 'boolean' ? perms.welcome : defaults.welcome
    };
}

function normalizeGroupEntry(entry) {
    if (typeof entry === 'string') {
        const name = entry.trim();
        if (!name) return null;
        return { name, groupId: '', permissions: buildDefaultPermissions() };
    }

    if (entry && typeof entry === 'object') {
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (!name) return null;
        return {
            name,
            groupId: typeof entry.groupId === 'string' ? entry.groupId.trim() : '',
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

function normalizePartnerId(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    if (/@(c\.us|s\.whatsapp\.net|lid)$/i.test(raw)) {
        return raw;
    }

    const digits = getNumberFromJid(raw);
    if (!digits) return '';
    return `${digits}@c.us`;
}

function normalizePartnerIds(values) {
    const list = Array.isArray(values) ? values : [values];
    const unique = [];
    const seen = new Set();

    for (const value of list) {
        const normalized = normalizePartnerId(value);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        unique.push(normalized);
    }

    return unique;
}

async function readGroupPartners() {
    try {
        const raw = await fs.readFile(GROUP_PARTNERS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

async function writeGroupPartners(data) {
    await fs.writeFile(GROUP_PARTNERS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function matchPartnerId(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return getNumberFromJid(a) === getNumberFromJid(b);
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
        // Se for JID valido, salva como usuario permitido.
        if (isJidLike(param)) {
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
        const groupId = typeof options.groupId === 'string' ? options.groupId.trim() : '';
        current.push({ name, groupId, permissions });
        await writeAllowedGroups(current);

        return {
            success: true,
            message: `Grupo "${name}" adicionado com sucesso.\n\nPermissoes:\n- abertura/fechamento: ${permissions.openClose ? 'SIM' : 'NAO'}\n- anti-spam: ${permissions.spam ? 'SIM' : 'NAO'}\n- lembretes: ${permissions.reminders ? 'SIM' : 'NAO'}\n- promo: ${permissions.promo ? 'SIM' : 'NAO'}\n- moderacao: ${permissions.moderation ? 'SIM' : 'NAO'}\n- engajamento (ler grupo): ${permissions.engagement ? 'SIM' : 'NAO'}\n- leads (ler grupo): ${permissions.leadsRead ? 'SIM' : 'NAO'}\n- boas-vindas: ${permissions.welcome ? 'SIM' : 'NAO'}`
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
            `Grupo: ${g.name} | abrir/fechar=${g.permissions.openClose ? 'SIM' : 'NAO'} | spam=${g.permissions.spam ? 'SIM' : 'NAO'} | lembretes=${g.permissions.reminders ? 'SIM' : 'NAO'} | promo=${g.permissions.promo ? 'SIM' : 'NAO'} | moderacao=${g.permissions.moderation ? 'SIM' : 'NAO'} | engajamento=${g.permissions.engagement ? 'SIM' : 'NAO'} | leads=${g.permissions.leadsRead ? 'SIM' : 'NAO'} | boas-vindas=${g.permissions.welcome ? 'SIM' : 'NAO'}`
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
        if (isJidLike(param)) {
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

export async function getAllowedGroupPermissions(groupName, groupId = '') {
    const safeName = String(groupName || '').trim();
    const safeGroupId = String(groupId || '').trim();
    if (!safeName && !safeGroupId) return buildDefaultPermissions();

    const entries = await readAllowedGroupEntries();
    const normalizedSafeName = normalizeGroupName(safeName);
    const found = entries.find((entry) => {
        if (safeGroupId && String(entry.groupId || '').trim() === safeGroupId) {
            return true;
        }
        return normalizedSafeName && normalizeGroupName(entry.name) === normalizedSafeName;
    });
    if (!found) return buildDefaultPermissions();

    return normalizePermissions(found.permissions || {});
}

export async function bindAllowedGroupId(groupName, groupId) {
    const safeName = String(groupName || '').trim();
    const safeGroupId = String(groupId || '').trim();
    if (!safeName || !safeGroupId) return { updated: false, reason: 'missing-data' };

    const entries = await readAllowedGroupEntries();
    const normalizedSafeName = normalizeGroupName(safeName);
    let updated = false;

    for (const entry of entries) {
        if (normalizeGroupName(entry.name) !== normalizedSafeName) continue;
        if (String(entry.groupId || '').trim() === safeGroupId) {
            return { updated: false, reason: 'already-bound' };
        }
        entry.groupId = safeGroupId;
        updated = true;
        break;
    }

    if (!updated) {
        return { updated: false, reason: 'group-not-found' };
    }

    await writeAllowedGroups(entries);
    return { updated: true };
}

export async function addGroupPartner(currentUserId, groupId, partnerId) {
    const safeGroupId = String(groupId || '').trim();
    const safePartnerIds = normalizePartnerIds(partnerId);

    if (!safeGroupId.endsWith('@g.us')) {
        return { success: false, message: 'Grupo invalido. Informe um ID de grupo valido.' };
    }

    if (!safePartnerIds.length) {
        return { success: false, message: 'Usuario invalido. Informe @usuario ou numero/ID valido.' };
    }

    try {
        const data = await readGroupPartners();
        const current = Array.isArray(data[safeGroupId]) ? data[safeGroupId] : [];
        if (safePartnerIds.some((candidate) => current.some((item) => matchPartnerId(item, candidate)))) {
            return { success: false, message: `⚠️ ${safePartnerIds[0]} ja esta na lista de parceiros deste grupo.` };
        }

        current.push(...safePartnerIds);
        current.sort((a, b) => a.localeCompare(b, 'pt-BR'));
        data[safeGroupId] = current;
        await writeGroupPartners(data);
        return { success: true, message: `✅ Parceiro adicionado: ${safePartnerIds[0]}` };
    } catch (error) {
        console.error('Erro ao adicionar parceiro:', error);
        return { success: false, message: '❌ Falha ao salvar parceiro. Veja os logs.' };
    }
}

export async function removeGroupPartner(currentUserId, groupId, partnerId) {
    const safeGroupId = String(groupId || '').trim();
    const safePartnerIds = normalizePartnerIds(partnerId);

    if (!safeGroupId.endsWith('@g.us')) {
        return { success: false, message: 'Grupo invalido. Informe um ID de grupo valido.' };
    }

    if (!safePartnerIds.length) {
        return { success: false, message: 'Usuario invalido. Informe @usuario ou numero/ID valido.' };
    }

    try {
        const data = await readGroupPartners();
        const current = Array.isArray(data[safeGroupId]) ? data[safeGroupId] : [];
        const filtered = current.filter((item) => !safePartnerIds.some((candidate) => matchPartnerId(item, candidate)));

        if (filtered.length === current.length) {
            return { success: false, message: `⚠️ ${safePartnerIds[0]} nao esta na lista de parceiros deste grupo.` };
        }

        if (filtered.length) {
            data[safeGroupId] = filtered;
        } else {
            delete data[safeGroupId];
        }

        await writeGroupPartners(data);
        return { success: true, message: `✅ Parceiro removido: ${safePartnerIds[0]}` };
    } catch (error) {
        console.error('Erro ao remover parceiro:', error);
        return { success: false, message: '❌ Falha ao salvar alteracao. Veja os logs.' };
    }
}

export async function listGroupPartners(groupId) {
    const safeGroupId = String(groupId || '').trim();
    if (!safeGroupId.endsWith('@g.us')) return [];

    const data = await readGroupPartners();
    const current = Array.isArray(data[safeGroupId]) ? data[safeGroupId] : [];
    return current.slice();
}

export async function isGroupPartner(groupId, userId) {
    const safeGroupId = String(groupId || '').trim();
    if (!safeGroupId.endsWith('@g.us') || !userId) return false;

    const data = await readGroupPartners();
    const current = Array.isArray(data[safeGroupId]) ? data[safeGroupId] : [];
    return current.some((item) => matchPartnerId(item, userId));
}

