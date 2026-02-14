const { verificarToken, verificarGrupoDoCliente } = require('../auth/authMiddleware.js');
const { gerarRankingPorCliente } = require('../services/rankingService.js');
const { createInteracao, normalizeDate } = require('../models/interacao.js');
const { sanitizeText } = require('../services/supabaseTenantClient.js');
const { validarLimitePlano } = require('../services/grupoService.js');

function isPath(pathname, candidates) {
    return candidates.includes(pathname);
}

async function handleDashboardRoutes(req, res, parsedUrl, helpers) {
    const pathname = parsedUrl.pathname;

    const isRankingPath = isPath(pathname, ['/dashboard/ranking', '/api/dashboard/ranking']);
    const isInteracaoPath = isPath(pathname, ['/dashboard/interacoes', '/api/dashboard/interacoes']);

    if (!isRankingPath && !isInteracaoPath) {
        return false;
    }

    if (!(await verificarToken(req, res, helpers))) {
        return true;
    }

    if (isRankingPath && req.method === 'GET') {
        try {
            const dataInicio = normalizeDate(parsedUrl.searchParams.get('dataInicio'));
            const dataFim = normalizeDate(parsedUrl.searchParams.get('dataFim'));
            const grupoId = sanitizeText(parsedUrl.searchParams.get('grupoId') || '', 160) || null;

            if (!dataInicio || !dataFim) {
                helpers.sendJson(res, 400, { ok: false, error: 'dataInicio e dataFim sao obrigatorios no formato YYYY-MM-DD.' });
                return true;
            }

            if (grupoId) {
                const allowed = await verificarGrupoDoCliente(req, res, helpers, grupoId);
                if (!allowed) {
                    return true;
                }
            }

            const resultado = await gerarRankingPorCliente({
                clienteId: req.auth.clienteId,
                dataInicio,
                dataFim,
                grupoId
            });

            helpers.sendJson(res, 200, { ok: true, ...resultado });
        } catch (error) {
            helpers.sendJson(res, error.statusCode || 500, {
                ok: false,
                error: error.message || 'Erro ao gerar ranking do cliente.'
            });
        }

        return true;
    }

    if (isInteracaoPath && req.method === 'POST') {
        try {
            const body = await helpers.readJsonBody(req);
            const grupoId = sanitizeText(body && body.grupoId, 160);

            if (!grupoId) {
                helpers.sendJson(res, 400, { ok: false, error: 'grupoId e obrigatorio.' });
                return true;
            }

            const allowed = await verificarGrupoDoCliente(req, res, helpers, grupoId);
            if (!allowed) {
                return true;
            }

            const plano = await validarLimitePlano(req.auth.clienteId, 1);
            if (!plano.permitidoInteracoesMes) {
                helpers.sendJson(res, 403, {
                    ok: false,
                    error: 'Limite mensal de interacoes do plano atingido.'
                });
                return true;
            }

            const interacao = await createInteracao({
                id: sanitizeText(body && body.id, 180),
                participante: sanitizeText(body && body.participante, 160),
                data: normalizeDate(body && body.data),
                grupoId
            });

            helpers.sendJson(res, 201, { ok: true, interacao });
        } catch (error) {
            helpers.sendJson(res, error.statusCode || 500, {
                ok: false,
                error: error.message || 'Erro ao registrar interacao.'
            });
        }

        return true;
    }

    helpers.sendJson(res, 405, { ok: false, error: 'Metodo nao permitido para rotas de dashboard multi-cliente.' });
    return true;
}

module.exports = {
    handleDashboardRoutes
};
