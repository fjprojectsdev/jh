const jwt = require('jsonwebtoken');
const { findGrupoById } = require('../models/grupo.js');

const JWT_SECRET = process.env.IMAVY_JWT_SECRET || process.env.JWT_SECRET || 'imavy_multitenant_secret_change_me';

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

async function verificarToken(req, res, helpers) {
    const token = parseBearerToken(req);
    if (!token) {
        helpers.sendJson(res, 401, { ok: false, error: 'Token ausente.' });
        return false;
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.auth = {
            clienteId: decoded.clienteId,
            plano: decoded.plano,
            exp: decoded.exp
        };

        return true;
    } catch (_) {
        helpers.sendJson(res, 401, { ok: false, error: 'Token invalido ou expirado.' });
        return false;
    }
}

async function verificarGrupoDoCliente(req, res, helpers, grupoId) {
    const grupo = await findGrupoById(grupoId);

    if (!grupo) {
        helpers.sendJson(res, 404, { ok: false, error: 'Grupo nao encontrado.' });
        return false;
    }

    if (!req.auth || grupo.clienteId !== req.auth.clienteId) {
        helpers.sendJson(res, 403, { ok: false, error: 'Acesso negado ao grupo informado.' });
        return false;
    }

    req.grupo = grupo;
    return true;
}

module.exports = {
    JWT_SECRET,
    verificarToken,
    verificarGrupoDoCliente
};
