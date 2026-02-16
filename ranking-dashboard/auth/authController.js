const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
    findClienteByEmail,
    createCliente,
    normalizePlano
} = require('../models/cliente.js');
const { sanitizeText, sanitizeEmail } = require('../services/supabaseTenantClient.js');
const { getJwtSecret } = require('./authMiddleware.js');
const { vincularGruposAutorizadosAoCliente } = require('../services/allowedGroupsSyncService.js');
const { getDashboardRoleForEmail, isDashboardDeveloperAdminEmail } = require('../services/dashboardAccessControlService.js');

const TOKEN_EXPIRATION = process.env.IMAVY_TOKEN_EXPIRATION || '12h';

function validarEmail(email) {
    const value = sanitizeEmail(email);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function gerarToken(cliente) {
    const jwtSecret = getJwtSecret();
    const email = sanitizeEmail(cliente && cliente.email);
    const dashboardRole = getDashboardRoleForEmail(email);
    const isDashboardAdmin = dashboardRole === 'developer_admin';

    return jwt.sign(
        {
            clienteId: cliente.id,
            plano: cliente.plano,
            email,
            dashboardRole,
            isDashboardAdmin
        },
        jwtSecret,
        { expiresIn: TOKEN_EXPIRATION }
    );
}

async function executarVinculoAutomaticoGrupos(clienteId) {
    try {
        const resumo = await vincularGruposAutorizadosAoCliente(clienteId);
        return {
            ok: true,
            resumo
        };
    } catch (error) {
        return {
            ok: false,
            erro: error.message || 'Falha na sincronizacao de grupos autorizados.'
        };
    }
}

async function registrarCliente(req, res, helpers) {
    try {
        const body = await helpers.readJsonBody(req);
        const nome = sanitizeText(body && body.nome, 160);
        const email = sanitizeEmail(body && body.email);
        const senha = sanitizeText(body && body.senha, 200);
        const plano = normalizePlano(body && body.plano);

        if (!nome || !email || !senha) {
            helpers.sendJson(res, 400, { ok: false, error: 'nome, email e senha sao obrigatorios.' });
            return;
        }

        if (!validarEmail(email)) {
            helpers.sendJson(res, 400, { ok: false, error: 'Email invalido.' });
            return;
        }

        if (senha.length < 6) {
            helpers.sendJson(res, 400, { ok: false, error: 'Senha deve ter ao menos 6 caracteres.' });
            return;
        }

        const existente = await findClienteByEmail(email, true);
        if (existente) {
            helpers.sendJson(res, 409, { ok: false, error: 'Email ja cadastrado.' });
            return;
        }

        const senhaHash = await bcrypt.hash(senha, 12);
        const cliente = await createCliente({ nome, email, senhaHash, plano });
        const syncResult = await executarVinculoAutomaticoGrupos(cliente.id);
        const dashboardRole = getDashboardRoleForEmail(cliente.email);
        const clienteComRole = {
            ...cliente,
            dashboardRole,
            isDashboardAdmin: dashboardRole === 'developer_admin'
        };
        const token = gerarToken(clienteComRole);

        helpers.sendJson(res, 201, {
            ok: true,
            cliente: clienteComRole,
            token,
            expiraEm: TOKEN_EXPIRATION,
            gruposAutorizadosSync: syncResult
        });
    } catch (error) {
        helpers.sendJson(res, error.statusCode || 500, {
            ok: false,
            error: error.message || 'Erro ao registrar cliente.'
        });
    }
}

async function loginCliente(req, res, helpers) {
    try {
        const body = await helpers.readJsonBody(req);
        const email = sanitizeEmail(body && body.email);
        const senha = sanitizeText(body && body.senha, 200);

        if (!email || !senha) {
            helpers.sendJson(res, 400, { ok: false, error: 'email e senha sao obrigatorios.' });
            return;
        }

        const cliente = await findClienteByEmail(email, true);
        if (!cliente || !cliente.senhaHash) {
            helpers.sendJson(res, 401, { ok: false, error: 'Credenciais invalidas.' });
            return;
        }

        const senhaOk = await bcrypt.compare(senha, cliente.senhaHash);
        if (!senhaOk) {
            helpers.sendJson(res, 401, { ok: false, error: 'Credenciais invalidas.' });
            return;
        }

        const clienteSeguro = {
            id: cliente.id,
            nome: cliente.nome,
            email: cliente.email,
            plano: cliente.plano,
            criadoEm: cliente.criadoEm,
            dashboardRole: getDashboardRoleForEmail(cliente.email),
            isDashboardAdmin: isDashboardDeveloperAdminEmail(cliente.email)
        };

        const syncResult = await executarVinculoAutomaticoGrupos(clienteSeguro.id);
        const token = gerarToken(clienteSeguro);

        helpers.sendJson(res, 200, {
            ok: true,
            cliente: clienteSeguro,
            token,
            expiraEm: TOKEN_EXPIRATION,
            gruposAutorizadosSync: syncResult
        });
    } catch (error) {
        helpers.sendJson(res, error.statusCode || 500, {
            ok: false,
            error: error.message || 'Erro no login.'
        });
    }
}

module.exports = {
    registrarCliente,
    loginCliente
};
