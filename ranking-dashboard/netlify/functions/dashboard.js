const { handleDashboardRoutes } = require('../../routes/dashboardRoutes.js');
const { buildResponse, createRouteContext } = require('./_route-adapter.js');

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return buildResponse(204, {}, 'GET,POST,OPTIONS');
    }

    const ctx = createRouteContext(event, {
        functionName: 'dashboard',
        apiBase: '/api/dashboard',
        allowedMethods: 'GET,POST,OPTIONS'
    });

    try {
        const handled = await handleDashboardRoutes(ctx.req, ctx.res, ctx.parsedUrl, ctx.helpers);
        if (handled) {
            return ctx.getResponse() || buildResponse(204, {}, 'GET,POST,OPTIONS');
        }

        return buildResponse(404, { ok: false, error: 'Rota dashboard nao encontrada.' }, 'GET,POST,OPTIONS');
    } catch (error) {
        return buildResponse(500, {
            ok: false,
            error: error.message || 'Erro interno na funcao dashboard.'
        }, 'GET,POST,OPTIONS');
    }
};

