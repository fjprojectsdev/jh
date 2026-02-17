const gerarRankingParticipantesTexto = require('./ranking-engine.cjs');
const { fetchInteractionsFromSupabase } = require('../../realtimeSupabaseSource.cjs');
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

        const allowedSet = new Set(FORCED_RANKING_GROUPS.map((name) => normalizeGroupName(name)));
        const safeGroup = allowedSet.has(normalizeGroupName(grupoSelecionado)) ? String(grupoSelecionado).trim() : '';
        const fonteSupabase = Boolean(usarSupabase) || !Array.isArray(interacoes);
        const baseInteracoes = fonteSupabase
            ? await fetchInteractionsFromSupabase({
                dataInicio,
                dataFim,
                grupoSelecionado: safeGroup,
                gruposPermitidos: FORCED_RANKING_GROUPS
            })
            : interacoes.filter((item) => allowedSet.has(normalizeGroupName(item && item.grupo)));

        const resultado = gerarRankingParticipantesTexto(baseInteracoes, dataInicio, dataFim, safeGroup);
        return response(200, resultado);
    } catch (error) {
        return response(400, {
            ok: false,
            error: error.message || 'Erro ao processar ranking.'
        });
    }
};

