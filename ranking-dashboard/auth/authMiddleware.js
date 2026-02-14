const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { findGrupoById } = require('../models/grupo.js');

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
    getJwtSecret,
    verificarToken,
    verificarGrupoDoCliente
};
