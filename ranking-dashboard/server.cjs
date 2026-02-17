const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const dotenv = require('dotenv');

// Carrega variaveis locais do dashboard e tambem o .env da raiz do bot.
dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const gerarRankingParticipantesTexto = require('../functions/rankingParticipantesTextos.cjs');
const {
    fetchInteractionsFromSupabase,
    fetchGroupsFromSupabase
} = require('./realtimeSupabaseSource.cjs');
const { getOpsResumo } = require('./services/opsResumoService.cjs');
const { handleAuthRoutes } = require('./routes/authRoutes.js');
const { handleGrupoRoutes } = require('./routes/grupoRoutes.js');
const { handleAdminRoutes } = require('./routes/adminRoutes.js');
const { handleDashboardRoutes } = require('./routes/dashboardRoutes.js');
const { verificarToken } = require('./auth/authMiddleware.js');
const { resolveDashboardAccessForCliente, normalizeGroupName } = require('./services/dashboardAccessControlService.js');

const HOST = process.env.RANKING_DASHBOARD_HOST || '0.0.0.0';
const PORT = Number(process.env.RANKING_DASHBOARD_PORT || 3010);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const HAS_SUPABASE_ENV = Boolean(
    (process.env.IMAVY_SUPABASE_URL || process.env.SUPABASE_URL) &&
    (
        process.env.IMAVY_SUPABASE_SERVICE_KEY ||
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.IMAVY_SUPABASE_ANON_KEY ||
        process.env.SUPABASE_ANON_KEY ||
        process.env.IMAVY_SUPABASE_PUBLISHABLE_KEY ||
        process.env.SUPABASE_PUBLISHABLE_KEY ||
        process.env.SUPABASE_KEY
    )
);

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8'
};
const FORCED_RANKING_GROUPS = [
    'CriptoNoPix é Vellora (1)',
    'CriptoNoPix é Vellora (2)',
    'CriptoNoPix é Vellora (3)'
];

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
}

function sendText(res, statusCode, content, contentType) {
    res.writeHead(statusCode, {
        'Content-Type': contentType || 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(content)
    });
    res.end(content);
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let total = 0;
        const chunks = [];

        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                reject(new Error('Payload excede o limite de 5MB.'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                const parsed = raw ? JSON.parse(raw) : {};
                resolve(parsed);
            } catch (error) {
                reject(new Error('JSON invalido no corpo da requisicao.'));
            }
        });

        req.on('error', (error) => {
            reject(error);
        });
    });
}

function isPathInsidePublic(resolvedPath) {
    return resolvedPath.startsWith(PUBLIC_DIR);
}

function getFilePathFromRequest(urlPath) {
    const normalizedPath = urlPath === '/' ? '/index.html' : urlPath;
    const resolvedPath = path.normalize(path.join(PUBLIC_DIR, normalizedPath));

    if (!isPathInsidePublic(resolvedPath)) {
        return null;
    }

    return resolvedPath;
}

function serveStaticFile(req, res, urlPath) {
    const filePath = getFilePathFromRequest(urlPath);
    if (!filePath) {
        sendText(res, 403, 'Acesso negado.');
        return;
    }

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                sendText(res, 404, 'Arquivo nao encontrado.');
                return;
            }

            sendText(res, 500, 'Erro ao ler arquivo.');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        sendText(res, 200, content, contentType);
    });
}

