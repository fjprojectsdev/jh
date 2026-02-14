const { verificarToken, verificarGrupoDoCliente } = require('../auth/authMiddleware.js');
const {
    criarGrupoParaCliente,
    editarGrupoDoCliente,
    removerGrupoDoCliente,
    listGruposByCliente,
    validarLimitePlano
} = require('../services/grupoService.js');
const { sanitizeText } = require('../services/supabaseTenantClient.js');

function isPath(pathname, candidates) {
    return candidates.includes(pathname);
}

function extractGrupoId(pathname) {
    const normalized = pathname.startsWith('/api/') ? pathname.slice(4) : pathname;
    const parts = normalized.split('/').filter(Boolean);

    if (parts.length === 2 && parts[0] === 'grupos') {
        return parts[1];
    }

    return null;
}

async function handleGrupoRoutes(req, res, parsedUrl, helpers) {
    const pathname = parsedUrl.pathname;

    if (!pathname.startsWith('/grupos') && !pathname.startsWith('/api/grupos')) {
        return false;
    }

    if (!(await verificarToken(req, res, helpers))) {
        return true;
    }

    if (req.method === 'GET' && isPath(pathname, ['/grupos', '/api/grupos'])) {
        try {
            const grupos = await listGruposByCliente(req.auth.clienteId);
            const plano = await validarLimitePlano(req.auth.clienteId);
            helpers.sendJson(res, 200, { ok: true, grupos, plano });
        } catch (error) {
            helpers.sendJson(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao listar grupos.' });
        }
        return true;
    }

    if (req.method === 'POST' && isPath(pathname, ['/grupos', '/api/grupos'])) {
        try {
            const body = await helpers.readJsonBody(req);
            const grupo = await criarGrupoParaCliente(req.auth.clienteId, {
                id: sanitizeText(body && body.id, 160),
                nome: sanitizeText(body && body.nome, 180)
            });
            helpers.sendJson(res, 201, { ok: true, grupo });
        } catch (error) {
            helpers.sendJson(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao criar grupo.' });
        }
        return true;
    }

    if (req.method === 'PUT') {
        const grupoId = extractGrupoId(pathname);
        if (!grupoId) {
            return false;
        }

        if (!(await verificarGrupoDoCliente(req, res, helpers, grupoId))) {
            return true;
        }

        try {
            const body = await helpers.readJsonBody(req);
            const grupo = await editarGrupoDoCliente(req.auth.clienteId, grupoId, {
                nome: sanitizeText(body && body.nome, 180)
            });
            helpers.sendJson(res, 200, { ok: true, grupo });
        } catch (error) {
            helpers.sendJson(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao editar grupo.' });
        }
        return true;
    }

    if (req.method === 'DELETE') {
        const grupoId = extractGrupoId(pathname);
        if (!grupoId) {
            return false;
        }

        if (!(await verificarGrupoDoCliente(req, res, helpers, grupoId))) {
            return true;
        }

        try {
            await removerGrupoDoCliente(req.auth.clienteId, grupoId);
            helpers.sendJson(res, 200, { ok: true });
        } catch (error) {
            helpers.sendJson(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao remover grupo.' });
        }
        return true;
    }

    helpers.sendJson(res, 405, { ok: false, error: 'Metodo nao permitido para /grupos.' });
    return true;
}

module.exports = {
    handleGrupoRoutes
};
