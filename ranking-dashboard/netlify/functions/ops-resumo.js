const { verificarToken } = require('../../auth/authMiddleware.js');
const { getOpsResumo } = require('../../services/opsResumoService.cjs');

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
        const resumo = getOpsResumo();
        return response(200, { ok: true, ...resumo });
    } catch (error) {
        return response(500, {
            ok: false,
            error: error.message || 'Erro ao carregar resumo operacional.'
        });
    }
};
