const gerarRankingParticipantesTexto = require('./ranking-engine.cjs');

function response(statusCode, body) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
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

    try {
        const payload = event.body ? JSON.parse(event.body) : {};
        const { interacoes, dataInicio, dataFim } = payload;
        const resultado = gerarRankingParticipantesTexto(interacoes, dataInicio, dataFim);
        return response(200, resultado);
    } catch (error) {
        return response(400, {
            ok: false,
            error: error.message || 'Erro ao processar ranking.'
        });
    }
};
