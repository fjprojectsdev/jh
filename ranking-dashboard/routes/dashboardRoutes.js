const { verificarToken, verificarGrupoDoCliente } = require('../auth/authMiddleware.js');
const { gerarRankingPorCliente } = require('../services/rankingService.js');
const { createInteracao, normalizeDate } = require('../models/interacao.js');
const { sanitizeText } = require('../services/supabaseTenantClient.js');
const { validarLimitePlano } = require('../services/grupoService.js');
const {
    ingestIntelEvent,
    listIntelEvents,
    getIntelOpsSummary,
    isIntelWebhookAuthorized
} = require('../services/intelEventsService.js');
const { notifyBotSync, fetchBotSyncStatus } = require('../services/botSyncService.js');

function isPath(pathname, candidates) {
    return candidates.includes(pathname);
}

async function handleDashboardRoutes(req, res, parsedUrl, helpers) {
    const pathname = parsedUrl.pathname;

    const isRankingPath = isPath(pathname, ['/dashboard/ranking', '/api/dashboard/ranking']);
    const isInteracaoPath = isPath(pathname, ['/dashboard/interacoes', '/api/dashboard/interacoes']);
    const isIntelPath = isPath(pathname, ['/dashboard/intel-events', '/api/dashboard/intel-events']);
    const isBotControlPath = isPath(pathname, ['/dashboard/bot-control', '/api/dashboard/bot-control']);

    if (!isRankingPath && !isInteracaoPath && !isIntelPath && !isBotControlPath) {
        return false;
    }

    if (isIntelPath && req.method === 'POST') {
        try {
            if (!isIntelWebhookAuthorized(req)) {
                helpers.sendJson(res, 403, {
                    ok: false,
                    error: 'Webhook de inteligencia nao autorizado.'
                });
                return true;
            }

            const body = await helpers.readJsonBody(req);
            const saved = ingestIntelEvent(body);
            helpers.sendJson(res, 202, {
                ok: true,
                eventId: saved.id
            });
        } catch (error) {
            helpers.sendJson(res, error.statusCode || 500, {
                ok: false,
                error: error.message || 'Erro ao registrar evento de inteligencia.'
            });
        }

        return true;
    }

    if (!(await verificarToken(req, res, helpers))) {
        return true;
    }

    if (isBotControlPath && req.method === 'GET') {
        try {
            const botStatus = await fetchBotSyncStatus();
            helpers.sendJson(res, 200, {
                ok: true,
                botStatus
            });
        } catch (error) {
            helpers.sendJson(res, error.statusCode || 500, {
                ok: false,
                error: error.message || 'Erro ao consultar status de controle do bot.'
            });
        }
        return true;
    }

    if (isBotControlPath && req.method === 'POST') {
        try {
            const body = await helpers.readJsonBody(req);
            const patch = body && body.patch && typeof body.patch === 'object' ? body.patch : {};
            const botSync = await notifyBotSync({
                type: 'RUNTIME_FEATURE_FLAGS_PATCH',
                action: 'RUNTIME_PATCH_REQUESTED',
                source: 'dashboard-control',
                runtimeFeatureFlags: patch,
                triggeredBy: req.auth && req.auth.email
            });

            helpers.sendJson(res, 200, {
                ok: true,
                botSync
            });
        } catch (error) {
            helpers.sendJson(res, error.statusCode || 500, {
                ok: false,
                error: error.message || 'Erro ao aplicar controle em tempo real no bot.'
            });
        }
        return true;
    }

    if (isIntelPath && req.method === 'GET') {
        try {
            const limit = sanitizeText(parsedUrl.searchParams.get('limit') || '', 10);
            const type = sanitizeText(parsedUrl.searchParams.get('type') || '', 64);
            const token = sanitizeText(parsedUrl.searchParams.get('token') || '', 40);
            const group = sanitizeText(parsedUrl.searchParams.get('group') || '', 180);
            const events = listIntelEvents({
                limit,
                type,
                token,
                group
            });
            const summary = getIntelOpsSummary();

            helpers.sendJson(res, 200, {
                ok: true,
                events,
                summary
            });
        } catch (error) {
            helpers.sendJson(res, error.statusCode || 500, {
                ok: false,
                error: error.message || 'Erro ao listar eventos de inteligencia.'
            });
        }

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
