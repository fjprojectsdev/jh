const { verificarToken, verificarAdminDashboard } = require('../auth/authMiddleware.js');
const { findClienteByEmail, findClienteById, listClientes } = require('../models/cliente.js');
const { sanitizeText, sanitizeEmail } = require('../services/supabaseTenantClient.js');
const {
    getDashboardAccessPolicy,
    listDashboardAccessPolicies,
    resolveDashboardAccessForCliente,
    upsertDashboardAccessPolicy,
    clearDashboardAccessPolicy,
    normalizeGroupName,
    isDashboardDeveloperAdminEmail
} = require('../services/dashboardAccessControlService.js');
const { notifyBotSync } = require('../services/botSyncService.js');

function isPath(pathname, candidates) {
    return candidates.includes(pathname);
}

async function resolveCliente(bodyOrParams) {
    const clienteId = sanitizeText(bodyOrParams && bodyOrParams.clienteId, 120);
    const email = sanitizeEmail(bodyOrParams && bodyOrParams.email);

    if (clienteId) {
        return findClienteById(clienteId, false);
    }

    if (email) {
        return findClienteByEmail(email, false);
    }

    return null;
}

function parseOptionalBoolean(value) {
    if (value === true || value === false) {
        return value;
    }

    if (typeof value === 'string') {
        const safe = value.trim().toLowerCase();
        if (safe === 'true') {
            return true;
        }
        if (safe === 'false') {
            return false;
        }
    }

    return undefined;
}

function parsePolicyPayload(body, gruposDisponiveis) {
    const allowMultipleGroups = parseOptionalBoolean(body && body.allowMultipleGroups);
    const maxGroupsRaw = body && body.maxGroups;
    const primaryGroupId = sanitizeText(body && body.primaryGroupId, 160);

    let maxGroups = undefined;
    if (maxGroupsRaw !== undefined && maxGroupsRaw !== null && String(maxGroupsRaw).trim() !== '') {
        const parsed = Math.floor(Number(maxGroupsRaw));
        if (!Number.isFinite(parsed) || parsed <= 0) {
            const error = new Error('maxGroups deve ser numero inteiro positivo.');
            error.statusCode = 400;
            throw error;
        }
        maxGroups = parsed;
    }

    if (allowMultipleGroups === false) {
        maxGroups = 1;
    }

    const availableIds = new Set((gruposDisponiveis || []).map((g) => g.id));
    const availableByNormalizedName = new Map();
    for (const grupo of gruposDisponiveis || []) {
        availableByNormalizedName.set(normalizeGroupName(grupo.nome), grupo.nome);
    }

    let allowedGroupIds = undefined;
    if (body && Array.isArray(body.allowedGroupIds)) {
        const ids = [];
        for (const value of body.allowedGroupIds) {
            const safeId = sanitizeText(value, 160);
            if (!safeId) {
                continue;
            }
            if (!availableIds.has(safeId)) {
                const error = new Error(`Grupo nao pertence ao cliente alvo: ${safeId}`);
                error.statusCode = 400;
                throw error;
            }
            if (!ids.includes(safeId)) {
                ids.push(safeId);
            }
        }
        allowedGroupIds = ids;
    }

    let allowedGroupNames = undefined;
    if (body && Array.isArray(body.allowedGroupNames)) {
        const names = [];
        for (const value of body.allowedGroupNames) {
            const safeName = sanitizeText(value, 180);
            if (!safeName) {
                continue;
            }

            const normalized = normalizeGroupName(safeName);
            if (!normalized) {
                continue;
            }

            const matchedName = availableByNormalizedName.get(normalized) || safeName;
            if (!names.includes(matchedName)) {
                names.push(matchedName);
            }
        }
        allowedGroupNames = names;
    }

    if (primaryGroupId && !availableIds.has(primaryGroupId)) {
        const error = new Error('primaryGroupId nao pertence ao cliente alvo.');
        error.statusCode = 400;
        throw error;
    }

    return {
        allowMultipleGroups,
        maxGroups,
        primaryGroupId,
        allowedGroupIds,
        allowedGroupNames
    };
}

function sanitizeCliente(cliente) {
    if (!cliente) {
        return null;
    }

    return {
        id: cliente.id,
        nome: cliente.nome,
        email: cliente.email,
        plano: cliente.plano,
        criadoEm: cliente.criadoEm,
        isDashboardAdmin: isDashboardDeveloperAdminEmail(cliente.email)
    };
}

