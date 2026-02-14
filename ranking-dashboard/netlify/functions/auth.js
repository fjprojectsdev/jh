const { handleAuthRoutes } = require('../../routes/authRoutes.js');
const { buildResponse, createRouteContext } = require('./_route-adapter.js');

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return buildResponse(204, {}, 'POST,OPTIONS');
    }

    const ctx = createRouteContext(event, {
        functionName: 'auth',
        apiBase: '/api/auth',
        allowedMethods: 'POST,OPTIONS'
    });

    try {
        const handled = await handleAuthRoutes(ctx.req, ctx.res, ctx.parsedUrl, ctx.helpers);
        if (handled) {
            return ctx.getResponse() || buildResponse(204, {}, 'POST,OPTIONS');
        }

        return buildResponse(404, { ok: false, error: 'Rota auth nao encontrada.' }, 'POST,OPTIONS');
    } catch (error) {
        return buildResponse(500, {
            ok: false,
            error: error.message || 'Erro interno na funcao auth.'
        }, 'POST,OPTIONS');
    }
};

