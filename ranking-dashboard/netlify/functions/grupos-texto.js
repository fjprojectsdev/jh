const { fetchGroupsFromSupabase } = require('../../realtimeSupabaseSource.cjs');
const { verificarToken } = require('../../auth/authMiddleware.js');

const FORCED_RANKING_GROUPS = [
    'CriptoNoPix é Vellora (1)',
    'CriptoNoPix é Vellora (2)'
];

function normalizeGroupName(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function response(statusCode, body) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        },
        body: JSON.stringify(body)
    };
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return response(204, {});
    }

    if (event.httpMethod !== 'GET') {
        return response(405, { ok: false, error: 'Metodo nao permitido.' });
    }

    const req = { headers: event.headers || {} };
    let authResponse = null;
    const authorized = await verificarToken(req, {}, {
        sendJson(_res, statusCode, payload) {
            authResponse = response(statusCode, payload);
        }
    });

    if (!authorized) {
        return authResponse || response(401, { ok: false, error: 'Token invalido ou expirado.' });
    }

    try {
        const allowedSet = new Set(FORCED_RANKING_GROUPS.map((name) => normalizeGroupName(name)));
        const grupos = (await fetchGroupsFromSupabase())
            .filter((name) => allowedSet.has(normalizeGroupName(name)));
        return response(200, { grupos });
    } catch (error) {
        return response(400, {
            ok: false,
            error: error.message || 'Erro ao listar grupos.'
        });
    }
};
