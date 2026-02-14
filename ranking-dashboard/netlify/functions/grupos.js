const { handleGrupoRoutes } = require('../../routes/grupoRoutes.js');
const { buildResponse, createRouteContext } = require('./_route-adapter.js');

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return buildResponse(204, {}, 'GET,POST,PUT,DELETE,OPTIONS');
    }

    const ctx = createRouteContext(event, {
        functionName: 'grupos',
        apiBase: '/api/grupos',
        allowedMethods: 'GET,POST,PUT,DELETE,OPTIONS'
    });

    try {
        const handled = await handleGrupoRoutes(ctx.req, ctx.res, ctx.parsedUrl, ctx.helpers);
        if (handled) {
            return ctx.getResponse() || buildResponse(204, {}, 'GET,POST,PUT,DELETE,OPTIONS');
        }

        return buildResponse(404, { ok: false, error: 'Rota grupos nao encontrada.' }, 'GET,POST,PUT,DELETE,OPTIONS');
    } catch (error) {
        return buildResponse(500, {
            ok: false,
            error: error.message || 'Erro interno na funcao grupos.'
        }, 'GET,POST,PUT,DELETE,OPTIONS');
    }
};

