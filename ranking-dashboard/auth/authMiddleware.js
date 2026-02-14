const jwt = require('jsonwebtoken');
const { findGrupoById } = require('../models/grupo.js');

function getJwtSecret() {
    const secret = process.env.IMAVY_JWT_SECRET || process.env.JWT_SECRET || '';
    if (!secret || secret.length < 24) {
        throw new Error('JWT secret nao configurado. Defina IMAVY_JWT_SECRET (>=24 caracteres).');
    }
    return secret;
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

async function verificarToken(req, res, helpers) {
    const token = parseBearerToken(req);
    if (!token) {
        helpers.sendJson(res, 401, { ok: false, error: 'Token ausente.' });
        return false;
    }

    try {
        const jwtSecret = getJwtSecret();
        const decoded = jwt.verify(token, jwtSecret);
        req.auth = {
            clienteId: decoded.clienteId,
            plano: decoded.plano,
            exp: decoded.exp
        };

        return true;
    } catch (error) {
        if (error && error.message && error.message.includes('JWT secret nao configurado')) {
            helpers.sendJson(res, 500, { ok: false, error: error.message });
            return false;
        }

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
    getJwtSecret,
    verificarToken,
    verificarGrupoDoCliente
};