function uniqueGroupNames(groups) {
    const out = [];
    const seen = new Set();

    for (const value of Array.isArray(groups) ? groups : []) {
        const safe = String(value || '').trim();
        const normalized = normalizeGroupName(safe);
        if (!safe || !normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        out.push(safe);
    }

    return out;
}

function applyForcedRankingScope(groups) {
    const rankingSet = new Set(FORCED_RANKING_GROUPS.map((name) => normalizeGroupName(name)));
    return uniqueGroupNames(groups).filter((name) => rankingSet.has(normalizeGroupName(name)));
}

async function resolvePermittedGroupNamesFromAuth(auth) {
    if (!auth || !auth.clienteId) {
        return [];
    }

    const access = await resolveDashboardAccessForCliente(auth.clienteId);
    return uniqueGroupNames(access.permittedGroupNames);
}

function isGroupNamePermitted(grupoNome, permittedGroups) {
    const normalizedTarget = normalizeGroupName(grupoNome);
    if (!normalizedTarget) {
        return false;
    }

    return uniqueGroupNames(permittedGroups)
        .map((name) => normalizeGroupName(name))
        .includes(normalizedTarget);
}

async function handleApi(req, res, parsedUrl) {
    const pathname = parsedUrl.pathname;
    const authHelpers = { sendJson };

    if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, {
            ok: true,
            service: 'ranking-dashboard',
            timestamp: new Date().toISOString()
        });
        return;
    }

    if (req.method === 'POST' && pathname === '/api/ranking-texto') {
        if (!(await verificarToken(req, res, authHelpers))) {
            return;
        }

        try {
            const permittedGroupNames = applyForcedRankingScope(await resolvePermittedGroupNamesFromAuth(req.auth));
            const payload = await readJsonBody(req);
            const {
                interacoes,
                dataInicio,
                dataFim,
                grupoSelecionado,
                usarSupabase
            } = payload || {};

            const fonteSupabase = Boolean(usarSupabase) || !Array.isArray(interacoes);
            const grupoSelecionadoSafe = String(grupoSelecionado || '').trim();

            if (grupoSelecionadoSafe && !isGroupNamePermitted(grupoSelecionadoSafe, permittedGroupNames)) {
                sendJson(res, 403, {
                    ok: false,
                    error: 'Grupo fora do escopo permitido para este usuario.'
                });
                return;
            }

            if (fonteSupabase && !grupoSelecionadoSafe && permittedGroupNames.length === 0) {
                const resultado = gerarRankingParticipantesTexto([], dataInicio, dataFim, grupoSelecionadoSafe);
                sendJson(res, 200, resultado);
                return;
            }

            const baseInteracoes = fonteSupabase
                ? await fetchInteractionsFromSupabase({
                    dataInicio,
                    dataFim,
                    grupoSelecionado: grupoSelecionadoSafe,
                    gruposPermitidos: permittedGroupNames
                })
                : (Array.isArray(interacoes)
                    ? interacoes.filter((item) => isGroupNamePermitted(item && item.grupo, permittedGroupNames))
                    : []);
            const resultado = gerarRankingParticipantesTexto(baseInteracoes, dataInicio, dataFim, grupoSelecionadoSafe);
            sendJson(res, 200, resultado);
            return;
        } catch (error) {
            sendJson(res, 400, {
                ok: false,
                error: error.message || 'Erro ao processar requisicao.'
            });
            return;
        }
    }

    if (req.method === 'GET' && pathname === '/api/grupos-texto') {
        if (!(await verificarToken(req, res, authHelpers))) {
            return;
        }

        try {
            const permittedGroupNames = applyForcedRankingScope(await resolvePermittedGroupNamesFromAuth(req.auth));
            const gruposSupabase = await fetchGroupsFromSupabase();
            const permittedSet = new Set(permittedGroupNames.map((name) => normalizeGroupName(name)));
            const grupos = (gruposSupabase || []).filter((name) => permittedSet.has(normalizeGroupName(name)));
            sendJson(res, 200, { grupos });
            return;
        } catch (error) {
            sendJson(res, 400, {
                ok: false,
                error: error.message || 'Erro ao listar grupos.'
            });
            return;
        }
    }

    if (req.method === 'GET' && pathname === '/api/interacoes-texto') {
        if (!(await verificarToken(req, res, authHelpers))) {
            return;
        }

        try {
            const permittedGroupNames = applyForcedRankingScope(await resolvePermittedGroupNamesFromAuth(req.auth));
            const dataInicio = parsedUrl.searchParams.get('dataInicio');
            const dataFim = parsedUrl.searchParams.get('dataFim');
            const grupoSelecionado = String(parsedUrl.searchParams.get('grupoSelecionado') || '').trim();

            if (grupoSelecionado && !isGroupNamePermitted(grupoSelecionado, permittedGroupNames)) {
                sendJson(res, 403, {
                    ok: false,
                    error: 'Grupo fora do escopo permitido para este usuario.'
                });
                return;
            }

            if (!grupoSelecionado && permittedGroupNames.length === 0) {
                sendJson(res, 200, { interacoes: [] });
                return;
            }

            const interacoes = await fetchInteractionsFromSupabase({
                dataInicio,
                dataFim,
                grupoSelecionado,
                gruposPermitidos: permittedGroupNames
            });
            sendJson(res, 200, { interacoes });
            return;
        } catch (error) {
            sendJson(res, 400, {
                ok: false,
                error: error.message || 'Erro ao listar interacoes.'
            });
            return;
        }
    }

    if (req.method === 'GET' && pathname === '/api/ops-resumo') {
        if (!(await verificarToken(req, res, authHelpers))) {
            return;
        }

        try {
            const resumo = getOpsResumo();
            sendJson(res, 200, { ok: true, ...resumo });
            return;
        } catch (error) {
            sendJson(res, 500, {
                ok: false,
                error: error.message || 'Erro ao carregar resumo operacional.'
            });
            return;
        }
    }

    sendJson(res, 404, {
        ok: false,
        error: 'Rota nao encontrada.'
    });
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const helpers = {
        sendJson,
        readJsonBody
    };

    // Rotas multi-cliente adicionadas de forma isolada.
    if (await handleAuthRoutes(req, res, parsedUrl, helpers)) {
        return;
    }

    if (await handleAdminRoutes(req, res, parsedUrl, helpers)) {
        return;
    }

    if (await handleGrupoRoutes(req, res, parsedUrl, helpers)) {
        return;
    }

    if (await handleDashboardRoutes(req, res, parsedUrl, helpers)) {
        return;
    }

    if (parsedUrl.pathname.startsWith('/api/')) {
        await handleApi(req, res, parsedUrl);
        return;
    }

    serveStaticFile(req, res, parsedUrl.pathname);
});

server.listen(PORT, HOST, () => {
    console.log(`Ranking Dashboard ativo em http://localhost:${PORT}`);
    console.log(`API health: http://localhost:${PORT}/api/health`);
    if (!HAS_SUPABASE_ENV) {
        console.warn('Aviso: variaveis Supabase nao encontradas no processo do dashboard. O ranking pode nao carregar dados.');
    }
});

