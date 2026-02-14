const { fetchInteractionsFromSupabase } = require('../../realtimeSupabaseSource.cjs');

function response(statusCode, body) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
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

    try {
        const params = event.queryStringParameters || {};
        const interacoes = await fetchInteractionsFromSupabase({
            dataInicio: params.dataInicio,
            dataFim: params.dataFim,
            grupoSelecionado: params.grupoSelecionado || ''
        });

        return response(200, { interacoes });
    } catch (error) {
        return response(400, {
            ok: false,
            error: error.message || 'Erro ao listar interacoes.'
        });
    }
};
