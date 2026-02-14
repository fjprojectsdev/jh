const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const gerarRankingParticipantesTexto = require('../functions/rankingParticipantesTextos.cjs');

const HOST = process.env.RANKING_DASHBOARD_HOST || '0.0.0.0';
const PORT = Number(process.env.RANKING_DASHBOARD_PORT || 3010);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8'
};

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

async function handleApi(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, {
            ok: true,
            service: 'ranking-dashboard',
            timestamp: new Date().toISOString()
        });
        return;
    }

    if (req.method === 'POST' && pathname === '/api/ranking-texto') {
        try {
            const payload = await readJsonBody(req);
            const { interacoes, dataInicio, dataFim, grupoSelecionado } = payload || {};
            const resultado = gerarRankingParticipantesTexto(interacoes, dataInicio, dataFim, grupoSelecionado);
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

    sendJson(res, 404, {
        ok: false,
        error: 'Rota nao encontrada.'
    });
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (parsedUrl.pathname.startsWith('/api/')) {
        await handleApi(req, res, parsedUrl.pathname);
        return;
    }

    serveStaticFile(req, res, parsedUrl.pathname);
});

server.listen(PORT, HOST, () => {
    console.log(`Ranking Dashboard ativo em http://localhost:${PORT}`);
    console.log(`API health: http://localhost:${PORT}/api/health`);
});