async function handleAdminRoutes(req, res, parsedUrl, helpers) {
    const pathname = parsedUrl.pathname;
    const accessPath = ['/admin/dashboard-access', '/api/admin/dashboard-access'];

    if (!isPath(pathname, accessPath)) {
        return false;
    }

    if (!(await verificarToken(req, res, helpers))) {
        return true;
    }

    if (!(await verificarAdminDashboard(req, res, helpers))) {
        return true;
    }

    if (req.method === 'GET') {
        try {
            const clienteId = sanitizeText(parsedUrl.searchParams.get('clienteId'), 120);
            const email = sanitizeEmail(parsedUrl.searchParams.get('email'));

            if (!clienteId && !email) {
                const clientes = await listClientes(500);
                const policies = listDashboardAccessPolicies();

                const items = clientes.map((cliente) => {
                    const safeCliente = sanitizeCliente(cliente);
                    const policy = policies[cliente.id] || getDashboardAccessPolicy(cliente.id);
                    return {
                        cliente: safeCliente,
                        policy
                    };
                });

                helpers.sendJson(res, 200, { ok: true, items });
                return true;
            }

            const cliente = await resolveCliente({ clienteId, email });
            if (!cliente) {
                helpers.sendJson(res, 404, { ok: false, error: 'Cliente nao encontrado.' });
                return true;
            }

            const acesso = await resolveDashboardAccessForCliente(cliente.id);
            helpers.sendJson(res, 200, {
                ok: true,
                cliente: sanitizeCliente(cliente),
                policy: acesso.policy,
                gruposDisponiveis: acesso.gruposDisponiveis,
                gruposVisiveis: acesso.gruposVisiveis,
                permittedGroupNames: acesso.permittedGroupNames
            });
        } catch (error) {
            helpers.sendJson(res, error.statusCode || 500, {
                ok: false,
                error: error.message || 'Erro ao consultar acesso administrativo.'
            });
        }

        return true;
    }

    if (req.method === 'PUT') {
        try {
            const body = await helpers.readJsonBody(req);
            const cliente = await resolveCliente(body);

            if (!cliente) {
                helpers.sendJson(res, 404, { ok: false, error: 'Cliente alvo nao encontrado.' });
                return true;
            }

            const acessoAtual = await resolveDashboardAccessForCliente(cliente.id);
            const changes = parsePolicyPayload(body, acessoAtual.gruposDisponiveis);

            const payload = {
                clienteId: cliente.id,
                updatedBy: req.auth && req.auth.email,
                ...changes
            };

            const policy = upsertDashboardAccessPolicy(payload);
            const acesso = await resolveDashboardAccessForCliente(cliente.id);
            const botSync = await notifyBotSync({
                type: 'DASHBOARD_ACCESS_UPDATED',
                action: 'POLICY_UPDATED',
                clienteId: cliente.id,
                triggeredBy: req.auth && req.auth.email
            });

            helpers.sendJson(res, 200, {
                ok: true,
                cliente: sanitizeCliente(cliente),
                policy,
                gruposDisponiveis: acesso.gruposDisponiveis,
                gruposVisiveis: acesso.gruposVisiveis,
                permittedGroupNames: acesso.permittedGroupNames,
                botSync
            });
        } catch (error) {
            helpers.sendJson(res, error.statusCode || 500, {
                ok: false,
                error: error.message || 'Erro ao atualizar politica de acesso.'
            });
        }

        return true;
    }

    if (req.method === 'DELETE') {
        try {
            const body = await helpers.readJsonBody(req);
            const cliente = await resolveCliente(body);

            if (!cliente) {
                helpers.sendJson(res, 404, { ok: false, error: 'Cliente alvo nao encontrado.' });
                return true;
            }

            clearDashboardAccessPolicy(cliente.id);
            const acesso = await resolveDashboardAccessForCliente(cliente.id);
            const botSync = await notifyBotSync({
                type: 'DASHBOARD_ACCESS_UPDATED',
                action: 'POLICY_RESET',
                clienteId: cliente.id,
                triggeredBy: req.auth && req.auth.email
            });

            helpers.sendJson(res, 200, {
                ok: true,
                cliente: sanitizeCliente(cliente),
                policy: acesso.policy,
                gruposDisponiveis: acesso.gruposDisponiveis,
                gruposVisiveis: acesso.gruposVisiveis,
                permittedGroupNames: acesso.permittedGroupNames,
                botSync
            });
        } catch (error) {
            helpers.sendJson(res, error.statusCode || 500, {
                ok: false,
                error: error.message || 'Erro ao resetar politica de acesso.'
            });
        }

        return true;
    }

    helpers.sendJson(res, 405, { ok: false, error: 'Metodo nao permitido para /admin/dashboard-access.' });
    return true;
}

module.exports = {
    handleAdminRoutes
};
