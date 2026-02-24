const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { findGrupoById } = require('../models/grupo.js');
const { listClientes } = require('../models/cliente.js');
const { sanitizeEmail } = require('../services/supabaseTenantClient.js');
const { isDashboardDeveloperAdminEmail, resolveDashboardAccessForCliente } = require('../services/dashboardAccessControlService.js');

function buildFallbackJwtSecret() {
    const source =
        process.env.IMAVY_SUPABASE_SERVICE_KEY ||
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.SUPABASE_KEY ||
        process.env.IMAVY_SUPABASE_URL ||
        process.env.SUPABASE_URL ||
        'imavy-default-fallback-source';

    return crypto
        .createHash('sha256')
        .update(`imavy-jwt:${String(source)}`)
        .digest('hex');
}

function getJwtSecret() {
    const secret = process.env.IMAVY_JWT_SECRET || process.env.JWT_SECRET || '';
    if (secret && secret.length >= 24) {
        return secret;
    }

    return buildFallbackJwtSecret();
}

function parseBearerToken(req) {
    const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
    if (!authHeader || typeof authHeader !== 'string') {
        return null;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
        return null;
    }

    return parts[1].trim();
}

function isSingleModeEnabled() {
    const raw = String(process.env.IMAVY_DASHBOARD_SINGLE_MODE || '').trim().toLowerCase();
    if (!raw) {
        return true;
    }

    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

let singleModeAuthCache = {
    expiresAt: 0,
    payload: null
};

async function resolveSingleModeAuth() {
    const now = Date.now();
    if (singleModeAuthCache.payload && singleModeAuthCache.expiresAt > now) {
        return singleModeAuthCache.payload;
    }

    let clienteId = String(process.env.IMAVY_DASHBOARD_DEFAULT_CLIENTE_ID || '').trim();
    if (!clienteId) {
        try {
            const clientes = await listClientes(100);
            const safeClientes = Array.isArray(clientes) ? clientes : [];
            let fallbackFirst = '';

            for (const cliente of safeClientes) {
                const id = String(cliente && cliente.id || '').trim();
                if (!id) {
                    continue;
                }

                if (!fallbackFirst) {
                    fallbackFirst = id;
                }

                try {
                    const access = await resolveDashboardAccessForCliente(id);
                    const totalDisponiveis = Array.isArray(access && access.gruposDisponiveis) ? access.gruposDisponiveis.length : 0;
                    const totalVisiveis = Array.isArray(access && access.gruposVisiveis) ? access.gruposVisiveis.length : 0;
                    if (totalDisponiveis > 0 || totalVisiveis > 0) {
                        clienteId = id;
                        break;
                    }
                } catch (_) {
                    // ignora cliente com falha de consulta e testa o proximo
                }
            }

            if (!clienteId) {
                clienteId = fallbackFirst;
            }
        } catch (_) {
            clienteId = '';
        }
    }

    if (!clienteId) {
        return null;
    }

    const payload = {
        clienteId,
        plano: String(process.env.IMAVY_DASHBOARD_SINGLE_PLAN || 'enterprise').trim() || 'enterprise',
        exp: null,
        email: sanitizeEmail(process.env.IMAVY_DASHBOARD_SINGLE_EMAIL || 'dashboard@local.imavy'),
        dashboardRole: 'developer_admin',
        isDashboardAdmin: true,
        singleMode: true
    };

    singleModeAuthCache = {
        payload,
        expiresAt: now + 60 * 1000
    };

    return payload;
}

async function verificarToken(req, res, helpers) {
    const token = parseBearerToken(req);
    const singleMode = isSingleModeEnabled();

    if (!token) {
        if (singleMode) {
            const auth = await resolveSingleModeAuth();
            if (!auth) {
                helpers.sendJson(res, 503, {
                    ok: false,
                    error: 'Modo unico ativo, mas nenhum cliente padrao foi encontrado.'
                });
                return false;
            }

            req.auth = auth;
            return true;
        }

        helpers.sendJson(res, 401, { ok: false, error: 'Token ausente.' });
        return false;
    }

    try {
        const jwtSecret = getJwtSecret();
        const decoded = jwt.verify(token, jwtSecret);
        const email = sanitizeEmail(decoded.email);
        const dashboardRole = decoded.dashboardRole || (isDashboardDeveloperAdminEmail(email) ? 'developer_admin' : 'cliente');
        const isDashboardAdmin = Boolean(decoded.isDashboardAdmin) || dashboardRole === 'developer_admin' || isDashboardDeveloperAdminEmail(email);

        req.auth = {
            clienteId: decoded.clienteId,
            plano: decoded.plano,
            exp: decoded.exp,
            email,
            dashboardRole,
            isDashboardAdmin
        };

        return true;
    } catch (_) {
        if (singleMode) {
            const auth = await resolveSingleModeAuth();
            if (!auth) {
                helpers.sendJson(res, 503, {
                    ok: false,
                    error: 'Modo unico ativo, mas nenhum cliente padrao foi encontrado.'
                });
                return false;
            }

            req.auth = auth;
            return true;
        }

        helpers.sendJson(res, 401, { ok: false, error: 'Token invalido ou expirado.' });
        return false;
    }
}

async function verificarGrupoDoCliente(req, res, helpers, grupoId) {
    try {
        const grupo = await findGrupoById(grupoId);

        if (!grupo) {
            helpers.sendJson(res, 404, { ok: false, error: 'Grupo nao encontrado.' });
            return false;
        }

        if (!req.auth || grupo.clienteId !== req.auth.clienteId) {
            helpers.sendJson(res, 403, { ok: false, error: 'Acesso negado ao grupo informado.' });
            return false;
        }

        const access = await resolveDashboardAccessForCliente(req.auth.clienteId);
        const visibleIds = new Set((access.gruposVisiveis || []).map((item) => item.id));

        if (!visibleIds.has(grupo.id)) {
            helpers.sendJson(res, 403, { ok: false, error: 'Grupo fora do escopo permitido para este usuario.' });
            return false;
        }

        req.grupo = grupo;
        return true;
    } catch (error) {
        helpers.sendJson(res, error.statusCode || 500, {
            ok: false,
            error: error.message || 'Erro ao validar acesso ao grupo.'
        });
        return false;
    }
}

async function verificarAdminDashboard(req, res, helpers) {
    if (!req.auth || !req.auth.isDashboardAdmin) {
        helpers.sendJson(res, 403, { ok: false, error: 'Acesso restrito ao admin desenvolvedor do dashboard.' });
        return false;
    }

    return true;
}

module.exports = {
    getJwtSecret,
    verificarToken,
    verificarGrupoDoCliente,
    verificarAdminDashboard
};
