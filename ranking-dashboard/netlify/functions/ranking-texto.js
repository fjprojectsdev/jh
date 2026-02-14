const gerarRankingParticipantesTexto = require('./ranking-engine.cjs');
const { fetchInteractionsFromSupabase } = require('../../realtimeSupabaseSource.cjs');
const { verificarToken } = require('../../auth/authMiddleware.js');

function response(statusCode, body) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        },
        body: JSON.stringify(body)
    };
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return response(204, {});
    }

    if (event.httpMethod !== 'POST') {
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
        const payload = event.body ? JSON.parse(event.body) : {};
        const {
            interacoes,
            dataInicio,
            dataFim,
            grupoSelecionado,
            usarSupabase
        } = payload;

        const fonteSupabase = Boolean(usarSupabase) || !Array.isArray(interacoes);
        const baseInteracoes = fonteSupabase
            ? await fetchInteractionsFromSupabase({ dataInicio, dataFim, grupoSelecionado })
            : interacoes;

        const resultado = gerarRankingParticipantesTexto(baseInteracoes, dataInicio, dataFim, grupoSelecionado);
        return response(200, resultado);
    } catch (error) {
        return response(400, {
            ok: false,
            error: error.message || 'Erro ao processar ranking.'
        });
    }
};

